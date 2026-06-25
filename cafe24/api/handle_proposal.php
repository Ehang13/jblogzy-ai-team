<?php
// 관리자가 비용 제안을 승인 또는 반려 처리
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$data   = json_decode(file_get_contents('php://input'), true);
$id     = (int)($data['content_id'] ?? 0);
$action = $data['action'] ?? '';

if (!$id || !in_array($action, ['approve', 'reject'])) {
    http_response_code(400); echo json_encode(['error' => 'content_id and action required']); exit;
}

$status = $action === 'approve' ? 'approved' : 'rejected';

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->prepare("
        UPDATE content_queue
        SET approval_status = ?, approved_at = NOW()
        WHERE id = ? AND department = 'strategy' AND content_type = 'proposal'
    ");
    $stmt->execute([$status, $id]);

    if ($stmt->rowCount() === 0) {
        http_response_code(404); echo json_encode(['error' => 'Proposal not found']); exit;
    }

    echo json_encode(['success' => true, 'status' => $status]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
