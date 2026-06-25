<?php
// CHM 에이전트용 — 재생성 요청된 항목의 member_id 목록 반환

require_once __DIR__ . '/../config.php';
header('Content-Type: application/json; charset=utf-8');

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']); exit;
}

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->prepare("
        SELECT id, target_audience
        FROM content_queue
        WHERE department = 'chm' AND approval_status = 'regen_requested'
        ORDER BY created_at ASC
    ");
    $stmt->execute();
    $rows = $stmt->fetchAll();

    $items = [];
    foreach ($rows as $row) {
        // target_audience 형식: "member_id:123|basic 플랜 / 위험도 중간"
        if (preg_match('/member_id:(\d+)/', $row['target_audience'] ?? '', $m)) {
            $items[] = [
                'content_queue_id' => $row['id'],
                'member_id'        => $m[1],
            ];
        }
    }

    echo json_encode(['items' => $items]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
