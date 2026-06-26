import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const POLL_INTERVAL_MS = 30_000;
const MAX_RETRY = 3;
const BACKOFF_MINUTES = [1, 2, 4]; // index = retry_count (0-based next attempt)
const ERROR_WINDOW_HOURS = 1;
const ERROR_THRESHOLD = 2;

async function getEligibleTasks() {
  const client = await pool.connect();
  try {
    // 최근 1시간 내 에러 2건 이상인 agent들의 error 작업 중
    // 백오프 대기 시간이 지난 작업만 선정
    const query = `
      WITH agent_error_counts AS (
        SELECT agent_id, COUNT(*) as error_count
        FROM agent_tasks
        WHERE status = 'error'
          AND updated_at >= NOW() - INTERVAL '${ERROR_WINDOW_HOURS} hours'
        GROUP BY agent_id
        HAVING COUNT(*) >= ${ERROR_THRESHOLD}
      ),
      eligible AS (
        SELECT t.*
        FROM agent_tasks t
        JOIN agent_error_counts aec ON t.agent_id = aec.agent_id
        WHERE t.status = 'error'
          AND (
            -- retry_count가 없는 신규 에러
            t.metadata->>'retry_count' IS NULL
            OR (
              -- retry_count가 있고 백오프 대기 시간이 지난 경우
              (t.metadata->>'retry_count')::int < ${MAX_RETRY}
              AND (
                CASE (t.metadata->>'retry_count')::int
                  WHEN 0 THEN t.updated_at <= NOW() - INTERVAL '1 minutes'
                  WHEN 1 THEN t.updated_at <= NOW() - INTERVAL '2 minutes'
                  WHEN 2 THEN t.updated_at <= NOW() - INTERVAL '4 minutes'
                  ELSE FALSE
                END
              )
            )
          )
      )
      SELECT * FROM eligible
      ORDER BY updated_at ASC
      LIMIT 50;
    `;
    const result = await client.query(query);
    return result.rows;
  } finally {
    client.release();
  }
}

async function retryTask(task) {
  const client = await pool.connect();
  try {
    const currentRetryCount = parseInt(task.metadata?.retry_count ?? '0', 10);
    const nextRetryCount = currentRetryCount + 1;

    if (nextRetryCount > MAX_RETRY) {
      // 3회 초과 → failed_permanent 처리
      await markAsPermanentlyFailed(client, task);
      return { action: 'permanent_fail', task };
    }

    // 재시도: status를 pending 또는 queued로 변경하고 retry_count 증가
    const updatedMetadata = {
      ...(task.metadata || {}),
      retry_count: nextRetryCount,
      last_retry_at: new Date().toISOString(),
      retry_history: [
        ...((task.metadata?.retry_history) || []),
        {
          attempt: nextRetryCount,
          retried_at: new Date().toISOString(),
          previous_error: task.error_message || task.metadata?.error_message || null,
        }
      ]
    };

    await client.query(
      `UPDATE agent_tasks
       SET status = 'pending',
           metadata = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(updatedMetadata), task.id]
    );

    return { action: 'retried', task, retryCount: nextRetryCount };
  } finally {
    client.release();
  }
}

async function markAsPermanentlyFailed(client, task) {
  const updatedMetadata = {
    ...(task.metadata || {}),
    retry_count: MAX_RETRY,
    permanently_failed_at: new Date().toISOString(),
  };

  await client.query(
    `UPDATE agent_tasks
     SET status = 'failed_permanent',
         metadata = $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(updatedMetadata), task.id]
  );

  // settings 테이블의 admin_alert_queue에 알림 항목 추가
  await addAdminAlert(client, task);
}

async function addAdminAlert(client, task) {
  try {
    // settings 테이블에서 admin_alert_queue 조회
    const settingsResult = await client.query(
      `SELECT value FROM settings WHERE key = 'admin_alert_queue' LIMIT 1`
    );

    let alertQueue = [];
    if (settingsResult.rows.length > 0) {
      try {
        alertQueue = JSON.parse(settingsResult.rows[0].value) || [];
      } catch {
        alertQueue = [];
      }
    }

    const newAlert = {
      id: `alert_${task.id}_${Date.now()}`,
      type: 'workflow_permanent_fail',
      task_id: task.id,
      agent_id: task.agent_id,
      task_type: task.task_type || null,
      created_at: new Date().toISOString(),
      message: `워크플로우 작업(ID: ${task.id})이 최대 재시도 횟수(${MAX_RETRY}회)를 초과하여 영구 실패 처리되었습니다.`,
      metadata: task.metadata || {},
    };

    alertQueue.push(newAlert);

    // upsert
    await client.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('admin_alert_queue', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(alertQueue)]
    );
  } catch (alertErr) {
    await notifyError(alertErr, { context: 'addAdminAlert', taskId: task.id });
  }
}

