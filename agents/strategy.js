// 전략기획팀 에이전트 - 매주 월요일 09:00 실행
// 비즈니스 현황 분석 → 목표 수립 → 부서별 KPI → 시스템 갭 파악 → 대시보드 리포트
// 비용 발생 제안은 승인 큐로 분리, 목표 미수립 시 목표 제안 → 승인 후 활성화

import 'dotenv/config';
import { ask } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import { sendMail } from '../core/mailer.js';
import { ALL_INDUSTRIES, ALL_REGIONS } from './sales.js';

const DEPARTMENT      = 'strategy';
const CAFE24_API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const CAFE24_API_KEY  = process.env.CAFE24_API_KEY;
const JBLOGZY_API_URL = process.env.JBLOGZY_API_URL;
const JBLOGZY_API_KEY = process.env.JBLOGZY_API_KEY;
const ADMIN_EMAIL     = process.env.SMTP_USER;

// ── 비즈니스 고정 컨텍스트 ───────────────────────────────────────────────
const BUSINESS = {
  서비스명: 'jblogzy.com',
  서비스설명: '자영업자 대상 네이버 블로그 AI 자동화 SaaS',
  운영형태: '1인 운영 (개발·운영·마케팅 모두 혼자)',
  출시상태: '정식 출시 완료',
  무료체험: '가입 후 3일 무료 (이후 유료 플랜 선택)',
  자동결제: '없음 (매월 수동 결제)',
  요금제: [
    { 이름: 'Basic',    월정액: 39000, 원고생성: '월 90회',  특이사항: '기본 기능' },
    { 이름: 'Premium',  월정액: 69000, 원고생성: '월 300회', 특이사항: '방문자 유입 품앗이·콘텐츠 플래너 포함, 인기 플랜' },
    { 이름: 'Business', 월정액: 79000, 원고생성: '월 600회', 특이사항: '다계정·전담 매니저·맞춤 세팅 지원' },
  ],
  주요기능: [
    '네이버 블로그 AI 글 생성 (음식리뷰/브랜딩/정보글 등)',
    '스케줄 자동 발행',
    'AI 브랜딩 플래너 (월간 콘텐츠 제목 자동 생성)',
    'AI 썸네일 자동 생성',
    '네이버 플레이스 URL → 가게 정보 자동 추출',
    '방문자 유입 품앗이 (Premium+)',
  ],
};

// ── AI 자동화 팀 설계 현황 ───────────────────────────────────────────────
const AI_TEAM = {
  영업팀: {
    역할: '네이버 플레이스에서 잠재 고객 발굴 → 이메일 초안 생성',
    총업종수: ALL_INDUSTRIES.length,
    하루실행횟수: 4,
    실행당처리업종: ALL_INDUSTRIES.length,
    업종당리드수: 5,
    총지역수: ALL_REGIONS.length,
    이메일유형: ['naver.com (pending)', 'gmail.com (guess — 추정 주소)'],
    현재문제점: '이메일 발송 후 답장 여부·전환 여부 추적 불가',
  },
  마케팅팀: {
    역할: '네이버 블로그에 jblogzy 홍보 포스팅 + SNS 캡션 생성',
    하루실행횟수: 1,
    실행당섹터수: 3,
    총섹터수: 18,
    현재문제점: '블로그 포스팅이 실제 검색 유입·가입 전환으로 이어지는지 측정 불가',
  },
  고객관리팀: {
    역할: '유료 회원 이탈 방지 리텐션 이메일 생성·발송',
    하루실행횟수: 1,
    위험도기준: { HIGH: '70점+', MEDIUM: '40~69점 + 만료 7일 이내', LOW: '미발송' },
    쿨다운: '30일',
    현재문제점: '유료 구독자 0명 → 사실상 미운영 상태. 3일 무료 체험 만료 전 전환 유도 기능 없음',
  },
  전략기획팀: {
    역할: '주간 시스템 전체 감사 + 목표 수립·추적 + 개선 제안',
    실행주기: '매주 월요일 09:00',
  },
};

