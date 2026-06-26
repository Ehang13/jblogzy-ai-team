<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (empty($key) || $key !== AGENT_API_KEY) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

$body     = json_decode(file_get_contents('php://input'), true) ?? [];
$dept     = $body['department']      ?? '';
$priority = $body['priority']        ?? 'HIGH';
$title    = $body['title']           ?? '';
$desc     = $body['description']     ?? '';
$action   = $body['action_required'] ?? '';

if (empty($title)) {
    http_response_code(400); echo json_encode(['error' => 'title required']); exit;
}

try {
    $pdo = getDbConnection();

    $pdo->exec("CREATE TABLE IF NOT EXISTS ceo_inbox (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        department      VARCHAR(50)  NOT NULL,
        priority        ENUM('CRITICAL','HIGH','MEDIUM') NOT NULL DEFAULT 'HIGH',
        title           VARCHAR(200) NOT NULL,
        description     TEXT,
        action_required TEXT,
        status          ENUM('open','resolved') NOT NULL DEFAULT 'open',
        created_at      DATETIME DEFAULT NOW(),
        resolved_at     DATETIME NULL
    )");

    // 중복 방지: 같은 제목 + open 상태이면 새 행 생성 안 함
    $dup = $pdo->prepare("SELECT id FROM ceo_inbox WHERE title=? AND status='open' LIMIT 1");
    $dup->execute([$title]);
    if ($dup->fetch()) {
        echo json_encode(['success' => true, 'duplicate' => true]); exit;
    }

    $stmt = $pdo->prepare("INSERT INTO ceo_inbox
        (department, priority, title, description, action_required)
        VALUES (?, ?, ?, ?, ?)");
    $stmt->execute([$dept, $priority, $title, $desc, $action]);
    echo json_encode(['success' => true, 'id' => (int)$pdo->lastInsertId()]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
