# jblogzy AI 자동화 팀 - Claude Code 코딩 가이드라인

## 프로젝트 개요
jblogzy.com(네이버 블로그 자동화 SaaS)의 성장을 위한 AI 자동화 팀.
영업팀, 마케팅팀, 고객관리팀 3개 부서가 24시간 협업한다.

## 기술 스택
- 언어: Node.js (ESM, `type: "module"`)
- AI: Anthropic SDK (`@anthropic-ai/sdk`)
- 스케줄링: `node-cron`
- 이메일: `nodemailer` + Gmail SMTP
- 대시보드: PHP + MySQL (카페24)
- 환경변수: `dotenv`

## 코딩 규칙

### 에이전트 파일 구조
모든 에이전트는 다음 패턴을 따른다:
```js
// 1. 환경변수 로드
// 2. Claude 호출로 결과 생성
// 3. reporter.send()로 카페24 대시보드에 전송
// 4. 필요 시 이메일/SNS 발송
export async function run() { ... }
```

### 모델 선택 기준
- 단순 분류, 요약, 점수 계산: `claude-haiku-4-5-20251001` (속도·비용 우선)
- 블로그 글, 이메일 초안, 전략 기획: `claude-sonnet-4-6` (품질 우선)

### 마케팅 언어 규칙 (필수)
- **"보장", "확정", "100%" 같은 단언적 표현 금지**
- 자영업자의 실질적 시간 절약과 효율성을 신뢰감 있는 톤으로 강조
- 과장 광고 표현 대신 구체적인 사용 사례로 설득

### 보안
- API 키는 반드시 `.env`에서 로드, 코드에 하드코딩 금지
- 수집된 이메일은 공개 프로필에 직접 기재된 것만 사용
- 모든 발송 이메일에 수신거부 안내 문구 포함

### 에러 처리
- 에이전트 에러 발생 시 `reporter.send({ status: 'error', error_message: ... })`로 대시보드에 기록
- 프로세스 전체를 중단시키지 않고 해당 작업만 건너뜀

### reporter.send() 필드
```js
{
  department: 'sales' | 'marketing' | 'chm',
  task_type: string,          // 작업 유형 설명
  status: 'completed' | 'error',
  summary: string,            // 대시보드 피드에 표시될 한 줄 요약
  detail: string | object,    // 상세 결과
  content_url: string,        // 발행된 URL (있을 때)
  // 콘텐츠 저장 시 추가
  content_type: string,
  content_title: string,
  content_body: string,
  image_prompt: string,
  target_platform: string,
  target_audience: string,
  // 리드 저장 시 추가
  lead_industry: string,
  lead_platform: string,
  lead_contact: string,
  lead_source_url: string,
  lead_email_subject: string,
  lead_email_body: string,
}
```
