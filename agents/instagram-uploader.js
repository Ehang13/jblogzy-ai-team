import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';
const DAILY_LIMIT = 25;

const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };
}

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: { ...sbHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase fetch error [${res.status}] ${path}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getApprovedInstagramContent() {
  return sbFetch(
    `/content_queue?platform=eq.instagram&status=eq.approved&order=created_at.asc`,
    { method: 'GET', headers: { Prefer: 'return=representation' } }
  );
}

async function getTodayPublishedCount() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = await sbFetch(
    `/content_queue?platform=eq.instagram&status=eq.published&published_at=gte.${todayStart.toISOString()}`,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows.length : 0;
}

async function updateContentStatus(id, status, extra = {}) {
  return sbFetch(`/content_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status, ...extra }),
  });
}

async function logAgentTask(data) {
  return sbFetch('/agent_tasks', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
}

async function createIgMediaContainer(imageUrl, caption) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: IG_ACCESS_TOKEN,
  });
  const res = await fetch(`${IG_API_BASE}/${IG_ACCOUNT_ID}/media`, {
    method: 'POST',
    body: params,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      `컨테이너 생성 실패: ${JSON.stringify(data.error || data)}`
    );
  }
  return data.id;
}

async function publishIgMedia(containerId) {
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: IG_ACCESS_TOKEN,
  });
  const res = await fetch(`${IG_API_BASE}/${IG_ACCOUNT_ID}/media_publish`, {
    method: 'POST',
    body: params,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      `게시 실패: ${JSON.stringify(data.error || data)}`
    );
  }
  return data.id;
}

async function waitForContainerReady(containerId, maxRetries = 10, delayMs = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(
      `${IG_API_BASE}/${containerId}?fields=status_code&access_token=${IG_ACCESS_TOKEN}`
    );
    const data = await res.json();
    if (data.status_code === 'FINISHED') return true;
    if (data.status_code === 'ERROR') {
      throw new Error(`컨테이너 처리 오류: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('컨테이너 준비 타임아웃');
}

export async function run() {
  const runAt = new Date().toISOString();
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;
  const details = [];

  let approvedItems = [];
  try {
    approvedItems = await getApprovedInstagramContent();
    if (!Array.isArray(approvedItems)) approvedItems = [];
  } catch (err) {
    await notifyError('instagram-uploader', '승인 콘텐츠 조회 실패', err);
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'error',
      summary: '승인 콘텐츠 조회 중 오류 발생',
      detail: err.message,
      run_at: runAt,
    });
    return;
  }

  if (approvedItems.length === 0) {
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'completed',
      summary: '업로드할 승인된 인스타그램 콘텐츠 없음',
      detail: '조회된 항목 없음',
      run_at: runAt,
    });
    return;
  }

  let todayCount = 0;
  try {
    todayCount = await getTodayPublishedCount();
  } catch (err) {
    await notifyError('instagram-uploader', '일별 카운터 조회 실패', err);
    todayCount = 0;
  }

  for (const item of approvedItems) {
    if (todayCount >= DAILY_LIMIT) {
      skipCount++;
      details.push({
        id: item.id,
        result: 'skipped',
        reason: `일별 게시 한도(${DAILY_LIMIT}건) 초과`,
      });
      continue;
    }

    const imageUrl = item.image_url || item.media_url;
    const caption = item.caption || item.content || '';

    if (!imageUrl) {
      skipCount++;
      details.push({
        id: item.id,
        result: 'skipped',
        reason: '이미지 URL 없음',
      });
      try {
        await updateContentStatus(item.id, 'failed');
        await logAgentTask({
          agent: 'instagram-uploader',
          content_id: item.id,
          status: 'error',
          message: '이미지 URL이 없어 업로드를 건너뜀',
          created_at: new Date().toISOString(),
        });
      } catch (logErr) {
        await notifyError('instagram-uploader', '상태 업데이트 실패', logErr);
      }
      continue;
    }

    try {
      const containerId = await createIgMediaContainer(imageUrl, caption);
      await waitForContainerReady(containerId);
      const igMediaId = await publishIgMedia(containerId);

      const publishedAt = new Date().toISOString();
      await updateContentStatus(item.id, 'published', {
        published_at: publishedAt,
        ig_media_id: igMediaId,
      });

      successCount++;
      todayCount++;
      details.push({
        id: item.id,
        result: 'success',
        ig_media_id: igMediaId,
        published_at: publishedAt,
      });
    } catch (err) {
      failCount++;
      details.push({
        id: item.id,
        result: 'failed',
        error: err.message,
      });

      try {
        await updateContentStatus(item.id, 'failed');
        await logAgentTask({
          agent: 'instagram-uploader',
          content_id: item.id,
          status: 'error',
          message: err.message,
          created_at: new Date().toISOString(),
        });
      } catch (logErr) {
        await notifyError('instagram-uploader', '실패 상태 기록 오류', logErr);
      }

      await notifyError('instagram-uploader', `콘텐츠 ID ${item.id} 업로드 실패`, err);
    }

    // API 요청 간 간격
    await new Promise((r) => setTimeout(r, 1500));
  }

  const summary = `인스타그램 업로드 완료 — 성공: ${successCount}건, 실패: ${failCount}건, 스킵: ${skipCount}건 (오늘 누적 게시: ${todayCount}건)`;

  try {
    await logAgentTask({
      agent: 'instagram-uploader',
      status: 'completed',
      message: summary,
      detail: JSON.stringify(details),
      success_count: successCount,
      fail_count: failCount,
      skip_count: skipCount,
      today_published_count: todayCount,
      created_at: runAt,
    });
  } catch (logErr) {
    await notifyError('instagram-uploader', '결과 요약 저장 실패', logErr);
  }

  await send({
    department: DEPARTMENT,
    task_type: 'instagram_upload',
    status: failCount > 0 && successCount === 0 ? 'error' : 'completed',
    summary,
    detail: details
      .map(
        (d) =>
          `[${d.result.toUpperCase()}] ID:${d.id}${d.ig_media_id ? ` → IG:${d.ig_media_id}` : ''}${d.error ? ` 오류:${d.error}` : ''}${d.reason ? ` 사유:${d.reason}` : ''}`
      )
      .join('\n'),
    run_at: runAt,
    success_count: successCount,
    fail_count: failCount,
    skip_count: skipCount,
    today_count: todayCount,
  });
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);