import 'dotenv/config';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;

const DEPARTMENT = 'chm';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMediaContainer(imageUrl, caption) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, {
    method: 'POST',
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      `미디어 컨테이너 생성 실패: ${JSON.stringify(data.error || data)}`
    );
  }

  return data.id;
}

async function publishMediaContainer(creationId) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, {
    method: 'POST',
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      `미디어 게시 확정 실패: ${JSON.stringify(data.error || data)}`
    );
  }

  return data.id;
}

async function updateQueueStatus(client, id, status) {
  await client.query(
    `UPDATE content_queue SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
}

async function logAgentTask(client, { queueId, status, summary, detail }) {
  await client.query(
    `INSERT INTO agent_tasks (task_type, ref_id, status, summary, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    ['instagram_upload', queueId, status, summary, detail]
  );
}

async function fetchApprovedItems(client) {
  const res = await client.query(
    `SELECT id, caption, media_url FROM content_queue
     WHERE status = 'approved' AND platform = 'instagram'
     ORDER BY created_at ASC`
  );
  return res.rows;
}

export async function run() {
  const client = await pool.connect();

  try {
    const items = await fetchApprovedItems(client);

    if (items.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        status: 'completed',
        summary: '업로드 대상 항목 없음',
        detail: 'status=approved, platform=instagram 항목이 없습니다.',
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const item of items) {
      const { id, caption, media_url } = item;

      try {
        if (!media_url) {
          throw new Error('media_url이 비어 있습니다.');
        }

        // 1단계: 미디어 컨테이너 생성
        const creationId = await createMediaContainer(
          media_url,
          caption || ''
        );

        // 2단계: 게시 확정
        const publishedId = await publishMediaContainer(creationId);

        await updateQueueStatus(client, id, 'published');

        await logAgentTask(client, {
          queueId: id,
          status: 'completed',
          summary: '인스타그램 게시 성공',
          detail: `creation_id=${creationId}, published_media_id=${publishedId}`,
        });

        successCount++;
      } catch (err) {
        await updateQueueStatus(client, id, 'failed').catch(() => {});

        await logAgentTask(client, {
          queueId: id,
          status: 'error',
          summary: '인스타그램 게시 실패',
          detail: err.message,
        }).catch(() => {});

        notifyError({
          department: DEPARTMENT,
          task_type: 'instagram_upload',
          summary: `항목 ${id} 업로드 실패`,
          detail: err.message,
        });

        failCount++;
      }

      // 레이트 리밋 대응: 항목당 2초 딜레이
      await sleep(2000);
    }

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: failCount > 0 && successCount === 0 ? 'error' : 'completed',
      summary: `인스타그램 업로드 완료 (성공: ${successCount}, 실패: ${failCount})`,
      detail: `총 ${items.length}개 항목 처리. 성공: ${successCount}개, 실패: ${failCount}개.`,
    });
  } catch (err) {
    notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      summary: '인스타그램 업로더 실행 오류',
      detail: err.message,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);