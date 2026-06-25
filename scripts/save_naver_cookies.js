// 네이버 쿠키 저장 도구 (로컬에서 한 번만 실행)
// 실행: node scripts/save_naver_cookies.js
// 브라우저가 열리면 네이버에 로그인 → 자동 감지 후 naver_cookies.json 저장

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

console.log('\n🍪 네이버 쿠키 저장 도구');
console.log('브라우저가 열리면 네이버에 로그인하세요.\n');

const browser = await chromium.launch({
  headless: false,
  args: ['--lang=ko-KR'],
});

const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'ko-KR',
});

const page = await context.newPage();
await page.goto('https://nid.naver.com/nidlogin.login');

console.log('로그인 완료를 기다리는 중... (최대 2분)');

// NID_AUT 쿠키가 생길 때까지 대기 (로그인 완료 신호)
await page.waitForFunction(
  () => document.cookie.includes('NID_AUT'),
  { timeout: 120_000 }
).catch(() => {
  console.error('로그인 시간 초과. 다시 시도하세요.');
  process.exit(1);
});

await page.waitForTimeout(2000);

const cookies = await context.cookies([
  'https://www.naver.com',
  'https://naver.com',
  'https://blog.naver.com',
]);

const output = JSON.stringify(cookies, null, 2);
writeFileSync('naver_cookies.json', output, 'utf-8');

console.log(`\n✅ 쿠키 ${cookies.length}개 저장 완료: naver_cookies.json`);
console.log('\n다음 단계:');
console.log('1. GitHub 저장소 → Settings → Secrets → New repository secret');
console.log('   Name:  NAVER_COOKIES');
console.log('   Value: naver_cookies.json 파일 내용 전체 (JSON 그대로)');
console.log('2. NAVER_BLOG_ID secret도 추가 (네이버 블로그 아이디)');
console.log('\n⚠️  naver_cookies.json 파일은 .gitignore에 추가하세요.\n');

await browser.close();
