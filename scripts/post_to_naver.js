// 네이버 블로그 자동 발행 (Playwright + 쿠키 인증)
// export: postToNaverBlog({ title, content, tags, blogId })

import { chromium } from 'playwright';

const WRITE_URL = (id) => `https://blog.naver.com/${id}/postwrite`;

// 쿠키 복원
async function restoreCookies(context) {
  const raw = process.env.NAVER_COOKIES;
  if (!raw) throw new Error('NAVER_COOKIES 환경변수가 없습니다');
  const cookies = JSON.parse(raw);
  await context.addCookies(cookies);
}

// 로그인 상태 확인
async function isLoggedIn(page) {
  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
  return page.evaluate(() => document.cookie.includes('NID_AUT'));
}

// 작성 중 팝업 처리 (이전 임시저장 글 있을 때)
async function handleDraftPopup(page) {
  try {
    const btns = ['button:has-text("아니오")', 'button:has-text("취소")', 'button:has-text("나가기")'];
    for (const sel of btns) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(800);
        return;
      }
    }
  } catch {}
}

// 에디터 iframe 찾기 (SE3: mainFrame, SE2: se2_iframe 등)
async function findEditorFrame(page) {
  await page.waitForTimeout(3000);
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes('blog.naver.com') && url.includes('postwrite')) return frame;
    if (url.includes('editor') || url.includes('se.naver.com')) return frame;
  }
  // iframe이 없으면 메인 페이지에서 직접 처리
  return page;
}

// 제목 입력
async function inputTitle(frame, title) {
  const selectors = [
    '.se-title-input',
    '#title',
    '[placeholder*="제목"]',
    '.tit_input input',
    'input[name="subject"]',
  ];
  for (const sel of selectors) {
    try {
      const el = await frame.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.click();
        await el.fill('');
        await frame.keyboard.type(title, { delay: 30 });
        return true;
      }
    } catch {}
  }
  // contenteditable 폴백
  try {
    const el = await frame.locator('[contenteditable="true"]').first();
    await el.click();
    await frame.keyboard.type(title, { delay: 30 });
    return true;
  } catch {}
  return false;
}

// 본문 입력 (제목 다음 contenteditable 영역)
async function inputContent(frame, content) {
  // SE3: 본문 영역은 두 번째 contenteditable 또는 .se-content
  const selectors = [
    '.se-content',
    '.se-main-container',
    '.se-section-text',
    'div.se_textarea',
  ];
  for (const sel of selectors) {
    try {
      const el = await frame.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.click();
        await frame.waitForTimeout(500);
        // 줄바꿈 포함 텍스트 입력
        for (const line of content.split('\n')) {
          await frame.keyboard.type(line, { delay: 10 });
          await frame.keyboard.press('Enter');
        }
        return true;
      }
    } catch {}
  }
  // 폴백: Tab 이동 후 입력
  try {
    await frame.keyboard.press('Tab');
    await frame.waitForTimeout(300);
    for (const line of content.split('\n')) {
      await frame.keyboard.type(line, { delay: 10 });
      await frame.keyboard.press('Enter');
    }
    return true;
  } catch {}
  return false;
}

// 태그 입력
async function inputTags(page, tags) {
  if (!tags?.length) return;
  try {
    const tagSelectors = ['.tag_input input', '#tagsInput', 'input[placeholder*="태그"]'];
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

// 발행 버튼 클릭 (메인 페이지에서)
async function clickPublish(page) {
  // 메인 컨텍스트로 복귀
  await page.evaluate(() => {});

  // 1차 발행 버튼 클릭
  const clicked1 = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, .btn_submit, a.btn')];
    const btn = btns.find(el => {
      const txt = el.textContent?.trim();
      return txt === '발행' || txt === '포스트 발행';
    });
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!clicked1) {
    // CSS 선택자로 재시도
    try {
      await page.locator('button:has-text("발행")').first().click({ timeout: 3000 });
    } catch {
      throw new Error('발행 버튼을 찾을 수 없습니다');
    }
  }

  await page.waitForTimeout(2000);

  // 발행 설정 패널이 열리면 → 전체공개 확인 후 최종 발행
  const published = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    // 패널 내부의 확인/발행 버튼 (마지막 "발행" 텍스트 버튼)
    const candidates = btns.filter(b => {
      const txt = b.textContent?.trim();
      return txt === '발행' || txt === '확인' || txt === '포스트 발행';
    });
    if (candidates.length > 0) {
      candidates[candidates.length - 1].click();
      return true;
    }
    return false;
  });

  await page.waitForTimeout(3000);
  return published;
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

    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) throw new Error('네이버 로그인 실패 - 쿠키가 만료됐을 수 있습니다');
    console.log('  ✅ 네이버 로그인 확인');

    // 블로그 글쓰기 페이지 이동
    await page.goto(WRITE_URL(blogId), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await handleDraftPopup(page);

    // 에디터 iframe 진입
    const editorCtx = await findEditorFrame(page);

    // 제목 입력
    const titleOk = await inputTitle(editorCtx, title);
    if (!titleOk) throw new Error('제목 입력 실패');
    console.log('  ✅ 제목 입력 완료');
    await page.waitForTimeout(500);

    // 본문 입력
    const contentOk = await inputContent(editorCtx, content);
    if (!contentOk) throw new Error('본문 입력 실패');
    console.log('  ✅ 본문 입력 완료');
    await page.waitForTimeout(500);

    // 태그 입력
    await inputTags(page, tags);

    // 발행
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
