<?php
// 대기 중인 영업팀 리드 전체 승인
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

try {
    $pdo  = getDbConnection();
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $scheduledAt = $body['scheduled_send_at'] ?? null;
    if ($scheduledAt) {
        $stmt = $pdo->prepare("UPDATE leads SET email_status='approved', scheduled_send_at=? WHERE email_status='pending'");
        $stmt->execute([$scheduledAt]);
    } else {
        $stmt = $pdo->prepare("UPDATE leads SET email_status='approved' WHERE email_status='pending'");
        $stmt->execute();
    }
    echo json_encode(['success' => true, 'approved' => $stmt->rowCount()]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
