<?php
session_start();
require_once __DIR__ . '/../config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header('Location: index.php'); exit;
}

$allowed = ['sales', 'marketing', 'chm', 'strategy'];
$dept    = $_GET['dept'] ?? '';
if (!in_array($dept, $allowed)) {
    header('Location: index.php'); exit;
}

$pdo = getDbConnection();
$today = date('Y-m-d');

$deptInfo = [
    'sales'     => ['name' => '영업팀',     'icon' => '📊', 'color' => 'success'],
    'marketing' => ['name' => '마케팅팀',   'icon' => '✍️', 'color' => 'primary'],
    'chm'       => ['name' => '고객관리팀', 'icon' => '🤝', 'color' => 'warning'],
    'strategy'  => ['name' => '전략기획팀', 'icon' => '🔍', 'color' => 'secondary'],
][$dept];

// 오늘 부서 통계
$stmtStat = $pdo->prepare('
    SELECT COUNT(*) AS total, SUM(status="completed") AS completed, SUM(status="error") AS errors
    FROM agent_tasks WHERE department=? AND DATE(created_at)=?
');
$stmtStat->execute([$dept, $today]);
$stat = $stmtStat->fetch();

// 진행 중인 작업 (running)
$stmtRunning = $pdo->prepare('
    SELECT id, task_type, status, summary, created_at
    FROM agent_tasks WHERE department=? AND status="running"
    ORDER BY created_at DESC LIMIT 5
');
$stmtRunning->execute([$dept]);
$runningLogs = $stmtRunning->fetchAll();

// 최근 완료/오류 로그 (20건)
$stmtLog = $pdo->prepare('
    SELECT id, task_type, status, summary, detail, content_url, created_at
    FROM agent_tasks WHERE department=? AND status IN ("completed","error")
    ORDER BY created_at DESC LIMIT 20
');
$stmtLog->execute([$dept]);
$logs = $stmtLog->fetchAll();

// 전체 업종 리스트 (sales.js와 동일)
$allIndustries = [
    'food'       => '외식업 (맛집/카페)',
    'beauty'     => '미용 (헤어/네일/속눈썹)',
    'fitness'    => '피트니스 (헬스/필라테스/요가)',
    'medical'     => '병원/의원 (치과/한의원/피부과)',
    'orthopedic'  => '정형외과',
    'eyeclinic'   => '안과',
    'plastic'     => '성형외과',
    'education'   => '교육 (학원/과외)',
    'pet'        => '반려동물 (동물병원/펫샵)',
    'interior'   => '인테리어/시공',
    'realestate' => '부동산/공인중개사',
    'lodging'    => '숙박업 (펜션/게스트하우스)',
    'auto'       => '자동차 (정비/세차)',
    'studio'     => '사진관/스튜디오',
    'flower'     => '꽃집/화원',
    'wellness'   => '건강/웰니스 (마사지/스파)',
    'clothing'   => '의류/패션 (쇼핑몰)',
    'kids'       => '아동/육아 (키즈카페/유아교육)',
];

// 업종별 리드 통계
$industryStats = [];
if ($dept === 'sales') {
    $stmtInd = $pdo->query('
        SELECT industry,
               COUNT(*) AS total,
               SUM(DATE(created_at) = CURDATE()) AS today,
               MAX(created_at) AS last_worked
        FROM leads GROUP BY industry
    ');
    foreach ($stmtInd->fetchAll() as $row) {
        $industryStats[$row['industry']] = $row;
    }
}

// 부서별 전용 데이터
$extra = [];
if ($dept === 'sales') {
    $stmt = $pdo->prepare('
        SELECT id, industry, platform, contact, email_status, email_subject, created_at
        FROM leads ORDER BY created_at DESC LIMIT 30
    ');
    $stmt->execute();
    $extra = $stmt->fetchAll();
} elseif ($dept === 'marketing') {
    $stmt = $pdo->prepare("
        SELECT id, content_type, title, target_platform, approval_status, created_at
        FROM content_queue WHERE department='marketing' ORDER BY created_at DESC LIMIT 20
    ");
    $stmt->execute();
    $extra = $stmt->fetchAll();
} elseif ($dept === 'chm') {
    $stmt = $pdo->prepare("
        SELECT id, title, body, target_audience, approval_status, created_at
        FROM content_queue WHERE department='chm' ORDER BY created_at DESC LIMIT 30
    ");
    $stmt->execute();
    $extra = $stmt->fetchAll();
} elseif ($dept === 'strategy') {
    try {
        $stmt = $pdo->query("
            SELECT id, title, body, approval_status, created_at
            FROM content_queue
            WHERE department='strategy' AND content_type='proposal'
            ORDER BY created_at DESC LIMIT 30
        ");
        $extra = $stmt->fetchAll();
    } catch (PDOException $e) {
        $extra = [];
    }
}

function timeAgo(string $dt): string {
    $diff = time() - strtotime($dt);
    if ($diff < 60)    return $diff . '초 전';
    if ($diff < 3600)  return floor($diff/60) . '분 전';
    if ($diff < 86400) return floor($diff/3600) . '시간 전';
    return floor($diff/86400) . '일 전';
}

$statusBadge = [
    'pending'  => '<span class="badge bg-warning text-dark">대기</span>',
    'approved' => '<span class="badge bg-success">승인</span>',
    'rejected' => '<span class="badge bg-danger">반려</span>',
    'sent'     => '<span class="badge bg-info">발송완료</span>',
    'replied'  => '<span class="badge bg-primary">답장받음</span>',
];
?>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= $deptInfo['name'] ?> 상세 - jblogzy AI 팀</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>

<nav class="navbar navbar-dark px-4 py-3" style="background:#0f172a;border-bottom:1px solid #1e3a5f;">
  <div class="d-flex align-items-center gap-3">
    <a href="index.php" class="btn btn-sm btn-outline-secondary">
      <i class="bi bi-arrow-left"></i> 대시보드
    </a>
    <span class="navbar-brand fw-bold mb-0">
      <?= $deptInfo['icon'] ?> <?= $deptInfo['name'] ?> 상세
    </span>
  </div>
  <div class="d-flex gap-2">
    <?php if ($dept === 'sales'): ?>
      <a href="leads.php?action=csv&filter=all" class="btn btn-sm btn-outline-info">
        <i class="bi bi-download"></i> CSV 다운로드
      </a>
      <a href="leads.php" class="btn btn-sm btn-outline-success">리드 전체보기</a>
    <?php elseif ($dept === 'marketing'): ?>
      <a href="content.php" class="btn btn-sm btn-outline-primary">콘텐츠 승인</a>
    <?php endif; ?>
  </div>
</nav>

<div class="container-fluid px-4 py-4">

  <!-- 오늘 통계 -->
  <div class="row g-3 mb-4">
    <div class="col-4">
      <div class="stat-card">
        <div class="stat-value text-success"><?= $stat['completed'] ?? 0 ?></div>
        <div class="stat-label">오늘 완료</div>
      </div>
    </div>
    <div class="col-4">
      <div class="stat-card">
        <div class="stat-value text-danger"><?= $stat['errors'] ?? 0 ?></div>
        <div class="stat-label">오늘 오류</div>
      </div>
    </div>
    <div class="col-4">
      <div class="stat-card">
        <div class="stat-value text-info"><?= $stat['total'] ?? 0 ?></div>
        <div class="stat-label">오늘 전체</div>
      </div>
    </div>
  </div>

  <div class="row g-4 align-items-stretch" style="min-height:calc(100vh - 260px);">

    <!-- 왼쪽: 진행 중인 작업 + 작업 로그 -->
    <div class="col-12 col-lg-5 d-flex flex-column gap-3" style="min-height:0;">

      <!-- ① 진행 중인 작업 -->
      <div class="feed-container" style="max-height:200px;overflow-y:auto;flex-shrink:0;">
        <h6 class="fw-bold mb-3 d-flex align-items-center gap-2">
          <?php if (!empty($runningLogs)): ?>
            <span class="running-dot"></span>
          <?php endif; ?>
          진행 중인 작업
        </h6>
        <?php if (empty($runningLogs)): ?>
          <div class="text-muted small py-1">현재 실행 중인 작업이 없습니다.</div>
        <?php else: ?>
          <?php foreach ($runningLogs as $log): ?>
            <div class="feed-item feed-running mb-2">
              <div class="d-flex justify-content-between align-items-start">
                <div class="flex-grow-1">
                  <div class="small text-muted"><?= htmlspecialchars($log['task_type']) ?></div>
                  <div class="mt-1 small"><?= htmlspecialchars($log['summary'] ?? '') ?></div>
                </div>
                <div class="small text-muted ms-2 text-nowrap"><?= timeAgo($log['created_at']) ?></div>
              </div>
            </div>
          <?php endforeach; ?>
        <?php endif; ?>
      </div>

      <!-- ② 최근 작업 로그 -->
      <div class="feed-container" style="flex:1 1 0;overflow-y:auto;min-height:0;">
        <h6 class="fw-bold mb-3">최근 작업 로그</h6>
        <?php if (empty($logs)): ?>
          <div class="text-center text-muted py-4">아직 작업 기록이 없습니다.</div>
        <?php else: ?>
          <?php foreach ($logs as $log): ?>
            <div class="feed-item feed-<?= $dept ?> mb-2">
              <div class="d-flex justify-content-between align-items-start">
                <div class="flex-grow-1">
                  <div class="small text-muted"><?= htmlspecialchars($log['task_type']) ?>
                    <?php if ($log['status'] === 'error'): ?>
                      <span class="badge bg-danger ms-1">오류</span>
                    <?php endif; ?>
                  </div>
                  <div class="mt-1 small"><?= htmlspecialchars($log['summary'] ?? '') ?></div>
                  <?php if (!empty($log['content_url'])): ?>
                    <a href="<?= htmlspecialchars($log['content_url']) ?>" target="_blank"
                       class="btn btn-sm btn-outline-info py-0 mt-1" style="font-size:0.7rem">
                      결과 보기
                    </a>
                  <?php endif; ?>
                </div>
                <div class="small text-muted ms-2 text-nowrap"><?= timeAgo($log['created_at']) ?></div>
              </div>
            </div>
          <?php endforeach; ?>
        <?php endif; ?>
      </div>

    </div>

    <!-- 오른쪽: 부서별 상세 -->
    <div class="col-12 col-lg-7 d-flex flex-column">
      <div class="feed-container" style="flex:1 1 0;overflow-y:auto;min-height:0;">

        <?php if ($dept === 'sales'): ?>

          <!-- 업종 커버리지 현황 -->
          <h6 class="fw-bold mb-2">업종 커버리지 현황 <span class="text-muted fw-normal" style="font-size:0.8rem">(18개 업종 · 3개씩 순환)</span></h6>
          <div class="row g-2 mb-4">
            <?php foreach ($allIndustries as $indId => $indName):
              $s = $industryStats[$indName] ?? null;
              $total = (int)($s['total'] ?? 0);
              $today = (int)($s['today'] ?? 0);
              if ($today > 0) {
                  $badge = '<span class="badge bg-success">오늘 완료</span>';
                  $border = 'border-color:#22c55e';
              } elseif ($total > 0) {
                  $badge = '<span class="badge bg-secondary">누적</span>';
                  $border = 'border-color:#475569';
              } else {
                  $badge = '<span class="badge bg-secondary">미시작</span>';
                  $border = '';
              }
            ?>
              <div class="col-6 col-md-4">
                <div class="p-2 rounded" style="background:#1e293b;border:1px solid #334155;<?= $border ?>">
                  <div class="d-flex justify-content-between align-items-start mb-1">
                    <div class="small fw-bold" style="font-size:0.75rem;line-height:1.3"><?= htmlspecialchars($indName) ?></div>
                    <?= $badge ?>
                  </div>
                  <div class="d-flex gap-2 small text-muted" style="font-size:0.7rem">
                    <span>누적 <strong class="text-white"><?= $total ?></strong></span>
                    <span>오늘 <strong class="<?= $today > 0 ? 'text-success' : 'text-white' ?>"><?= $today ?></strong></span>
                    <?php if ($s && $s['last_worked']): ?>
                      <span><?= timeAgo($s['last_worked']) ?></span>
                    <?php endif; ?>
                  </div>
                </div>
              </div>
            <?php endforeach; ?>
          </div>

          <!-- 최근 리드 목록 -->
          <h6 class="fw-bold mb-2">최근 발굴 리드</h6>
          <?php if (empty($extra)): ?>
            <div class="text-center text-muted py-3">발굴된 리드가 없습니다.</div>
          <?php else: ?>
            <div class="table-responsive">
              <table class="table table-dark table-hover table-sm">
                <thead><tr>
                  <th>업종</th><th>연락처</th><th>이메일 상태</th><th>발굴일</th>
                </tr></thead>
                <tbody>
                <?php foreach ($extra as $lead): ?>
                  <tr>
                    <td><span class="badge bg-secondary" style="font-size:0.65rem"><?= htmlspecialchars($lead['industry'] ?? '-') ?></span></td>
                    <td class="small"><?= htmlspecialchars($lead['contact'] ?? '-') ?></td>
                    <td><?= $statusBadge[$lead['email_status']] ?? htmlspecialchars($lead['email_status']) ?></td>
                    <td class="small text-muted"><?= timeAgo($lead['created_at']) ?></td>
                  </tr>
                <?php endforeach; ?>
                </tbody>
              </table>
            </div>
          <?php endif; ?>

        <?php elseif ($dept === 'marketing'): ?>
          <h6 class="fw-bold mb-3">생성된 콘텐츠 목록</h6>
          <?php if (empty($extra)): ?>
            <div class="text-center text-muted py-4">생성된 콘텐츠가 없습니다.</div>
          <?php else: ?>
            <?php foreach ($extra as $c): ?>
              <div class="p-3 mb-2 rounded" style="background:#1e293b;border:1px solid #334155">
                <div class="d-flex justify-content-between align-items-start">
                  <div>
                    <span class="badge bg-primary me-1"><?= htmlspecialchars($c['target_platform'] ?? $c['content_type']) ?></span>
                    <?= $statusBadge[$c['approval_status']] ?? '' ?>
                    <div class="mt-1 small fw-bold"><?= htmlspecialchars($c['title'] ?? '제목 없음') ?></div>
                  </div>
                  <div class="small text-muted text-nowrap ms-2"><?= timeAgo($c['created_at']) ?></div>
                </div>
              </div>
            <?php endforeach; ?>
          <?php endif; ?>

        <?php elseif ($dept === 'chm'): ?>
          <h6 class="fw-bold mb-3">리텐션 이메일 초안</h6>
          <?php if (empty($extra)): ?>
            <div class="text-center text-muted py-4">생성된 이메일이 없습니다.</div>
          <?php else: ?>
            <?php foreach ($extra as $c): ?>
              <div class="p-3 mb-2 rounded" style="background:#1e293b;border:1px solid #334155">
                <div class="d-flex justify-content-between align-items-start mb-1">
                  <div>
                    <span class="small fw-bold"><?= htmlspecialchars($c['title'] ?? '') ?></span>
                    <span class="ms-2"><?= $statusBadge[$c['approval_status']] ?? '' ?></span>
                  </div>
                  <div class="small text-muted text-nowrap ms-2"><?= timeAgo($c['created_at']) ?></div>
                </div>
                <?php if (!empty($c['target_audience'])): ?>
                  <div class="small text-muted mb-1"><?= htmlspecialchars($c['target_audience']) ?></div>
                <?php endif; ?>
                <?php if (!empty($c['body'])): ?>
                  <div class="small mt-2 p-2 rounded" style="background:#0f172a;max-height:100px;overflow:hidden;white-space:pre-wrap;font-size:0.75rem">
                    <?= htmlspecialchars(mb_substr($c['body'], 0, 200)) ?>...
                  </div>
                <?php endif; ?>
              </div>
            <?php endforeach; ?>
          <?php endif; ?>

        <?php elseif ($dept === 'strategy'): ?>

          <!-- 승인 대기 제안 -->
          <?php
            $pendingProposals = array_filter($extra, fn($p) => $p['approval_status'] === 'pending');
            $doneProposals    = array_filter($extra, fn($p) => $p['approval_status'] !== 'pending');
          ?>
          <?php if (!empty($pendingProposals)): ?>
            <div class="d-flex align-items-center gap-2 mb-3">
              <h6 class="fw-bold mb-0">⚠️ 승인 대기 제안</h6>
              <span class="badge bg-warning text-dark"><?= count($pendingProposals) ?>건</span>
            </div>
            <?php foreach ($pendingProposals as $p):
              preg_match('/\[예상 비용:\s*([^\]]+)\]/', $p['body'] ?? '', $cm);
              $cost = $cm[1] ?? '';
            ?>
              <div class="p-3 mb-3 rounded" id="proposal-<?= $p['id'] ?>" style="background:#1e293b;border:1px solid #f59e0b">
                <div class="d-flex justify-content-between align-items-start mb-2">
                  <div>
                    <span class="badge bg-warning text-dark me-1">비용 발생</span>
                    <?php if ($cost): ?><span class="badge bg-secondary"><?= htmlspecialchars($cost) ?></span><?php endif; ?>
                    <div class="fw-bold mt-1 small"><?= htmlspecialchars($p['title']) ?></div>
                  </div>
                  <div class="small text-muted text-nowrap ms-2"><?= timeAgo($p['created_at']) ?></div>
                </div>
                <div class="small text-muted mb-3" style="white-space:pre-wrap;font-size:0.78rem;line-height:1.6">
                  <?= htmlspecialchars(mb_substr($p['body'] ?? '', 0, 300)) ?>
                </div>
                <div class="d-flex gap-2">
                  <button class="btn btn-sm btn-success" onclick="handleProposal(<?= $p['id'] ?>, 'approve')">승인</button>
                  <button class="btn btn-sm btn-outline-danger" onclick="handleProposal(<?= $p['id'] ?>, 'reject')">반려</button>
                </div>
              </div>
            <?php endforeach; ?>
            <hr style="border-color:#334155">
          <?php endif; ?>

          <!-- 최신 감사 리포트 -->
          <h6 class="fw-bold mb-3">주간 자체 감사 리포트</h6>
          <?php
            $auditLogs = array_filter($logs, fn($l) => in_array($l['task_type'], ['주간 시스템 감사', '최초 전략 계획 수립', '주간 전략 진척도 검토']));
            $latest    = reset($auditLogs);
          ?>
          <?php if (!$latest): ?>
            <div class="text-center text-muted py-4">아직 감사 리포트가 없습니다.<br><small>매주 월요일 09:00에 자동 생성됩니다.</small></div>
          <?php else: ?>
            <div class="small text-muted mb-3"><?= timeAgo($latest['created_at']) ?> 생성</div>
            <div class="p-3 rounded" style="background:#0f172a;white-space:pre-wrap;font-size:0.82rem;line-height:1.7;max-height:500px;overflow-y:auto">
              <?= nl2br(htmlspecialchars($latest['detail'] ?? '')) ?>
            </div>
            <?php if (count($auditLogs) > 1): ?>
              <h6 class="fw-bold mt-4 mb-2">이전 리포트</h6>
              <?php foreach (array_slice(array_values($auditLogs), 1) as $old): ?>
                <div class="p-2 mb-2 rounded" style="background:#1e293b;border:1px solid #334155;cursor:pointer"
                     onclick="this.nextElementSibling.classList.toggle('d-none')">
                  <div class="small text-muted"><?= timeAgo($old['created_at']) ?> 생성</div>
                </div>
                <div class="p-3 rounded d-none mb-3" style="background:#0f172a;white-space:pre-wrap;font-size:0.8rem;line-height:1.6">
                  <?= nl2br(htmlspecialchars($old['detail'] ?? '')) ?>
                </div>
              <?php endforeach; ?>
            <?php endif; ?>
          <?php endif; ?>

          <!-- 처리 완료 제안 -->
          <?php if (!empty($doneProposals)): ?>
            <h6 class="fw-bold mt-4 mb-2 text-muted">처리 완료 제안</h6>
            <?php foreach ($doneProposals as $p): ?>
              <div class="p-2 mb-2 rounded d-flex justify-content-between align-items-center" style="background:#1e293b;border:1px solid #334155">
                <div class="small"><?= htmlspecialchars($p['title']) ?></div>
                <span class="badge <?= $p['approval_status'] === 'approved' ? 'bg-success' : 'bg-secondary' ?> ms-2">
                  <?= $p['approval_status'] === 'approved' ? '승인됨' : '반려됨' ?>
                </span>
              </div>
            <?php endforeach; ?>
          <?php endif; ?>

        <?php endif; ?>

      </div>
    </div>

  </div>
</div>

<script src="assets/dashboard.js"></script>
</body>
</html>
