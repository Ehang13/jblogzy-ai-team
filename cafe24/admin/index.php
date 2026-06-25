<?php
// 메인 대시보드 - jblogzy AI 자동화 팀 현황

session_start();
require_once __DIR__ . '/../config.php';

// 간단한 비밀번호 인증
if (!isset($_SESSION['admin_logged_in'])) {
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['password'] ?? '') === ADMIN_PASSWORD) {
        $_SESSION['admin_logged_in'] = true;
    } else {
        ?>
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>jblogzy AI 팀 - 로그인</title>
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
          <style>body{background:#0f172a;} .card{border:1px solid #334155;background:#1e293b;color:#e2e8f0;}</style>
        </head>
        <body class="d-flex align-items-center justify-content-center" style="min-height:100vh">
          <div class="card p-4" style="width:360px">
            <h5 class="mb-3 text-center">🤖 jblogzy AI 팀</h5>
            <?php if ($_SERVER['REQUEST_METHOD'] === 'POST'): ?>
              <div class="alert alert-danger py-2">비밀번호가 틀렸습니다.</div>
            <?php endif; ?>
            <form method="POST">
              <input type="password" name="password" class="form-control mb-3" placeholder="관리자 비밀번호" autofocus
                     style="background:#0f172a;border-color:#475569;color:#e2e8f0">
              <button type="submit" class="btn btn-primary w-100">입장</button>
            </form>
          </div>
        </body>
        </html>
        <?php
        exit;
    }
}

