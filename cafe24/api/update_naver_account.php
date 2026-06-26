<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth.php';

verifyApiKey();

$body    = json_decode(file_get_contents('php://input'), true) ?? [];
$id      = (int)($body['id'] ?? 0);
$success = (bool)($body['success'] ?? false);
$error   = $body['error'] ?? null;

if (!$id) {
    http_response_code(400); echo json_encode(['error' => 'id required']); exit;
}

try {
    $pdo = getDbConnection();

    if ($success) {
        $pdo->prepare("UPDATE naver_accounts SET last_post_at=NOW(), post_count=post_count+1 WHERE id=?")
            ->execute([$id]);
    } else {
        $pdo->prepare("UPDATE naver_accounts
                       SET error_count=error_count+1, last_error=?,
                           is_active = IF(error_count+1 >= 3, 0, is_active)
                       WHERE id=?")
            ->execute([$error, $id]);
    }

    echo json_encode(['success' => true]);
} catch (PDOException $e) {
    http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
}
