<?php
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$id = (int)($_POST['id'] ?? 0);
if ($id <= 0) {
    http_response_code(400); echo json_encode(['error' => 'invalid id']); exit;
}

try {
    $pdo = getDbConnection();
    $pdo->prepare("UPDATE ceo_inbox SET status='resolved', resolved_at=NOW() WHERE id=?")
        ->execute([$id]);
    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