// ── 목표 관련 ────────────────────────────────────────────────────────────
async function fetchActiveGoal() {
  try {
    const res  = await fetch(`${CAFE24_API_BASE}/get_setting.php?key=strategy_active_goal`, {
      headers: { 'X-Api-Key': CAFE24_API_KEY },
    });
    const data = await res.json();
    return data.value ? JSON.parse(data.value) : null;
  } catch {
    return null;
  }
}

// ── jblogzy 회원 현황 조회 ───────────────────────────────────────────────
async function fetchMemberStats() {
  try {
    const res = await fetch(JBLOGZY_API_URL, {
      headers: { 'X-Api-Key': JBLOGZY_API_KEY },
    });
    if (!res.ok) return null;
    const { members } = await res.json();
    const paid  = members.filter(m => m.sub_status === 'active').length;
    const trial = members.filter(m => m.sub_status === 'trialing').length;
    const total = members.length;
    return { total, paid, trial, expired: total - paid - trial };
  } catch {
    return null;
  }
}

// ── 운영 통계 조회 ────────────────────────────────────────────────────────
async function fetchAuditData() {
  const res = await fetch(`${CAFE24_API_BASE}/fetch_audit_data.php`, {
    headers: { 'X-Api-Key': CAFE24_API_KEY },
  });
  if (!res.ok) throw new Error(`감사 데이터 조회 실패: ${res.status}`);
  return res.json();
}

// ── [비용발생] 태그 항목 파싱 ────────────────────────────────────────────
function extractCostProposals(text) {
  const proposals = [];
  const regex = /[-•]\s*(.+?)\[비용발생:\s*([^\]]+)\]/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const title = m[1].replace(/\*\*/g, '').trim().slice(0, 100);
    const cost  = m[2].trim();
    const startIdx  = m.index + m[0].length;
    const nextBullet = text.indexOf('\n-', startIdx);
    const desc = text.slice(startIdx, nextBullet > 0 ? nextBullet : startIdx + 300).trim();
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
  } catch { /* 전체 실행 중단 없이 건너뜀 */ }
}

function mdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#93c5fd;margin-top:1em">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 style="color:#60a5fa;margin-top:1.2em">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 style="color:#3b82f6">$1</h1>')
    .replace(/\n/g, '<br>');
}

