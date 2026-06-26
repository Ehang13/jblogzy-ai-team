import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPARTMENT = 'chm';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function getApprovedInstagramContent() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM content_queue
       WHERE platform = 'instagram' AND status = 'approved'
       ORDER BY created_at ASC`
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function createMediaContainer(imageUrl, caption) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption || '',
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || `미디어 컨테이너 생성 실패: HTTP ${res.status}`
    );
  }

  return data.id;
}

async function publishMediaContainer(containerId) {
  const url = `${GRAPH_API_BASE}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: INSTAGRAM_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message || `미디어 게시 실패: HTTP ${res.status}`
    );
  }

  return data.id;
}

async function markAsPublished(id) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE content_queue
       SET status = 'published', published_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } finally {
    client.release();
  }
}

async function markAsFailed(id) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE content_queue
       SET status = 'failed'
       WHERE id = $1`,
      [id]
    );
  } finally {
    client.release();
  }
}

async function logAgentTaskError(contentId, errorMessage) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO agent_tasks (agent_name, related_id, status, error_message, created_at)
       VALUES ($1, $2, 'error', $3, NOW())`,
      ['instagram-uploader', contentId, errorMessage]
    );
  } catch (err) {
    console.error('agent_tasks 에러 로그 적재 실패:', err.message);
  } finally {
    client.release();
  }
}

async function getAdminNotificationChannel() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT value FROM settings WHERE key = 'admin_notification_channel' LIMIT 1`
    );
    return result.rows[0]?.value || null;
  } finally {
    client.release();
  }
}

export async function run() {
  console.log('[instagram-uploader] 실행 시작 -', new Date().toISOString());

  let successCount = 0;
  let failCount = 0;
  const failedItems = [];
  const successItems = [];

  let items = [];
  try {
    items = await getApprovedInstagramContent();
    console.log(`[instagram-uploader] 처리 대상 콘텐츠: ${items.length}건`);
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
    console.log('[instagram-uploader] 처리할 콘텐츠 없음. 종료.');
    await send({
      department: DEPARTMENT,
      task_type: 'instagram_upload',
      status: 'completed',
      summary: '인스타그램 업로드 완료 (처리 항목 없음)',
      detail: '승인된 인스타그램 콘텐츠가 없어 업로드를 건너뜁니다.',
    });
    return;
  }

  for (const item of items) {
    const { id, image_url, caption, title } = item;
    console.log(`[instagram-uploader] 처리 중: ID=${id}`);

    try {
      if (!image_url) {
        throw new Error('image_url이 없어 업로드할 수 없습니다.');
      }

      // 1) 미디어 컨테이너 생성
      const containerId = await createMediaContainer(image_url, caption || title || '');
      console.log(`[instagram-uploader] 컨테이너 생성 완료: containerId=${containerId}`);

      // 2) 실제 게시
      const postId = await publishMediaContainer(containerId);
      console.log(`[instagram-uploader] 게시 완료: postId=${postId}`);

      // 3) DB 상태 업데이트
      await markAsPublished(id);

      successCount++;
      successItems.push({ id, postId });
    } catch (err) {
      console.error(`[instagram-uploader] 항목 ID=${id} 처리 실패:`, err.message);

      try {
        await markAsFailed(id);
      } catch (dbErr) {
        console.error(`[instagram-uploader] failed 마킹 실패 ID=${id}:`, dbErr.message);
      }

      try {
        await logAgentTaskError(id, err.message);
      } catch (logErr) {
        console.error(`[instagram-uploader] 에러 로그 적재 실패 ID=${id}:`, logErr.message);
      }

      await notifyError({
        department: DEPARTMENT,
        task_type: 'instagram_upload',
        error: err,
        summary: `인스타그램 게시 실패 (ID: ${id})`,
        detail: err.message,
      });

      failCount++;
      failedItems.push({ id, error: err.message });
    }
  }

  // 결과 요약 생성
  const summaryPrompt = `
인스타그램 자동 업로드 에이전트 실행 결과를 간결하게 요약해주세요.

처리 결과:
- 전체 대상: ${items.length}건
- 성공: ${successCount}건
- 실패: ${failCount}건
${failedItems.length > 0 ? `- 실패 항목 ID: ${failedItems.map((f) => f.id).join(', ')}` : ''}

실행 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}

2~3문장 이내로 요약해주세요. 단언적 표현("보장", "확정", "100%")은 사용하지 마세요.
  `.trim();

  let summaryText = '';
  try {
    summaryText = await askFast(summaryPrompt, 300);
  } catch (err) {
    summaryText = `인스타그램 업로드 완료 — 성공 ${successCount}건 / 실패 ${failCount}건`;
  }

  const detailLines = [
    `실행 일시: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)`,
    `전체 대상: ${items.length}건`,
    `✅ 성공: ${successCount}건`,
    `❌ 실패: ${failCount}건`,
  ];

  if (successItems.length > 0) {
    detailLines.push(`\n[성공 항목]`);
    successItems.forEach((s) => detailLines.push(`  - content_queue ID: ${s.id} → Instagram Post ID: ${s.postId}`));
  }

  if (failedItems.length > 0) {
    detailLines.push(`\n[실패 항목]`);
    failedItems.forEach((f) => detailLines.push(`  - content_queue ID: ${f.id} → 사유: ${f.error}`));
  }

  const finalStatus = failCount === 0 ? 'completed' : successCount > 0 ? 'completed' : 'error';

  await send({
    department: DEPARTMENT,
    task_type: 'instagram_upload',
    status: finalStatus,
    summary: summaryText,
    detail: detailLines.join('\n'),
    success_count: successCount,
    fail_count: failCount,
  });

  // admin_notification_channel로 결과 전송
  try {
    const notificationChannel = await getAdminNotificationChannel();
    if (notificationChannel) {
      console.log(`[instagram-uploader] 관리자 알림 채널(${notificationChannel})로 결과 전송`);
      await send({
        department: DEPARTMENT,
        task_type: 'instagram_upload_admin_notify',
        status: finalStatus,
        channel: notificationChannel,
        summary: `[인스타그램 자동 업로드] 성공 ${successCount}건 / 실패 ${failCount}건`,
        detail: detailLines.join('\n'),
      });
    }
  } catch (err) {
    console.error('[instagram-uploader] 관리자 알림 채널 전송 실패:', err.message);
  }

  console.log(
    `[instagram-uploader] 실행 완료 — 성공: ${successCount}건, 실패: ${failCount}건`
  );
}

if (process.argv[1].endsWith('instagram-uploader.js')) run().catch(console.error);