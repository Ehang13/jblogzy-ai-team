<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

$key = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (empty($key) || $key !== AGENT_API_KEY) {
    http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit;
}

$dept = $_GET['department'] ?? null;

try {
    $pdo = getDbConnection();

    // 테이블 없으면 빈 배열 반환
    try {
        $stmt = $pdo->query("SELECT id, title, description, target_departments,
            status, plan, dept_instructions, progress_notes, created_at
            FROM ceo_directives
            WHERE status IN ('open','planning','in_progress')
            ORDER BY created_at DESC");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $e2) {
        echo json_encode([]); exit;
    }

    // department 필터: target_departments가 null이면 전 부서 대상
    if ($dept) {
        $rows = array_filter($rows, function($r) use ($dept) {
            if (empty($r['target_departments'])) return true;
            $targets = json_decode($r['target_departments'], true) ?? [];
            return in_array($dept, $targets);
        });
        $rows = array_values($rows);

        // dept_instructions에서 해당 부서 지시만 추출
        foreach ($rows as &$r) {
            $instructions = json_decode($r['dept_instructions'] ?? '{}', true) ?? [];
            $r['my_instruction'] = $instructions[$dept] ?? null;
        }
        unset($r);
    }

    echo json_encode($rows, JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
