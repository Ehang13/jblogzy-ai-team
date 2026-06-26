<?php
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$body    = json_decode(file_get_contents('php://input'), true) ?? [];
$action  = $body['action']  ?? '';
$id      = (int)($body['id'] ?? 0);
$blogId  = trim($body['blog_id']  ?? '');
$cookies = trim($body['cookies']  ?? '');

try {
    $pdo = getDbConnection();

    // 테이블 없으면 자동 생성
    $pdo->exec("CREATE TABLE IF NOT EXISTS naver_accounts (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        blog_id      VARCHAR(100) NOT NULL UNIQUE,
        cookies      TEXT NOT NULL,
        is_active    TINYINT(1) DEFAULT 1,
        last_post_at DATETIME NULL,
        post_count   INT DEFAULT 0,
        error_count  INT DEFAULT 0,
        last_error   TEXT NULL,
        created_at   DATETIME DEFAULT NOW()
    )");

    if ($action === 'add') {
        if (!$blogId || !$cookies) {
            http_response_code(400); echo json_encode(['error' => 'blog_id와 cookies가 필요합니다']); exit;
        }
        // 이미 있으면 cookies, is_active 업데이트
        $pdo->prepare("INSERT INTO naver_accounts (blog_id, cookies)
                       VALUES (?, ?)
                       ON DUPLICATE KEY UPDATE cookies=VALUES(cookies), is_active=1, error_count=0, last_error=NULL")
            ->execute([$blogId, $cookies]);
        $newId = $pdo->lastInsertId() ?: null;
        echo json_encode(['success' => true, 'id' => $newId]);

    } elseif ($action === 'delete') {
        if (!$id) { http_response_code(400); echo json_encode(['error' => 'id required']); exit; }
        $pdo->prepare("DELETE FROM naver_accounts WHERE id=?")->execute([$id]);
        echo json_encode(['success' => true]);

    } elseif ($action === 'update_cookies') {
        if (!$id || !$cookies) {
            http_response_code(400); echo json_encode(['error' => 'id와 cookies가 필요합니다']); exit;
        }
        $pdo->prepare("UPDATE naver_accounts SET cookies=?, is_active=1, error_count=0, last_error=NULL WHERE id=?")
            ->execute([$cookies, $id]);
        echo json_encode(['success' => true]);

    } else {
        http_response_code(400); echo json_encode(['error' => '알 수 없는 action']);
    }

} catch (PDOException $e) {
    http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
}
