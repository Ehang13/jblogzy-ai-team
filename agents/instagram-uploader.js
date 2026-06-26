import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_BUSINESS_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchApprovedItems() {
  const result = await pool.query(
    `SELECT * FROM content_queue
     WHERE platform = 'instagram' AND status = 'approved'
     ORDER BY created_at ASC`
  );
  return result.rows;
}

async function updateStatus(id, status, errorLog = null) {
  if (errorLog) {
    await pool.query(
      `UPDATE content_queue
       SET status = $1, error_log = $2, updated_at = NOW()
       WHERE id = $3`,
      [status, errorLog, id]
    );
  } else {
    await pool.query(
      `UPDATE content_queue
       SET status = $1, updated_at = NOW()
       WHERE id = $2`,
      [status, id]
    );
  }
}

async function logAgentTask({ taskType, status, summary, detail, refId }) {
  try {
    await pool.query(
      `INSERT INTO agent_tasks (department, task_type, status, summary, detail, ref_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [DEPARTMENT, taskType, status, summary, JSON.stringify(detail), refId]
    );
  } catch (err) {
    console.error('[agent_tasks 로깅 실패]', err.message);
  }
}

async function createMediaContainer(imageUrl, caption) {
  const url = `${IG_API_BASE}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || `컨테이너 생성 실패: HTTP ${res.status}`
    );
  }

  return data.id;
}

async function publishMediaContainer(containerId) {
  const url = `${IG_API_BASE}/${IG_BUSINESS_ACCOUNT_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || `게시 실패: HTTP ${res.status}`
    );
  }

  return data.id;
}

async function uploadWithRetry(item) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const imageUrl = item.image_url || item.media_url;
      const caption = item.caption || item.content || '';

      if (!imageUrl) {
        throw new Error('이미지 URL이 없습니다.');
      }

      console.log(`[시도 ${attempt}/${MAX_RETRIES}] 컨테이너 생성 중... (id: ${item.id})`);
      const containerId = await createMediaContainer(imageUrl, caption);

      console.log(`[시도 ${attempt}/${MAX_RETRIES}] 게시 중... (containerId: ${containerId})`);
      await sleep(5000); // 컨테이너 처리 대기
      const mediaId = await publishMediaContainer(containerId);

      return { success: true, mediaId, attempt };
    } catch (err) {
      lastError = err;
      console.error(`[시도 ${attempt}/${MAX_RETRIES}] 실패: ${err.message}`);

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`${delay}ms 후 재시도...`);
        await sleep(delay);
      }
    }
  }

  return { success: false, error: lastError?.message || '알 수 없는 오류' };
}

export async function run() {
  console.log('[instagram-uploader] 실행 시작');

  let items = [];
  try {
    items = await fetchApprovedItems();
    console.log(`[instagram-uploader] 승인된 항목: ${items.length}건`);
  } catch (err) {
    await notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      error: err,
      summary: 'content_queue 조회 실패',
    });
    return;
  }

  if (items.length === 0) {
    console.log('[instagram-uploader] 업로드할 항목 없음. 종료.');
    return;
  }

  const results = {
    total: items.length,
    published: 0,
    failed: 0,
    details: [],
  };

  for (const item of items) {
    console.log(`\n[처리 중] id=${item.id}, title=${item.title || '(제목 없음)'}`);

    try {
      const uploadResult = await uploadWithRetry(item);

      if (uploadResult.success) {
        await updateStatus(item.id, 'published');
        results.published++;

        const detail = {
          id: item.id,
          title: item.title,
          mediaId: uploadResult.mediaId,
          attempts: uploadResult.attempt,
          status: 'published',
        };
        results.details.push(detail);

        await logAgentTask({
          taskType: 'instagram_upload',
          status: 'completed',
          summary: `인스타그램 게시 성공: ${item.title || item.id}`,
          detail,
          refId: String(item.id),
        });

        console.log(`[성공] id=${item.id}, mediaId=${uploadResult.mediaId}`);
      } else {
        const errorMsg = uploadResult.error;
        await updateStatus(item.id, 'failed', errorMsg);
        results.failed++;

        const detail = {
          id: item.id,
          title: item.title,
          error: errorMsg,
          attempts: MAX_RETRIES,
          status: 'failed',
        };
        results.details.push(detail);

        await logAgentTask({
          taskType: 'instagram_upload',
          status: 'error',
          summary: `인스타그램 게시 실패: ${item.title || item.id}`,
          detail,
          refId: String(item.id),
        });

        await notifyError({
          department: DEPARTMENT,
          task_type: 'instagram_upload',
          error: new Error(errorMsg),
          summary: `인스타그램 게시 최종 실패 (id: ${item.id})`,
        });

        console.error(`[최종 실패] id=${item.id}, error=${errorMsg}`);
      }
    } catch (err) {
      // 예상치 못한 오류 - 해당 항목 건너뜀
      const errorMsg = err.message || '처리 중 예외 발생';
      console.error(`[예외] id=${item.id}, error=${errorMsg}`);

      try {
        await updateStatus(item.id, 'failed', errorMsg);
        results.failed++;

        results.details.push({
          id: item.id,
          title: item.title,
          error: errorMsg,
          status: 'failed',
        });

        await notifyError({
          department: DEPARTMENT,
          task_type: 'instagram_upload',
          error: err,
          summary: `인스타그램 업로드 예외 발생 (id: ${item.id})`,
        });
      } catch (innerErr) {
        console.error('[내부 오류 처리 실패]', innerErr.message);
      }
    }
  }

  // 최종 리포트
  const summary = `인스타그램 업로드 완료: 전체 ${results.total}건 중 성공 ${results.published}건, 실패 ${results.failed}건`;
  console.log(`\n[완료] ${summary}`);

  try {
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: results.failed === results.total && results.total > 0 ? 'error' : 'completed',
      summary,
      detail: results,
    });
  } catch (err) {
    console.error('[리포트 전송 실패]', err.message);
  }

  await pool.end();
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);