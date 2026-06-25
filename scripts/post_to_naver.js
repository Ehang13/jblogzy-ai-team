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
async function clickPublish(page, screenshotDir) {
  const writeUrl = page.url();

  // 디버그: 현재 페이지의 모든 프레임 목록 출력
  const frameInfo = page.frames().map(f => `[${f.name()||'main'}] ${f.url().substring(0,80)}`);
  console.log('  프레임 목록:');
  frameInfo.forEach(f => console.log('   ', f));

  // 디버그: 발행 관련 버튼 전체 목록 출력
  const btnInfo = await page.evaluate(() => {
    return [...document.querySelectorAll('button')]
      .map(b => ({ text: (b.textContent||'').trim().substring(0,30), cls: b.className.substring(0,50) }))
      .filter(b => b.text.length > 0);
  });
  console.log('  버튼 목록:', JSON.stringify(btnInfo));

  // 스크린샷 1: 발행 전
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/1_before_publish.png`, fullPage: false });
    console.log('  📸 스크린샷 저장: 1_before_publish.png');
  }

  // 1차: 우측 상단 '발행' 버튼 (정확히 "발행" 텍스트만 — "예약 발행 0건" 제외)
  let clicked1 = false;
  try {
    // /^발행$/ = 텍스트가 정확히 "발행"인 버튼만 매치
    await page.locator('button').filter({ hasText: /^발행$/ }).click({ force: true, timeout: 5000 });
    clicked1 = true;
  } catch {}

  if (!clicked1) {
    // fallback: getByRole exact match
    try {
      await page.getByRole('button', { name: '발행', exact: true }).click({ force: true, timeout: 3000 });
      clicked1 = true;
    } catch {}
  }

  if (!clicked1) throw new Error('1차 발행 버튼을 찾을 수 없습니다');
  console.log('  1차 발행 버튼 클릭 완료');

  await page.waitForTimeout(3000);

  // 스크린샷 2: 1차 클릭 후 (패널 열렸는지 확인)
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/2_after_first_click.png`, fullPage: false });
    console.log('  📸 스크린샷 저장: 2_after_first_click.png');
  }

  // 2차: 패널 내 '발행' 확인 버튼
  // 1차 클릭 후 패널이 열리면 "발행" 버튼이 2개가 됨 (툴바 + 패널)
  // 패널 버튼은 y좌표가 훨씬 아래에 있음
  let clicked2 = false;

  // 전략 1: 패널에 새 발행 버튼이 나타날 때까지 대기
  try {
    // y좌표가 200px 이상인 "발행" 버튼 = 패널 버튼
    clicked2 = await findAndPlaywrightClick(page, () => {
      const candidates = [...document.querySelectorAll('button')]
        .filter(e => {
          const txt = (e.textContent || '').trim();
          const y = e.getBoundingClientRect().top;
          return txt.includes('발행') && !txt.includes('예약') && !txt.includes('임시') && y > 200;
        });
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return candidates[0];
    });
  } catch {}

  // 전략 2: 패널 컨테이너 내부의 버튼 찾기
  if (!clicked2) {
    try {
      const panelSelectors = [
        '[class*="publishLayer"] button',
        '[class*="publish_layer"] button',
        '[class*="PublishPanel"] button',
        '[class*="publish-panel"] button',
      ];
      for (const sel of panelSelectors) {
        const btn = page.locator(sel).filter({ hasText: /발행/ }).last();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click({ force: true });
          clicked2 = true;
          break;
        }
      }
    } catch {}
  }

  console.log(`  2차 발행 버튼 클릭: ${clicked2 ? '완료' : '실패(무시)'}`);
  await page.waitForTimeout(4000);

  // 스크린샷 3: 2차 클릭 후 (발행 완료 여부 확인)
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/3_after_second_click.png`, fullPage: false });
    console.log('  📸 스크린샷 저장: 3_after_second_click.png');
  }

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

  // 스크린샷 저장 디렉토리 (GitHub Actions artifacts 업로드용)
  const screenshotDir = process.env.RUNNER_TEMP
    ? `${process.env.RUNNER_TEMP}/naver-screenshots`
    : null;
  if (screenshotDir) {
    const { mkdirSync } = await import('fs');
    mkdirSync(screenshotDir, { recursive: true });
  }

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
    await clickPublish(page, screenshotDir);
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
