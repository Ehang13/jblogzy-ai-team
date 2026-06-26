import 'dotenv/config';
import { askJson } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';
const MAX_BATCH = 5;
const DEPARTMENT = 'chm';

async function graphApiRequest(endpoint, method = 'GET', body = null) {
  const url = `${GRAPH_API_BASE}${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Graph API error: ${res.status}`);
  }
  return data;
}

async function createMediaContainer(imageUrl, caption) {
  const data = await graphApiRequest(
    `/${INSTAGRAM_ACCOUNT_ID}/media`,
    'POST',
    {
      image_url: imageUrl,
      caption,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }
  );
  return data.id;
}

async function publishMedia(containerId) {
  const data = await graphApiRequest(
    `/${INSTAGRAM_ACCOUNT_ID}/media_publish`,
    'POST',
    {
      creation_id: containerId,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }
  );
  return data.id;
}

async function fetchApprovedItems(client) {
  const result = await client.query(
    `SELECT * FROM content_queue
     WHERE platform = 'instagram' AND status = 'approved'
     ORDER BY created_at ASC
     LIMIT $1`,
    [MAX_BATCH]
  );
  return result.rows;
}

async function updateStatus(client, id, status, extra = {}) {
  const fields = ['status = $2'];
  const values = [id, status];
  let idx = 3;

  if (extra.published_at !== undefined) {
    fields.push(`published_at = $${idx++}`);
    values.push(extra.published_at);
  }
  if (extra.error_log !== undefined) {
    fields.push(`error_log = $${idx++}`);
    values.push(extra.error_log);
  }

  await client.query(
    `UPDATE content_queue SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1`,
    values
  );
}

async function logAgentTask(client, { item_id, status, summary, detail }) {
  await client.query(
    `INSERT INTO agent_tasks (agent_name, item_id, status, summary, detail, executed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    ['instagram-uploader', item_id, status, summary, detail]
  );
}

export async function run() {
  const client = await pool.connect();
  const results = { success: 0, failed: 0, items: [] };

  try {
    const items = await fetchApprovedItems(client);

    if (items.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        status: 'completed',
        summary: '처리할 승인된 인스타그램 게시물이 없습니다.',
        detail: '대기 중인 항목 없음',
      });
      return;
    }

    for (const item of items) {
      try {
        const contentData =
          typeof item.content_data === 'string'
            ? JSON.parse(item.content_data)
            : item.content_data || {};

        const imageUrl = contentData.image_url || item.image_url;
        const caption = contentData.caption || item.caption || '';

        if (!imageUrl) {
          throw new Error('이미지 URL이 없습니다.');
        }

        // 1) 미디어 컨테이너 생성
        const containerId = await createMediaContainer(imageUrl, caption);

        // 2) 게시 실행
        const publishedId = await publishMedia(containerId);

        // 3) DB 상태 업데이트 → published
        await updateStatus(client, item.id, 'published', {
          published_at: new Date().toISOString(),
        });

        // 4) agent_tasks 로깅
        await logAgentTask(client, {
          item_id: item.id,
          status: 'success',
          summary: `인스타그램 게시 성공: ${publishedId}`,
          detail: JSON.stringify({ containerId, publishedId, imageUrl }),
        });

        results.success++;
        results.items.push({ id: item.id, status: 'published', publishedId });

      } catch (err) {
        notifyError(err, {
          context: 'instagram-uploader',
          item_id: item.id,
        });

        // DB 상태 업데이트 → failed
        try {
          await updateStatus(client, item.id, 'failed', {
            error_log: err.message,
          });

          await logAgentTask(client, {
            item_id: item.id,
            status: 'error',
            summary: `인스타그램 게시 실패: ${err.message}`,
            detail: JSON.stringify({ error: err.message, stack: err.stack }),
          });
        } catch (dbErr) {
          notifyError(dbErr, { context: 'instagram-uploader db update failed', item_id: item.id });
        }

        results.failed++;
        results.items.push({ id: item.id, status: 'failed', error: err.message });
      }
    }

    const summaryText = `인스타그램 자동 업로드 완료 — 성공: ${results.success}건, 실패: ${results.failed}건 (총 ${items.length}건 처리)`;

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: results.failed === items.length ? 'error' : 'completed',
      summary: summaryText,
      detail: JSON.stringify(results.items, null, 2),
    });

  } catch (err) {
    notifyError(err, { context: 'instagram-uploader run()', fatal: true });

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'error',
      summary: `인스타그램 업로더 실행 중 오류 발생: ${err.message}`,
      detail: err.stack,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);