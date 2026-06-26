import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';
const INSTAGRAM_API_BASE = 'https://graph.instagram.com/v21.0';
const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15분

// ── DB 헬퍼 (카페24 report API 활용) ──────────────────────────────────────
const BASE = process.env.CAFE24_API_URL?.replace('/report.php', '') ?? '';
const KEY  = process.env.CAFE24_API_KEY ?? '';

async function dbQuery(sql) {
  const res = await fetch(`${BASE}/query.php`, {
    method: 'POST',
    headers: {
      'X-Api-Key': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function dbExecute(sql) {
  const res = await fetch(`${BASE}/execute.php`, {
    method: 'POST',
    headers: {
      'X-Api-Key': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) throw new Error(`DB execute failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── 지수 백오프 재시도 ────────────────────────────────────────────────────
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(`[instagram-uploader] 재시도 ${attempt + 1}/${retries - 1}, ${delay}ms 대기:`, err.message);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ── Instagram Graph API ───────────────────────────────────────────────────
async function createMediaContainer({ igUserId, accessToken, imageUrl, caption }) {
  return withRetry(async () => {
    const url = new URL(`${INSTAGRAM_API_BASE}/${igUserId}/media`);
    url.searchParams.set('image_url', imageUrl);
    url.searchParams.set('caption', caption ?? '');
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString(), { method: 'POST' });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error?.message ?? `미디어 컨테이너 생성 실패 (${res.status})`);
    }
    return data.id; // creation_id
  });
}

async function publishMedia({ igUserId, accessToken, creationId }) {
  return withRetry(async () => {
    const url = new URL(`${INSTAGRAM_API_BASE}/${igUserId}/media_publish`);
    url.searchParams.set('creation_id', creationId);
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString(), { method: 'POST' });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error?.message ?? `미디어 게시 실패 (${res.status})`);
    }
    return data.id; // media_id
  });
}

// ── content_queue 상태 업데이트 ───────────────────────────────────────────
async function markPublished(id, mediaId) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await dbExecute(
    `UPDATE content_queue
     SET status='published', published_at='${now}', external_id='${mediaId}'
     WHERE id=${id}`
  );
}

async function markFailed(id, errorMsg) {
  const safeMsg = errorMsg.replace(/'/g, "''").slice(0, 500);
  await dbExecute(
    `UPDATE content_queue
     SET status='failed', error_log='${safeMsg}'
     WHERE id=${id}`
  );
}

// ── agent_tasks 로깅 ──────────────────────────────────────────────────────
async function logAgentTask({ taskType, status, detail }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const safeDetail = JSON.stringify(detail).replace(/'/g, "''").slice(0, 2000);
  await dbExecute(
    `INSERT INTO agent_tasks (agent_name, task_type, status, detail, created_at)
     VALUES ('instagram-uploader', '${taskType}', '${status}', '${safeDetail}', '${now}')`
  ).catch(err => console.warn('[instagram-uploader] agent_tasks 로깅 실패:', err.message));
}

// ── 승인된 큐 항목 조회 ───────────────────────────────────────────────────
async function fetchApprovedItems() {
  const result = await dbQuery(
    `SELECT id, member_id, image_url, caption, ig_user_id, ig_access_token
     FROM content_queue
     WHERE platform='instagram' AND status='approved'
     ORDER BY created_at ASC
     LIMIT 20`
  );
  return result.rows ?? result.data ?? [];
}

// ── 단일 항목 업로드 처리 ─────────────────────────────────────────────────
async function processItem(item) {
  const { id, image_url, caption, ig_user_id, ig_access_token } = item;

  const igUserId     = ig_user_id     ?? process.env.INSTAGRAM_USER_ID;
  const accessToken  = ig_access_token ?? process.env.INSTAGRAM_ACCESS_TOKEN;

  if (!igUserId || !accessToken) {
    throw new Error('Instagram 사용자 ID 또는 액세스 토큰이 없습니다.');
  }
  if (!image_url) {
    throw new Error('이미지 URL이 없습니다.');
  }

  console.log(`[instagram-uploader] 처리 중 id=${id}, imageUrl=${image_url}`);

  // 1) 미디어 컨테이너 생성
  const creationId = await createMediaContainer({
    igUserId,
    accessToken,
    imageUrl: image_url,
    caption: caption ?? '',
  });

  // 2) 게시 요청
  const mediaId = await publishMedia({ igUserId, accessToken, creationId });

  return mediaId;
}

// ── 메인 폴링 루프 ────────────────────────────────────────────────────────
export async function run() {
  console.log('[instagram-uploader] 실행 시작');

  let totalSuccess = 0;
  let totalFailed  = 0;
  const failedItems = [];

  // 승인 항목 조회
  let items = [];
  try {
    items = await fetchApprovedItems();
    console.log(`[instagram-uploader] 승인된 항목 ${items.length}건 조회`);
  } catch (err) {
    await notifyError(err, '[instagram-uploader] content_queue 조회 실패');
    await logAgentTask({ taskType: 'fetch_queue', status: 'error', detail: { error: err.message } });
    return;
  }

  if (items.length === 0) {
    console.log('[instagram-uploader] 업로드할 항목 없음');
    await logAgentTask({ taskType: 'poll', status: 'skipped', detail: { message: '승인 항목 없음' } });
    return;
  }

  // 항목별 처리
  for (const item of items) {
    try {
      const mediaId = await processItem(item);
      await markPublished(item.id, mediaId);
      totalSuccess++;
      console.log(`[instagram-uploader] id=${item.id} 게시 완료, mediaId=${mediaId}`);

      await logAgentTask({
        taskType: 'upload',
        status: 'success',
        detail: { queueId: item.id, mediaId },
      });
    } catch (err) {
      totalFailed++;
      failedItems.push({ id: item.id, error: err.message });
      console.error(`[instagram-uploader] id=${item.id} 실패:`, err.message);

      try {
        await markFailed(item.id, err.message);
      } catch (dbErr) {
        console.error(`[instagram-uploader] id=${item.id} 상태 업데이트 실패:`, dbErr.message);
      }

      await logAgentTask({
        taskType: 'upload',
        status: 'error',
        detail: { queueId: item.id, error: err.message },
      });

      // 프로세스 중단 없이 다음 항목으로
      await notifyError(err, `[instagram-uploader] 항목 id=${item.id} 업로드 실패`).catch(() => {});
    }
  }

  // 실행 결과 리포팅
  const summary = `Instagram 업로드 완료: 성공 ${totalSuccess}건 / 실패 ${totalFailed}건`;
  const detail  = [
    `총 처리 대상: ${items.length}건`,
    `성공: ${totalSuccess}건`,
    `실패: ${totalFailed}건`,
    failedItems.length > 0
      ? `실패 항목: ${failedItems.map(f => `id=${f.id}(${f.error})`).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');

  await send({
    department: DEPARTMENT,
    task_type: 'instagram_upload',
    status: totalFailed > 0 && totalSuccess === 0 ? 'error' : 'completed',
    summary,
    detail,
    success_count: totalSuccess,
    fail_count: totalFailed,
  });

  await logAgentTask({
    taskType: 'poll_result',
    status: 'completed',
    detail: { total: items.length, success: totalSuccess, failed: totalFailed, failedItems },
  });

  console.log(`[instagram-uploader] 완료 — ${summary}`);
}

// ── 주기적 폴링 실행 ──────────────────────────────────────────────────────
async function startPolling() {
  await run().catch(err => notifyError(err, '[instagram-uploader] run() 오류'));

  setInterval(async () => {
    await run().catch(err => notifyError(err, '[instagram-uploader] run() 오류'));
  }, POLL_INTERVAL_MS);
}

if (process.argv[1]?.endsWith('instagram-uploader.js')) {
  startPolling().catch(console.error);
}