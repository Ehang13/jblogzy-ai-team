import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';
const MAX_RETRIES = 3;
const DAILY_LIMIT = 25;

// 지수 백오프 대기
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 지수 백오프 재시도 래퍼
async function withRetry(fn, label = 'operation') {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[Retry ${attempt}/${MAX_RETRIES}] ${label} 실패, ${delay}ms 후 재시도:`, err.message);
      await sleep(delay);
    }
  }
}

// content_queue에서 approved 상태 인스타그램 콘텐츠 조회
async function fetchApprovedContent(BASE, KEY) {
  const res = await fetch(`${BASE}/content_queue?platform=instagram&status=approved&limit=10`, {
    headers: { 'X-Api-Key': KEY }
  });
  if (!res.ok) throw new Error(`content_queue 조회 실패: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.items || [];
}

// 24시간 내 게시 건수 조회 (일일 한도 체크)
async function fetchTodayPublishedCount(BASE, KEY) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `${BASE}/content_queue?platform=instagram&status=published&published_after=${encodeURIComponent(since)}&count_only=true`,
    { headers: { 'X-Api-Key': KEY } }
  );
  if (!res.ok) throw new Error(`일일 게시 건수 조회 실패: ${res.status}`);
  const data = await res.json();
  return data.count || 0;
}

// Instagram Graph API: 미디어 컨테이너 생성 (1단계)
async function createMediaContainer(igUserId, accessToken, content) {
  const params = new URLSearchParams();
  params.append('access_token', accessToken);
  params.append('caption', content.caption || '');

  if (content.media_type === 'VIDEO') {
    params.append('media_type', 'VIDEO');
    params.append('video_url', content.media_url);
  } else if (content.media_type === 'CAROUSEL') {
    // 캐러셀은 별도 처리 필요 (단순화: 첫 이미지 사용)
    params.append('image_url', content.media_url);
  } else {
    params.append('image_url', content.media_url);
  }

  const res = await fetch(`https://graph.instagram.com/v21.0/${igUserId}/media`, {
    method: 'POST',
    body: params
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`컨테이너 생성 실패: ${JSON.stringify(data.error || data)}`);
  }
  return data.id;
}

// Instagram Graph API: 미디어 게시 완료 (2단계)
async function publishMedia(igUserId, accessToken, containerId) {
  const params = new URLSearchParams();
  params.append('access_token', accessToken);
  params.append('creation_id', containerId);

  const res = await fetch(`https://graph.instagram.com/v21.0/${igUserId}/media_publish`, {
    method: 'POST',
    body: params
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`미디어 게시 실패: ${JSON.stringify(data.error || data)}`);
  }
  return data.id; // 게시된 미디어 ID
}

// content_queue 상태 업데이트
async function updateContentStatus(BASE, KEY, contentId, status, extra = {}) {
  const body = { status, updated_at: new Date().toISOString(), ...extra };
  const res = await fetch(`${BASE}/content_queue/${contentId}`, {
    method: 'PATCH',
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`상태 업데이트 실패: ${res.status}`);
  return await res.json();
}

// agent_tasks 테이블에 로그 기록
async function logAgentTask(BASE, KEY, taskData) {
  const res = await fetch(`${BASE}/agent_tasks`, {
    method: 'POST',
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: 'instagram-uploader',
      department: DEPARTMENT,
      created_at: new Date().toISOString(),
      ...taskData
    })
  });
  if (!res.ok) {
    console.warn('agent_tasks 로그 기록 실패:', res.status);
  }
}

// 단일 콘텐츠 업로드 처리
async function uploadContent(BASE, KEY, content) {
  const igUserId = content.ig_user_id || process.env.INSTAGRAM_USER_ID;
  const accessToken = content.access_token || process.env.INSTAGRAM_ACCESS_TOKEN;

  if (!igUserId || !accessToken) {
    throw new Error('Instagram User ID 또는 Access Token이 없습니다.');
  }

  console.log(`[Upload] 콘텐츠 ID: ${content.id} 업로드 시작`);

  // 1단계: 미디어 컨테이너 생성
  const containerId = await withRetry(
    () => createMediaContainer(igUserId, accessToken, content),
    `미디어 컨테이너 생성 (id: ${content.id})`
  );
  console.log(`[Upload] 컨테이너 생성 완료: ${containerId}`);

  // 컨테이너 처리 대기 (영상의 경우 더 긴 대기 필요)
  const waitTime = content.media_type === 'VIDEO' ? 10000 : 2000;
  await sleep(waitTime);

  // 2단계: 미디어 게시
  const publishedMediaId = await withRetry(
    () => publishMedia(igUserId, accessToken, containerId),
    `미디어 게시 (id: ${content.id})`
  );
  console.log(`[Upload] 게시 완료: ${publishedMediaId}`);

  return { containerId, publishedMediaId };
}

