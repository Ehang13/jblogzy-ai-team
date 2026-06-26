import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import { createClient } from '@supabase/supabase-js';

const DEPARTMENT = 'chm';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createMediaContainer(imageUrl, caption) {
  const url = `${IG_API_BASE}/${IG_USER_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Media container creation failed: ${res.status}`);
  }

  return data.id;
}

async function publishMedia(creationId) {
  const url = `${IG_API_BASE}/${IG_USER_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Media publish failed: ${res.status}`);
  }

  return data.id;
}

async function markPublished(id, mediaId) {
  const { error } = await supabase
    .from('content_queue')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      error_log: null,
    })
    .eq('id', id);

  if (error) throw new Error(`DB update (published) failed: ${error.message}`);
}

async function markFailed(id, errorMessage) {
  const { error } = await supabase
    .from('content_queue')
    .update({
      status: 'failed',
      error_log: errorMessage,
    })
    .eq('id', id);

  if (error) console.error(`DB update (failed) error for id=${id}:`, error.message);
}

async function logAgentTask({ taskType, status, summary, detail }) {
  const { error } = await supabase.from('agent_tasks').insert({
    agent: 'instagram-uploader',
    task_type: taskType,
    status,
    summary,
    detail,
    created_at: new Date().toISOString(),
  });

  if (error) console.error('agent_tasks insert error:', error.message);
}

export async function run() {
  console.log('[instagram-uploader] 시작');

  let approvedItems = [];

  try {
    const { data, error } = await supabase
      .from('content_queue')
      .select('*')
      .eq('status', 'approved')
      .eq('platform', 'instagram')
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) throw new Error(`Supabase 조회 오류: ${error.message}`);
    approvedItems = data || [];
  } catch (err) {
    await notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      error: err,
      summary: 'Supabase 콘텐츠 큐 조회 실패',
    });
    return;
  }

  console.log(`[instagram-uploader] 승인된 항목 ${approvedItems.length}건 조회됨`);

  if (approvedItems.length === 0) {
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'completed',
      summary: '업로드할 승인된 Instagram 콘텐츠가 없습니다.',
      detail: '대기 중인 항목 없음',
    });
    return;
  }

  let successCount = 0;
  let failCount = 0;
  const results = [];

  for (let i = 0; i < approvedItems.length; i++) {
    const item = approvedItems[i];
    console.log(`[instagram-uploader] 처리 중 (${i + 1}/${approvedItems.length}) id=${item.id}`);

    try {
      if (!item.image_url) {
        throw new Error('image_url이 없습니다.');
      }

      const caption = item.caption || '';

      // Step 1: 미디어 컨테이너 생성
      const creationId = await createMediaContainer(item.image_url, caption);
      console.log(`[instagram-uploader] 컨테이너 생성 완료: creationId=${creationId}`);

      await sleep(500);

      // Step 2: 미디어 게시
      const publishedMediaId = await publishMedia(creationId);
      console.log(`[instagram-uploader] 게시 완료: mediaId=${publishedMediaId}`);

      // Step 3: DB 상태 업데이트
      await markPublished(item.id, publishedMediaId);

      // Step 4: agent_tasks 로그
      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'success',
        summary: `Instagram 게시 성공 (id=${item.id})`,
        detail: JSON.stringify({ item_id: item.id, media_id: publishedMediaId, caption }),
      });

      successCount++;
      results.push({ id: item.id, status: 'published', mediaId: publishedMediaId });
    } catch (err) {
      console.error(`[instagram-uploader] 게시 실패 id=${item.id}:`, err.message);

      await markFailed(item.id, err.message);

      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'error',
        summary: `Instagram 게시 실패 (id=${item.id})`,
        detail: JSON.stringify({ item_id: item.id, error: err.message }),
      });

      await notifyError({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        error: err,
        summary: `Instagram 게시 실패: id=${item.id}`,
      });

      failCount++;
      results.push({ id: item.id, status: 'failed', error: err.message });
    }

    // API 레이트 리밋 준수 (200req/h): 각 항목 처리 후 500ms 대기
    if (i < approvedItems.length - 1) {
      await sleep(500);
    }
  }

  const summary = `Instagram 업로드 완료 - 성공: ${successCount}건, 실패: ${failCount}건 (총 ${approvedItems.length}건 처리)`;
  const detail = results.map(r =>
    r.status === 'published'
      ? `✅ id=${r.id} → mediaId=${r.mediaId}`
      : `❌ id=${r.id} → ${r.error}`
  ).join('\n');

  console.log(`[instagram-uploader] ${summary}`);

  await send({
    department: DEPARTMENT,
    task_type: 'instagram_upload',
    status: failCount > 0 && successCount === 0 ? 'error' : 'completed',
    summary,
    detail,
    success_count: successCount,
    fail_count: failCount,
    total_count: approvedItems.length,
  });

  console.log('[instagram-uploader] 종료');
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);