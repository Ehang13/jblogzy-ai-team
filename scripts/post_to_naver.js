// 네이버 블로그 자동 발행 (Playwright + 쿠키 인증)
// export: postToNaverBlog({ title, content, tags, blogId })

import { chromium } from 'playwright';

const WRITE_URL = (id) => `https://blog.naver.com/${id}/postwrite`;

// 쿠키 복원 (base64 또는 raw JSON 모두 지원)
async function restoreCookies(context) {
  const raw = process.env.NAVER_COOKIES;
  if (!raw) throw new Error('NAVER_COOKIES 환경변수가 없습니다');
  const json = raw.trim().startsWith('[')
    ? raw
    : Buffer.from(raw.trim(), 'base64').toString('utf-8');
  const cookies = JSON.parse(json);
  await context.addCookies(cookies);
}

// 로그인 상태 확인 (NID_AUT는 HttpOnly → context.cookies() 사용)
async function isLoggedIn(context, page) {
  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const cookies = await context.cookies(['https://www.naver.com', 'https://naver.com']);
  return cookies.some(c => c.name === 'NID_AUT');
}

// SE3 팝업 처리 (임시저장 확인 팝업 등)
// "취소"(첫 번째 버튼) 클릭 → 이전 임시저장 글 버리고 새 글 작성
async function handleDraftPopup(page) {
  try {
    const popup = page.locator('.se-popup-alert-confirm, .se-popup-alert');
    if (await popup.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  팝업 감지 → 취소(새 글 작성) 클릭...');
      const popupBtns = popup.first().locator('button');
      const count = await popupBtns.count();
      if (count >= 1) {
        // 첫 번째 버튼 = "취소" (이전 글 버리고 새로 작성)
        await popupBtns.first().click();
      }
      await page.waitForTimeout(1000);
    }
  } catch {}
}

// 에디터 컨텍스트 탐색 (SE3는 iframe 불필요, 메인 DOM 직접 접근)
// Python blog_uploader.py와 동일한 전략: 직접 접근 → mainFrame fallback
async function findEditorContext(page) {
  await page.waitForTimeout(4000);

  // 1순위: 메인 DOM 직접 접근 (SE3 표준)
  try {
    await page.waitForSelector('.se-documentTitle', { timeout: 8000 });
    console.log('  에디터: 메인 DOM 직접 접근');
    return page;
  } catch {}

  // 2순위: mainFrame iframe fallback
  for (const frame of page.frames()) {
    if (frame.name() === 'mainFrame') {
      try {
        await frame.waitForSelector('.se-documentTitle, [contenteditable="true"]', { timeout: 5000 });
        console.log('  에디터: mainFrame iframe');
        return frame;
      } catch {}
    }
  }

  // 3순위: URL 패턴으로 iframe 탐색
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes('PostWriteForm') || url.includes('postwrite')) {
      console.log('  에디터: URL 패턴 iframe');
      return frame;
    }
  }

  console.log('  에디터: fallback (메인 페이지)');
  return page;
}

// 제목 입력 (SE3 정확한 셀렉터 + click→Ctrl+A→Delete→type)
async function inputTitle(ctx, title) {
  const sel = [
    '.se-documentTitle .se-text-paragraph',
    '.se-documentTitle [contenteditable="true"]',
    '.se-documentTitle',
    '.se-title-input',
  ].join(', ');

  const el = await ctx.waitForSelector(sel, { timeout: 8000 });
  await el.click();
  await ctx.waitForTimeout(300);
  await ctx.keyboard.press('Control+a');
  await ctx.keyboard.press('Delete');
  await ctx.waitForTimeout(200);
  await ctx.keyboard.type(title, { delay: 30 });
  return true;
}

// 본문 입력 — 제목 영역(.se-documentTitle)을 제외한 첫 번째 .se-text-paragraph 사용
async function inputContent(ctx, content) {
  // Python blog_uploader.py와 동일: title_el.contains(p) 체크로 제목 제외
  const bodyEl = await ctx.evaluateHandle(() => {
    const titleEl = document.querySelector('.se-documentTitle');
    const all = [...document.querySelectorAll('.se-text-paragraph')];
    return all.find(p => !(titleEl && titleEl.contains(p))) || null;
  });

  if (!bodyEl || !(await bodyEl.asElement())) {
    throw new Error('본문 입력 영역을 찾을 수 없습니다');
  }

  await bodyEl.click();
  await ctx.waitForTimeout(300);

  const paragraphs = content.split('\n\n');
  for (const para of paragraphs) {
    if (para.trim()) {
      await ctx.keyboard.type(para.trim(), { delay: 10 });
      await ctx.keyboard.press('Enter');
      await ctx.keyboard.press('Enter');
      await ctx.waitForTimeout(150);
    }
  }
  return true;
}

