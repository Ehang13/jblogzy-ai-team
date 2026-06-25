<?php
// API 키 검증 미들웨어 - 모든 API 엔드포인트에서 require_once로 사용

require_once __DIR__ . '/../config.php';

function verifyApiKey(): void {
    $headers = getallheaders();
    $providedKey = $headers['X-Api-Key'] ?? $_SERVER['HTTP_X_API_KEY'] ?? '';

    if (empty($providedKey)) {
        http_response_code(401);
        echo json_encode(['error' => 'API key required']);
        exit;
    }

    try {
        $pdo = getDbConnection();
        $stmt = $pdo->prepare('SELECT id FROM api_keys WHERE key_value = ? AND is_active = 1 LIMIT 1');
        $stmt->execute([$providedKey]);

        if (!$stmt->fetch()) {
            http_response_code(403);
            echo json_encode(['error' => 'Invalid API key']);
            exit;
        }
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => 'DB connection failed']);
        exit;
    }
}
