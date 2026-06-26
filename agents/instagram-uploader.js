import 'dotenv/config';
import { askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID   = process.env.INSTAGRAM_ACCOUNT_ID;
const GRAPH_API_BASE         = 'https://graph.facebook.com/v19.0';
const DEPARTMENT             = 'chm';
const BATCH_SIZE             = 5;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchApprovedItems(client) {
  const result = await client.query(
    `SELECT id, image_url, caption, user_id, metadata
     FROM content_queue
     WHERE platform = 'instagram'
       AND status   = 'approved'
     ORDER BY created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [BATCH_SIZE]
  );
  return result.rows;
}

async function createMediaContainer(imageUrl, caption) {
  const params = new URLSearchParams({
    image_url:    imageUrl,
    caption:      caption ?? '',
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(
    `${GRAPH_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media`,
    { method: 'POST', body: params }
  );
  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`미디어 컨테이너 생성 실패: ${msg}`);
  }
  return data.id;
}

async function publishMedia(containerId) {
  const params = new URLSearchParams({
    creation_id:  containerId,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(
    `${GRAPH_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media_publish`,
    { method: 'POST', body: params }
  );
  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`미디어 게시 실패: ${msg}`);
  }
  return data.id;
}

async function markPublished(client, id, instagramPostId) {
  await client.query(
    `UPDATE content_queue
     SET status       = 'published',
         published_at = NOW(),
         metadata     = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('instagram_post_id', $2)
     WHERE id = $1`,
    [id, instagramPostId]
  );
}

async function markFailed(client, id, errorMessage) {
  await client.query(
    `UPDATE content_queue
     SET status    = 'failed',
         error_log = $2
     WHERE id = $1`,
    [id, errorMessage]
  );
}

async function logAgentTask(client, { refId, status, summary, detail }) {
  await client.query(
    `INSERT INTO agent_tasks (agent_name, ref_id, status, summary, detail, executed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    ['instagram-uploader', refId, status, summary, detail]
  );
}

export async function run() {
  const client = await pool.connect();
  const results = { success: 0, failed: 0, skipped: 0, items: [] };

  try {
    await client.query('BEGIN');
    const items = await fetchApprovedItems(client);
    await client.query('COMMIT');

    if (items.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type:  'instagram_upload',
        status:     'completed',
        summary:    '처리할 인스타그램 콘텐츠가 없습니다.',
        detail:     '승인된(approved) 항목이 존재하지 않아 종료합니다.',
      });
      return;
    }

    for (const item of items) {
      const { id, image_url, caption } = item;
      let containerId  = null;
      let postId       = null;

      try {
        // 이미지 URL 유효성 간단 검증
        if (!image_url || !/^https?:\/\//i.test(image_url)) {
          throw new Error(`유효하지 않은 이미지 URL: ${image_url}`);
        }

        // 1) 미디어 컨테이너 생성
        containerId = await createMediaContainer(image_url, caption);
        await sleep(1000);

        // 2) 실제 게시
        postId = await publishMedia(containerId);
        await sleep(1000);

        // 3) DB 상태 업데이트
        await client.query('BEGIN');
        await markPublished(client, id, postId);

        // Claude를 활용한 게시 결과 요약 생성
        const summaryText = await askFast(
          `인스타그램 게시 성공 알림 한 줄 요약을 작성해줘.\n` +
          `content_queue id: ${id}, 인스타그램 게시물 id: ${postId}, 캡션: "${caption ?? '없음'}"`,
          100
        );

        await logAgentTask(client, {
          refId:   String(id),
          status:  'success',
          summary: summaryText.trim(),
          detail:  JSON.stringify({ containerId, postId, image_url }),
        });
        await client.query('COMMIT');

        results.success++;
        results.items.push({ id, status: 'published', postId });

      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}

        const errMsg = err.message ?? String(err);

        try {
          await client.query('BEGIN');
          await markFailed(client, id, errMsg);
          await logAgentTask(client, {
            refId:   String(id),
            status:  'failed',
            summary: `게시 실패: ${errMsg.slice(0, 120)}`,
            detail:  JSON.stringify({ containerId, image_url, error: errMsg }),
          });
          await client.query('COMMIT');
        } catch (dbErr) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          notifyError(dbErr, { context: 'instagram-uploader DB 실패 처리 중 오류', itemId: id });
        }

        notifyError(err, { context: 'instagram-uploader 게시 실패', itemId: id });
        results.failed++;
        results.items.push({ id, status: 'failed', error: errMsg });

        await sleep(1000);
      }
    }

    const statusLabel = results.failed === 0 ? 'completed' : 'error';
    const summaryLine =
      `총 ${items.length}건 처리 — 성공: ${results.success}, 실패: ${results.failed}, 건너뜀: ${results.skipped}`;

    await send({
      department: DEPARTMENT,
      task_type:  'instagram_upload',
      status:     statusLabel,
      summary:    summaryLine,
      detail:     JSON.stringify(results.items, null, 2),
    });

  } catch (fatalErr) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    notifyError(fatalErr, { context: 'instagram-uploader 치명적 오류' });

    await send({
      department: DEPARTMENT,
      task_type:  'instagram_upload',
      status:     'error',
      summary:    `인스타그램 업로더 실행 중 오류 발생: ${fatalErr.message}`,
      detail:     fatalErr.stack ?? String(fatalErr),
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);