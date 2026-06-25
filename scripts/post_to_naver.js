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

// 본문 입력 (SE3 정확한 셀렉터 + 단락 단위 입력)
async function inputContent(ctx, content) {
  const sel = [
    '.se-component-content .se-text-paragraph',
    '.se-main-container .se-text-paragraph',
  ].join(', ');

  const el = await ctx.waitForSelector(sel, { timeout: 8000 });
  await el.click();
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

// JS로 "발행" 텍스트를 가진 요소를 DOM 전체에서 탐색해 클릭
async function jsClickByText(page, text) {
  return page.evaluate((t) => {
    const all = [...document.querySelectorAll('button, a, span, div')];
    // 정확히 일치하는 것 우선
    let el = all.find(e => (e.textContent || '').trim() === t);
    // 없으면 포함 검색
    if (!el) el = all.find(e => (e.textContent || '').trim().includes(t));
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, text);
}

// 발행 버튼 클릭 (default content, 2단계)
async function clickPublish(page) {
  // 1차: 우측 상단 '발행' 버튼 — 여러 전략 순차 시도
  let clicked1 = false;

  // 전략 1: getByRole
  try {
    await page.getByRole('button', { name: '발행' }).first().click({ timeout: 3000 });
    clicked1 = true;
  } catch {}

  // 전략 2: locator filter
  if (!clicked1) {
    try {
      await page.locator('button, a').filter({ hasText: /^발행$/ }).first().click({ timeout: 3000 });
      clicked1 = true;
    } catch {}
  }

  // 전략 3: JS DOM 전체 탐색
  if (!clicked1) {
    clicked1 = await jsClickByText(page, '발행');
  }

  if (!clicked1) throw new Error('1차 발행 버튼을 찾을 수 없습니다');

  // 발행 설정 패널 열릴 때까지 대기
  await page.waitForTimeout(2500);

  // 2차: 패널 내 확인 발행 버튼
  let clicked2 = false;

  try {
    const btns = page.locator('button, a').filter({ hasText: /^발행$/ });
    const count = await btns.count();
    if (count > 0) {
      await btns.nth(count - 1).click({ timeout: 3000 });
      clicked2 = true;
    }
  } catch {}

  if (!clicked2) {
    clicked2 = await jsClickByText(page, '발행');
  }

  await page.waitForTimeout(3000);
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
