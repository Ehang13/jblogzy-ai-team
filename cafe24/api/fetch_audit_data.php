<?php
// 부서별 7일 운영 통계 반환 - 자체 감사 에이전트(reviewer.js)용
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../auth.php';
verifyApiKey();

require_once __DIR__ . '/../config.php';

try {
    $pdo = getDbConnection();

    // ── 영업팀: leads 테이블 ──────────────────────────────────────
    $salesStatus = $pdo->query("
        SELECT approval_status, COUNT(*) AS cnt
        FROM leads
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY approval_status
    ")->fetchAll(PDO::FETCH_KEY_PAIR);

    $industryDist = $pdo->query("
        SELECT lead_industry AS name, COUNT(*) AS count
        FROM leads
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          AND lead_industry IS NOT NULL AND lead_industry != ''
        GROUP BY lead_industry
        ORDER BY count DESC
        LIMIT 10
    ")->fetchAll();

    // ── 마케팅팀: content_queue ───────────────────────────────────
    $marketingStatus = $pdo->query("
        SELECT approval_status, COUNT(*) AS cnt
        FROM content_queue
        WHERE department = 'marketing'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY approval_status
    ")->fetchAll(PDO::FETCH_KEY_PAIR);

    // ── 고객관리팀: content_queue ─────────────────────────────────
    $chmRow = $pdo->query("
        SELECT
            COUNT(*)                                                         AS total_generated,
            COUNT(DISTINCT chm_member_id)                                    AS unique_members,
            SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END)       AS sent_count
        FROM content_queue
        WHERE department = 'chm'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    ")->fetch();

    // 같은 회원에게 7일 내 2회 이상 생성된 경우 (중복 감지)
    $duplicateMembers = (int) $pdo->query("
        SELECT COUNT(*) FROM (
            SELECT chm_member_id
            FROM content_queue
            WHERE department = 'chm'
              AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
              AND chm_member_id IS NOT NULL
            GROUP BY chm_member_id
            HAVING COUNT(*) > 1
        ) t
    ")->fetchColumn();

    // 위험도별 분포 (detail JSON에서 riskLevel 파싱)
    $riskRows = $pdo->query("
        SELECT
            JSON_UNQUOTE(JSON_EXTRACT(detail, '$.riskLevel')) AS risk_level,
            COUNT(*) AS cnt
        FROM content_queue
        WHERE department = 'chm'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          AND detail IS NOT NULL
        GROUP BY risk_level
    ")->fetchAll(PDO::FETCH_KEY_PAIR);

    // HIGH 위험도인데 30일 내 발송 이력 없는 회원 수
    $highRiskNotSent30d = (int) $pdo->query("
        SELECT COUNT(DISTINCT chm_member_id)
        FROM content_queue
        WHERE department = 'chm'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.riskLevel')) = 'HIGH'
          AND (published_at IS NULL
               OR chm_member_id NOT IN (
                   SELECT DISTINCT chm_member_id
                   FROM content_queue
                   WHERE department = 'chm'
                     AND published_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                     AND chm_member_id IS NOT NULL
               ))
    ")->fetchColumn();

    echo json_encode([
        'period_days' => 7,
        'sales' => [
            'total_leads'            => array_sum($salesStatus),
            'industry_distribution'  => $industryDist,
            'approval_status_counts' => $salesStatus,
        ],
        'marketing' => [
            'total_contents'         => array_sum($marketingStatus),
            'approval_status_counts' => $marketingStatus,
        ],
        'chm' => [
            'total_generated'           => (int)($chmRow['total_generated'] ?? 0),
            'unique_members'            => (int)($chmRow['unique_members']   ?? 0),
            'duplicate_member_contacts' => $duplicateMembers,
            'sent_count'                => (int)($chmRow['sent_count']       ?? 0),
            'risk_level_distribution'   => $riskRows,
            'high_risk_not_sent_30d'    => $highRiskNotSent30d,
        ],
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
