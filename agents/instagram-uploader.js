import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';
const BATCH_SIZE = 10;
const DEPARTMENT = 'chm';

async function createMediaContainer({ mediaUrl, caption }) {
  const url = `${IG_API_BASE}/${IG_USER_ID}/media`;
  const params = new URLSearchParams({
    image_url: mediaUrl,
    caption: caption || '',
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Container creation failed: ${res.status}`);
  }

  return data.id;
}

async function publishMediaContainer(containerId) {
  const url = `${IG_API_BASE}/${IG_USER_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Publish failed: ${res.status}`);
  }

  return data.id;
}

async function updateQueueStatus(client, id, status, errorLog = null) {
  const query = errorLog
    ? `UPDATE content_queue SET status = $1, error_log = $2, updated_at = NOW() WHERE id = $3`
    : `UPDATE content_queue SET status = $1, updated_at = NOW() WHERE id = $2`;
  const values = errorLog ? [status, errorLog, id] : [status, id];
  await client.query(query, values);
}

async function insertAgentTaskLog(client, { queueId, platform, status, summary, detail }) {
  await client.query(
    `INSERT INTO agent_tasks (queue_id, platform, status, summary, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [queueId, platform, status, summary, detail]
  );
}

async function fetchApprovedItems(client) {
  const result = await client.query(
    `SELECT id, media_url, caption, created_at
     FROM content_queue
     WHERE status = 'approved' AND platform = 'instagram'
     ORDER BY created_at ASC
     LIMIT $1`,
    [BATCH_SIZE]
  );
  return result.rows;
}

export async function run() {
  const client = await pool.connect();
  const results = { success: 0, failed: 0, items: [] };

  try {
    const items = await fetchApprovedItems(client);

    if (items.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_auto_publish',
        status: 'completed',
        summary: '처리할 승인 항목 없음',
        detail: 'content_queue에서 승인된 Instagram 게시 항목이 없습니다.',
      });
      return;
    }

    for (const item of items) {
      const { id, media_url, caption } = item;
      let containerId = null;

      try {
        // 1. 미디어 컨테이너 생성
        containerId = await createMediaContainer({ mediaUrl: media_url, caption });

        // 2. 컨테이너 게시
        const publishedId = await publishMediaContainer(containerId);

        // 3. status → 'published' 업데이트
        await updateQueueStatus(client, id, 'published');

        // 4. agent_tasks 로그 INSERT
        await insertAgentTaskLog(client, {
          queueId: id,
          platform: 'instagram',
          status: 'published',
          summary: `Instagram 게시 성공 (queue_id: ${id})`,
          detail: JSON.stringify({ containerId, publishedId, media_url, caption }),
        });

        results.success++;
        results.items.push({ id, status: 'published', publishedId });

        console.log(`[OK] queue_id=${id} published, ig_media_id=${publishedId}`);

        // API 레이트리밋 회피: 항목 간 1초 대기
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.error(`[FAIL] queue_id=${id}`, err.message);

        // 5. status → 'failed', error_log 기록
        try {
          await updateQueueStatus(client, id, 'failed', err.message);
          await insertAgentTaskLog(client, {
            queueId: id,
            platform: 'instagram',
            status: 'failed',
            summary: `Instagram 게시 실패 (queue_id: ${id})`,
            detail: JSON.stringify({ error: err.message, media_url, caption, containerId }),
          });
        } catch (dbErr) {
          console.error(`[DB ERROR] queue_id=${id} 상태 업데이트 실패`, dbErr.message);
        }

        notifyError({
          department: DEPARTMENT,
          task_type: 'instagram_auto_publish',
          summary: `Instagram 게시 실패 - queue_id: ${id}`,
          detail: err.message,
        });

        results.failed++;
        results.items.push({ id, status: 'failed', error: err.message });
      }
    }

    // 최종 리포트
    const summary = `Instagram 자동 게시 완료: 성공 ${results.success}건 / 실패 ${results.failed}건 (총 ${items.length}건 처리)`;
    const detail = results.items
      .map((r) =>
        r.status === 'published'
          ? `✅ queue_id=${r.id} → ig_media_id=${r.publishedId}`
          : `❌ queue_id=${r.id} → ${r.error}`
      )
      .join('\n');

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_auto_publish',
      status: results.failed === items.length ? 'error' : 'completed',
      summary,
      detail,
    });

    console.log(`\n${summary}`);
  } catch (err) {
    console.error('[FATAL]', err);
    notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_auto_publish',
      summary: 'Instagram 자동 게시 스크립트 치명적 오류',
      detail: err.message,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);