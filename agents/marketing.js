// 마케팅팀 에이전트 - 매일 오전 10시 실행
// 업종별 트렌드 키워드 발굴 → jblogzy 공식 채널용 콘텐츠 + 이미지 프롬프트 생성

import 'dotenv/config';
import { ask } from '../core/claude.js';
import { send, notifyStart, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'marketing';

const CAFE24_API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const CAFE24_API_KEY  = process.env.CAFE24_API_KEY;

async function isDeptEnabled() {
  try {
    const res  = await fetch(`${CAFE24_API_BASE}/get_setting.php?key=dept_enabled_marketing`, {
      headers: { 'X-Api-Key': CAFE24_API_KEY },
    });
    const json = await res.json();
    return json.value !== '0';
  } catch { return true; }
}

async function isMarketingAutoApproveEnabled() {
  try {
    const res = await fetch(
      `${CAFE24_API_BASE}/get_setting.php?key=marketing_auto_approve`,
      { headers: { 'X-Api-Key': CAFE24_API_KEY } },
    );
    const { value } = await res.json();
    return value === '1';
  } catch {
    return false;
  }
}

async function fetchMyDirectiveInstructions() {
  try {
    const res = await fetch(
      `${CAFE24_API_BASE}/api/get_active_directives.php?department=marketing`,
      { headers: { 'X-Api-Key': CAFE24_API_KEY } },
    );
    if (!res.ok) return '';
    const list = await res.json();
    return list
      .filter(d => d.my_instruction)
      .map(d => `[CEO 지시] ${d.title}: ${d.my_instruction}`)
      .join('\n');
  } catch { return ''; }
}

// sales.js와 동일한 18개 업종 (날짜 기반 3개 순환)
const SECTORS = [
  { name: '외식업 (맛집/카페)',            keywords: ['맛집 블로그', '카페 인테리어', '메뉴 소개'] },
  { name: '미용 (헤어/네일/속눈썹)',       keywords: ['헤어 스타일', '네일 아트', '속눈썹 연장'] },
  { name: '피트니스 (헬스/필라테스/요가)', keywords: ['다이어트 운동', '필라테스 효과', '요가 자세'] },
  { name: '병원/의원 (치과/한의원/피부과)',keywords: ['치과 후기', '한의원 다이어트', '피부과 시술'] },
  { name: '정형외과',                       keywords: ['허리디스크', '무릎통증', '도수치료'] },
  { name: '안과',                           keywords: ['라식 라섹', '드림렌즈', '시력교정'] },
  { name: '성형외과',                       keywords: ['쌍꺼풀 수술', '코성형', '지방흡입'] },
  { name: '교육 (학원/과외)',              keywords: ['영어학원 추천', '수학 과외', '입시 전략'] },
  { name: '반려동물 (동물병원/펫샵)',      keywords: ['강아지 미용', '반려동물 케어', '동물병원 후기'] },
  { name: '인테리어/시공',                 keywords: ['인테리어 시공', '홈리모델링', '인테리어 비용'] },
  { name: '부동산/공인중개사',             keywords: ['아파트 매물', '전세 계약', '부동산 투자'] },
  { name: '숙박업 (펜션/게스트하우스)',    keywords: ['펜션 추천', '제주 숙박', '가족 여행 숙소'] },
  { name: '자동차 (정비/세차)',            keywords: ['자동차 정비', '셀프세차', '차량 관리'] },
  { name: '사진관/스튜디오',              keywords: ['증명사진', '가족사진', '프로필 촬영'] },
  { name: '꽃집/화원',                    keywords: ['꽃다발 주문', '플라워 클래스', '꽃집 인테리어'] },
  { name: '건강/웰니스 (마사지/스파)',     keywords: ['마사지 효과', '스파 추천', '힐링 여행'] },
  { name: '의류/패션 (쇼핑몰)',           keywords: ['쇼핑몰 운영', '패션 블로그', '스타일링 팁'] },
  { name: '아동/육아 (키즈카페/유아교육)',keywords: ['키즈카페 추천', '유아 교육', '육아 일기'] },
];

function dayOfYearKST() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const start = new Date(kst.getFullYear(), 0, 0);
  return Math.floor((kst - start) / 86400000);
}

// 날짜 기반 3개 업종 순환 (18개 전체 커버, KST 기준)
function getTodaySectors() {
  const day = dayOfYearKST();
  return [0, 1, 2].map(i => SECTORS[(day * 3 + i) % SECTORS.length]);
}

async function generateBlogPost(sector, directiveContext) {
  const prompt = `당신은 jblogzy.com의 공식 마케팅 블로그 필진입니다.
jblogzy는 자영업자들이 AI로 5분 만에 고품질 네이버 블로그 포스팅을 만들 수 있도록 돕는 SaaS입니다.
${directiveContext ? `\n[CEO 지시 사항 — 최우선 반영]\n${directiveContext}\n` : ''}
아래 업종의 자영업자를 위한 jblogzy 홍보 블로그 포스팅 초안을 작성해주세요.

[대상 업종]
${sector.name}

[포함할 내용]
1. 이 업종 자영업자들이 블로그 마케팅 시 가장 자주 검색하는 핵심 키워드 3개 (이유 포함)
2. jblogzy를 활용해 이 업종 포스팅을 5분 만에 완성하는 실제 방법 (구체적 예시)
3. 실제 사용 사례처럼 느껴지는 성공 스토리 (가상이지만 현실적으로)
4. 무료 체험 안내로 마무리

[필수 규칙]
- "보장", "확정", "반드시 매출이 오른다" 같은 단언적 표현 절대 금지
- 신뢰감 있고 따뜻한 톤, 자영업자의 바쁜 일상을 공감하는 어조
- 제목 포함, 전체 800~1000자 분량
- 마크다운 형식으로 작성 (##, **굵게** 등 활용)`;

  return ask(prompt, 2500);
}

