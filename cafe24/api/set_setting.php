<?php
// 설정값 변경 (대시보드 관리자 전용)

session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$data  = json_decode(file_get_contents('php://input'), true);
$name  = trim($data['key']   ?? '');
$value = trim($data['value'] ?? '');

if (!$name) { http_response_code(400); echo json_encode(['error' => 'key required']); exit; }

$allowed = ['chm_auto_approve', 'sales_auto_approve', 'marketing_auto_approve', 'strategy_active_goal',
            'dept_enabled_sales', 'dept_enabled_marketing', 'dept_enabled_chm', 'dept_enabled_strategy'];
if (!in_array($name, $allowed)) {
    http_response_code(400); echo json_encode(['error' => 'Unknown setting']); exit;
}

try {
    $pdo = getDbConnection();
    $pdo->prepare('INSERT INTO settings (key_name, value) VALUES (?, ?)
                   ON DUPLICATE KEY UPDATE value = ?')
        ->execute([$name, $value, $value]);

    $bulkApproved = 0;

    // 자동 승인 ON 전환 시 기존 pending 항목 일괄 승인
    if ($value === '1') {
        if ($name === 'chm_auto_approve') {
            $stmt = $pdo->prepare("
                UPDATE content_queue SET approval_status = 'approved', approved_at = NOW()
                WHERE department = 'chm' AND approval_status = 'pending'
            ");
            $stmt->execute();
            $bulkApproved = $stmt->rowCount();
        } elseif ($name === 'marketing_auto_approve') {
            $stmt = $pdo->prepare("
                UPDATE content_queue SET approval_status = 'approved', approved_at = NOW()
                WHERE department = 'marketing' AND approval_status = 'pending'
            ");
            $stmt->execute();
            $bulkApproved = $stmt->rowCount();
        }
    }

    echo json_encode(['success' => true, 'key' => $name, 'value' => $value, 'bulk_approved' => $bulkApproved]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
