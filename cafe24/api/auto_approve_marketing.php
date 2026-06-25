<?php
// 마케팅팀 에이전트용 자동 승인 처리 (API 키 인증)

require_once __DIR__ . '/../config.php';
header('Content-Type: application/json; charset=utf-8');

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

$pdo = getDbConnection();
$setting = $pdo->query("SELECT value FROM settings WHERE key_name = 'marketing_auto_approve' LIMIT 1")->fetch();
if (($setting['value'] ?? '0') !== '1') {
    echo json_encode(['success' => false, 'reason' => 'auto_approve_disabled']); exit;
}

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['content_queue_id'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'content_queue_id required']); exit; }

try {
    $stmt = $pdo->prepare("UPDATE content_queue SET approval_status = 'approved', approved_at = NOW() WHERE id = ? AND department = 'marketing'");
    $stmt->execute([$id]);

    if ($stmt->rowCount() === 0) {
        echo json_encode(['success' => false, 'reason' => 'not_found']); exit;
    }

    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
