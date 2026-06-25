<?php
// 에이전트 결과 수신 API 엔드포인트
// POST /ai-team/api/report.php

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-Api-Key');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth.php';

verifyApiKey();

$raw  = file_get_contents('php://input');
$data = json_decode($raw, true);

if (json_last_error() !== JSON_ERROR_NONE) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

$department   = trim($data['department']   ?? '');
$taskType     = trim($data['task_type']    ?? '');
$status       = trim($data['status']       ?? 'completed');
$summary      = trim($data['summary']      ?? '');
$detail       = $data['detail']            ?? '';
$contentUrl   = trim($data['content_url']  ?? '');
$errorMessage = trim($data['error_message'] ?? '');

// content_queue에 저장할 콘텐츠 데이터 (선택 필드)
$contentType     = trim($data['content_type']     ?? '');
$contentTitle    = trim($data['content_title']    ?? '');
$contentBody     = $data['content_body']           ?? '';
$imagePrompt     = $data['image_prompt']           ?? '';
$targetPlatform  = trim($data['target_platform']  ?? '');
$targetAudience  = trim($data['target_audience']  ?? '');

// 리드 데이터 (선택 필드)
$leadIndustry   = trim($data['lead_industry']   ?? '');
$leadPlatform   = trim($data['lead_platform']   ?? '');
$leadContact    = trim($data['lead_contact']    ?? '');
$leadContactType = trim($data['lead_contact_type'] ?? 'email');
$leadSourceUrl  = trim($data['lead_source_url'] ?? '');
$leadEmailSubject = $data['lead_email_subject'] ?? '';
$leadEmailBody  = $data['lead_email_body']      ?? '';
$leadEmailStatus = in_array($data['lead_email_status'] ?? '', ['pending', 'guess'])
    ? $data['lead_email_status'] : 'pending';
$benefitType  = trim($data['benefit_type']  ?? '');
$benefitValue = trim($data['benefit_value'] ?? '');
$benefitDesc  = trim($data['benefit_desc']  ?? '');
$chmMemberId  = trim($data['chm_member_id'] ?? '');

if (empty($department) || empty($taskType)) {
    http_response_code(400);
    echo json_encode(['error' => 'department and task_type are required']);
    exit;
}

try {
    $pdo = getDbConnection();
    $pdo->beginTransaction();

    // agent_tasks 에 항상 기록
    $stmt = $pdo->prepare('
        INSERT INTO agent_tasks (department, task_type, status, summary, detail, content_url, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([$department, $taskType, $status, $summary,
                    is_array($detail) ? json_encode($detail, JSON_UNESCAPED_UNICODE) : $detail,
                    $contentUrl, $errorMessage]);
    $taskId = $pdo->lastInsertId();

    // 콘텐츠가 있으면 content_queue에도 저장
    $contentQueueId = null;
    if (!empty($contentBody) || !empty($contentTitle)) {
        $stmt2 = $pdo->prepare('
            INSERT INTO content_queue
              (department, content_type, title, body, image_prompt, target_platform, target_audience, content_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ');
        $stmt2->execute([$department, $contentType, $contentTitle,
                         is_array($contentBody) ? json_encode($contentBody, JSON_UNESCAPED_UNICODE) : $contentBody,
                         $imagePrompt, $targetPlatform, $targetAudience, $contentUrl]);
        $contentQueueId = $pdo->lastInsertId();

        // CHM 혜택 약속 기록
        if (!empty($benefitType) && !empty($chmMemberId) && $contentQueueId) {
            $memberEmail = !empty($leadContact) ? $leadContact : '';
            $stmt4 = $pdo->prepare('
                INSERT INTO benefit_promises
                  (member_id, member_email, member_name, benefit_type, benefit_value, benefit_desc, content_queue_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ');
            $stmt4->execute([$chmMemberId, $memberEmail, $summary,
                             $benefitType, $benefitValue, $benefitDesc, $contentQueueId]);
        }
    }

    // 리드 정보가 있으면 leads에도 저장 (연락처 기준 중복 방지)
    if (!empty($leadContact)) {
        $dupCheck = $pdo->prepare('SELECT id FROM leads WHERE contact = ? LIMIT 1');
        $dupCheck->execute([$leadContact]);
        if (!$dupCheck->fetch()) {
            $stmt3 = $pdo->prepare('
                INSERT INTO leads (industry, platform, contact, contact_type, source_url, email_status, email_subject, email_body)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ');
            $stmt3->execute([$leadIndustry, $leadPlatform, $leadContact, $leadContactType,
                             $leadSourceUrl, $leadEmailStatus, $leadEmailSubject, $leadEmailBody]);
        }
    }

    $pdo->commit();

    echo json_encode([
        'success'          => true,
        'task_id'          => (int)$taskId,
        'content_queue_id' => $contentQueueId ? (int)$contentQueueId : null,
        'message' => '작업 로그가 저장되었습니다.',
    ]);

} catch (PDOException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['error' => 'DB error: ' . $e->getMessage()]);
}
