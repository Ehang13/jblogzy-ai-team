import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;

const DEPARTMENT = 'chm';
const FAILURE_THRESHOLD = 3;
const MAX_RETRY_COUNT = 3;
const SCAN_WINDOW_HOURS = 1;

const BACKOFF_MINUTES = [1, 2, 4]; // exponential backoff: 1분→2분→4분

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function getFailedAgentGroups() {
  const client = await pool.connect();
  try {
    const windowStart = new Date(Date.now() - SCAN_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const result = await client.query(
      `SELECT
        agent_id,
        COUNT(*) AS failure_count,
        MAX(updated_at) AS last_failure_at,
        json_agg(
          json_build_object(
            'id', id,
            'task_type', task_type,
            'retry_count', retry_count,
            'error_message', error_message,
            'created_at', created_at,
            'updated_at', updated_at
          ) ORDER BY updated_at DESC
        ) AS tasks
      FROM agent_tasks
      WHERE status = 'failed'
        AND updated_at >= $1
        AND retry_count < $2
      GROUP BY agent_id
      HAVING COUNT(*) >= $3
      ORDER BY failure_count DESC`,
      [windowStart, MAX_RETRY_COUNT, FAILURE_THRESHOLD]
    );

    return result.rows;
  } finally {
    client.release();
  }
}

async function getDeadLetterCandidates() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, agent_id, task_type, retry_count, error_message, created_at, updated_at
       FROM agent_tasks
       WHERE status = 'failed'
         AND retry_count >= $1
       ORDER BY updated_at DESC`,
      [MAX_RETRY_COUNT]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function scheduleRetry(taskId, retryCount) {
  const client = await pool.connect();
  try {
    const backoffIndex = Math.min(retryCount, BACKOFF_MINUTES.length - 1);
    const delayMinutes = BACKOFF_MINUTES[backoffIndex];
    const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

    await client.query(
      `UPDATE agent_tasks
       SET status = 'pending',
           retry_count = retry_count + 1,
           scheduled_at = $1,
           updated_at = NOW()
       WHERE id = $2
         AND status = 'failed'`,
      [scheduledAt, taskId]
    );

    return { taskId, delayMinutes, scheduledAt };
  } finally {
    client.release();
  }
}

async function markAsDeadLetter(taskId, agentId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE agent_tasks
       SET status = 'dead_letter',
           updated_at = NOW()
       WHERE id = $1`,
      [taskId]
    );

    await client.query(
      `INSERT INTO settings (key, value, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = $2, updated_at = NOW()`,
      [
        `alert_dead_letter_${taskId}`,
        JSON.stringify({
          task_id: taskId,
          agent_id: agentId,
          reason,
          flagged_at: new Date().toISOString(),
          notification_sent: false,
        }),
      ]
    );

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function analyzeFailurePattern(agentGroup) {
  const { agent_id, failure_count, tasks } = agentGroup;

  const errorSummary = tasks
    .slice(0, 5)
    .map((t) => `[${t.task_type}] ${t.error_message || '알 수 없는 오류'}`)
    .join('\n');

  const prompt = `
다음은 에이전트(${agent_id})에서 발생한 반복 실패 패턴입니다.
최근 1시간 내 ${failure_count}회 실패가 발생했습니다.

오류 목록:
${errorSummary}

다음을 간단히 분석해주세요 (3줄 이내):
1. 주요 실패 원인 추정
2. 재시도로 해소 가능성 (높음/중간/낮음)
3. 즉각 조치 권고사항

반드시 추정/가능성 표현을 사용하고, 단정적 표현은 피해주세요.
`.trim();

  try {
    const analysis = await askFast(prompt, 300);
    return analysis;
  } catch {
    return '패턴 분석을 일시적으로 수행하지 못했습니다.';
  }
}

async function generateRetryReport(results) {
  const { retried, deadLettered, skipped, agentGroups } = results;

  const prompt = `
워크플로우 자동 재시도 처리 결과를 요약해주세요.

처리 통계:
- 재시도 스케줄링된 태스크: ${retried.length}건
- dead_letter로 마킹된 태스크: ${deadLettered.length}건
- 건너뛴 항목(오류): ${skipped.length}건
- 영향받은 에이전트 그룹: ${agentGroups.length}개

재시도 스케줄 상세:
${retried.slice(0, 10).map((r) => `- Task ${r.taskId}: ${r.delayMinutes}분 후 재시도 예정`).join('\n')}

dead_letter 항목:
${deadLettered.slice(0, 5).map((d) => `- Task ${d.taskId} (Agent: ${d.agentId}): ${d.reason}`).join('\n')}

운영팀에게 전달할 요약 보고서를 작성해주세요.
추정/가능성 등 완곡한 표현을 사용하고 단정적 표현은 피해주세요.
한국어로 작성하며 200자 이내로 요약해주세요.
`.trim();

  try {
    const summary = await ask(prompt, 400);
    return summary;
  } catch {
    return `자동 재시도 처리 완료: 재시도 ${retried.length}건, dead_letter ${deadLettered.length}건 처리됨`;
  }
}

