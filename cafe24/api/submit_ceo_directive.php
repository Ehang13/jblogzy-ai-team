<?php
session_start();
header('Content-Type: application/json; charset=utf-8');

if (!isset($_SESSION['admin_logged_in'])) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

require_once __DIR__ . '/../config.php';

$body        = json_decode(file_get_contents('php://input'), true) ?? [];
$title       = trim($body['title'] ?? '');
$description = trim($body['description'] ?? '');
$targets     = $body['target_departments'] ?? null; // null = 전 부서

if (empty($title)) {
    http_response_code(400); echo json_encode(['error' => 'title required']); exit;
}

try {
    $pdo = getDbConnection();

    $pdo->exec("CREATE TABLE IF NOT EXISTS ceo_directives (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        title               VARCHAR(200) NOT NULL,
        description         TEXT,
        target_departments  TEXT,
        status              ENUM('open','planning','in_progress','completed') NOT NULL DEFAULT 'open',
        plan                TEXT,
        dept_instructions   TEXT,
        progress_notes      TEXT,
        result_report       TEXT,
        created_at          DATETIME DEFAULT NOW(),
        updated_at          DATETIME DEFAULT NOW() ON UPDATE NOW(),
        completed_at        DATETIME NULL
    )");

    $stmt = $pdo->prepare("INSERT INTO ceo_directives (title, description, target_departments)
        VALUES (?, ?, ?)");
    $stmt->execute([$title, $description, $targets ? json_encode($targets) : null]);

    echo json_encode(['success' => true, 'id' => (int)$pdo->lastInsertId()]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
