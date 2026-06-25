<?php
// 최근 30일 내 이메일이 발송된 회원 ID 목록 반환 (CHM 중복 발송 방지)
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../config.php';

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->query("
        SELECT DISTINCT
            REGEXP_SUBSTR(target_audience, 'member_id:([0-9]+)', 1, 1, '', 1) AS member_id
        FROM content_queue
        WHERE department = 'chm'
          AND published_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND target_audience LIKE 'member_id:%'
    ");
    $ids = array_filter(array_column($stmt->fetchAll(), 'member_id'));
    echo json_encode(['member_ids' => array_values($ids)]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