export async function run() {
  const retried = [];
  const deadLettered = [];
  const skipped = [];
  const analysisLogs = [];

  console.log('[workflow-retry] 에러율 높은 워크플로우 스캔 시작...');

  // 1. dead_letter 후보 먼저 처리 (최대 재시도 초과)
  let deadLetterCandidates = [];
  try {
    deadLetterCandidates = await getDeadLetterCandidates();
    console.log(`[workflow-retry] dead_letter 후보: ${deadLetterCandidates.length}건`);
  } catch (err) {
    notifyError(err, { step: 'getDeadLetterCandidates' });
  }

  for (const task of deadLetterCandidates) {
    try {
      const reason = `최대 재시도 횟수(${MAX_RETRY_COUNT}회) 초과. 최근 오류: ${task.error_message || '알 수 없음'}`;
      await markAsDeadLetter(task.id, task.agent_id, reason);
      deadLettered.push({ taskId: task.id, agentId: task.agent_id, reason });
      console.log(`[workflow-retry] dead_letter 마킹: task=${task.id}, agent=${task.agent_id}`);
    } catch (err) {
      notifyError(err, { step: 'markAsDeadLetter', taskId: task.id });
      skipped.push({ taskId: task.id, reason: err.message });
    }
  }

  // 2. 실패율 높은 에이전트 그룹 스캔
  let agentGroups = [];
  try {
    agentGroups = await getFailedAgentGroups();
    console.log(`[workflow-retry] 실패율 높은 에이전트 그룹: ${agentGroups.length}개`);
  } catch (err) {
    notifyError(err, { step: 'getFailedAgentGroups' });
  }

  // 3. 각 그룹별 처리
  for (const group of agentGroups) {
    try {
      // 패턴 분석
      const analysis = await analyzeFailurePattern(group);
      analysisLogs.push({ agent_id: group.agent_id, analysis });

      // 해당 그룹의 태스크들 재시도 스케줄링
      for (const task of group.tasks) {
        try {
          if (task.retry_count >= MAX_RETRY_COUNT) {
            // 이미 최대 재시도 초과 - dead_letter 처리
            const reason = `에이전트 그룹 스캔 중 최대 재시도 초과 감지. 오류: ${task.error_message || '알 수 없음'}`;
            await markAsDeadLetter(task.id, group.agent_id, reason);
            deadLettered.push({ taskId: task.id, agentId: group.agent_id, reason });
          } else {
            const result = await scheduleRetry(task.id, task.retry_count);
            retried.push(result);
            console.log(
              `[workflow-retry] 재시도 스케줄: task=${task.id}, agent=${group.agent_id}, ` +
                `retryCount=${task.retry_count + 1}/${MAX_RETRY_COUNT}, delay=${result.delayMinutes}분`
            );
          }
        } catch (taskErr) {
          notifyError(taskErr, { step: 'scheduleRetry', taskId: task.id, agentId: group.agent_id });
          skipped.push({ taskId: task.id, reason: taskErr.message });
        }
      }
    } catch (groupErr) {
      notifyError(groupErr, { step: 'processAgentGroup', agentId: group.agent_id });
      skipped.push({ agentId: group.agent_id, reason: groupErr.message });
    }
  }

  // 4. 처리 결과 보고
  const results = { retried, deadLettered, skipped, agentGroups };
  const reportSummary = await generateRetryReport(results);

  const detailLines = [
    `## 워크플로우 자동 재시도 처리 결과`,
    ``,
    `### 처리 통계`,
    `- 재시도 스케줄링: ${retried.length}건`,
    `- dead_letter 마킹: ${deadLettered.length}건`,
    `- 건너뛴 항목: ${skipped.length}건`,
    `- 영향 에이전트 그룹: ${agentGroups.length}개`,
    ``,
    `### Exponential Backoff 스케줄`,
    `- 1차 재시도: 1분 후`,
    `- 2차 재시도: 2분 후`,
    `- 3차 재시도: 4분 후`,
    `- 3회 초과 시: dead_letter 처리`,
    ``,
  ];

  if (analysisLogs.length > 0) {
    detailLines.push(`### 에이전트 실패 패턴 분석`);
    for (const log of analysisLogs.slice(0, 3)) {
      detailLines.push(`**Agent: ${log.agent_id}**`);
      detailLines.push(log.analysis);
      detailLines.push('');
    }
  }

  if (deadLettered.length > 0) {
    detailLines.push(`### dead_letter 마킹 항목 (settings 알림 플래그 기록됨)`);
    deadLettered.slice(0, 10).forEach((d) => {
      detailLines.push(`- Task ${d.taskId} (Agent: ${d.agentId})`);
    });
    detailLines.push('');
  }

  if (retried.length > 0) {
    detailLines.push(`### 재시도 스케줄 상세 (최근 10건)`);
    retried.slice(0, 10).forEach((r) => {
      detailLines.push(`- Task ${r.taskId}: ${r.delayMinutes}분 후 (${r.scheduledAt})`);
    });
    detailLines.push('');
  }

  detailLines.push(`---`);
  detailLines.push(`본 알림은 자동화 시스템에서 발송됩니다. 수신을 원치 않으시면 시스템 관리자에게 수신거부를 요청해주세요.`);

  const hasIssues = deadLettered.length > 0 || skipped.length > 0;

  await send({
    department: DEPARTMENT,
    task_type: 'workflow_retry',
    status: hasIssues ? 'error' : 'completed',
    summary: reportSummary,
    detail: detailLines.join('\n'),
    retried_count: retried.length,
    dead_letter_count: deadLettered.length,
    skipped_count: skipped.length,
    affected_agents: agentGroups.length,
  });

  await pool.end();
  console.log('[workflow-retry] 완료.');

  return results;
}

if (process.argv[1].endsWith('workflow-retry.js')) run().catch(console.error);