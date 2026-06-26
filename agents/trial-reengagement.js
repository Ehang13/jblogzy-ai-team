import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';
const TASK_TYPE = 'trial_reengagement';

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchMembers() {
  const res = await fetch(process.env.JBLOGZY_API_URL, {
    headers: { 'X-Api-Key': process.env.JBLOGZY_API_KEY },
  });
  if (!res.ok) throw new Error(`jblogzy API error: ${res.status}`);
  const { members } = await res.json();
  return members ?? [];
}

async function fetchSettings() {
  const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
  const KEY  = process.env.CAFE24_API_KEY;

  const res = await fetch(`${BASE}/api/settings?status=trial_expired&converted=false`, {
    headers: { 'X-Api-Key': KEY },
  });
  if (!res.ok) throw new Error(`settings API error: ${res.status}`);
  const json = await res.json();
  return json.settings ?? [];
}

async function fetchAgentTasks(userId) {
  const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
  const KEY  = process.env.CAFE24_API_KEY;

  const res = await fetch(
    `${BASE}/api/agent_tasks?user_id=${encodeURIComponent(userId)}&task_type=${TASK_TYPE}`,
    { headers: { 'X-Api-Key': KEY } },
  );
  if (!res.ok) throw new Error(`agent_tasks fetch error: ${res.status}`);
  const json = await res.json();
  return json.tasks ?? [];
}

async function recordAgentTask({ userId, status, sentAt }) {
  const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
  const KEY  = process.env.CAFE24_API_KEY;

  const res = await fetch(`${BASE}/api/agent_tasks`, {
    method: 'POST',
    headers: {
      'X-Api-Key': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: userId,
      task_type: TASK_TYPE,
      status,
      sent_at: sentAt,
    }),
  });
  if (!res.ok) throw new Error(`agent_tasks record error: ${res.status}`);
  return res.json();
}

async function sendEmail({ to, subject, html }) {
  const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
  const KEY  = process.env.CAFE24_API_KEY;

  const res = await fetch(`${BASE}/api/email/send`, {
    method: 'POST',
    headers: {
      'X-Api-Key': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, subject, html }),
  });
  if (!res.ok) throw new Error(`email send error: ${res.status}`);
  return res.json();
}

function daysSince(dateStr) {
  const expired = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - expired) / (1000 * 60 * 60 * 24));
}

// ── email template ────────────────────────────────────────────────────────────

async function buildEmailContent({ member, setting }) {
  const activitySummary = setting.activity_summary
    ?? `서비스를 이용해 주신 ${setting.trial_days ?? 3}일 동안의 활동 내역`;

  const prompt = `
당신은 SaaS 서비스의 고객 성공 매니저입니다.
3일 무료 체험이 만료된 후 아직 유료 전환을 하지 않은 사용자에게 보낼 재가입 유도 이메일을 작성해 주세요.

[사용자 정보]
- 이름: ${member?.name ?? setting.user_name ?? '고객'}
- 이메일: ${setting.email}
- 체험 만료일: ${setting.trial_expired_at}
- 체험 중 활동 요약: ${activitySummary}

[작성 지침]
1. 따뜻하고 개인적인 톤으로 작성
2. 체험 기간 동안의 주요 활동을 구체적으로 언급
3. 한정 할인 코드 "COMEBACK30" (30% 할인, 7일 내 유효) 포함
4. 서비스의 핵심 가치 2~3가지 간결하게 소개
5. 명확한 CTA(혜택 받기 버튼) 포함
6. "보장", "확정", "100%" 등의 단언적 표현 사용 금지
7. HTML 형식으로 작성 (인라인 스타일 포함, 깔끔한 디자인)
8. 마지막에 반드시 수신거부 안내 문구 포함: "이 이메일은 서비스 이용 약관에 따라 발송되었습니다. 더 이상 이메일을 받지 않으시려면 <a href='{unsubscribe_link}'>수신거부</a>를 클릭해 주세요."
9. 결과는 JSON으로: { "subject": "이메일 제목", "html": "HTML 본문" }

JSON만 출력하세요.
`;

  const result = await askJson(prompt, false);
  return result;
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function run() {
  const startedAt = new Date().toISOString();
  const results = { processed: 0, sent: 0, skipped_duplicate: 0, skipped_too_early: 0, errors: 0 };
  const logs = [];

  let settings = [];
  let members = [];

  try {
    [settings, members] = await Promise.all([fetchSettings(), fetchMembers()]);
  } catch (err) {
    await notifyError(err, { context: 'trial-reengagement: initial data fetch' });
    await send({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      status: 'error',
      summary: '초기 데이터 조회 실패로 에이전트 중단',
      detail: err.message,
    });
    return;
  }

  const memberMap = Object.fromEntries(members.map((m) => [m.id ?? m.user_id, m]));

  for (const setting of settings) {
    const userId = setting.user_id ?? setting.id;
    const userLabel = `user_id=${userId}`;

    results.processed++;

    try {
      // 1) 중복 발송 방지 체크
      const existingTasks = await fetchAgentTasks(userId);
      const alreadySent = existingTasks.some(
        (t) => t.task_type === TASK_TYPE && t.status === 'sent',
      );
      if (alreadySent) {
        results.skipped_duplicate++;
        logs.push({ userId, reason: 'duplicate', status: 'skipped' });
        continue;
      }

      // 2) 만료일 기준 3일 경과 여부 확인
      const expired = setting.trial_expired_at ?? setting.expired_at;
      if (!expired) {
        results.skipped_too_early++;
        logs.push({ userId, reason: 'no_expiry_date', status: 'skipped' });
        continue;
      }

      const days = daysSince(expired);
      if (days < 3) {
        results.skipped_too_early++;
        logs.push({ userId, reason: `only_${days}_days_since_expiry`, status: 'skipped' });
        continue;
      }

      // 3) 이메일 콘텐츠 생성
      const member = memberMap[userId] ?? null;
      const emailTo = setting.email ?? member?.email;
      if (!emailTo) {
        results.errors++;
        logs.push({ userId, reason: 'no_email_address', status: 'error' });
        continue;
      }

      const { subject, html } = await buildEmailContent({ member, setting });

      // 4) 이메일 발송
      await sendEmail({ to: emailTo, subject, html });

      const sentAt = new Date().toISOString();

      // 5) agent_tasks 기록
      await recordAgentTask({ userId, status: 'sent', sentAt });

      results.sent++;
      logs.push({ userId, email: emailTo, sentAt, status: 'sent' });
    } catch (err) {
      results.errors++;
      logs.push({ userId, reason: err.message, status: 'error' });
      await notifyError(err, { context: `trial-reengagement: ${userLabel}` });
      // 에러 발생 시 해당 항목 건너뜀 (프로세스 중단 없음)
      continue;
    }
  }

  // 6) 발송 결과 요약 로그 출력
  const summary = `체험 만료 재가입 유도 이메일 발송 완료 | 대상: ${results.processed}명 | 발송: ${results.sent}명 | 중복 건너뜀: ${results.skipped_duplicate}명 | 3일 미경과: ${results.skipped_too_early}명 | 오류: ${results.errors}건`;

  console.log('[trial-reengagement]', summary);
  console.log('[trial-reengagement] details:', JSON.stringify(logs, null, 2));

  await send({
    department: DEPARTMENT,
    task_type: TASK_TYPE,
    status: results.errors > 0 && results.sent === 0 ? 'error' : 'completed',
    summary,
    detail: JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), results, logs }),
  });
}

if (process.argv[1].endsWith('trial-reengagement.js')) run().catch(console.error);