async function analyzeFailurePattern(tasks) {
  if (!tasks || tasks.length === 0) return null;

  try {
    const taskSummaries = tasks.slice(0, 20).map(t => ({
      id: t.id,
      agent_id: t.agent_id,
      task_type: t.task_type,
      error: t.error_message || t.metadata?.error_message || '(에러 상세 없음)',
      retry_count: t.metadata?.retry_count ?? 0,
    }));

    const prompt = `다음은 자동 재시도 대상으로 선정된 워크플로우 에러 작업 목록입니다.
에러 패턴을 분석하고 주요 원인 그룹을 간략히 요약해 주세요. (2~3문장, 단정적 표현 사용 금지)

작업 목록:
${JSON.stringify(taskSummaries, null, 2)}

응답 형식: 짧은 한국어 요약 텍스트`;

    const analysis = await askFast(prompt, 300);
    return analysis;
  } catch (err) {
    await notifyError(err, { context: 'analyzeFailurePattern' });
    return null;
  }
}

async function runOnce() {
  let tasks = [];
  let retriedCount = 0;
  let permanentFailCount = 0;
  const errors = [];

  try {
    tasks = await getEligibleTasks();
  } catch (err) {
    await notifyError(err, { context: 'getEligibleTasks' });
    return;
  }

  if (tasks.length === 0) {
    return; // 조용히 종료 (로그 최소화)
  }

  for (const task of tasks) {
    try {
      const result = await retryTask(task);
      if (result.action === 'retried') {
        retriedCount++;
      } else if (result.action === 'permanent_fail') {
        permanentFailCount++;
      }
    } catch (err) {
      errors.push({ taskId: task.id, error: err.message });
      await notifyError(err, { context: 'retryTask', taskId: task.id });
      // 해당 항목 건너뜀 — 프로세스 중단 없음
    }
  }

  // 유의미한 처리가 있을 때만 리포트 전송
  if (retriedCount > 0 || permanentFailCount > 0) {
    let analysisText = null;
    if (tasks.length > 0) {
      analysisText = await analyzeFailurePattern(tasks);
    }

    const detail = [
      `총 스캔 대상: ${tasks.length}건`,
      `재시도 처리: ${retriedCount}건`,
      `영구 실패 처리: ${permanentFailCount}건`,
      errors.length > 0 ? `처리 중 오류 발생: ${errors.length}건` : null,
      analysisText ? `\n[에러 패턴 분석]\n${analysisText}` : null,
    ].filter(Boolean).join('\n');

    try {
      await send({
        department: DEPARTMENT,
        task_type: '워크플로우_자동재시도',
        status: errors.length > 0 ? 'error' : 'completed',
        summary: `에러율 높은 워크플로우 재시도 — 재시도 ${retriedCount}건, 영구실패 ${permanentFailCount}건`,
        detail,
        retried_count: retriedCount,
        permanent_fail_count: permanentFailCount,
        scan_count: tasks.length,
        processed_at: new Date().toISOString(),
      });
    } catch (reportErr) {
      await notifyError(reportErr, { context: 'send report' });
    }
  }
}

export async function run() {
  console.log(`[workflow-retry] 시작 — 폴링 인터벌: ${POLL_INTERVAL_MS / 1000}초`);

  // 즉시 1회 실행
  await runOnce();

  // 이후 30초마다 반복
  setInterval(async () => {
    try {
      await runOnce();
    } catch (err) {
      await notifyError(err, { context: 'setInterval runOnce' });
    }
  }, POLL_INTERVAL_MS);
}

if (process.argv[1].endsWith('workflow-retry.js')) {
  run().catch(async (err) => {
    await notifyError(err, { context: 'top-level run' });
    console.error(err);
  });
}