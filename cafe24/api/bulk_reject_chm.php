<?php
// 대기 중인 CHM 이메일 전체 반려

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

try {
    $pdo = getDbConnection();
    $pdo->beginTransaction();

    // content_queue 일괄 반려
    $stmt = $pdo->prepare("
        UPDATE content_queue SET approval_status = 'rejected'
        WHERE department = 'chm' AND approval_status = 'pending'
    ");
    $stmt->execute();
    $count = $stmt->rowCount();

    // benefit_promises 취소
    $pdo->exec("
        UPDATE benefit_promises bp
        JOIN content_queue cq ON cq.id = bp.content_queue_id
        SET bp.status = 'cancelled'
        WHERE cq.department = 'chm' AND cq.approval_status = 'rejected'
          AND bp.status = 'pending'
    ");

    $pdo->commit();
    echo json_encode(['success' => true, 'rejected' => $count]);

} catch (PDOException $e) {
    if (isset($pdo)) $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
