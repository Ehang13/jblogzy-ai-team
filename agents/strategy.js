// 전략기획팀 에이전트 - 매주 월요일 09:00 실행
// 비즈니스 현황 분석 → 목표 수립 → 부서별 KPI → 시스템 갭 파악 → 대시보드 리포트
// 비용 발생 제안은 승인 큐로 분리, 목표 미수립 시 목표 제안 → 승인 후 활성화

import 'dotenv/config';
import { execSync }                   from 'child_process';
import { writeFileSync }              from 'fs';
import { ask, askJson }               from '../core/claude.js';
import { send, notifyError }          from '../core/reporter.js';
import { sendMail }                   from '../core/mailer.js';
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

// ── GitHub Actions 워크플로우 실행 통계 ──────────────────────────────────
async function fetchWorkflowStats() {
  if (!process.env.GITHUB_ACTIONS) return null;
  try {
    const raw  = execSync(
      'gh run list --limit=28 --json workflowName,durationMs,conclusion',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const runs = JSON.parse(raw);
    const stats = {};
    for (const run of runs) {
      const name = run.workflowName;
      if (!stats[name]) stats[name] = { count: 0, totalMs: 0, errors: 0 };
      stats[name].count++;
      if (run.durationMs) stats[name].totalMs += run.durationMs;
      if (run.conclusion === 'failure') stats[name].errors++;
    }
    return Object.entries(stats).map(([name, s]) => ({
      워크플로우: name,
      평균소요분: Math.round(s.totalMs / s.count / 60000),
      에러율: `${Math.round((s.errors / s.count) * 100)}%`,
      샘플수: s.count,
    }));
  } catch {
    return null;
  }
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

// ── 자율 코드 개발 (GitHub Actions 전용) ────────────────────────────────
async function developFeature(weeklyReport) {
  if (!process.env.GITHUB_ACTIONS) {
    console.log('  → 자율 개발: GitHub Actions 환경에서만 실행');
    return null;
  }

  console.log('  → 자율 개발: 구현 기능 선택 중...');

  // Step 1: Claude가 구현할 기능 1개 결정
  const plan = await askJson(`
## 이번 주 전략 감사 결과
${weeklyReport}

## 이미 구현된 기능
- 유료 회원 이탈 위험도 분석 + 리텐션 이메일 (agents/chm.js)
- 3일 무료 체험 전환 이메일 D+1 온보딩, D+2 전환 유도 (agents/chm.js)
- 네이버 플레이스 리드 발굴 + 이메일 초안 자동 생성 (agents/sales.js)
- 마케팅 블로그 자동 포스팅 + SNS 캡션 (agents/marketing.js)
- 주간 전략 감사 리포트 + 비용 제안 승인 큐 (agents/strategy.js)

## 구현 가능한 갭 예시 (자유롭게 제안 가능)

### 기능 갭
- 체험 만료 후 재가입 유도 이메일 (만료 3일 후 한 번) → agents/trial-reengagement.js
- 영업팀 업종별 리드 품질 분석 리포트 (주간) → agents/lead-quality-report.js
- CHM 회원 위험도 재계산 + settings 업데이트
- 마케팅 섹터별 포스팅 빈도 균형 모니터링

### 시스템 갭
- 특정 부서가 평균 실행시간 2배 초과 시 관리자 알림 → agents/workflow-monitor.js
- 에러율 높은 워크플로우 자동 재시도 로직 → .github/workflows/*.yml 수정
- 영업팀 중복 실행 감지 및 방지 (concurrency 그룹) → .github/workflows/sales.yml 수정
- 실행 시간 추적 및 대시보드 기록 → agents/perf-tracker.js

## 제약
- Node.js ESM, 기존 테이블만 (content_queue, leads, settings, agent_tasks)
- 새 외부 API 없이 구현 가능한 것
- 단일 파일로 완성

구현할 기능 1가지를 골라 JSON으로 답해:
{
  "title": "기능명 (40자 이내)",
  "description": "기능 상세 설명과 동작 방식",
  "target_file": "파일 경로 (agents/*.js 또는 .github/workflows/*.yml)",
  "rationale": "이 기능을 선택한 이유와 기대 효과"
}
`);

  if (!plan?.title || !plan?.target_file) {
    console.log('  → 자율 개발: 적합한 구현 대상 없음');
    return null;
  }

  console.log(`  → 자율 개발: "${plan.title}" 구현 시작`);

  // Step 2: 코드 생성
  const codeRaw = await ask(`다음 기능을 Node.js ESM으로 구현하세요.

## 기능 명세
제목: ${plan.title}
설명: ${plan.description}
파일: ${plan.target_file}

## 필수 코드 패턴

\`\`\`js
import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
// ask(prompt, maxTokens?) → string (Sonnet, 고품질)
// askFast(prompt, maxTokens?) → string (Haiku, 빠름·저비용)
// askJson(prompt, fast?) → JSON object

import { send, notifyError } from '../core/reporter.js';
// send({ department, task_type, status: 'completed'|'error', summary, detail, ... })

// jblogzy 회원 조회
const { members } = await (await fetch(process.env.JBLOGZY_API_URL,
  { headers: { 'X-Api-Key': process.env.JBLOGZY_API_KEY } })).json();

// 카페24 API
const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const KEY  = process.env.CAFE24_API_KEY;

const DEPARTMENT = 'chm'; // sales / marketing / chm / strategy

export async function run() { ... }
if (process.argv[1].endsWith('파일명.js')) run().catch(console.error);
\`\`\`

## 규칙
- "보장", "확정", "100%" 단언적 표현 금지
- 이메일 발송 시 수신거부 안내 문구 포함
- 에러 발생 시 notifyError() 호출, 프로세스 중단 없이 해당 항목 건너뜀

전체 파일 코드만 출력 (설명 없이):
\`\`\`js
[코드]
\`\`\``, 4000);

  const codeMatch = codeRaw.match(/```(?:js|javascript)?\n([\s\S]+?)\n```/);
  if (!codeMatch) {
    console.log('  → 자율 개발: 코드 블록 파싱 실패');
    return null;
  }
  const code = codeMatch[1].trim();

  // Step 3: 브랜치 생성 → 파일 작성 → 커밋 → PR
  try {
    execSync('git config user.name "전략기획팀 AI"',   { stdio: 'pipe' });
    execSync('git config user.email "ai@jblogzy.com"', { stdio: 'pipe' });

    const slug   = Date.now().toString(36);
    const branch = `strategy/auto-${new Date().toISOString().slice(0, 10)}-${slug}`;

    execSync(`git checkout -b ${branch}`, { stdio: 'pipe' });
    writeFileSync(plan.target_file, code, 'utf8');
    execSync(`git add "${plan.target_file}"`, { stdio: 'pipe' });
    execSync(`git commit -m "feat: ${plan.title} (전략기획팀 자율 구현)"`, { stdio: 'pipe' });
    execSync(`git push origin ${branch}`, { stdio: 'pipe' });

    const prBody = [
      '## 전략기획팀 자율 개발 PR',
      '',
      `**기능**: ${plan.title}`,
      '',
      `**선택 이유**: ${plan.rationale}`,
      '',
      `**기능 설명**: ${plan.description}`,
      '',
      '---',
      '> 이 PR은 전략기획팀 AI가 자율적으로 생성했습니다. **반드시 코드 리뷰 후 머지**해주세요.',
    ].join('\n');

    writeFileSync('/tmp/strategy-pr-body.md', prBody, 'utf8');

    const prUrl = execSync(
      `gh pr create --title "[전략기획팀] ${plan.title}" --body-file /tmp/strategy-pr-body.md --base main`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    console.log(`  → PR 생성: ${prUrl}`);
    return { title: plan.title, rationale: plan.rationale, prUrl };

  } catch (err) {
    console.error('  → 자율 개발 Git/PR 오류:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
export async function run() {
  const isMonday = new Date().getUTCDay() === 1; // UTC 월요일 = KST 월요일 09:00

  console.log(`\n🔍 [전략기획팀] ${isMonday ? '주간 전략 분석' : '일일 현황 점검'} 시작`);

  const [auditData, memberStats, activeGoal, workflowStats] = await Promise.allSettled([
    fetchAuditData(),
    fetchMemberStats(),
    fetchActiveGoal(),
    fetchWorkflowStats(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

  if (!auditData) {
    await notifyError(DEPARTMENT, isMonday ? '주간 전략 분석' : '일일 현황 점검', new Error('운영 데이터 조회 실패'));
    return;
  }

  const members = memberStats ?? { total: '조회 실패', paid: 0, trial: 0, expired: 0 };
  const goal    = activeGoal;
  const isFirstRun = !goal;

  console.log(`  → 유료 ${members.paid}명 / 체험 ${members.trial}명`);

  // ── 평일: 일일 현황 점검 (Haiku, 빠름) ──────────────────────────────
  if (!isMonday) {
    const quickSummary = await ask(`
오늘 jblogzy AI팀 운영 결과를 간략히 점검하세요 (150자 이내).

회원현황: 유료 ${members.paid}명 / 체험 ${members.trial}명
오늘 통계: ${JSON.stringify(auditData)}

판단:
- 🔴 즉시 보고 필요: 에러 다수, 리드 0건, 이메일 발송 실패 등
- 🟢 정상: 별다른 이슈 없음

상태 이모지 + 한 줄 요약만 출력.
`, 200);

    const isCritical = quickSummary.includes('🔴');
    await send({
      department: DEPARTMENT,
      task_type:  '일일 현황 점검',
      status:     'completed',
      summary:    quickSummary.trim(),
    });

    if (isCritical && ADMIN_EMAIL) {
      await sendMail({
        to:      ADMIN_EMAIL,
        subject: '[긴급] jblogzy AI팀 이상 감지',
        html:    mdToHtml(quickSummary),
        text:    quickSummary,
      }).catch(e => console.error('  → 이메일 발송 실패:', e.message));
    }

    console.log(`✅ [전략기획팀] 일일 점검 완료: ${quickSummary.slice(0, 60)}\n`);
    return;
  }

  // ── 이하 월요일 전체 분석 ─────────────────────────────────────────────

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

## GitHub Actions 실행 통계 (최근 28회)
${workflowStats ? JSON.stringify(workflowStats, null, 2) : '데이터 없음'}

## 현재 실행 구조
- 조간 번들(09:00 KST): 영업/마케팅/고객관리 병렬 동시 실행 → 전체 완료 후 전략기획팀 실행
- 영업팀 추가 실행: 12:00, 16:00, 20:00 KST

---
## 작성 지침

### 1. 이번 주 진척도
- 목표 대비 실제 수치 비교 (달성률 %)
- 잘된 점 / 미흡한 점

### 2. 이탈 위험 신호
- 목표 달성 경로에서 벗어나는 징후 (있을 경우)

### 3. 이번 주 전술 조정
- 각 부서에 이번 주 특별히 집중해야 할 것

### 4. 시스템 효율성 검토
- 부서별 평균 실행시간 중 이상치(평균 2배+)가 있는가
- 에러율이 높은 워크플로우가 있는가
- 현재 실행 구조에서 병목·중복·낭비가 있는가
- 개선 가능한 구조적 변경 제안 (실행 순서, 병렬화, 불필요 중복 제거 등)

### 5. 기능/시스템 개선 제안
- [무료] 또는 [비용발생: 예상 규모] 태그 필수

형식: 한국어, 800자 내외, 수치 직접 인용
`;

  const report = await ask(prompt);
  console.log(`  → ${isFirstRun ? '최초 전략 계획서' : '주간 진척도 리포트'} 생성 완료`);

  // 비용 제안 추출 → 승인 큐
  const costProposals = extractCostProposals(report);
  for (const p of costProposals) await submitProposal(p);

  // 자율 코드 개발 → GitHub PR
  const devResult = await developFeature(report);

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

  const devNote  = devResult ? ` / 자율 개발 PR 1건` : '';
  await send({
    department: DEPARTMENT,
    task_type:  taskType,
    status:     'completed',
    summary:    `${taskType} 완료 — 유료 ${members.paid}명 / 체험 ${members.trial}명${costProposals.length > 0 ? ` / 비용 제안 ${costProposals.length}건` : ''}${devNote}`,
    detail:     report + (devResult ? `\n\n---\n🛠 자율 개발 PR: ${devResult.prUrl}` : ''),
  });

  if (ADMIN_EMAIL) {
    const costNote = costProposals.length > 0
      ? `<p style="background:#1e3a5f;padding:10px;border-radius:6px;margin-bottom:1em">⚠️ 승인 대기 제안 ${costProposals.length}건이 대시보드에 등록됐습니다.</p>`
      : '';
    const prNote = devResult
      ? `<p style="background:#1a2e1a;padding:10px;border-radius:6px;margin-bottom:1em">🛠 <strong>자율 개발 PR 생성됨</strong>: <a href="${devResult.prUrl}" style="color:#4ade80">${devResult.title}</a><br><small>${devResult.rationale}</small></p>`
      : '';
    await sendMail({
      to:      ADMIN_EMAIL,
      subject: `[jblogzy 전략기획팀] ${isFirstRun ? '최초 전략 계획서' : '주간 진척도 리포트'}${devResult ? ' + 자율 개발 PR' : ''}`,
      html:    costNote + prNote + mdToHtml(report),
      text:    report + (devResult ? `\n\n자율 개발 PR: ${devResult.prUrl}` : ''),
    }).catch(e => console.error('  → 이메일 발송 실패:', e.message));
  }

  console.log('✅ [전략기획팀] 완료\n');
}

if (process.argv[1].endsWith('strategy.js')) {
  run().catch(console.error);
}
