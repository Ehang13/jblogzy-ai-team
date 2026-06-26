import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';
const TASK_TYPE = 'trial_reengagement';

// ── DB 쿼리 헬퍼 (카페24 API 재사용) ─────────────────────────────────────────
const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const KEY  = process.env.CAFE24_API_KEY;

async function query(sql) {
  const res = await fetch(`${BASE}/query.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': KEY,
    },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.rows ?? json.data ?? json;
}

// ── 이메일 발송 유틸 (CHM 에이전트 공용) ─────────────────────────────────────
async function sendEmail({ to, name, subject, html }) {
  const res = await fetch(`${BASE}/email.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': KEY,
    },
    body: JSON.stringify({ to, name, subject, html }),
  });
  if (!res.ok) throw new Error(`sendEmail failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── 만료 후 3일(±12h) 경과, 미전환 회원 조회 ─────────────────────────────────
async function fetchTargetMembers() {
  const sql = `
    SELECT
      s.member_id,
      s.trial_expired_at,
      s.used_features,
      COALESCE(l.email, s.email) AS email,
      COALESCE(l.name,  s.name)  AS name
    FROM settings s
    LEFT JOIN leads l ON l.member_id = s.member_id
    WHERE
      s.trial_expired_at IS NOT NULL
      AND s.converted = 0
      AND s.trial_expired_at BETWEEN
            NOW() - INTERVAL 3 DAY - INTERVAL 12 HOUR
        AND NOW() - INTERVAL 3 DAY + INTERVAL 12 HOUR
      AND COALESCE(l.email, s.email) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_tasks at2
        WHERE at2.member_id = s.member_id
          AND at2.type      = '${TASK_TYPE}'
          AND at2.status    = 'sent'
      )
  `;
  return query(sql);
}

// ── 사용 기능 요약 파싱 ───────────────────────────────────────────────────────
function parseUsedFeatures(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  }
}

// ── 개인화 이메일 본문 생성 (Claude) ─────────────────────────────────────────
async function generateEmailContent({ name, usedFeatures }) {
  const featureList = usedFeatures.length > 0
    ? usedFeatures.map(f => `- ${f}`).join('\n')
    : '- 다양한 블로그 관리 기능';

  const prompt = `
당신은 SaaS 서비스의 이메일 마케팅 전문가입니다.
무료 체험이 만료된 지 3일이 지난 회원에게 재가입을 유도하는 이메일 HTML 본문을 작성하세요.

[회원 정보]
- 이름: ${name || '고객'}
- 체험 중 사용한 주요 기능:
${featureList}

[작성 지침]
1. 따뜻하고 친근한 톤으로 작성
2. 체험 기간 중 사용한 기능을 구체적으로 언급하며 가치를 상기
3. 한정 기간 특별 할인 혜택 문구 포함 (단, "보장", "확정", "100%" 등 단언적 표현 금지)
4. 재가입 유도 CTA 버튼 포함
5. 수신거부 안내 문구를 본문 하단에 반드시 포함
6. HTML 형식으로 출력 (스타일은 인라인 CSS 사용, 깔끔하고 모바일 친화적)
7. 과도한 영업 압박 없이 자연스럽게 유도

HTML 본문만 출력하세요. (<!DOCTYPE html> 포함 완전한 HTML)
`;

  const html = await ask(prompt, 1500);
  return html.trim();
}

// ── agent_tasks 기록 ──────────────────────────────────────────────────────────
async function recordTask(memberId, email, detail) {
  const sql = `
    INSERT INTO agent_tasks (member_id, type, status, email, detail, created_at)
    VALUES (
      ${memberId ? `'${memberId}'` : 'NULL'},
      '${TASK_TYPE}',
      'sent',
      '${email.replace(/'/g, "\\'")}',
      '${JSON.stringify(detail).replace(/'/g, "\\'")}',
      NOW()
    )
  `;
  await query(sql);
}

// ── 메인 실행 ─────────────────────────────────────────────────────────────────
export async function run() {
  const startedAt = new Date().toISOString();
  const results = { sent: [], skipped: [], errors: [] };

  let members = [];
  try {
    members = await fetchTargetMembers();
  } catch (err) {
    await notifyError({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      error: err,
      message: '대상 회원 조회 실패',
    });
    await send({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      status: 'error',
      summary: '대상 회원 조회 실패로 에이전트 중단',
      detail: err.message,
    });
    return;
  }

  if (members.length === 0) {
    await send({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      status: 'completed',
      summary: '재가입 유도 대상 회원 없음',
      detail: `실행 시각: ${startedAt}`,
    });
    return;
  }

  for (const member of members) {
    const { member_id, email, name, trial_expired_at, used_features } = member;

    // 이메일 누락 스킵
    if (!email) {
      results.skipped.push({ member_id, reason: '이메일 없음' });
      continue;
    }

    try {
      const usedFeatures = parseUsedFeatures(used_features);

      // 이메일 본문 생성
      const html = await generateEmailContent({ name, usedFeatures });

      // 이메일 발송
      await sendEmail({
        to: email,
        name: name || '고객',
        subject: `${name || '고객'}님, 체험 기간에 사용하셨던 기능들이 기다리고 있어요 🎁`,
        html,
      });

      // 발송 이력 기록
      await recordTask(member_id, email, {
        trial_expired_at,
        used_features: usedFeatures,
        sent_at: new Date().toISOString(),
      });

      results.sent.push({ member_id, email, name });
    } catch (err) {
      results.errors.push({ member_id, email, error: err.message });
      await notifyError({
        department: DEPARTMENT,
        task_type: TASK_TYPE,
        error: err,
        message: `회원 ${member_id}(${email}) 처리 중 오류`,
      });
      // 개별 오류는 스킵하고 계속 진행
    }
  }

  // ── 결과 리포트 ────────────────────────────────────────────────────────────
  const status = results.errors.length > 0 && results.sent.length === 0
    ? 'error'
    : 'completed';

  const summary =
    `총 대상 ${members.length}명 | ` +
    `발송 완료 ${results.sent.length}명 | ` +
    `스킵 ${results.skipped.length}명 | ` +
    `오류 ${results.errors.length}명`;

  const detail = [
    `## 실행 시각\n${startedAt}`,
    `## 발송 완료 (${results.sent.length}명)\n` +
      (results.sent.map(r => `- [${r.member_id}] ${r.name} <${r.email}>`).join('\n') || '없음'),
    `## 스킵 (${results.skipped.length}명)\n` +
      (results.skipped.map(r => `- [${r.member_id}] ${r.reason}`).join('\n') || '없음'),
    `## 오류 (${results.errors.length}명)\n` +
      (results.errors.map(r => `- [${r.member_id}] ${r.email}: ${r.error}`).join('\n') || '없음'),
  ].join('\n\n');

  await send({
    department: DEPARTMENT,
    task_type: TASK_TYPE,
    status,
    summary,
    detail,
  });
}

if (process.argv[1].endsWith('trial-reengagement.js')) {
  run().catch(console.error);
}