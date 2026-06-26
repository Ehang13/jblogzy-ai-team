<?php
// 리드 발송 승인 처리 AJAX 핸들러
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['lead_id'] ?? 0);

if (!$id) {
    echo json_encode(['error' => 'lead_id required']); exit;
}

try {
    $pdo  = getDbConnection();
    $scheduledAt = $data['scheduled_send_at'] ?? null;
    if ($scheduledAt) {
        $stmt = $pdo->prepare("UPDATE leads SET email_status='approved', scheduled_send_at=? WHERE id=?");
        $stmt->execute([$scheduledAt, $id]);
    } else {
        $stmt = $pdo->prepare("UPDATE leads SET email_status='approved' WHERE id=?");
        $stmt->execute([$id]);
    }
    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    echo json_encode(['error' => $e->getMessage()]);
}
