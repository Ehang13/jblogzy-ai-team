<?php
// 설정값 변경 (대시보드 관리자 전용)

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$data  = json_decode(file_get_contents('php://input'), true);
$name  = trim($data['key']   ?? '');
$value = trim($data['value'] ?? '');

if (!$name) { http_response_code(400); echo json_encode(['error' => 'key required']); exit; }

$allowed = ['chm_auto_approve', 'sales_auto_approve'];
if (!in_array($name, $allowed)) {
    http_response_code(400); echo json_encode(['error' => 'Unknown setting']); exit;
}

try {
    $pdo = getDbConnection();
    $pdo->prepare('INSERT INTO settings (key_name, value) VALUES (?, ?)
                   ON DUPLICATE KEY UPDATE value = ?')
        ->execute([$name, $value, $value]);
    echo json_encode(['success' => true, 'key' => $name, 'value' => $value]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