// ─────────────────────────────────────────────────────────────────────────
export async function run() {
  console.log('\n🔍 [전략기획팀] 주간 전략 분석 시작');

  const [auditData, memberStats, activeGoal] = await Promise.allSettled([
    fetchAuditData(),
    fetchMemberStats(),
    fetchActiveGoal(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  if (!auditData) {
    await notifyError(DEPARTMENT, '주간 전략 분석', new Error('운영 데이터 조회 실패'));
    return;
  }

  const members = memberStats ?? { total: '조회 실패', paid: 0, trial: 0, expired: 0 };
  const goal    = activeGoal;
  const isFirstRun = !goal;

  console.log(`  → 유료 ${members.paid}명 / 체험 ${members.trial}명 / 목표: ${goal ? goal.title : '미수립'}`);

  // ── Claude 프롬프트 ────────────────────────────────────────────────────
  const prompt = isFirstRun
    ? `
당신은 jblogzy의 전략기획 총괄 임원입니다.
아래 비즈니스 현황과 AI 자동화 팀 설계를 바탕으로 **최초 전략 계획서**를 작성하세요.

## 비즈니스 현황
${JSON.stringify(BUSINESS, null, 2)}

## AI 자동화 팀 현황
${JSON.stringify(AI_TEAM, null, 2)}

## 실제 회원 현황
${JSON.stringify(members, null, 2)}

## AI팀 지난 7일 운영 통계
${JSON.stringify(auditData, null, 2)}

---
## 작성 지침

### 1. 현황 진단
- 수치 기반으로 현재 상태 명확히 정리 (잘되고 있는 것 / 안 되고 있는 것)

### 2. 90일 목표 수립
- 현실적이고 구체적인 유료 구독자 수 목표 제시 (근거 포함)
- 월별 세부 마일스톤 (1개월차 / 2개월차 / 3개월차)
- 예상 월 매출 (모든 구독자가 Basic 기준 최소치)

### 3. 부서별 KPI (주간 기준)
- 영업팀 / 마케팅팀 / 고객관리팀 각각에 수치 목표 부여
- KPI가 달성되면 목표 달성 가능한지 논리적으로 연결

### 4. 즉시 개선이 필요한 시스템 갭 (우선순위 순)
- 현재 없는 기능 중 목표 달성에 가장 중요한 것들
- 각 항목에 [무료] 또는 [비용발생: 예상 규모] 태그 명시

### 5. 전략기획팀 자체 발전 계획
- 다음 4주간 전략기획팀이 스스로 개선할 항목

형식: 한국어, 경영 전략 보고서 톤, 800자 내외
`
    : `
당신은 jblogzy의 전략기획 총괄 임원입니다.
이번 주 진척도를 검토하고 전략을 조정하세요.

## 현재 목표
${JSON.stringify(goal, null, 2)}

## 실제 회원 현황
${JSON.stringify(members, null, 2)}

## 비즈니스 컨텍스트
${JSON.stringify(BUSINESS, null, 2)}

## AI팀 지난 7일 운영 통계
${JSON.stringify(auditData, null, 2)}

## AI팀 설계 현황
${JSON.stringify(AI_TEAM, null, 2)}

---
## 작성 지침

### 1. 이번 주 진척도
- 목표 대비 실제 수치 비교 (달성률 %)
- 잘된 점 / 미흡한 점

### 2. 이탈 위험 신호
- 목표 달성 경로에서 벗어나는 징후 (있을 경우)

### 3. 이번 주 전술 조정
- 각 부서에 이번 주 특별히 집중해야 할 것

### 4. 개선 제안
- [무료] 또는 [비용발생: 예상 규모] 태그 필수

형식: 한국어, 600자 내외, 수치 직접 인용
`;

  const report = await ask(prompt);
  console.log(`  → ${isFirstRun ? '최초 전략 계획서' : '주간 진척도 리포트'} 생성 완료`);

  // 비용 제안 추출 → 승인 큐
  const costProposals = extractCostProposals(report);
  for (const p of costProposals) await submitProposal(p);

  // 최초 실행 시: 목표를 '제안' 상태로 설정값 저장 (관리자 확인 후 직접 활성화)
  if (isFirstRun) {
    const goalMatch = report.match(/(\d+)명.*?(\d+)일|(\d+)명.*?(3개월|90일)/);
    const proposed  = {
      title:    '90일 목표 (전략기획팀 수립)',
      source:   '아래 전략 계획서 참고',
      status:   'proposed',
      created:  new Date().toISOString(),
    };
    await fetch(`${CAFE24_API_BASE}/set_setting.php`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: 'strategy_active_goal', value: JSON.stringify(proposed) }),
    }).catch(() => {});
  }

  const taskType = isFirstRun ? '최초 전략 계획 수립' : '주간 전략 진척도 검토';

  await send({
    department: DEPARTMENT,
    task_type:  taskType,
    status:     'completed',
    summary:    `${taskType} 완료 — 유료 ${members.paid}명 / 체험 ${members.trial}명${costProposals.length > 0 ? ` / 비용 제안 ${costProposals.length}건` : ''}`,
    detail:     report,
  });

  if (ADMIN_EMAIL) {
    const isFirst = isFirstRun;
    const costNote = costProposals.length > 0
      ? `<p style="background:#1e3a5f;padding:10px;border-radius:6px;margin-bottom:1em">⚠️ 승인 대기 제안 ${costProposals.length}건이 대시보드에 등록됐습니다.</p>`
      : '';
    await sendMail({
      to:      ADMIN_EMAIL,
      subject: `[jblogzy 전략기획팀] ${isFirst ? '최초 전략 계획서' : '주간 진척도 리포트'}`,
      html:    costNote + mdToHtml(report),
      text:    report,
    }).catch(e => console.error('  → 이메일 발송 실패:', e.message));
  }

  console.log('✅ [전략기획팀] 완료\n');
}

if (process.argv[1].endsWith('strategy.js')) {
  run().catch(console.error);
}
