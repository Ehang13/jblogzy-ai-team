<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (empty($key) || $key !== AGENT_API_KEY) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

try {
    $pdo = getDbConnection();

    // 영업팀
    $salesStatus = $pdo->query("
        SELECT email_status, COUNT(*) AS cnt
        FROM leads
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY email_status
    ")->fetchAll(PDO::FETCH_KEY_PAIR);

    $industryDist = $pdo->query("
        SELECT industry AS name, COUNT(*) AS cnt
        FROM leads
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          AND industry IS NOT NULL AND industry != ''
        GROUP BY industry
        ORDER BY cnt DESC
        LIMIT 10
    ")->fetchAll();

    // 마케팅팀
    $marketingStatus = $pdo->query("
        SELECT approval_status, COUNT(*) AS cnt
        FROM content_queue
        WHERE department = 'marketing'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY approval_status
    ")->fetchAll(PDO::FETCH_KEY_PAIR);

    // 고객관리팀
    $chmRow = $pdo->query("
        SELECT
            COUNT(*) AS total_generated,
            SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS sent_count
        FROM content_queue
        WHERE department = 'chm'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    ")->fetch();

    echo json_encode([
        'period_days' => 7,
        'sales' => [
            'total_leads'     => array_sum($salesStatus),
            'industry_top10'  => $industryDist,
            'status_counts'   => $salesStatus,
        ],
        'marketing' => [
            'total_contents' => array_sum($marketingStatus),
            'status_counts'  => $marketingStatus,
        ],
        'chm' => [
            'total_generated' => (int)($chmRow['total_generated'] ?? 0),
            'sent_count'      => (int)($chmRow['sent_count']      ?? 0),
        ],
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    http_response_code(200);
    echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
