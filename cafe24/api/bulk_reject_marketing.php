<?php
// 대기 중인 마케팅팀 콘텐츠 전체 반려

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

try {
    $pdo = getDbConnection();
    $stmt = $pdo->prepare("
        UPDATE content_queue SET approval_status = 'rejected'
        WHERE department = 'marketing' AND approval_status = 'pending'
    ");
    $stmt->execute();
    echo json_encode(['success' => true, 'rejected' => $stmt->rowCount()]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
