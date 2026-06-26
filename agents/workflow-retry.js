import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const MAX_RETRY = 3;

// 지수 백오프 간격 (분 단위)
const BACKOFF_INTERVALS = [1, 5, 15];

function getBackoffInterval(retryCount) {
  const idx = Math.min(retryCount, BACKOFF_INTERVALS.length - 1);
  return BACKOFF_INTERVALS[idx];
}

async function fetchFailedTasks(client) {
  const query = `
    SELECT t.*
    FROM agent_tasks t
    WHERE t.status = 'failed'
      AND t.retry_count < $1
      AND t.updated_at < NOW() - (
        CASE t.retry_count
          WHEN 0 THEN INTERVAL '1 minute'
          WHEN 1 THEN INTERVAL '5 minutes'
          ELSE INTERVAL '15 minutes'
        END
      )
    ORDER BY t.updated_at ASC
  `;
  const result = await client.query(query, [MAX_RETRY]);
  return result.rows;
}

async function markCompleted(client, taskId) {
  await client.query(
    `UPDATE agent_tasks SET status = 'completed', updated_at = NOW() WHERE id = $1`,
    [taskId]
  );
}

async function incrementRetry(client, taskId, retryCount, errorMessage) {
  await client.query(
    `UPDATE agent_tasks
     SET retry_count = $2, last_error = $3, updated_at = NOW()
     WHERE id = $1`,
    [taskId, retryCount + 1, errorMessage]
  );
}

async function markDeadLetter(client, taskId, errorMessage) {
  await client.query(
    `UPDATE agent_tasks SET status = 'dead_letter', last_error = $2, updated_at = NOW() WHERE id = $1`,
    [taskId, errorMessage]
  );

  const alertKey = `alert_dead_letter_${taskId}`;
  const alertValue = JSON.stringify({
    task_id: taskId,
    marked_at: new Date().toISOString(),
    error: errorMessage,
  });

  await client.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [alertKey, alertValue]
  );
}

async function loadAndRunAgent(agentName, task) {
  // agent_name 기준으로 동적 import
  const agentPath = path.resolve(__dirname, `${agentName}.js`);
  const agentModule = await import(agentPath);

  if (typeof agentModule.run !== 'function') {
    throw new Error(`에이전트 '${agentName}'에 run() 함수가 존재하지 않습니다.`);
  }

  await agentModule.run(task);
}

export async function run() {
  const client = await pool.connect();
  let processedCount = 0;
  let successCount = 0;
  let deadLetterCount = 0;
  const errors = [];

  try {
    const tasks = await fetchFailedTasks(client);

    if (tasks.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type: 'workflow_retry',
        status: 'completed',
        summary: '재시도 대상 태스크 없음',
        detail: '현재 재시도 조건에 해당하는 failed 태스크가 없습니다.',
      });
      return;
    }

    for (const task of tasks) {
      processedCount++;
      const { id: taskId, agent_name: agentName, retry_count: retryCount } = task;

      try {
        await loadAndRunAgent(agentName, task);

        await markCompleted(client, taskId);
        successCount++;

        console.log(`[workflow-retry] 태스크 ${taskId} (${agentName}) 재실행 성공`);
      } catch (err) {
        const errorMessage = err?.message || String(err);
        console.error(`[workflow-retry] 태스크 ${taskId} (${agentName}) 재실행 실패:`, errorMessage);

        const nextRetryCount = retryCount + 1;

        if (nextRetryCount >= MAX_RETRY) {
          // dead_letter 전환
          try {
            await markDeadLetter(client, taskId, errorMessage);
            deadLetterCount++;
            console.warn(`[workflow-retry] 태스크 ${taskId} dead_letter 전환 완료`);
          } catch (dbErr) {
            notifyError(dbErr, `dead_letter 마킹 실패 - task_id: ${taskId}`);
            errors.push({ taskId, agentName, error: dbErr.message });
          }
        } else {
          // retry_count 증가 및 last_error 업데이트
          try {
            await incrementRetry(client, taskId, retryCount, errorMessage);
            const nextInterval = getBackoffInterval(nextRetryCount);
            console.log(`[workflow-retry] 태스크 ${taskId} retry_count → ${nextRetryCount}, 다음 재시도: ${nextInterval}분 후`);
          } catch (dbErr) {
            notifyError(dbErr, `retry_count 업데이트 실패 - task_id: ${taskId}`);
            errors.push({ taskId, agentName, error: dbErr.message });
          }
        }

        errors.push({ taskId, agentName, error: errorMessage });
        notifyError(err, `에이전트 재실행 실패 - task_id: ${taskId}, agent: ${agentName}`);
      }
    }

    const summary = `처리: ${processedCount}건 | 성공: ${successCount}건 | dead_letter: ${deadLetterCount}건 | 실패: ${errors.length}건`;

    await send({
      department: DEPARTMENT,
      task_type: 'workflow_retry',
      status: errors.length > 0 && successCount === 0 ? 'error' : 'completed',
      summary,
      detail: [
        `## 워크플로우 자동 재시도 결과`,
        ``,
        `- 전체 처리 태스크: ${processedCount}건`,
        `- 재실행 성공: ${successCount}건`,
        `- Dead Letter 전환: ${deadLetterCount}건`,
        `- 재실행 실패(재시도 예정): ${errors.filter((_, i) => i < errors.length - deadLetterCount).length}건`,
        ``,
        deadLetterCount > 0
          ? `### Dead Letter 전환된 태스크\n${errors
              .slice(0, deadLetterCount)
              .map((e) => `- task_id: ${e.taskId} (${e.agentName}): ${e.error}`)
              .join('\n')}`
          : '',
        ``,
        `> 본 메일은 자동 발송되며 수신을 원하지 않으시면 관리자에게 문의해 주세요.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  } catch (err) {
    notifyError(err, 'workflow-retry 전체 실행 오류');
    await send({
      department: DEPARTMENT,
      task_type: 'workflow_retry',
      status: 'error',
      summary: '워크플로우 재시도 로직 실행 중 오류 발생',
      detail: `오류 내용: ${err?.message || String(err)}\n\n> 본 메일은 자동 발송되며 수신을 원하지 않으시면 관리자에게 문의해 주세요.`,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('workflow-retry.js')) run().catch(console.error);