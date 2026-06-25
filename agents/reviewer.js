// 자체 감사 에이전트 - 매주 월요일 09:00 실행
// 전체 시스템 설계 + 7일 운영 통계를 Claude가 분석해 문제점·설계 의문점·개선 제안을 리포트
// 비용 발생 제안은 대시보드 승인 큐로 분리 전송

import 'dotenv/config';
import { ask } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import { sendMail } from '../core/mailer.js';
import { ALL_INDUSTRIES, ALL_REGIONS } from './sales.js';

const DEPARTMENT      = 'ceo';
const CAFE24_API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const CAFE24_API_KEY  = process.env.CAFE24_API_KEY;
const ADMIN_EMAIL     = process.env.SMTP_USER;

// 시스템 전체 설계 현황 — Claude가 설계 근거를 파악하고 의문을 제기하기 위한 컨텍스트
const SYSTEM_DESIGN = {
  영업팀: {
    총업종수: ALL_INDUSTRIES.length,
    실행당처리업종: ALL_INDUSTRIES.length,   // pickTodaysIndustries()가 전체 18개 반환
    업종당발굴리드수: 5,
    하루실행횟수: 4,                          // 08:00 / 12:00 / 16:00 / 20:00
    총지역수: ALL_REGIONS.length,
    지역단위: '구/시 단위 혼합 (예: 서울 강남구, 수원시)',
    지역순환방식: '날짜 기반 순환 (하루 1개 지역)',
    이메일유형: [
      'blogId@naver.com — 상태:pending (계정 존재 가능)',
      'blogId@gmail.com — 상태:guess (추정 주소, 실제 여부 불명)',
    ],
    업종목록: ALL_INDUSTRIES.map(i => i.name),
    지역목록: ALL_REGIONS,
  },
  마케팅팀: {
    총섹터수: 18,
    실행당섹터수: 3,      // 날짜 × 3 순환
    하루실행횟수: 1,      // 10:00
    플랫폼: '네이버 블로그',
    콘텐츠유형: '블로그 포스팅 초안',
    자동승인: '설정 가능 (marketing_auto_approve 토글)',
  },
  고객관리팀: {
    위험도기준: {
      HIGH: '70점 이상 → 즉시 발송',
      MEDIUM: '40~69점 + 구독 만료 7일 이내만 발송',
      LOW: '발송 안 함',
    },
    중복방지쿨다운: '30일 (같은 회원에게 30일 내 재발송 없음)',
    실행당최대회원수: 30,
    하루실행횟수: 1,      // 18:00
    이메일발송시간: '21:00 (승인된 건 10분 배치, 건당 90초 간격)',
    혜택정책: {
      MEDIUM: '다음 갱신 시 10% 할인',
      LOW: '지인 추천 시 추천인·피추천인 각 10% 혜택',
    },
  },
  자체감사: {
    실행주기: '매주 월요일 09:00',
    분석기간: '최근 7일',
    리포트발송: '대시보드(ceo탭) + 관리자 이메일',
  },
  현재없는부서: [
    '고객 피드백/후기 수집 에이전트',
    '경쟁사 모니터링 에이전트',
    '결제/구독 만료 예측 에이전트',
  ],
};

async function fetchAuditData() {
  const res = await fetch(`${CAFE24_API_BASE}/fetch_audit_data.php`, {
    headers: { 'X-Api-Key': CAFE24_API_KEY },
  });
  if (!res.ok) throw new Error(`감사 데이터 조회 실패: ${res.status}`);
  return res.json();
}

// Claude 응답에서 [비용발생: ...] 태그가 붙은 항목 추출
function extractCostProposals(reportText) {
  const proposals = [];
  // "- 제안 내용 [비용발생: 예상 규모]" 패턴 매칭
  const regex = /[-•]\s*(.+?)\[비용발생:\s*([^\]]+)\]/g;
  let m;
  while ((m = regex.exec(reportText)) !== null) {
    const title = m[1].replace(/\*\*/g, '').trim().slice(0, 100);
    const cost  = m[2].trim();
    // 제목 뒤의 설명 문장 수집 (최대 300자)
    const startIdx = m.index + m[0].length;
    const nextBullet = reportText.indexOf('\n-', startIdx);
    const desc = reportText.slice(startIdx, nextBullet > 0 ? nextBullet : startIdx + 300).trim();
    proposals.push({ title, cost, description: m[0].trim() + (desc ? '\n' + desc : '') });
  }
  return proposals;
}

async function submitProposal(proposal) {
  try {
    await fetch(`${CAFE24_API_BASE}/submit_proposal.php`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_API_KEY },
      body:    JSON.stringify({
        title:          proposal.title,
        description:    proposal.description,
        estimated_cost: proposal.cost,
      }),
    });
  } catch {
    // 제안 저장 실패는 전체 실행을 중단시키지 않음
  }
}

function mdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#93c5fd;margin-top:1em">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 style="color:#60a5fa;margin-top:1.2em">$2</h2>')
    .replace(/^# (.+)$/gm,   '<h1 style="color:#3b82f6">$1</h1>')
    .replace(/\n/g, '<br>');
}

export async function run() {
  console.log('\n🔍 [자체 감사] 주간 전체 시스템 분석 시작');

  let auditData;
  try {
    auditData = await fetchAuditData();
  } catch (err) {
    await notifyError(DEPARTMENT, '주간 자체 감사', err);
    return;
  }

  console.log(`  → 영업팀 ${auditData.sales.total_leads}건 / 마케팅 ${auditData.marketing.total_contents}건 / CHM ${auditData.chm.total_generated}건`);

  const report = await ask(`
당신은 jblogzy AI 자동화 팀의 수석 감사관입니다.
아래 두 가지를 종합해 주간 감사 리포트를 작성하세요:
(1) 시스템 설계 현황 — 각 에이전트가 무엇을 어떻게 하는지
(2) 지난 7일 실제 운영 통계

---
## 시스템 설계 현황
${JSON.stringify(SYSTEM_DESIGN, null, 2)}

## 지난 7일 운영 통계
${JSON.stringify(auditData, null, 2)}

---
## 리포트 작성 지침

아래 5개 섹션을 순서대로 작성하세요.

### 1. 운영 이상 징후
- 통계 수치에서 발견된 문제 (중복, 편중, 낮은 승인률 등)
- 이상 없으면 "이상 없음" 한 줄로 명시

### 2. 시스템 설계 의문점
- 설계 방식에 대한 "왜 이렇게?" 형태의 날카로운 질문
- 예: "영업팀이 매 실행(하루 4회)마다 18개 업종 전체를 처리한다 — 하루 최대 720건 발굴 시도. 실제 처리 가능한 이메일 발송 용량과 비교했을 때 과잉 생성이 아닌가?"
- 예: "지역이 하루 1개 지역으로만 고정된다면, 전국 ${ALL_REGIONS.length}개 지역을 모두 커버하는 데 ${ALL_REGIONS.length}일이 필요하다. 이 주기가 적절한가?"
- 예: "gmail.com guess 주소는 존재 여부를 확인하지 않고 발송한다. 반송률이 높아질수록 발신 도메인 평판이 떨어질 수 있지 않은가?"

### 3. 추가 부서/기능 필요 여부
- 현재 없는 기능 중 jblogzy 성장에 실질적으로 기여할 수 있는 것
- 각 제안에 예상 효과와 구현 복잡도를 명시

### 4. 비용 효율화 방안
- Claude API 호출 횟수, 이메일 발송량, GitHub Actions 실행 횟수 기준
- 현재 추정 비용 구조와 절감 가능 포인트

### 5. 개선 제안 목록
- 각 항목 앞에 반드시 아래 태그 중 하나를 붙일 것:
  - [무료] — 코드 수정만으로 가능
  - [비용발생: 월 X원 예상] — 추가 API, 서비스, 인프라 비용 발생
- 비용 규모가 불확실하면 "소액" / "중간" / "상당" 으로 표기

---
형식: 한국어, 실무 보고서 톤, 총 700자 내외
수치를 직접 인용할 것. 모호한 표현 금지.
`);

  console.log('\n📋 감사 리포트 생성 완료');

  // 비용 발생 제안 추출 → 승인 큐에 저장
  const costProposals = extractCostProposals(report);
  if (costProposals.length > 0) {
    console.log(`  → 비용 제안 ${costProposals.length}건 승인 큐에 저장`);
    for (const p of costProposals) {
      await submitProposal(p);
    }
  }

  // 대시보드 전송
  await send({
    department: DEPARTMENT,
    task_type:  '주간 자체 감사',
    status:     'completed',
    summary:    `주간 자체 감사 완료 — 영업 ${auditData.sales.total_leads}건 / 마케팅 ${auditData.marketing.total_contents}건 / CHM ${auditData.chm.total_generated}건 / 비용 제안 ${costProposals.length}건`,
    detail:     report,
  });

  // 관리자 이메일 발송
  if (ADMIN_EMAIL) {
    try {
      const costNote = costProposals.length > 0
        ? `<p style="background:#1e3a5f;padding:10px;border-radius:6px;margin-bottom:1em">⚠️ <strong>승인 대기 제안 ${costProposals.length}건</strong>이 대시보드에 등록되었습니다. 검토 후 승인해 주세요.</p>`
        : '';
      await sendMail({
        to:      ADMIN_EMAIL,
        subject: `[jblogzy AI팀] 주간 자체 감사 리포트`,
        html:    costNote + mdToHtml(report),
        text:    report,
      });
      console.log(`  → 이메일 발송 완료: ${ADMIN_EMAIL}`);
    } catch (e) {
      console.error('  → 이메일 발송 실패:', e.message);
    }
  }

  console.log('✅ [자체 감사] 완료\n');
}

// 직접 실행 지원
if (process.argv[1].endsWith('reviewer.js')) {
  run().catch(console.error);
}
