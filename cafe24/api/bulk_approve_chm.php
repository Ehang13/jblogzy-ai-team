<?php
// 대기 중인 고객관리팀 콘텐츠 전체 승인 + benefit_promises 적용

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

try {
    $pdo = getDbConnection();

    // 대기 중인 CHM 항목 ID 목록 조회
    $stmt = $pdo->query("SELECT id FROM content_queue WHERE department = 'chm' AND approval_status = 'pending'");
    $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);

    if (empty($ids)) {
        echo json_encode(['success' => true, 'approved' => 0]); exit;
    }

    $approved = 0;
    foreach ($ids as $id) {
        $pdo->beginTransaction();
        try {
            // 승인 처리
            $pdo->prepare("UPDATE content_queue SET approval_status = 'approved', approved_at = NOW() WHERE id = ?")
                ->execute([$id]);

            // benefit_promises 적용
            $bp = $pdo->prepare('SELECT * FROM benefit_promises WHERE content_queue_id = ? AND status = "pending" LIMIT 1');
            $bp->execute([$id]);
            $benefit = $bp->fetch();

            if ($benefit && $benefit['benefit_type']) {
                $result = applyBenefitToJblogzy($benefit);
                if ($result['success']) {
                    $pdo->prepare('UPDATE benefit_promises SET status = "promised", applied_at = NOW() WHERE id = ?')
                        ->execute([$benefit['id']]);
                }
            }

            $pdo->commit();
            $approved++;
        } catch (Exception $e) {
            $pdo->rollBack();
        }
    }

    echo json_encode(['success' => true, 'approved' => $approved]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}

function applyBenefitToJblogzy(array $bp): array {
    $url  = JBLOGZY_API_BASE . '/chm/apply-benefit';
    $body = json_encode([
        'member_id'     => $bp['member_id'],
        'benefit_type'  => $bp['benefit_type'],
        'benefit_value' => $bp['benefit_value'],
    ]);
    $ctx = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: application/json\r\nX-Api-Key: " . JBLOGZY_API_KEY . "\r\nContent-Length: " . strlen($body),
        'content'       => $body,
        'timeout'       => 10,
        'ignore_errors' => true,
    ]]);
    $res = @file_get_contents($url, false, $ctx);
    if ($res === false) return ['success' => false];
    return json_decode($res, true) ?? ['success' => false];
}
