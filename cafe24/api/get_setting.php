<?php
// 설정값 조회 (에이전트 + 대시보드 공용)

require_once __DIR__ . '/../config.php';
header('Content-Type: application/json; charset=utf-8');

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

$name = trim($_GET['key'] ?? '');
if (!$name) { http_response_code(400); echo json_encode(['error' => 'key required']); exit; }

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key_name = ? LIMIT 1');
    $stmt->execute([$name]);
    $row  = $stmt->fetch();
    echo json_encode(['key' => $name, 'value' => $row ? $row['value'] : null]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
