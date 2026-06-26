import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status === 500) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.log(`[Retry] HTTP ${response.status} — attempt ${attempt + 1}/${maxRetries}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      return response;
    } catch (err) {
      const waitMs = Math.pow(2, attempt) * 1000;
      console.log(`[Retry] Network error — attempt ${attempt + 1}/${maxRetries}, waiting ${waitMs}ms`);
      await sleep(waitMs);
      lastError = err;
    }
  }
  throw lastError;
}

async function createMediaContainer(imageUrl, caption) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: IG_ACCESS_TOKEN,
  });

  const response = await fetchWithRetry(
    `${GRAPH_API_BASE}/${IG_USER_ID}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }
  );

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Container creation failed: HTTP ${response.status}`);
  }
  return data.id;
}

async function publishMediaContainer(containerId) {
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: IG_ACCESS_TOKEN,
  });

  const response = await fetchWithRetry(
    `${GRAPH_API_BASE}/${IG_USER_ID}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }
  );

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Publish failed: HTTP ${response.status}`);
  }
  return data.id;
}

async function getApprovedInstagramItems(client) {
  const result = await client.query(
    `SELECT * FROM content_queue
     WHERE platform = 'instagram' AND status = 'approved'
     ORDER BY created_at ASC`
  );
  return result.rows;
}

async function updateContentStatus(client, id, status, errorMessage = null) {
  if (errorMessage) {
    await client.query(
      `UPDATE content_queue
       SET status = $1, error_log = $2, updated_at = NOW()
       WHERE id = $3`,
      [status, errorMessage, id]
    );
  } else {
    await client.query(
      `UPDATE content_queue
       SET status = $1, updated_at = NOW()
       WHERE id = $2`,
      [status, id]
    );
  }
}

async function logAgentTask(client, { taskType, status, summary, detail, relatedId }) {
  try {
    await client.query(
      `INSERT INTO agent_tasks (task_type, status, summary, detail, related_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [taskType, status, summary, JSON.stringify(detail), relatedId]
    );
  } catch (err) {
    console.error('[AgentTask Log Error]', err.message);
  }
}

export async function run() {
  const client = await pool.connect();
  let successCount = 0;
  let failCount = 0;
  const failedItems = [];

  try {
    console.log('[instagram-uploader] Starting Instagram upload agent...');

    const items = await getApprovedInstagramItems(client);
    console.log(`[instagram-uploader] Found ${items.length} approved item(s) to process.`);

    if (items.length === 0) {
      console.log('[instagram-uploader] No items to process. Exiting.');
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        status: 'completed',
        summary: '처리할 승인된 인스타그램 콘텐츠가 없습니다.',
        detail: { successCount: 0, failCount: 0, totalItems: 0 },
      });
      return;
    }

    for (const item of items) {
      const { id, image_url, caption, title } = item;
      console.log(`[instagram-uploader] Processing item ID=${id}, title="${title || '(no title)'}"`);

      try {
        if (!image_url) {
          throw new Error('image_url이 없어 Instagram 게시를 진행할 수 없습니다.');
        }

        // Step 1: Create media container
        console.log(`[instagram-uploader] Creating media container for item ID=${id}...`);
        const containerId = await createMediaContainer(image_url, caption || '');

        // Step 2: Publish media container
        console.log(`[instagram-uploader] Publishing container ${containerId} for item ID=${id}...`);
        const postId = await publishMediaContainer(containerId);

        // Step 3: Update status to published
        await updateContentStatus(client, id, 'published');

        // Step 4: Log agent task (success)
        await logAgentTask(client, {
          taskType: 'instagram_upload',
          status: 'success',
          summary: `Instagram 게시 성공: item ID=${id}`,
          detail: { itemId: id, containerId, postId, imageUrl: image_url },
          relatedId: id,
        });

        console.log(`[instagram-uploader] ✅ Successfully published item ID=${id}, Instagram post ID=${postId}`);
        successCount++;

      } catch (err) {
        console.error(`[instagram-uploader] ❌ Failed to publish item ID=${id}:`, err.message);
        failedItems.push({ id, error: err.message });

        // Update status to failed
        try {
          await updateContentStatus(client, id, 'failed', err.message);
        } catch (updateErr) {
          console.error(`[instagram-uploader] Failed to update status for item ID=${id}:`, updateErr.message);
        }

        // Log agent task (failure)
        await logAgentTask(client, {
          taskType: 'instagram_upload',
          status: 'failed',
          summary: `Instagram 게시 실패: item ID=${id}`,
          detail: { itemId: id, error: err.message },
          relatedId: id,
        });

        notifyError({
          department: DEPARTMENT,
          task_type: 'instagram_upload',
          error: err,
          context: { itemId: id, imageUrl: item.image_url },
        });

        failCount++;
      }
    }

    // Summary output
    console.log('\n========================================');
    console.log('[instagram-uploader] 📊 Upload Summary');
    console.log(`  Total processed : ${items.length}`);
    console.log(`  ✅ Success       : ${successCount}`);
    console.log(`  ❌ Failed        : ${failCount}`);
    if (failedItems.length > 0) {
      console.log('  Failed items:');
      failedItems.forEach(f => console.log(`    - ID=${f.id}: ${f.error}`));
    }
    console.log('========================================\n');

    const finalStatus = failCount === 0 ? 'completed' : (successCount === 0 ? 'error' : 'completed');

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: finalStatus,
      summary: `Instagram 업로드 완료 — 성공: ${successCount}건, 실패: ${failCount}건`,
      detail: {
        totalItems: items.length,
        successCount,
        failCount,
        failedItems,
      },
    });

  } catch (err) {
    console.error('[instagram-uploader] Fatal error:', err);
    notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      error: err,
      context: { phase: 'main_run' },
    });
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'error',
      summary: `Instagram 업로드 에이전트 오류: ${err.message}`,
      detail: { error: err.message, successCount, failCount },
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);