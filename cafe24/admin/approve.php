<?php
// 콘텐츠 승인/반려 처리 AJAX 핸들러

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$data   = json_decode(file_get_contents('php://input'), true);
$id     = (int)($data['content_id'] ?? 0);
$action = $data['action'] ?? '';

if (!$id || !in_array($action, ['approve', 'reject'])) {
    echo json_encode(['error' => 'Invalid parameters']); exit;
}

$newStatus = $action === 'approve' ? 'approved' : 'rejected';
$now       = date('Y-m-d H:i:s');

try {
    $pdo  = getDbConnection();
    $stmt = $pdo->prepare('UPDATE content_queue SET approval_status = ?, approved_at = ? WHERE id = ?');
    $stmt->execute([$newStatus, $now, $id]);

    // benefit_promises 처리
    $bpStmt = $pdo->prepare('SELECT * FROM benefit_promises WHERE content_queue_id = ? LIMIT 1');
    $bpStmt->execute([$id]);
    $bp = $bpStmt->fetch();

    if ($bp) {
        if ($action === 'approve') {
            // jblogzy.com API에 혜택 자동 적용
            $applyResult = applyBenefitToJblogzy($bp);

            if ($applyResult['success']) {
                $pdo->prepare('UPDATE benefit_promises SET status = "promised", applied_at = NOW() WHERE id = ?')
                    ->execute([$bp['id']]);
            }
        } elseif ($action === 'reject') {
            $pdo->prepare('UPDATE benefit_promises SET status = "cancelled" WHERE id = ?')
                ->execute([$bp['id']]);
        }
    }

    echo json_encode(['success' => true, 'status' => $newStatus]);

} catch (PDOException $e) {
    echo json_encode(['error' => $e->getMessage()]);
}

function applyBenefitToJblogzy(array $bp): array {
    $url  = JBLOGZY_API_BASE . '/chm/apply-benefit';
    $body = json_encode([
        'member_id'    => $bp['member_id'],
        'benefit_type' => $bp['benefit_type'],
        'benefit_value'=> $bp['benefit_value'],
    ]);

    $ctx = stream_context_create([
        'http' => [
            'method'  => 'POST',
            'header'  => implode("\r\n", [
                'Content-Type: application/json',
                'X-Api-Key: ' . JBLOGZY_API_KEY,
                'Content-Length: ' . strlen($body),
            ]),
            'content' => $body,
            'timeout' => 10,
            'ignore_errors' => true,
        ],
    ]);

    $res = @file_get_contents($url, false, $ctx);
    if ($res === false) return ['success' => false, 'reason' => 'network_error'];

    $json = json_decode($res, true);
    return $json ?? ['success' => false, 'reason' => 'invalid_response'];
}
