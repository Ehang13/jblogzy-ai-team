// 마케팅팀 에이전트 - 매일 오전 10시 실행
// 업종별 트렌드 키워드 발굴 → jblogzy 공식 채널용 콘텐츠 + 이미지 프롬프트 생성

import 'dotenv/config';
import { ask } from '../core/claude.js';
import { send, notifyStart, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'marketing';

// 오늘 분석할 자영업자 업종 (매일 로테이션)
const SECTORS = [
  { name: '지역 맛집/카페',    keywords: ['맛집 블로그', '카페 인테리어', '메뉴 개발'] },
  { name: '1인 미용실/네일샵', keywords: ['헤어 스타일 추천', '네일 아트', '펌 후기'] },
  { name: '필라테스/헬스장',   keywords: ['다이어트 운동', '필라테스 효과', '홈트레이닝'] },
  { name: '애견 미용/카페',    keywords: ['강아지 미용', '반려동물 카페', '펫 케어'] },
  { name: '인테리어/소품숍',   keywords: ['인테리어 소품', '홈데코 트렌드', '자개 가구'] },
];

// 오늘 날짜 기준으로 업종 순환 선택 (3개)
function getTodaySectors() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return [0, 1, 2].map(i => SECTORS[(dayOfYear + i) % SECTORS.length]);
}

async function generateBlogPost(sector) {
  const prompt = `당신은 jblogzy.com의 공식 마케팅 블로그 필진입니다.
jblogzy는 자영업자들이 AI로 5분 만에 고품질 네이버 블로그 포스팅을 만들 수 있도록 돕는 SaaS입니다.

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
  const todaySectors = getTodaySectors();
  console.log(`\n✍️  [마케팅팀] 오늘의 콘텐츠 생성 시작 - ${todaySectors.map(s => s.name).join(', ')}`);

  await notifyStart(DEPARTMENT, '일일 콘텐츠 생성');

  for (const sector of todaySectors) {
    console.log(`  → [${sector.name}] 처리 중...`);
    try {
      const [blogPost, snsCaption, imagePrompt] = await Promise.all([
        generateBlogPost(sector),
        generateSnsCaption(sector),
        generateImagePrompt(sector),
      ]);

      // 블로그 포스팅 초안 → 대시보드 승인 대기열에 저장
      await send({
        department:      DEPARTMENT,
        task_type:       '블로그 포스팅 초안 생성',
        status:          'completed',
        summary:         `[${sector.name}] 블로그 초안 생성 완료 - 승인 대기 중`,
        content_type:    'blog_post',
        content_title:   `[${sector.name}] jblogzy 활용법 - ${new Date().toLocaleDateString('ko-KR')}`,
        content_body:    blogPost,
        image_prompt:    imagePrompt,
        target_platform: 'naver_blog',
        target_audience: sector.name,
      });

      // 인스타 캡션 → 대시보드 승인 대기열에 저장
      await send({
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
