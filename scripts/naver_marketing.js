// 네이버 마케팅 블로그 자동 발행
// GitHub Actions naver-blog.yml에서 하루 3회 실행
// 실행마다 1개 업종 선택 → 글 생성 → 네이버 블로그 발행

import 'dotenv/config';
import { ask } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import { postToNaverBlog } from './post_to_naver.js';
import { ALL_INDUSTRIES } from '../agents/sales.js';

const DEPT         = 'marketing';
const CAFE24_BASE  = (process.env.CAFE24_API_URL ?? '').replace('/report.php', '');
const CAFE24_KEY   = process.env.CAFE24_API_KEY ?? '';

async function fetchNaverAccount() {
  try {
    const res = await fetch(`${CAFE24_BASE}/get_naver_account.php`, {
      headers: { 'X-Api-Key': CAFE24_KEY },
    });
    const data = await res.json();
    return data.account ?? null;
  } catch { return null; }
}

async function reportAccountResult(id, success, error) {
  try {
    await fetch(`${CAFE24_BASE}/update_naver_account.php`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_KEY },
      body:    JSON.stringify({ id, success, error: error ?? null }),
    });
  } catch {}
}

// 하루 3회 실행 → 각 실행마다 다른 업종 (날짜 × 실행 시간으로 인덱스 결정)
function pickIndustry() {
  const now  = new Date();
  const day  = Math.floor((Date.now() - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const hour = now.getUTCHours(); // 0, 4, 9 UTC → 09, 13, 18 KST
  const slot = hour < 2 ? 0 : hour < 6 ? 1 : 2; // 3슬롯
  return ALL_INDUSTRIES[(day * 3 + slot) % ALL_INDUSTRIES.length];
}

async function generateNaverPost(industry) {
  const prompt = `당신은 jblogzy.com 공식 마케팅 블로그 필진입니다.
jblogzy는 자영업자가 AI로 5분 만에 네이버 블로그 포스팅을 완성할 수 있는 SaaS입니다.

[대상 업종]
${industry.name}

[포스팅 구성]
1. 훅 제목 (이 업종 자영업자가 검색할 법한 키워드 포함)
2. 공감 도입부: "${industry.painPoints}" 상황 묘사 2~3문장
3. jblogzy 활용법: 이 업종 포스팅을 5분 만에 완성하는 구체적 방법
4. 성공 사례 (업체명은 지어도 되지만 글 안에 "가상", "예시", "픽션" 등 단어 절대 금지, 수치 구체적)
5. 3일 무료 체험 CTA (jblogzy.com 링크)

[규칙]
- "보장", "반드시", "무조건" 금지
- 신뢰감 있는 톤, 자영업자 공감 어조
- 전체 900~1100자
- 마크다운 없이 순수 텍스트 (네이버 에디터 호환)
- 줄바꿈으로 단락 구분

출력 형식:
제목: [제목]
---
[본문]
---
태그: [태그1,태그2,태그3,태그4,태그5]`;

  const raw = await ask(prompt, 2000);
  return parsePost(raw);
}

function parsePost(raw) {
  const lines   = raw.split('\n');
  let title     = '';
  let body      = '';
  let tags      = [];
  let inBody    = false;
  let bodyLines = [];
  let inTags    = false;

  for (const line of lines) {
    if (!title && line.startsWith('제목:')) {
      title = line.replace('제목:', '').trim();
    } else if (line.includes('---') && !inBody) {
      inBody = true;
    } else if (line.includes('---') && inBody) {
      inBody = false;
      inTags = true;
    } else if (inBody) {
      bodyLines.push(line);
    } else if (inTags && line.startsWith('태그:')) {
      tags = line.replace('태그:', '').split(',').map(t => t.trim()).filter(Boolean);
    }
  }

  body = bodyLines.join('\n').trim();

  if (!title) title = '블로그 자동화로 마케팅 시간을 줄이는 방법';
  if (!body)  body  = raw.trim();
  if (!tags.length) tags = ['블로그자동화', 'jblogzy', '자영업마케팅', '네이버블로그', '블로그포스팅'];

  return { title, body, tags };
}

// ─────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────
console.log('\n📝 [네이버 마케팅] 자동 포스팅 시작');

// DB 계정 조회 (없으면 env 폴백)
const account = await fetchNaverAccount();
const BLOG_ID = account?.blog_id ?? process.env.NAVER_BLOG_ID;
const COOKIES = account?.cookies ?? null; // null이면 post_to_naver.js가 env 사용

if (!BLOG_ID) {
  console.error('NAVER_BLOG_ID 환경변수가 없고 DB 등록 계정도 없습니다');
  process.exit(1);
}
if (!COOKIES && !process.env.NAVER_COOKIES) {
  console.error('NAVER_COOKIES 환경변수가 없고 DB 등록 계정도 없습니다');
  process.exit(1);
}

if (account) console.log(`  계정: ${BLOG_ID} (DB 등록 계정)`);
else          console.log(`  계정: ${BLOG_ID} (env 폴백)`);

const industry = pickIndustry();
console.log(`  오늘 업종: ${industry.name}`);

try {
  // 1. 콘텐츠 생성
  console.log('  Claude로 포스팅 생성 중...');
  const { title, body, tags } = await generateNaverPost(industry);
  console.log(`  제목: ${title}`);

  // 2. 네이버 블로그 발행
  console.log('  네이버 블로그 발행 중...');
  const result = await postToNaverBlog({ title, content: body, tags, blogId: BLOG_ID, cookies: COOKIES });

  if (result.success) {
    if (account) await reportAccountResult(account.id, true, null);
    // 3. 카페24 대시보드 기록
    await send({
      department:      DEPT,
      task_type:       '네이버 블로그 발행',
      status:          'completed',
      summary:         `[${industry.name}] 네이버 블로그 포스팅 발행 완료`,
      content_type:    'naver_blog',
      content_title:   title,
      content_body:    body,
      target_platform: 'naver_blog',
      target_audience: industry.name,
      content_url:     result.url || '',
    });
    console.log(`\n✅ 발행 완료: ${result.url || '(URL 확인 필요)'}`);
  } else {
    if (account) await reportAccountResult(account.id, false, result.error);
    throw new Error(result.error);
  }

} catch (err) {
  console.error('  ❌ 오류:', err.message);
  await notifyError(DEPT, `네이버 블로그 발행 (${industry.name})`, err);
  process.exit(1);
}

console.log('📝 [네이버 마케팅] 완료\n');
