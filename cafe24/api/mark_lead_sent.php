<?php
// 리드 발송 완료 처리 - Node.js 오케스트레이터가 이메일 발송 후 호출
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth.php';

if (!validateApiKey()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['lead_id'] ?? 0);

if (!$id) {
    http_response_code(400);
    echo json_encode(['error' => 'lead_id required']);
    exit;
}

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->prepare("UPDATE leads SET email_status = 'sent', sent_at = NOW() WHERE id = ?");
    $stmt->execute([$id]);
    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
