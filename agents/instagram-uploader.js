import 'dotenv/config';
import { ask, askJson, askFast } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';
const DAILY_LIMIT = 25;
const POLL_INTERVAL_MS = 60 * 1000; // 1분

const BASE = process.env.CAFE24_API_URL?.replace('/report.php', '');
const KEY  = process.env.CAFE24_API_KEY;

const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID      = process.env.INSTAGRAM_USER_ID;
const IG_API_BASE     = 'https://graph.facebook.com/v19.0';

// ── DB 헬퍼 ──────────────────────────────────────────────────────────────────

async function dbFetch(sql, params = []) {
  const res = await fetch(`${BASE}/db.php`, {
    method: 'POST',
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getApprovedItems() {
  const rows = await dbFetch(
    `SELECT * FROM content_queue
     WHERE platform = 'instagram' AND status = 'approved'
     ORDER BY created_at ASC`,
  );
  return Array.isArray(rows) ? rows : (rows.rows ?? rows.data ?? []);
}

async function getTodayPublishedCount() {
  const rows = await dbFetch(
    `SELECT COUNT(*) AS cnt FROM content_queue
     WHERE platform = 'instagram'
       AND status   = 'published'
       AND DATE(published_at) = CURDATE()`,
  );
  const list = Array.isArray(rows) ? rows : (rows.rows ?? rows.data ?? []);
  return Number(list[0]?.cnt ?? 0);
}

async function updateStatus(id, status, errorLog = null) {
  if (status === 'published') {
    await dbFetch(
      `UPDATE content_queue
       SET status = ?, published_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [status, id],
    );
  } else {
    await dbFetch(
      `UPDATE content_queue
       SET status = ?, error_log = ?, updated_at = NOW()
       WHERE id = ?`,
      [status, errorLog, id],
    );
  }
}

async function logAgentTask({ taskType, targetId, status, summary, detail }) {
  await dbFetch(
    `INSERT INTO agent_tasks
       (department, task_type, target_id, status, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [DEPARTMENT, taskType, String(targetId ?? ''), status, summary, detail],
  ).catch(err => console.error('[agent_tasks 로깅 실패]', err.message));
}

// ── Instagram Graph API 헬퍼 ──────────────────────────────────────────────────

async function createMediaContainer({ imageUrl, caption }) {
  const url = new URL(`${IG_API_BASE}/${IG_USER_ID}/media`);
  url.searchParams.set('image_url',    imageUrl);
  url.searchParams.set('caption',      caption);
  url.searchParams.set('access_token', IG_ACCESS_TOKEN);

  const res  = await fetch(url.toString(), { method: 'POST' });
  const body = await res.json();

  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `컨테이너 생성 실패 (${res.status})`);
  }
  if (!body.id) throw new Error('creation_id 없음');
  return body.id; // creation_id
}

async function publishMediaContainer(creationId) {
  const url = new URL(`${IG_API_BASE}/${IG_USER_ID}/media_publish`);
  url.searchParams.set('creation_id',  creationId);
  url.searchParams.set('access_token', IG_ACCESS_TOKEN);

  const res  = await fetch(url.toString(), { method: 'POST' });
  const body = await res.json();

  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `게시 실패 (${res.status})`);
  }
  if (!body.id) throw new Error('media id 없음');
  return body.id; // instagram media id
}

// ── 단일 항목 처리 ────────────────────────────────────────────────────────────

async function processItem(item) {
  const { id, image_url, caption } = item;

  try {
    // 1) 컨테이너 생성
    const creationId = await createMediaContainer({
      imageUrl: image_url,
      caption:  caption ?? '',
    });

    // 2) 짧은 대기 (Instagram 권장: 컨테이너 생성 후 일정 시간 경과)
    await new Promise(r => setTimeout(r, 3000));

    // 3) 실제 게시
    const mediaId = await publishMediaContainer(creationId);

    // 4) status → published
    await updateStatus(id, 'published');

    // 5) agent_tasks 로깅
    await logAgentTask({
      taskType: 'instagram_upload',
      targetId: id,
      status:   'completed',
      summary:  `인스타그램 게시 성공 (media_id: ${mediaId})`,
      detail:   JSON.stringify({ id, creationId, mediaId, image_url }),
    });

    console.log(`[OK] content_queue#${id} → Instagram media_id=${mediaId}`);
    return { success: true, id, mediaId };

  } catch (err) {
    const errMsg = err.message ?? String(err);

    // status → failed + error_log
    await updateStatus(id, 'failed', errMsg).catch(() => {});

    // agent_tasks 로깅
    await logAgentTask({
      taskType: 'instagram_upload',
      targetId: id,
      status:   'error',
      summary:  `인스타그램 게시 실패: ${errMsg}`,
      detail:   JSON.stringify({ id, image_url, error: errMsg }),
    });

    await notifyError({
      department: DEPARTMENT,
      task_type:  'instagram_upload',
      summary:    `content_queue#${id} 게시 실패`,
      detail:     errMsg,
    }).catch(() => {});

    console.error(`[FAIL] content_queue#${id}:`, errMsg);
    return { success: false, id, error: errMsg };
  }
}

// ── 메인 실행 루프 ────────────────────────────────────────────────────────────

export async function run() {
  console.log('[instagram-uploader] 실행 시작');

  const items = await getApprovedItems();

  if (items.length === 0) {
    console.log('[instagram-uploader] 처리 대상 없음');
    await send({
      department: DEPARTMENT,
      task_type:  'instagram_upload',
      status:     'completed',
      summary:    '처리 대상 없음',
      detail:     'approved 상태의 인스타그램 콘텐츠가 없습니다.',
    }).catch(() => {});
    return;
  }

  // 오늘 이미 게시한 건수 확인
  let todayCount = await getTodayPublishedCount();
  console.log(`[instagram-uploader] 오늘 게시 건수: ${todayCount}/${DAILY_LIMIT}`);

  if (todayCount >= DAILY_LIMIT) {
    const msg = `일별 게시 한도(${DAILY_LIMIT}건)에 도달하여 업로드를 건너뜁니다.`;
    console.warn(`[instagram-uploader] ${msg}`);
    await send({
      department: DEPARTMENT,
      task_type:  'instagram_upload',
      status:     'completed',
      summary:    msg,
      detail:     `현재 게시 수: ${todayCount}`,
    }).catch(() => {});
    return;
  }

  const results   = { success: [], failed: [] };
  const remaining = DAILY_LIMIT - todayCount;
  const targets   = items.slice(0, remaining); // 한도 초과 방지

  console.log(`[instagram-uploader] 처리 예정: ${targets.length}건 (대기 ${items.length}건 중)`);

  for (const item of targets) {
    // 한도 재확인
    if (todayCount >= DAILY_LIMIT) {
      console.warn('[instagram-uploader] 루프 중 일별 한도 도달, 중단');
      break;
    }

    const result = await processItem(item);

    if (result.success) {
      results.success.push(result);
      todayCount += 1;
    } else {
      results.failed.push(result);
    }

    // API rate limit 방지를 위한 간격
    if (targets.indexOf(item) < targets.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── 최종 리포트 ──────────────────────────────────────────────────────────
  const summaryText = `인스타그램 업로드 완료 — 성공 ${results.success.length}건 / 실패 ${results.failed.length}건`;

  const detailLines = [
    `처리 대상: ${targets.length}건`,
    `성공: ${results.success.length}건`,
    `실패: ${results.failed.length}건`,
    `오늘 누적 게시: ${todayCount}/${DAILY_LIMIT}`,
    '',
    results.failed.length > 0
      ? `실패 항목:\n${results.failed.map(f => `  - ID ${f.id}: ${f.error}`).join('\n')}`
      : '실패 항목 없음',
  ];

  await send({
    department: DEPARTMENT,
    task_type:  'instagram_upload',
    status:     results.failed.length > 0 && results.success.length === 0 ? 'error' : 'completed',
    summary:    summaryText,
    detail:     detailLines.join('\n'),
  }).catch(() => {});

  console.log(`[instagram-uploader] 완료: ${summaryText}`);
}

// ── 직접 실행 ─────────────────────────────────────────────────────────────────
if (process.argv[1].endsWith('instagram-uploader.js')) {
  run().catch(console.error);
}