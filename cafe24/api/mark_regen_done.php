<?php
// CHM 에이전트용 — 재생성 완료된 항목을 'regenerated'로 표시

require_once __DIR__ . '/../config.php';
header('Content-Type: application/json; charset=utf-8');

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']); exit;
}

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['content_queue_id'] ?? 0);

if (!$id) {
    http_response_code(400);
    echo json_encode(['error' => 'content_queue_id required']); exit;
}

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->prepare("UPDATE content_queue SET approval_status = 'regenerated' WHERE id = ?");
    $stmt->execute([$id]);
    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
