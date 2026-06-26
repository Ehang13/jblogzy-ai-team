import 'dotenv/config';
import { askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';
const MAX_PER_RUN = 5;
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createMediaContainer(imageUrl, caption) {
  const url = `${IG_API_BASE}/${IG_USER_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption || '',
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(`미디어 컨테이너 생성 실패: ${JSON.stringify(data.error || data)}`);
  }

  return data.id;
}

async function publishMediaContainer(containerId) {
  const url = `${IG_API_BASE}/${IG_USER_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(`미디어 게시 실패: ${JSON.stringify(data.error || data)}`);
  }

  return data.id;
}

async function updateQueueStatus(client, id, status, note = null) {
  await client.query(
    `UPDATE content_queue
     SET status = $1, updated_at = NOW(), note = $2
     WHERE id = $3`,
    [status, note, id]
  );
}

async function logAgentTask(client, { taskType, status, targetId, summary, detail }) {
  await client.query(
    `INSERT INTO agent_tasks (task_type, status, target_id, summary, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [taskType, status, targetId, summary, detail]
  );
}

export async function run() {
  const client = await pool.connect();
  const results = { success: 0, failed: 0, items: [] };

  try {
    const { rows: queueItems } = await client.query(
      `SELECT id, media_url, caption, created_at
       FROM content_queue
       WHERE status = 'approved'
         AND platform = 'instagram'
       ORDER BY created_at ASC
       LIMIT $1`,
      [MAX_PER_RUN]
    );

    if (queueItems.length === 0) {
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_uploader',
        status: 'completed',
        summary: '처리할 인스타그램 콘텐츠가 없습니다.',
        detail: '승인된(approved) 항목이 없어 이번 실행은 건너뜁니다.',
      });
      return;
    }

    for (const item of queueItems) {
      const { id, media_url, caption } = item;

      try {
        if (!media_url) {
          throw new Error('media_url이 비어 있습니다.');
        }

        // 1단계: 미디어 컨테이너 생성
        const containerId = await createMediaContainer(media_url, caption);

        // 2단계: 게시
        const publishedId = await publishMediaContainer(containerId);

        // 상태 업데이트: published
        await updateQueueStatus(client, id, 'published', `instagram_media_id: ${publishedId}`);

        // agent_tasks 로그
        await logAgentTask(client, {
          taskType: 'instagram_uploader',
          status: 'success',
          targetId: String(id),
          summary: `인스타그램 게시 성공 (queue_id: ${id})`,
          detail: JSON.stringify({ containerId, publishedId, media_url, caption }),
        });

        results.success++;
        results.items.push({ id, status: 'published', publishedId });

        // Rate limit 대응 딜레이
        await sleep(DELAY_MS);
      } catch (itemError) {
        // 개별 항목 실패 처리 — 프로세스 중단 없이 건너뜀
        const errMsg = itemError.message || String(itemError);

        try {
          await updateQueueStatus(client, id, 'failed', errMsg);
          await logAgentTask(client, {
            taskType: 'instagram_uploader',
            status: 'error',
            targetId: String(id),
            summary: `인스타그램 게시 실패 (queue_id: ${id})`,
            detail: errMsg,
          });
        } catch (dbErr) {
          await notifyError(dbErr, { context: `DB 업데이트 실패 (queue_id: ${id})` });
        }

        await notifyError(itemError, {
          context: `instagram_uploader - queue_id: ${id}`,
          media_url,
        });

        results.failed++;
        results.items.push({ id, status: 'failed', error: errMsg });

        await sleep(DELAY_MS);
      }
    }

    // AI 요약 생성
    const summaryPrompt = `
인스타그램 자동 업로드 실행 결과를 한 문장으로 간결하게 요약해 주세요.
- 총 처리: ${results.success + results.failed}건
- 성공: ${results.success}건
- 실패: ${results.failed}건
단언적 표현("확정", "보장", "100%")은 사용하지 마세요.
`.trim();

    let aiSummary = `인스타그램 업로드 완료 — 성공 ${results.success}건, 실패 ${results.failed}건`;
    try {
      aiSummary = await askFast(summaryPrompt, 100);
    } catch (_) {
      // AI 요약 실패는 무시
    }

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_uploader',
      status: results.failed > 0 && results.success === 0 ? 'error' : 'completed',
      summary: aiSummary,
      detail: JSON.stringify({
        total: results.success + results.failed,
        success: results.success,
        failed: results.failed,
        items: results.items,
      }),
    });
  } catch (fatalError) {
    await notifyError(fatalError, { context: 'instagram_uploader - 치명적 오류' });
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_uploader',
      status: 'error',
      summary: '인스타그램 업로더 실행 중 치명적 오류 발생',
      detail: fatalError.message || String(fatalError),
    });
  } finally {
    client.release();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);