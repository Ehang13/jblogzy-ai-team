<?php
// DB 자동 설치 스크립트 - 실행 후 반드시 삭제할 것!
// 브라우저에서 https://ehe13.mycafe24.com/ai-team/setup.php 접속하면 실행됨

// 보안: 이 파일을 실행하려면 아래 토큰을 URL에 포함해야 함
// 예: /ai-team/setup.php?token=setup2024jblogzy
define('SETUP_TOKEN', 'setup2024jblogzy');

if (($_GET['token'] ?? '') !== SETUP_TOKEN) {
    http_response_code(403);
    die('<h2>403 Forbidden</h2><p>올바른 토큰이 필요합니다.</p>');
}

$host    = 'localhost';
$user    = 'ehe13';
$pass    = 'Godlovesyou13!';
$dbname  = 'ehe13';
$charset = 'utf8mb4';

header('Content-Type: text/html; charset=utf-8');
echo '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>jblogzy AI 팀 DB 설치</title>
<style>
  body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;background:#0f172a;color:#e2e8f0;}
  .ok{color:#22c55e;} .err{color:#ef4444;} .box{background:#1e293b;border-radius:8px;padding:20px;margin:10px 0;}
  h1{color:#3b82f6;}
</style>
</head><body>';

echo '<h1>🤖 jblogzy AI 팀 DB 설치</h1>';

try {
    $dsn = "mysql:host=$host;dbname=$dbname;charset=$charset";
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    echo '<div class="box"><span class="ok">✅ DB 연결 성공!</span> (host: localhost, db: ' . $dbname . ')</div>';
} catch (PDOException $e) {
    echo '<div class="box"><span class="err">❌ DB 연결 실패: ' . htmlspecialchars($e->getMessage()) . '</span></div>';
    echo '</body></html>';
    exit;
}

$sqls = [
    'agent_tasks 테이블' => "
        CREATE TABLE IF NOT EXISTS agent_tasks (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            department    VARCHAR(20) NOT NULL,
            task_type     VARCHAR(100) NOT NULL,
            status        VARCHAR(20) NOT NULL DEFAULT 'completed',
            summary       TEXT,
            detail        LONGTEXT,
            content_url   VARCHAR(500),
            error_message TEXT,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_department (department),
            INDEX idx_created_at (created_at),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ",
    'content_queue 테이블' => "
        CREATE TABLE IF NOT EXISTS content_queue (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            department       VARCHAR(20) NOT NULL,
            content_type     VARCHAR(50) NOT NULL,
            title            VARCHAR(500),
            body             LONGTEXT,
            image_prompt     TEXT,
            target_platform  VARCHAR(50),
            target_audience  VARCHAR(200),
            content_url      VARCHAR(500),
            approval_status  VARCHAR(20) NOT NULL DEFAULT 'pending',
            approved_at      TIMESTAMP NULL,
            published_at     TIMESTAMP NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_approval (approval_status),
            INDEX idx_department (department),
            INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ",
    'leads 테이블' => "
        CREATE TABLE IF NOT EXISTS leads (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            industry       VARCHAR(100),
            platform       VARCHAR(50),
            contact        VARCHAR(200),
            contact_type   VARCHAR(20) DEFAULT 'email',
            source_url     VARCHAR(500),
            email_status   VARCHAR(20) DEFAULT 'pending',
            email_subject  VARCHAR(500),
            email_body     LONGTEXT,
            sent_at        TIMESTAMP NULL,
            notes          TEXT,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_industry (industry),
            INDEX idx_email_status (email_status),
            INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ",
    'api_keys 테이블' => "
        CREATE TABLE IF NOT EXISTS api_keys (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            key_value  VARCHAR(64) NOT NULL UNIQUE,
            label      VARCHAR(100),
            is_active  TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ",
    'benefit_promises 테이블' => "
        CREATE TABLE IF NOT EXISTS benefit_promises (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            member_id        VARCHAR(100),
            member_email     VARCHAR(200),
            member_name      VARCHAR(100),
            benefit_type     VARCHAR(50),
            benefit_value    VARCHAR(100),
            benefit_desc     VARCHAR(300),
            content_queue_id INT,
            status           VARCHAR(20) NOT NULL DEFAULT 'pending',
            promised_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            applied_at       TIMESTAMP NULL,
            INDEX idx_status (status),
            INDEX idx_member (member_id),
            INDEX idx_cq (content_queue_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ",
    'settings 테이블' => "
        CREATE TABLE IF NOT EXISTS settings (
            key_name  VARCHAR(100) PRIMARY KEY,
            value     TEXT NOT NULL DEFAULT ''
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ",
    'settings 초기값' => "
        INSERT IGNORE INTO settings (key_name, value) VALUES
            ('chm_auto_approve', '0'),
            ('sales_auto_approve', '0')
    ",
    'API 키 초기값 삽입' => "
        INSERT IGNORE INTO api_keys (key_value, label)
        VALUES ('05595accfdea226916b8a39e687e3c5db768c2356cd7492d25b55b8a41f02c54', 'production')
    ",
];

$allOk = true;
foreach ($sqls as $label => $sql) {
    try {
        $pdo->exec($sql);
        echo '<div class="box"><span class="ok">✅ ' . $label . ' 완료</span></div>';
    } catch (PDOException $e) {
        echo '<div class="box"><span class="err">❌ ' . $label . ' 실패: ' . htmlspecialchars($e->getMessage()) . '</span></div>';
        $allOk = false;
    }
}

if ($allOk) {
    echo '<div class="box" style="border:2px solid #22c55e;">
        <h2 class="ok">🎉 설치 완료!</h2>
        <p>모든 테이블이 성공적으로 생성되었습니다.</p>
        <p style="color:#ef4444;font-weight:bold;">⚠️ 보안을 위해 지금 바로 이 파일(setup.php)을 서버에서 삭제해주세요!</p>
        <p><a href="/ai-team/admin/" style="color:#3b82f6;">→ 대시보드 접속하기</a></p>
    </div>';
} else {
    echo '<div class="box" style="border:2px solid #ef4444;">
        <h2 class="err">일부 항목에서 오류가 발생했습니다. 위 메시지를 확인해주세요.</h2>
    </div>';
}

echo '</body></html>';
