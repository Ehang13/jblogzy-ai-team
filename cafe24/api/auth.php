<?php
// API 키 검증 미들웨어 - 모든 API 엔드포인트에서 require_once로 사용

require_once __DIR__ . '/../config.php';

function verifyApiKey(): void {
    $headers     = getallheaders();
    $providedKey = $headers['X-Api-Key'] ?? $_SERVER['HTTP_X_API_KEY'] ?? '';

    if (empty($providedKey) || $providedKey !== AGENT_API_KEY) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }
}
