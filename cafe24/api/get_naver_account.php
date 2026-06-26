<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/auth.php';

verifyApiKey();

try {
    $pdo = getDbConnection();
    $stmt = $pdo->query("
        SELECT id, blog_id, cookies FROM naver_accounts
        WHERE is_active = 1
        ORDER BY COALESCE(last_post_at, '2000-01-01') ASC
        LIMIT 1
    ");
    $account = $stmt->fetch() ?: null;
    echo json_encode(['account' => $account]);
} catch (PDOException $e) {
    // 테이블 없으면 null 반환 (env 폴백)
    echo json_encode(['account' => null]);
}
