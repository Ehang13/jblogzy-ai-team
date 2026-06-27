<?php
// 대기 중인 영업팀 리드 전체 승인
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

try {
    $pdo  = getDbConnection();
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $scheduledAt = $body['scheduled_send_at'] ?? null;

    // 시간당 42건씩 분산 발송 (하루 12시간 × 42 = 504건)
    $batchPerHour = 42;
    $ids = $pdo->query("SELECT id FROM leads WHERE email_status='pending' ORDER BY id ASC")
                ->fetchAll(PDO::FETCH_COLUMN);

    $approved = 0;
    $baseTime = new DateTime($scheduledAt ?: 'now');
    $updateStmt = $pdo->prepare("UPDATE leads SET email_status='approved', scheduled_send_at=? WHERE id=?");

    foreach ($ids as $i => $id) {
        $hourOffset = (int)floor($i / $batchPerHour);
        $sendTime   = clone $baseTime;
        $sendTime->modify("+{$hourOffset} hours");
        $updateStmt->execute([$sendTime->format('Y-m-d H:i:s'), $id]);
        $approved++;
    }

    echo json_encode(['success' => true, 'approved' => $approved]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
