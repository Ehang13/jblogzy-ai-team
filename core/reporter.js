// 카페24 대시보드 API로 에이전트 결과를 전송하는 공통 모듈

import 'dotenv/config';

const API_URL = process.env.CAFE24_API_URL;
const API_KEY = process.env.CAFE24_API_KEY;

if (!API_URL || !API_KEY) {
  console.error('[reporter] .env에 CAFE24_API_URL, CAFE24_API_KEY가 설정되지 않았습니다.');
}

/**
 * 에이전트 작업 결과를 카페24 대시보드에 전송
 * @param {object} payload - CLAUDE.md 참고
 */
export async function send(payload) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'X-Api-Key':     API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();

    if (!res.ok) {
      console.error(`[reporter] 전송 실패 (${res.status}):`, text.substring(0, 300));
      return false;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error(`[reporter] JSON 파싱 실패 (status ${res.status}):`, text.substring(0, 500));
      return false;
    }

    console.log(`[reporter] ✅ 전송 완료 → task_id: ${json.task_id}`);
    return json;  // { task_id, content_queue_id, ... }

  } catch (err) {
    console.error('[reporter] 네트워크 오류:', err.message);
    return null;
  }
}

/** 에이전트 시작 알림 */
export async function notifyStart(department, taskType) {
  return send({
    department,
    task_type:  taskType,
    status:     'running',
    summary:    `${taskType} 작업을 시작합니다.`,
  });
}

/** 에이전트 에러 알림 */
export async function notifyError(department, taskType, error) {
  return send({
    department,
    task_type:     taskType,
    status:        'error',
    summary:       `오류 발생: ${error.message}`,
    error_message: error.stack || error.message,
  });
}
