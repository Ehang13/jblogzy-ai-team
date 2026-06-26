<?php
// 승인된 리드 목록 조회 - Node.js 오케스트레이터가 이메일 발송 전 호출
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth.php';

verifyApiKey();

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->query("
        SELECT id, industry, contact, email_subject, email_body
        FROM leads
        WHERE email_status = 'approved'
          AND (scheduled_send_at IS NULL OR scheduled_send_at <= NOW())
        ORDER BY scheduled_send_at ASC, created_at ASC
        LIMIT 50
    ");
    $leads = $stmt->fetchAll();
    echo json_encode(['leads' => $leads]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
