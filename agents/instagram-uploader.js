import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const DEPARTMENT = 'chm';
const TASK_TYPE = 'instagram_auto_upload';
const BATCH_SIZE = 5;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const IG_API_BASE = 'https://graph.facebook.com/v19.0';

async function createMediaContainer(imageUrl, caption) {
  const url = `${IG_API_BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`;
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

async function publishMediaContainer(containerId) {
  const url = `${IG_API_BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
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

async function updateQueueStatus(id, status, errorMessage = null) {
  const updateData = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (errorMessage) {
    updateData.error_message = errorMessage;
  }
  if (status === 'published') {
    updateData.published_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('content_queue')
    .update(updateData)
    .eq('id', id);

  if (error) {
    throw new Error(`content_queue 상태 업데이트 실패: ${error.message}`);
  }
}

async function recordAgentTask({ successCount, failCount, errors, details }) {
  const { error } = await supabase.from('agent_tasks').insert({
    task_type: TASK_TYPE,
    department: DEPARTMENT,
    status: failCount === 0 ? 'completed' : successCount === 0 ? 'failed' : 'partial',
    success_count: successCount,
    fail_count: failCount,
    error_messages: errors.length > 0 ? errors : null,
    detail: details,
    executed_at: new Date().toISOString(),
  });

  if (error) {
    console.error('agent_tasks 기록 실패:', error.message);
  }
}

export async function run() {
  console.log(`[${new Date().toISOString()}] Instagram 자동 업로드 에이전트 시작`);

  let successCount = 0;
  let failCount = 0;
  const errors = [];
  const details = [];

  try {
    // 1) approved 상태의 콘텐츠 배치 조회
    const { data: queueItems, error: fetchError } = await supabase
      .from('content_queue')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      throw new Error(`content_queue 조회 실패: ${fetchError.message}`);
    }

    if (!queueItems || queueItems.length === 0) {
      console.log('업로드할 approved 항목이 없습니다.');
      await recordAgentTask({
        successCount: 0,
        failCount: 0,
        errors: [],
        details: [{ message: '처리할 항목 없음' }],
      });
      await send({
        department: DEPARTMENT,
        task_type: TASK_TYPE,
        status: 'completed',
        summary: 'Instagram 자동 업로드: 처리할 항목 없음',
        detail: 'approved 상태의 콘텐츠가 없어 작업을 종료합니다.',
      });
      return;
    }

    console.log(`총 ${queueItems.length}건 처리 시작`);

    // 2~4) 각 항목 처리
    for (const item of queueItems) {
      try {
        console.log(`[${item.id}] 처리 중 - ${item.image_url}`);

        // 2) 미디어 컨테이너 생성
        const containerId = await createMediaContainer(item.image_url, item.caption || '');
        console.log(`[${item.id}] 컨테이너 생성 완료: ${containerId}`);

        // 컨테이너 준비 대기 (짧은 딜레이)
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 3) 실제 게시
        const postId = await publishMediaContainer(containerId);
        console.log(`[${item.id}] 게시 완료: ${postId}`);

        // 4) 성공 상태 업데이트
        await updateQueueStatus(item.id, 'published');
        successCount++;
        details.push({
          id: item.id,
          status: 'published',
          instagram_post_id: postId,
        });
      } catch (itemError) {
        console.error(`[${item.id}] 처리 실패:`, itemError.message);

        // 에러 발생 시 해당 항목 건너뜀 (프로세스 중단 없음)
        try {
          await updateQueueStatus(item.id, 'failed', itemError.message);
        } catch (updateError) {
          console.error(`[${item.id}] 상태 업데이트 실패:`, updateError.message);
        }

        failCount++;
        errors.push({ id: item.id, error: itemError.message });
        details.push({
          id: item.id,
          status: 'failed',
          error: itemError.message,
        });

        notifyError({
          department: DEPARTMENT,
          task_type: TASK_TYPE,
          error: itemError,
          context: { queue_id: item.id, image_url: item.image_url },
        });
      }
    }

    // 5) agent_tasks 기록
    await recordAgentTask({ successCount, failCount, errors, details });

    // 결과 요약 리포트
    const summaryText = `Instagram 자동 업로드 완료 - 성공: ${successCount}건, 실패: ${failCount}건`;
    const detailText =
      details.map((d) => `- [${d.id}] ${d.status}${d.error ? ` (오류: ${d.error})` : `${d.instagram_post_id ? ` (PostID: ${d.instagram_post_id})` : ''}`}`).join('\n');

    await send({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      status: failCount === 0 ? 'completed' : 'error',
      summary: summaryText,
      detail: detailText,
      success_count: successCount,
      fail_count: failCount,
    });

    console.log(`[${new Date().toISOString()}] 에이전트 종료 - ${summaryText}`);
  } catch (fatalError) {
    console.error('에이전트 치명적 오류:', fatalError.message);

    await recordAgentTask({
      successCount,
      failCount: failCount + 1,
      errors: [...errors, { fatal: fatalError.message }],
      details,
    });

    notifyError({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      error: fatalError,
      context: { phase: 'fatal' },
    });

    await send({
      department: DEPARTMENT,
      task_type: TASK_TYPE,
      status: 'error',
      summary: `Instagram 자동 업로드 치명적 오류: ${fatalError.message}`,
      detail: fatalError.stack || fatalError.message,
    });
  }
}

// 6) 일 2회 스케줄 (09:00, 18:00 KST = UTC+9)
// cron: KST 09:00 = UTC 00:00 / KST 18:00 = UTC 09:00
cron.schedule('0 0 * * *', () => {
  console.log('[스케줄] KST 09:00 실행');
  run().catch(console.error);
});

cron.schedule('0 9 * * *', () => {
  console.log('[스케줄] KST 18:00 실행');
  run().catch(console.error);
});

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);