async function generateSnsCaption(sector) {
  const prompt = `jblogzy.com 인스타그램 공식 계정에 올릴 짧은 홍보 캡션을 작성해주세요.

[업종]: ${sector.name}
[핵심 키워드]: ${sector.keywords.join(', ')}

[요구사항]
- 첫 줄이 눈에 띄는 훅으로 시작 (예: "미용실 사장님, 포스팅에 지치셨나요?")
- 자영업자의 공감 포인트 → jblogzy 혜택 → 무료 체험 CTA
- 200자 이내, 해시태그 8개 포함
- "보장"이라는 단어 사용 금지`;

  return ask(prompt, 600);
}

async function generateImagePrompt(sector) {
  const prompt = `jblogzy.com 인스타그램 홍보 이미지를 AI로 생성할 프롬프트를 영어로 작성해주세요.

[업종]: ${sector.name}

[요구사항]
- 자영업자가 스마트폰이나 노트북으로 블로그 포스팅을 하는 모습
- 밝고 깔끔한 카페/스튜디오 배경
- 현대적이고 전문적인 느낌
- Midjourney 또는 DALL-E 3 호환 프롬프트
- 100단어 이내의 영어 프롬프트만 출력`;

  return ask(prompt, 300);
}

export async function run() {
  if (!await isDeptEnabled()) {
    console.log('[마케팅팀] 비활성화 상태 — 실행 건너뜀');
    return;
  }

  const todaySectors = getTodaySectors();
  console.log(`\n✍️  [마케팅팀] 오늘의 콘텐츠 생성 시작 - ${todaySectors.map(s => s.name).join(', ')}`);

  const autoApprove = await isMarketingAutoApproveEnabled();
  if (autoApprove) console.log('  → 자동 승인 모드 ON');

  const directiveContext = await fetchMyDirectiveInstructions();
  if (directiveContext) console.log(`  → CEO 지시 반영: ${directiveContext.slice(0, 80)}`);

  await notifyStart(DEPARTMENT, '일일 콘텐츠 생성');

  for (const sector of todaySectors) {
    console.log(`  → [${sector.name}] 처리 중...`);
    await send({ department: DEPARTMENT, task_type: '콘텐츠 생성', status: 'running',
      summary: `[${sector.name}] 블로그 포스팅 + SNS 캡션 생성 중...` });
    try {
      const [blogPost, snsCaption, imagePrompt] = await Promise.all([
        generateBlogPost(sector, directiveContext),
        generateSnsCaption(sector),
        generateImagePrompt(sector),
      ]);

      // 블로그 포스팅 초안 → 대시보드 승인 대기열에 저장
      const blogRes = await send({
        department:      DEPARTMENT,
        task_type:       '블로그 포스팅 초안 생성',
        status:          'completed',
        summary:         `[${sector.name}] 블로그 초안 생성 완료 - 승인 대기 중`,
        content_type:    'blog_post',
        content_title:   `[${sector.name}] jblogzy 활용법 - ${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
        content_body:    blogPost,
        image_prompt:    imagePrompt,
        target_platform: 'naver_blog',
        target_audience: sector.name,
      });
      if (autoApprove && blogRes?.content_queue_id) {
        await fetch(`${CAFE24_API_BASE}/auto_approve_marketing.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_API_KEY },
          body: JSON.stringify({ content_queue_id: blogRes.content_queue_id }),
        });
      }

      // 인스타 캡션 → 대시보드 승인 대기열에 저장
      const snsRes = await send({
        department:      DEPARTMENT,
        task_type:       'SNS 캡션 생성',
        status:          'completed',
        summary:         `[${sector.name}] 인스타 캡션 생성 완료 - 승인 대기 중`,
        content_type:    'sns_caption',
        content_title:   `[인스타] ${sector.name} 홍보 캡션`,
        content_body:    snsCaption,
        image_prompt:    imagePrompt,
        target_platform: 'instagram',
        target_audience: sector.name,
      });
      if (autoApprove && snsRes?.content_queue_id) {
        await fetch(`${CAFE24_API_BASE}/auto_approve_marketing.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_API_KEY },
          body: JSON.stringify({ content_queue_id: snsRes.content_queue_id }),
        });
      }

      console.log(`  ✅ [${sector.name}] 완료`);

    } catch (err) {
      console.error(`  ❌ [${sector.name}] 오류:`, err.message);
      await notifyError(DEPARTMENT, `콘텐츠 생성 (${sector.name})`, err);
    }

    // API 호출 간 간격 (1초)
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('✍️  [마케팅팀] 오늘 작업 완료\n');
}

// 직접 실행 시 (npm run marketing)
if (process.argv[1].endsWith('marketing.js')) {
  run().catch(console.error);
}