// 태그 입력 (SE3 정확한 셀렉터 포함)
async function inputTags(page, tags) {
  if (!tags?.length) return;
  try {
    const tagSelectors = ['.se-tag-input input', '.tag_input input', 'input[placeholder*="태그"]'];
    for (const sel of tagSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        for (const tag of tags) {
          await el.fill(tag);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(200);
        }
        return;
      }
    }
  } catch {}
}

// evaluateHandle로 요소를 찾고 Playwright ElementHandle.click()으로 클릭
// (JS 네이티브 .click()은 React 이벤트를 트리거하지 않음)
async function findAndPlaywrightClick(page, findFn) {
  const handle = await page.evaluateHandle(findFn);
  const el = handle.asElement();
  if (!el) return false;
  await el.click({ timeout: 5000 });
  return true;
}

// 발행 버튼 클릭 (2단계: 상단 발행 → 패널 확인 발행)
async function clickPublish(page) {
  const writeUrl = page.url();

  // 1차: 우측 상단 '발행' 버튼
  // evaluateHandle로 찾고 Playwright ElementHandle.click()으로 React 이벤트 트리거
  let clicked1 = false;

  // 전략 1: Playwright locator (regex)
  try {
    await page.locator('button').filter({ hasText: /^발행/ }).first().click({ force: true, timeout: 3000 });
    clicked1 = true;
  } catch {}

  // 전략 2: evaluateHandle + ElementHandle.click() — React 이벤트 정상 트리거
  if (!clicked1) {
    clicked1 = await findAndPlaywrightClick(page, () => {
      const all = [...document.querySelectorAll('button, a[role="button"]')];
      return all.find(e => {
        const txt = (e.textContent || '').trim();
        return txt.includes('발행') && !txt.includes('임시');
      }) || null;
    });
  }

  if (!clicked1) throw new Error('1차 발행 버튼을 찾을 수 없습니다');
  console.log('  1차 발행 버튼 클릭 완료');

  // 발행 설정 패널이 열릴 때까지 대기
  await page.waitForTimeout(3000);

  // 2차: 패널 내 '발행' 확인 버튼 (화면에서 가장 아래쪽 발행 버튼)
  // evaluateHandle로 찾고 Playwright ElementHandle.click()으로 클릭
  let clicked2 = false;

  // 전략 1: Playwright locator last
  try {
    await page.locator('button').filter({ hasText: /^발행/ }).last().click({ force: true, timeout: 3000 });
    clicked2 = true;
  } catch {}

  // 전략 2: evaluateHandle + 가장 아래 위치한 발행 버튼
  if (!clicked2) {
    clicked2 = await findAndPlaywrightClick(page, () => {
      const candidates = [...document.querySelectorAll('button, a[role="button"]')]
        .filter(e => {
          const txt = (e.textContent || '').trim();
          return txt.includes('발행') && !txt.includes('임시');
        });
      if (!candidates.length) return null;
      // y좌표가 가장 큰(화면 아래) 버튼 = 패널 확인 버튼
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return candidates[0];
    });
  }

  console.log(`  2차 발행 버튼 클릭: ${clicked2 ? '완료' : '실패(무시)'}`);
  await page.waitForTimeout(4000);

  const finalUrl = page.url();
  if (finalUrl === writeUrl) {
    console.log('  ⚠️  URL 미변경 - 발행이 완료되지 않았을 수 있습니다');
  }
}

// ─────────────────────────────────────────────
// 메인 export
// ─────────────────────────────────────────────
export async function postToNaverBlog({ title, content, tags = [], blogId }) {
  if (!blogId) throw new Error('NAVER_BLOG_ID 환경변수가 없습니다');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ko-KR'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ko-KR',
      viewport: { width: 1280, height: 900 },
    });

    await restoreCookies(context);
    const page = await context.newPage();

    // 로그인 확인
    const loggedIn = await isLoggedIn(context, page);
    if (!loggedIn) throw new Error('네이버 로그인 실패 - 쿠키가 만료됐을 수 있습니다');
    console.log('  ✅ 네이버 로그인 확인');

    // 블로그 글쓰기 페이지 이동
    await page.goto(WRITE_URL(blogId), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 에디터 컨텍스트 탐색 (SE3: 메인 DOM 직접 접근)
    const editorCtx = await findEditorContext(page);

    // 에디터 로드 완료 후 팝업 처리 (임시저장 팝업은 에디터 로드 후 나타남)
    await handleDraftPopup(page);
    await page.waitForTimeout(500);

    // 제목 입력
    await inputTitle(editorCtx, title);
    console.log('  ✅ 제목 입력 완료');
    await page.waitForTimeout(500);

    // 본문 입력
    await inputContent(editorCtx, content);
    console.log('  ✅ 본문 입력 완료');
    await page.waitForTimeout(500);

    // 태그 입력 (메인 페이지 기준)
    await inputTags(page, tags);

    // 발행 (메인 페이지 기준 2단계)
    await clickPublish(page);
    console.log('  ✅ 발행 완료');

    const finalUrl = page.url();
    return { success: true, url: finalUrl };

  } catch (err) {
    console.error('  ❌ 발행 오류:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}
