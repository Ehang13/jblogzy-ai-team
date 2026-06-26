<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (empty($key) || $key !== AGENT_API_KEY) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

try {
    $pdo = getDbConnection();
    $stmt = $pdo->query("
        SELECT department, task_type, error_message, created_at
        FROM agent_tasks
        WHERE status = 'error'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ORDER BY created_at DESC
        LIMIT 20
    ");
    echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC), JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(200);
    echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
