<?php
// 자체 감사 에이전트가 제출한 비용 발생 개선 제안을 content_queue에 저장
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../auth.php';
verifyApiKey();

require_once __DIR__ . '/../config.php';

$data  = json_decode(file_get_contents('php://input'), true);
$title = trim($data['title']         ?? '');
$desc  = trim($data['description']   ?? '');
$cost  = trim($data['estimated_cost'] ?? '');

if (!$title || !$desc) {
    http_response_code(400);
    echo json_encode(['error' => 'title and description required']);
    exit;
}

try {
    $pdo = getDbConnection();
    $stmt = $pdo->prepare("
        INSERT INTO content_queue
            (department, content_type, title, body, detail, approval_status, created_at)
        VALUES
            ('ceo', 'proposal', ?, ?, ?, 'pending', NOW())
    ");
    $stmt->execute([$title, $desc, json_encode(['estimated_cost' => $cost], JSON_UNESCAPED_UNICODE)]);

    echo json_encode(['success' => true, 'id' => $pdo->lastInsertId()]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
