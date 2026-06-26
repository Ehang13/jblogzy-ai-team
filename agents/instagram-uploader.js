import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';

async function createMediaContainer(imageUrl, caption) {
  const url = `${IG_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      `미디어 컨테이너 생성 실패: ${data.error?.message || JSON.stringify(data)}`
    );
  }

  return data.id;
}

async function publishMediaContainer(containerId) {
  const url = `${IG_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      `게시 확정 실패: ${data.error?.message || JSON.stringify(data)}`
    );
  }

  return data.id;
}

async function updateContentStatus(client, id, status) {
  await client.query(
    `UPDATE content_queue SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
}

async function logAgentTask(client, { contentId, status, message, detail }) {
  await client.query(
    `INSERT INTO agent_tasks (task_type, ref_id, status, message, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      'instagram_upload',
      contentId,
      status,
      message,
      detail ? JSON.stringify(detail) : null,
    ]
  );
}

export async function run() {
  const client = await pool.connect();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const results = [];

  try {
    const { rows: items } = await client.query(
      `SELECT id, media_url, caption, created_at
       FROM content_queue
       WHERE status = 'approved' AND platform = 'instagram'
       ORDER BY created_at ASC`
    );

    if (items.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        status: 'completed',
        summary: '업로드 대상 항목이 없습니다.',
        detail: { processed: 0, succeeded: 0, failed: 0 },
      });
      return { processed: 0, succeeded: 0, failed: 0, results: [] };
    }

    for (const item of items) {
      processed++;
      const { id, media_url, caption } = item;

      try {
        if (!media_url) {
          throw new Error('media_url이 비어 있습니다.');
        }
        if (!caption) {
          throw new Error('caption이 비어 있습니다.');
        }

        // 1단계: 미디어 컨테이너 생성
        const containerId = await createMediaContainer(media_url, caption);

        // 잠시 대기 (Instagram API 처리 시간 고려)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 2단계: 게시 확정
        const publishedId = await publishMediaContainer(containerId);

        // 상태 업데이트: published
        await updateContentStatus(client, id, 'published');

        // 로그 기록
        await logAgentTask(client, {
          contentId: id,
          status: 'success',
          message: `Instagram 게시 완료 (media_id: ${publishedId})`,
          detail: { containerId, publishedId, media_url },
        });

        succeeded++;
        results.push({ id, status: 'published', publishedId });
      } catch (err) {
        // 상태 업데이트: failed
        try {
          await updateContentStatus(client, id, 'failed');
          await logAgentTask(client, {
            contentId: id,
            status: 'error',
            message: err.message,
            detail: { media_url, error: err.message },
          });
        } catch (dbErr) {
          notifyError(dbErr, { context: `DB 업데이트 실패 (content_queue id=${id})` });
        }

        notifyError(err, {
          context: `Instagram 업로드 실패 (content_queue id=${id})`,
          media_url,
        });

        failed++;
        results.push({ id, status: 'failed', error: err.message });
      }

      // API 요청 간격 (Rate Limit 방지)
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const summary = `Instagram 업로드 완료 — 전체: ${processed}건, 성공: ${succeeded}건, 실패: ${failed}건`;

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: failed > 0 && succeeded === 0 ? 'error' : 'completed',
      summary,
      detail: {
        processed,
        succeeded,
        failed,
        results,
      },
    });

    return { processed, succeeded, failed, results };
  } catch (err) {
    notifyError(err, { context: 'Instagram 업로더 실행 중 치명적 오류' });

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'error',
      summary: `Instagram 업로더 실행 오류: ${err.message}`,
      detail: { processed, succeeded, failed, error: err.message },
    });

    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);