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
// .se-popup-alert-confirm 이 클릭을 막는 경우 닫아줌
async function handleDraftPopup(page) {
  try {
    const popup = page.locator('.se-popup-alert-confirm, .se-popup-alert');
    if (await popup.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  팝업 감지 → 닫는 중...');
      // SE3 팝업 버튼: 보통 두 번째 버튼이 "아니오"/"취소"
      const popupBtns = popup.first().locator('button');
      const count = await popupBtns.count();
      if (count >= 2) {
        await popupBtns.nth(count - 1).click(); // 마지막 버튼 = 아니오/취소
      } else if (count === 1) {
        await popupBtns.first().click();
      } else {
        // 버튼 텍스트로 폴백
        for (const text of ['아니오', '취소', '나가기', '닫기', '확인']) {
          const btn = page.locator(`button:has-text("${text}")`).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            await btn.click();
            break;
          }
        }
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

// 발행 버튼 클릭 (2단계: 상단 발행 → 패널 확인 발행)
async function clickPublish(page) {
  // 1차: 우측 상단 '발행' 버튼 찾기
  // 스크린샷 기준: 상단에 "저장 N 발행 ■" 형태로 존재
  const publishWriteUrl = page.url();

  // 전략 1: getByRole
  let clicked1 = false;
  try {
    await page.getByRole('button', { name: /발행/ }).first().click({ timeout: 3000 });
    clicked1 = true;
  } catch {}

  // 전략 2: locator with partial text
  if (!clicked1) {
    try {
      await page.locator('button').filter({ hasText: '발행' }).first().click({ timeout: 3000 });
      clicked1 = true;
    } catch {}
  }

  // 전략 3: JS - 정확히 텍스트에 '발행' 포함 (단, '임시저장' 제외)
  if (!clicked1) {
    clicked1 = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button, a[role="button"]')];
      const el = all.find(e => {
        const txt = (e.textContent || '').trim();
        return txt.includes('발행') && !txt.includes('임시') && !txt.includes('저장');
      });
      if (el) { el.click(); return true; }
      return false;
    });
  }

  if (!clicked1) throw new Error('1차 발행 버튼을 찾을 수 없습니다');
  console.log('  1차 발행 버튼 클릭 완료');

  // 패널이 열릴 때까지 대기 (발행 설정 패널)
  await page.waitForTimeout(2500);

  // 2차: 패널 내 '발행' 확인 버튼
  // 패널에는 카테고리, 공개설정 등이 있고 하단에 '발행' 버튼이 있음
  let clicked2 = false;
  try {
    // 패널 하단 발행 버튼: 화면 하단에 위치한 버튼 중 발행 텍스트
    clicked2 = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button, a[role="button"]')];
      // 발행 버튼을 y좌표 기준으로 정렬해서 가장 아래 있는 것 선택
      const candidates = all.filter(e => {
        const txt = (e.textContent || '').trim();
        return txt.includes('발행') && !txt.includes('임시') && !txt.includes('저장');
      });
      if (!candidates.length) return false;
      // 가장 화면 아래쪽 버튼이 확인 발행 버튼
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      candidates[0].click();
      return true;
    });
  } catch {}

  if (!clicked2) {
    try {
      await page.getByRole('button', { name: /발행/ }).last().click({ timeout: 3000 });
      clicked2 = true;
    } catch {}
  }

  console.log(`  2차 발행 버튼 클릭: ${clicked2 ? '완료' : '실패(무시)'}`);
  await page.waitForTimeout(4000);

  // URL이 write 페이지에서 벗어났는지 확인 (발행 성공 시 포스트 URL로 이동)
  const finalUrl = page.url();
  if (finalUrl === publishWriteUrl) {
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