export async function run() {
  console.log('[instagram-uploader] 실행 시작:', new Date().toISOString());

  const BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
  const KEY = process.env.CAFE24_API_KEY;

  const results = {
    total: 0,
    published: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  try {
    // 일일 게시 한도 체크
    let todayCount = 0;
    try {
      todayCount = await fetchTodayPublishedCount(BASE, KEY);
      console.log(`[Limit] 오늘 게시 건수: ${todayCount}/${DAILY_LIMIT}`);
    } catch (err) {
      console.warn('[Limit] 일일 게시 건수 조회 실패 (계속 진행):', err.message);
    }

    if (todayCount >= DAILY_LIMIT) {
      const msg = `일일 게시 한도(${DAILY_LIMIT}건)에 도달하여 업로드를 건너뜁니다. (현재: ${todayCount}건)`;
      console.warn('[Limit]', msg);
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        status: 'completed',
        summary: '인스타그램 업로드 한도 초과 - 스킵',
        detail: msg
      });
      return;
    }

    const remainingSlots = DAILY_LIMIT - todayCount;

    // approved 콘텐츠 조회
    let approvedItems = [];
    try {
      approvedItems = await fetchApprovedContent(BASE, KEY);
    } catch (err) {
      await notifyError(err, { department: DEPARTMENT, task: 'content_queue 조회' });
      throw err;
    }

    // 일일 한도 내에서 처리할 수 있는 건수만 선택
    const itemsToProcess = approvedItems.slice(0, remainingSlots);
    results.total = itemsToProcess.length;
    results.skipped = approvedItems.length - itemsToProcess.length;

    console.log(`[Process] 처리 대상: ${itemsToProcess.length}건 (한도 초과로 스킵: ${results.skipped}건)`);

    if (itemsToProcess.length === 0) {
      console.log('[Process] 처리할 콘텐츠가 없습니다.');
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        status: 'completed',
        summary: '처리할 인스타그램 콘텐츠 없음',
        detail: 'approved 상태의 인스타그램 콘텐츠가 없습니다.'
      });
      return;
    }

    // 각 콘텐츠 업로드 처리
    for (const content of itemsToProcess) {
      const taskLog = {
        content_id: content.id,
        platform: 'instagram',
        caption_preview: (content.caption || '').substring(0, 50)
      };

      try {
        const { containerId, publishedMediaId } = await uploadContent(BASE, KEY, content);

        // 성공: status → published
        await updateContentStatus(BASE, KEY, content.id, 'published', {
          published_media_id: publishedMediaId,
          container_id: containerId,
          published_at: new Date().toISOString()
        });

        // agent_tasks 성공 로그
        await logAgentTask(BASE, KEY, {
          ...taskLog,
          status: 'success',
          result: { published_media_id: publishedMediaId, container_id: containerId },
          message: '인스타그램 업로드 성공'
        });

        results.published++;
        results.details.push({
          id: content.id,
          status: 'published',
          media_id: publishedMediaId
        });

        console.log(`[Success] 콘텐츠 ${content.id} 게시 완료 (media_id: ${publishedMediaId})`);

        // API 레이트 리밋 방지를 위한 간격
        await sleep(1500);

      } catch (err) {
        // 실패: status → failed, error_log 기록
        const errorMsg = err.message || String(err);
        console.error(`[Failed] 콘텐츠 ${content.id} 업로드 실패:`, errorMsg);

        try {
          await updateContentStatus(BASE, KEY, content.id, 'failed', {
            error_log: errorMsg,
            failed_at: new Date().toISOString()
          });
        } catch (updateErr) {
          console.error(`[Failed] 상태 업데이트도 실패 (content_id: ${content.id}):`, updateErr.message);
        }

        // agent_tasks 실패 로그
        await logAgentTask(BASE, KEY, {
          ...taskLog,
          status: 'error',
          error: errorMsg,
          message: '인스타그램 업로드 실패'
        });

        await notifyError(err, {
          department: DEPARTMENT,
          task: `인스타그램 업로드 (content_id: ${content.id})`
        });

        results.failed++;
        results.details.push({
          id: content.id,
          status: 'failed',
          error: errorMsg
        });

        // 실패해도 다음 항목 계속 진행
      }
    }

    // 최종 요약 리포트
    const summaryText = `인스타그램 업로드 완료 - 성공: ${results.published}건, 실패: ${results.failed}건, 전체: ${results.total}건`;
    const detailText = [
      `처리 시각: ${new Date().toISOString()}`,
      `오늘 누적 게시: ${todayCount + results.published}/${DAILY_LIMIT}건`,
      `한도 초과 스킵: ${results.skipped}건`,
      '',
      '처리 상세:',
      ...results.details.map(d =>
        d.status === 'published'
          ? `  ✓ [${d.id}] 게시 완료 (media_id: ${d.media_id})`
          : `  ✗ [${d.id}] 실패 - ${d.error}`
      )
    ].join('\n');

    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: results.failed > 0 && results.published === 0 ? 'error' : 'completed',
      summary: summaryText,
      detail: detailText,
      meta: {
        published: results.published,
        failed: results.failed,
        total: results.total,
        daily_used: todayCount + results.published,
        daily_limit: DAILY_LIMIT
      }
    });

    console.log('[instagram-uploader] 실행 완료:', summaryText);

  } catch (err) {
    console.error('[instagram-uploader] 치명적 오류:', err);
    await notifyError(err, {
      department: DEPARTMENT,
      task: 'instagram-uploader 전체 실행'
    });
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'error',
      summary: '인스타그램 업로더 오류 발생',
      detail: err.message || String(err)
    });
  }
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);