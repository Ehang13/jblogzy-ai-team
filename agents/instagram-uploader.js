import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID = process.env.INSTAGRAM_USER_ID;
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function getApprovedItems() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM content_queue
       WHERE status = 'approved' AND platform = 'instagram'
       ORDER BY created_at ASC`
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function createMediaContainer(imageUrl, caption) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_USER_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `미디어 컨테이너 생성 실패: HTTP ${res.status}`);
  }

  return data.id;
}

async function publishMedia(containerId) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_USER_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `미디어 게시 실패: HTTP ${res.status}`);
  }

  return data.id;
}

async function updateStatusPublished(id, postId) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE content_queue
       SET status = 'published', published_at = NOW(), instagram_post_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, postId]
    );
  } finally {
    client.release();
  }
}

async function updateStatusFailed(id, errorMessage) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE content_queue
       SET status = 'failed', error_log = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, errorMessage]
    );
  } finally {
    client.release();
  }
}

async function logAgentTask({ taskType, status, summary, detail, referenceId }) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO agent_tasks (agent_name, task_type, status, summary, detail, reference_id, executed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['instagram-uploader', taskType, status, summary, detail, referenceId]
    );
  } catch (err) {
    console.error('agent_tasks 로깅 실패:', err.message);
  } finally {
    client.release();
  }
}

export async function run() {
  const results = { success: [], failed: [], skipped: [] };

  let items = [];
  try {
    items = await getApprovedItems();
  } catch (err) {
    await notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      error: err,
      summary: 'content_queue 조회 실패',
    });
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'error',
      summary: 'content_queue 조회 중 오류 발생',
      detail: err.message,
    });
    return;
  }

  if (items.length === 0) {
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'completed',
      summary: '업로드 대상 없음',
      detail: 'approved 상태의 Instagram 게시 항목이 없습니다.',
    });
    return;
  }

  for (const item of items) {
    const { id, image_url, caption, title } = item;

    if (!image_url) {
      const reason = `항목 ID ${id}: image_url 없음, 건너뜀`;
      results.skipped.push({ id, reason });
      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'skipped',
        summary: `게시 건너뜀 - ID ${id}`,
        detail: reason,
        referenceId: id,
      });
      continue;
    }

    try {
      // 1) 미디어 컨테이너 생성
      const containerId = await createMediaContainer(image_url, caption || title || '');

      // 2) 실제 게시
      const postId = await publishMedia(containerId);

      // 3) 상태 업데이트
      await updateStatusPublished(id, postId);

      results.success.push({ id, postId });

      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'success',
        summary: `Instagram 게시 성공 - ID ${id}`,
        detail: `Instagram Post ID: ${postId}`,
        referenceId: id,
      });

      console.log(`[SUCCESS] content_queue ID=${id} → Instagram Post ID=${postId}`);

    } catch (err) {
      const errorMessage = err.message || '알 수 없는 오류';

      try {
        await updateStatusFailed(id, errorMessage);
      } catch (dbErr) {
        console.error(`status 업데이트 실패 (ID=${id}):`, dbErr.message);
      }

      results.failed.push({ id, error: errorMessage });

      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'failed',
        summary: `Instagram 게시 실패 - ID ${id}`,
        detail: errorMessage,
        referenceId: id,
      });

      await notifyError({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        error: err,
        summary: `Instagram 게시 실패 (ID=${id})`,
      });

      console.error(`[FAILED] content_queue ID=${id}:`, errorMessage);
    }

    // Graph API 레이트 리밋 방지를 위한 딜레이
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const totalCount = items.length;
  const successCount = results.success.length;
  const failedCount = results.failed.length;
  const skippedCount = results.skipped.length;

  const summaryText = `Instagram 업로드 완료 - 성공: ${successCount}건 / 실패: ${failedCount}건 / 건너뜀: ${skippedCount}건 (총 ${totalCount}건)`;

  const detailLines = [
    `## 실행 결과 요약`,
    `- 전체 대상: ${totalCount}건`,
    `- 성공: ${successCount}건`,
    `- 실패: ${failedCount}건`,
    `- 건너뜀: ${skippedCount}건`,
    '',
  ];

  if (results.success.length > 0) {
    detailLines.push('## 성공 목록');
    results.success.forEach(({ id, postId }) => {
      detailLines.push(`- ID ${id} → Post ID: ${postId}`);
    });
    detailLines.push('');
  }

  if (results.failed.length > 0) {
    detailLines.push('## 실패 목록');
    results.failed.forEach(({ id, error }) => {
      detailLines.push(`- ID ${id}: ${error}`);
    });
    detailLines.push('');
  }

  if (results.skipped.length > 0) {
    detailLines.push('## 건너뜀 목록');
    results.skipped.forEach(({ id, reason }) => {
      detailLines.push(`- ID ${id}: ${reason}`);
    });
  }

  await send({
    department: DEPARTMENT,
    task_type: 'instagram_upload',
    status: failedCount > 0 && successCount === 0 ? 'error' : 'completed',
    summary: summaryText,
    detail: detailLines.join('\n'),
    success_count: successCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    total_count: totalCount,
  });

  await pool.end();
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);