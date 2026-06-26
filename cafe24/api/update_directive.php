<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

// 에이전트(API 키) 또는 관리자(세션) 모두 허용
$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
$isAgent = (!empty($key) && $key === AGENT_API_KEY);
if (!$isAgent) {
    session_start();
    if (!isset($_SESSION['admin_logged_in'])) {
        http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
    }
}

$body = json_decode(file_get_contents('php://input'), true) ?? [];
$id   = (int)($body['id'] ?? 0);
if ($id <= 0) {
    http_response_code(400); echo json_encode(['error' => 'invalid id']); exit;
}

$allowed = ['title', 'description', 'target_departments', 'status', 'plan', 'dept_instructions', 'progress_notes', 'result_report', 'completed_at'];
$sets    = [];
$params  = [];

foreach ($allowed as $field) {
    if (!array_key_exists($field, $body)) continue;
    $val = $body[$field];
    if (is_array($val)) $val = json_encode($val, JSON_UNESCAPED_UNICODE);
    $sets[]   = "`$field` = ?";
    $params[] = $val;
}

if (empty($sets)) {
    echo json_encode(['success' => true, 'nothing' => true]); exit;
}

$params[] = $id;

try {
    $pdo = getDbConnection();
    $pdo->prepare("UPDATE ceo_directives SET " . implode(', ', $sets) . " WHERE id=?")
        ->execute($params);
    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