// DB에서 대시보드 데이터 조회
try {
    $pdo = getDbConnection();

    $today = date('Y-m-d');

    // 부서별 오늘 완료 작업 수
    $stmtDept = $pdo->prepare('
        SELECT department,
               COUNT(*) AS total_today,
               SUM(status = "completed") AS completed,
               SUM(status = "error") AS errors,
               MAX(created_at) AS last_run
        FROM agent_tasks
        WHERE DATE(created_at) = ?
        GROUP BY department
    ');
    $stmtDept->execute([$today]);
    $deptStats = [];
    while ($row = $stmtDept->fetch()) {
        $deptStats[$row['department']] = $row;
    }

    // 최근 활동 피드 (최근 30건)
    $stmtFeed = $pdo->query('
        SELECT id, department, task_type, status, summary, content_url, created_at
        FROM agent_tasks
        ORDER BY created_at DESC
        LIMIT 30
    ');
    $feed = $stmtFeed->fetchAll();

    // 승인 대기 콘텐츠 수
    $stmtPending = $pdo->query('SELECT COUNT(*) FROM content_queue WHERE approval_status = "pending"');
    $pendingCount = (int)$stmtPending->fetchColumn();

    // 오늘 발굴 리드 수
    $stmtLeads = $pdo->prepare('SELECT COUNT(*) FROM leads WHERE DATE(created_at) = ?');
    $stmtLeads->execute([$today]);
    $todayLeads = (int)$stmtLeads->fetchColumn();

    // 전체 통계
    $stmtTotal = $pdo->query('SELECT COUNT(*) FROM agent_tasks WHERE status = "completed"');
    $totalCompleted = (int)$stmtTotal->fetchColumn();

} catch (PDOException $e) {
    $dbError = $e->getMessage();
}

$departments = [
    'sales'     => ['name' => '영업팀',      'icon' => '📊', 'color' => 'success'],
    'marketing' => ['name' => '마케팅팀',    'icon' => '✍️', 'color' => 'primary'],
    'chm'       => ['name' => '고객관리팀',  'icon' => '🤝', 'color' => 'warning'],
    'ceo'       => ['name' => '자체 감사',   'icon' => '🔍', 'color' => 'secondary'],
];

function timeAgo(string $datetime): string {
    $diff = time() - strtotime($datetime);
    if ($diff < 60)     return $diff . '초 전';
    if ($diff < 3600)   return floor($diff / 60) . '분 전';
    if ($diff < 86400)  return floor($diff / 3600) . '시간 전';
    return floor($diff / 86400) . '일 전';
}
?>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>jblogzy AI 자동화 팀 대시보드</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>

<!-- 네비게이션 -->
<nav class="navbar navbar-dark px-4 py-3" style="background:#0f172a;border-bottom:1px solid #1e3a5f;">
  <span class="navbar-brand fw-bold">🤖 jblogzy AI 자동화 팀</span>
  <div class="d-flex gap-3 align-items-center">
    <a href="content.php" class="btn btn-sm btn-outline-primary position-relative">
      콘텐츠 승인
      <?php if (!empty($pendingCount)): ?>
        <span class="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger">
          <?= $pendingCount ?>
        </span>
      <?php endif; ?>
    </a>
    <a href="leads.php" class="btn btn-sm btn-outline-success">리드 현황</a>
    <span class="text-muted small" id="last-updated">마지막 갱신: 방금 전</span>
    <a href="?logout=1" class="btn btn-sm btn-outline-secondary">로그아웃</a>
  </div>
</nav>

<?php if (isset($_GET['logout'])): session_destroy(); header('Location: index.php'); exit; endif; ?>

<div class="container-fluid px-4 py-4">

  <?php if (isset($dbError)): ?>
    <div class="alert alert-danger">DB 연결 오류: <?= htmlspecialchars($dbError) ?></div>
  <?php endif; ?>

  <!-- 요약 통계 -->
  <div class="row g-3 mb-4">
    <div class="col-6 col-md-3">
      <div class="stat-card">
        <div class="stat-value"><?= $totalCompleted ?? 0 ?></div>
        <div class="stat-label">총 완료 작업</div>
      </div>
    </div>
    <div class="col-6 col-md-3">
      <div class="stat-card">
        <div class="stat-value text-warning"><?= $pendingCount ?? 0 ?></div>
        <div class="stat-label">승인 대기 콘텐츠</div>
      </div>
    </div>
    <div class="col-6 col-md-3">
      <div class="stat-card">
        <div class="stat-value text-success"><?= $todayLeads ?? 0 ?></div>
        <div class="stat-label">오늘 발굴 리드</div>
      </div>
    </div>
    <div class="col-6 col-md-3">
      <div class="stat-card">
        <div class="stat-value text-info"><?= array_sum(array_column($deptStats ?? [], 'total_today')) ?></div>
        <div class="stat-label">오늘 전체 작업</div>
      </div>
    </div>
  </div>

  <!-- 부서별 상태 카드 -->
  <div class="row g-3 mb-4">
    <?php foreach ($departments as $key => $dept): ?>
      <?php $stat = $deptStats[$key] ?? null; ?>
      <div class="col-12 col-md-4">
        <a href="department.php?dept=<?= $key ?>" class="text-decoration-none">
        <div class="dept-card" style="cursor:pointer;transition:border-color .2s" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor=''"">
          <div class="d-flex justify-content-between align-items-start mb-3">
            <div>
              <span class="dept-icon"><?= $dept['icon'] ?></span>
              <span class="dept-name"><?= $dept['name'] ?></span>
            </div>
            <span class="badge bg-<?= $stat ? ($stat['errors'] > 0 ? 'danger' : 'success') : 'secondary' ?>">
              <?= $stat ? ($stat['errors'] > 0 ? '⚠ 오류' : '● 정상') : '대기 중' ?>
            </span>
          </div>
          <div class="row text-center">
            <div class="col-4">
              <div class="fw-bold fs-4"><?= $stat['completed'] ?? 0 ?></div>
              <div class="small text-muted">완료</div>
            </div>
            <div class="col-4">
              <div class="fw-bold fs-4 text-danger"><?= $stat['errors'] ?? 0 ?></div>
              <div class="small text-muted">오류</div>
            </div>
            <div class="col-4">
              <div class="fw-bold fs-4"><?= $stat['total_today'] ?? 0 ?></div>
              <div class="small text-muted">오늘 합계</div>
            </div>
          </div>
          <?php if ($stat && $stat['last_run']): ?>
            <div class="mt-2 small text-muted">마지막 실행: <?= timeAgo($stat['last_run']) ?></div>
          <?php else: ?>
            <div class="mt-2 small text-muted">오늘 실행 없음</div>
          <?php endif; ?>
        </div>
        </a>
      </div>
    <?php endforeach; ?>
  </div>

  <!-- 실시간 활동 피드 -->
  <div class="row">
    <div class="col-12">
      <div class="feed-container">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h6 class="mb-0 fw-bold">실시간 활동 피드</h6>
          <span class="small text-muted">30초마다 자동 갱신</span>
        </div>
        <div id="activity-feed">
          <?php if (empty($feed)): ?>
            <div class="text-center text-muted py-5">
              <div style="font-size:3rem">🤖</div>
              <p class="mt-2">아직 AI 에이전트 활동이 없습니다.<br>에이전트를 실행하면 여기에 결과가 표시됩니다.</p>
            </div>
          <?php else: ?>
            <?php foreach ($feed as $item): ?>
              <div class="feed-item feed-<?= htmlspecialchars($item['department']) ?>">
                <div class="d-flex justify-content-between align-items-start">
                  <div class="flex-grow-1">
                    <span class="dept-badge dept-badge-<?= htmlspecialchars($item['department']) ?>">
                      <?= $departments[$item['department']]['icon'] ?? '🤖' ?>
                      <?= $departments[$item['department']]['name'] ?? $item['department'] ?>
                    </span>
                    <span class="ms-2 small text-muted"><?= htmlspecialchars($item['task_type']) ?></span>
                    <?php if ($item['status'] === 'error'): ?>
                      <span class="badge bg-danger ms-1">오류</span>
                    <?php endif; ?>
                    <div class="mt-1"><?= htmlspecialchars($item['summary'] ?? '') ?></div>
                    <?php if (!empty($item['content_url'])): ?>
                      <a href="<?= htmlspecialchars($item['content_url']) ?>" target="_blank"
                         class="btn btn-sm btn-outline-info mt-1 py-0">
                        <i class="bi bi-box-arrow-up-right"></i> 결과 보기
                      </a>
                    <?php endif; ?>
                  </div>
                  <div class="small text-muted ms-3 text-nowrap"><?= timeAgo($item['created_at']) ?></div>
                </div>
              </div>
            <?php endforeach; ?>
          <?php endif; ?>
        </div>
      </div>
    </div>
  </div>

</div><!-- /container -->

<script src="assets/dashboard.js"></script>
</body>
</html>
