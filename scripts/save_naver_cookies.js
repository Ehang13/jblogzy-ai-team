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

console.log('로그인 완료를 기다리는 중... (최대 3분)');
console.log('→ 브라우저에서 로그인하세요. 완료되면 자동으로 쿠키를 저장합니다.\n');

// 3초마다 쿠키 상태 출력하면서 대기
let found = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  const cookies = await context.cookies(['https://www.naver.com', 'https://naver.com']);
  const names   = cookies.map(c => c.name);
  const hasAuth = names.includes('NID_AUT') || names.includes('NID_SES');
  console.log(`  [${i * 3}초] 쿠키: ${names.slice(0, 5).join(', ')} ${hasAuth ? '✅ 로그인 감지!' : ''}`);
  if (hasAuth) { found = true; break; }
}

if (!found) {
  console.error('로그인 시간 초과. 다시 시도하세요.');
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(2000);

const cookies = await context.cookies([
  'https://www.naver.com',
  'https://naver.com',
  'https://blog.naver.com',
]);

const minified = JSON.stringify(cookies);
const encoded  = Buffer.from(minified).toString('base64');
writeFileSync('naver_cookies.json', minified, 'utf-8');

console.log(`\n✅ 쿠키 ${cookies.length}개 저장 완료: naver_cookies.json`);
console.log('\n📋 GitHub Secret 등록용 base64 값 (이 값을 NAVER_COOKIES에 등록):');
console.log('─'.repeat(60));
console.log(encoded);
console.log('─'.repeat(60));
console.log('\n다음 단계:');
console.log('1. 위 base64 문자열을 복사');
console.log('2. GitHub 저장소 → Settings → Secrets → NAVER_COOKIES → Update');
console.log('   (또는 터미널에서 Claude Code가 자동 등록)');
console.log('3. NAVER_BLOG_ID secret도 확인 (네이버 블로그 아이디)');
console.log('\n⚠️  naver_cookies.json 파일은 .gitignore에 추가하세요.\n');

await browser.close();
