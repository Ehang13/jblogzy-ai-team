import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function createMediaContainer(imageUrl, caption) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || `미디어 컨테이너 생성 실패 (HTTP ${res.status})`
    );
  }

  return data.id;
}

async function publishMedia(creationId) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_ACCOUNT_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || `미디어 게시 실패 (HTTP ${res.status})`
    );
  }

  return data.id;
}

async function markPublished(id) {
  const { error } = await supabase
    .from('content_queue')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) throw new Error(`DB 업데이트 실패(published): ${error.message}`);
}

async function markFailed(id, errorMessage) {
  const { error } = await supabase
    .from('content_queue')
    .update({
      status: 'failed',
      error_message: errorMessage,
    })
    .eq('id', id);

  if (error) throw new Error(`DB 업데이트 실패(failed): ${error.message}`);
}

async function logAgentTask({ taskType, status, summary, detail }) {
  const { error } = await supabase.from('agent_tasks').insert({
    department: DEPARTMENT,
    task_type: taskType,
    status,
    summary,
    detail,
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error('agent_tasks 로깅 실패:', error.message);
  }
}

export async function run() {
  console.log('[instagram-uploader] 실행 시작');

  // 1) content_queue에서 approved 항목 최대 5건 조회
  const { data: items, error: fetchError } = await supabase
    .from('content_queue')
    .select('*')
    .eq('platform', 'instagram')
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(5);

  if (fetchError) {
    await notifyError({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      error: fetchError,
      summary: 'content_queue 조회 실패',
    });
    throw new Error(`content_queue 조회 실패: ${fetchError.message}`);
  }

  if (!items || items.length === 0) {
    console.log('[instagram-uploader] 처리할 항목 없음');
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'completed',
      summary: '처리할 인스타그램 콘텐츠 없음',
      detail: '승인된(approved) 항목이 존재하지 않습니다.',
    });
    return;
  }

  console.log(`[instagram-uploader] 처리 대상: ${items.length}건`);

  const results = {
    total: items.length,
    published: 0,
    failed: 0,
    details: [],
  };

  // 2~4) 각 항목 처리
  for (const item of items) {
    const { id, image_url, caption } = item;
    console.log(`[instagram-uploader] 처리 중: id=${id}`);

    try {
      if (!image_url) {
        throw new Error('image_url이 없습니다.');
      }

      // 2) 미디어 컨테이너 생성
      const creationId = await createMediaContainer(
        image_url,
        caption || ''
      );
      console.log(`[instagram-uploader] 컨테이너 생성: creation_id=${creationId}`);

      // 3) 실제 게시
      const postId = await publishMedia(creationId);
      console.log(`[instagram-uploader] 게시 완료: post_id=${postId}`);

      // 4) 성공 상태 업데이트
      await markPublished(id);

      results.published += 1;
      results.details.push({ id, status: 'published', post_id: postId });

      // 5) agent_tasks 로깅 (개별 성공)
      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'completed',
        summary: `인스타그램 게시 성공 (id: ${id})`,
        detail: JSON.stringify({ id, post_id: postId, image_url, caption }),
      });
    } catch (err) {
      console.error(`[instagram-uploader] 처리 실패 id=${id}:`, err.message);

      // 4) 실패 상태 업데이트
      try {
        await markFailed(id, err.message);
      } catch (dbErr) {
        console.error(`[instagram-uploader] DB 실패 기록 오류 id=${id}:`, dbErr.message);
      }

      results.failed += 1;
      results.details.push({ id, status: 'failed', error: err.message });

      // 에러 알림 (프로세스 중단 없이 계속)
      await notifyError({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        error: err,
        summary: `인스타그램 게시 실패 (id: ${id})`,
      });

      // 5) agent_tasks 로깅 (개별 실패)
      await logAgentTask({
        taskType: 'instagram_upload',
        status: 'error',
        summary: `인스타그램 게시 실패 (id: ${id})`,
        detail: JSON.stringify({ id, error: err.message, image_url }),
      });
    }
  }

  // 최종 결과 리포트
  const summary = `인스타그램 자동 업로드 완료 — 전체: ${results.total}건, 성공: ${results.published}건, 실패: ${results.failed}건`;
  const overallStatus = results.failed === results.total ? 'error' : 'completed';

  await send({
    department: DEPARTMENT,
    task_type: 'instagram_upload',
    status: overallStatus,
    summary,
    detail: JSON.stringify(results.details, null, 2),
  });

  // 5) 최종 agent_tasks 로깅
  await logAgentTask({
    taskType: 'instagram_upload',
    status: overallStatus,
    summary,
    detail: JSON.stringify(results),
  });

  console.log(`[instagram-uploader] 완료 — ${summary}`);
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);