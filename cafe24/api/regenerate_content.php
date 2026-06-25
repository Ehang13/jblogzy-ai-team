<?php
// 반려된 콘텐츠 재생성 요청 처리

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['content_id'] ?? 0);

if (!$id) {
    http_response_code(400);
    echo json_encode(['error' => 'content_id required']); exit;
}

try {
    $pdo  = getDbConnection();

    // rejected → regen_requested (에이전트 다음 실행 시 재처리)
    $stmt = $pdo->prepare("
        UPDATE content_queue
        SET approval_status = 'regen_requested'
        WHERE id = ? AND department = 'chm' AND approval_status = 'rejected'
    ");
    $stmt->execute([$id]);

    if ($stmt->rowCount() === 0) {
        echo json_encode(['error' => 'Not found or not rejectable']); exit;
    }

    echo json_encode(['success' => true]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
