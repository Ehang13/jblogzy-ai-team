<?php
// CHM 에이전트용 자동 승인 처리 (API 키 인증)
// approve.php의 세션 인증 없이 에이전트가 직접 호출 가능

require_once __DIR__ . '/../config.php';
header('Content-Type: application/json; charset=utf-8');

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!$key) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }

// 자동 승인 설정이 ON인지 확인
$pdo = getDbConnection();
$setting = $pdo->query("SELECT value FROM settings WHERE key_name = 'chm_auto_approve' LIMIT 1")->fetch();
if (($setting['value'] ?? '0') !== '1') {
    echo json_encode(['success' => false, 'reason' => 'auto_approve_disabled']); exit;
}

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['content_queue_id'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'content_queue_id required']); exit; }

try {
    $pdo->beginTransaction();

    $stmt = $pdo->prepare("UPDATE content_queue SET approval_status = 'approved', approved_at = NOW() WHERE id = ? AND department = 'chm'");
    $stmt->execute([$id]);

    if ($stmt->rowCount() === 0) {
        $pdo->rollBack();
        echo json_encode(['success' => false, 'reason' => 'not_found']); exit;
    }

    // benefit_promises → jblogzy 자동 적용
    $bp = $pdo->prepare('SELECT * FROM benefit_promises WHERE content_queue_id = ? LIMIT 1');
    $bp->execute([$id]);
    $benefit = $bp->fetch();

    $applyResult = null;
    if ($benefit && $benefit['benefit_type']) {
        $applyResult = applyBenefitToJblogzy($benefit);
        if ($applyResult['success']) {
            $pdo->prepare('UPDATE benefit_promises SET status = "promised", applied_at = NOW() WHERE id = ?')
                ->execute([$benefit['id']]);
        }
    }

    $pdo->commit();
    echo json_encode(['success' => true, 'benefit_applied' => $applyResult]);

} catch (PDOException $e) {
    if (isset($pdo)) $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}

function applyBenefitToJblogzy(array $bp): array {
    $url  = JBLOGZY_API_BASE . '/chm/apply-benefit';
    $body = json_encode([
        'member_id'    => $bp['member_id'],
        'benefit_type' => $bp['benefit_type'],
        'benefit_value'=> $bp['benefit_value'],
    ]);
    $ctx = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: application/json\r\nX-Api-Key: " . JBLOGZY_API_KEY . "\r\nContent-Length: " . strlen($body),
        'content'       => $body,
        'timeout'       => 10,
        'ignore_errors' => true,
    ]]);
    $res = @file_get_contents($url, false, $ctx);
    if ($res === false) return ['success' => false, 'reason' => 'network_error'];
    return json_decode($res, true) ?? ['success' => false, 'reason' => 'invalid_response'];
}
