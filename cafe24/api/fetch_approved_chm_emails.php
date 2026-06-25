<?php
// 승인된 CHM 리텐션 이메일 목록 반환 (발송 대기)

require_once __DIR__ . '/../config.php';
header('Content-Type: application/json; charset=utf-8');

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->query("
        SELECT id, body
        FROM content_queue
        WHERE department = 'chm'
          AND approval_status = 'approved'
          AND published_at IS NULL
        ORDER BY approved_at ASC
        LIMIT 20
    ");
    $rows = $stmt->fetchAll();

    $emails = [];
    foreach ($rows as $row) {
        // body 파싱: "받는 사람: email\n제목: subject\n\nbody"
        $lines   = explode("\n", $row['body']);
        $to      = '';
        $subject = '';
        $bodyStart = 0;

        foreach ($lines as $i => $line) {
            if (str_starts_with($line, '받는 사람:')) {
                $to = trim(substr($line, strlen('받는 사람:')));
            } elseif (str_starts_with($line, '제목:')) {
                $subject = trim(substr($line, strlen('제목:')));
            } elseif ($line === '' && $to && $subject) {
                $bodyStart = $i + 1;
                break;
            }
        }

        if (!$to || !$subject) continue;

        $emails[] = [
            'id'      => $row['id'],
            'to'      => $to,
            'subject' => $subject,
            'body'    => implode("\n", array_slice($lines, $bodyStart)),
        ];
    }

    echo json_encode(['emails' => $emails]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
