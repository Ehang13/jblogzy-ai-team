<?php
// 콘텐츠 승인/반려 페이지

session_start();
require_once __DIR__ . '/../config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header('Location: index.php');
    exit;
}

$pdo = getDbConnection();

// 자동 승인 설정 조회
$autoApproveRow = $pdo->query("SELECT value FROM settings WHERE key_name = 'chm_auto_approve' LIMIT 1")->fetch();
$chmAutoApprove = ($autoApproveRow['value'] ?? '0') === '1';
$salesAutoApproveRow = $pdo->query("SELECT value FROM settings WHERE key_name = 'sales_auto_approve' LIMIT 1")->fetch();
$salesAutoApprove = ($salesAutoApproveRow['value'] ?? '0') === '1';

// 필터
$filter = $_GET['filter'] ?? 'pending';
$allowedFilters = ['pending', 'approved', 'rejected', 'regen_requested', 'published', 'all'];
if (!in_array($filter, $allowedFilters)) $filter = 'pending';

$where = $filter === 'all' ? '' : 'WHERE approval_status = ?';
$stmt = $pdo->prepare("
    SELECT * FROM content_queue
    $where
    ORDER BY created_at DESC
    LIMIT 50
");
$filter === 'all' ? $stmt->execute() : $stmt->execute([$filter]);
$items = $stmt->fetchAll();

// benefit_promises 일괄 조회 (content_queue_id 목록으로 in 쿼리)
$benefitMap = [];
if (!empty($items)) {
    $ids = implode(',', array_column($items, 'id'));
    $bpRows = $pdo->query("SELECT * FROM benefit_promises WHERE content_queue_id IN ($ids)")->fetchAll();
    foreach ($bpRows as $bp) {
        $benefitMap[$bp['content_queue_id']] = $bp;
    }
}

$departments = [
    'sales'     => ['name' => '영업팀',    'icon' => '📊'],
    'marketing' => ['name' => '마케팅팀',  'icon' => '✍️'],
    'chm'       => ['name' => '고객관리팀','icon' => '🤝'],
];

$platformLabels = [
    'naver_blog'    => '네이버 블로그',
    'instagram'     => '인스타그램',
    'email'         => '이메일',
    'image_prompt'  => '이미지 프롬프트',
];

function formatAudience(string $raw): string {
    // "member_id:123|basic 플랜 / 위험도 중간" → "basic 플랜 / 위험도 중간"
    return preg_replace('/^member_id:\d+\|/', '', $raw);
}
?>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>콘텐츠 승인 - jblogzy AI 팀</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>

<nav class="navbar navbar-dark px-4 py-3" style="background:#0f172a;border-bottom:1px solid #1e3a5f;">
  <a href="index.php" class="navbar-brand fw-bold">← jblogzy AI 팀</a>
  <span class="text-white fw-semibold">콘텐츠 승인 관리</span>
</nav>

<div class="container-fluid px-4 py-4">

  <!-- 자동 승인 토글 + 전체 반려 -->
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div class="d-flex align-items-center gap-3">
      <div class="d-flex align-items-center gap-2 me-3">
        <span class="text-white small">영업팀 자동 승인</span>
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" id="salesAutoApproveToggle"
                 <?= $salesAutoApprove ? 'checked' : '' ?>
                 onchange="toggleSalesAutoApprove(this.checked)"
                 style="cursor:pointer;width:2.5rem;height:1.25rem;">
        </div>
        <span id="salesAutoApproveLabel" class="badge <?= $salesAutoApprove ? 'bg-success' : 'bg-secondary' ?>">
          <?= $salesAutoApprove ? '자동 승인 ON' : '수동 승인' ?>
        </span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="text-white small">고객관리팀 자동 승인</span>
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" id="autoApproveToggle"
                 <?= $chmAutoApprove ? 'checked' : '' ?>
                 onchange="toggleAutoApprove(this.checked)"
                 style="cursor:pointer;width:2.5rem;height:1.25rem;">
        </div>
        <span id="autoApproveLabel" class="badge <?= $chmAutoApprove ? 'bg-success' : 'bg-secondary' ?>">
          <?= $chmAutoApprove ? '자동 승인 ON' : '수동 승인' ?>
        </span>
      </div>
    </div>
    <button onclick="bulkRejectChm()" class="btn btn-sm btn-outline-danger">
      🗑 CHM 대기 중 전체 반려
    </button>
  </div>

  <!-- 필터 탭 -->
  <div class="mb-4">
    <?php foreach ([
        'pending'        => '대기 중',
        'approved'       => '승인됨',
        'published'      => '발행됨',
        'rejected'       => '반려됨',
        'regen_requested'=> '재생성 요청',
        'all'            => '전체',
    ] as $f => $label): ?>
      <a href="?filter=<?= $f ?>"
         class="btn btn-sm me-1 <?= $f === $filter ? 'btn-primary' : 'btn-outline-secondary' ?>">
        <?= $label ?>
      </a>
    <?php endforeach; ?>
  </div>

  <?php if (empty($items)): ?>
    <div class="text-center text-muted py-5">
      <div style="font-size:3rem">✅</div>
      <p class="mt-2">해당 상태의 콘텐츠가 없습니다.</p>
    </div>
  <?php endif; ?>

  <?php foreach ($items as $item): ?>
    <?php $bp = $benefitMap[$item['id']] ?? null; ?>
    <div class="content-card" id="content-card-<?= $item['id'] ?>">
      <div class="d-flex justify-content-between align-items-start mb-3">
        <div>
          <span class="dept-badge dept-badge-<?= htmlspecialchars($item['department']) ?>">
            <?= $departments[$item['department']]['icon'] ?? '🤖' ?>
            <?= $departments[$item['department']]['name'] ?? $item['department'] ?>
          </span>
          <span class="badge bg-secondary ms-2">
            <?= htmlspecialchars($platformLabels[$item['target_platform']] ?? $item['target_platform']) ?>
          </span>
          <?php if ($item['target_audience']): ?>
            <span class="badge bg-dark ms-1"><?= htmlspecialchars(formatAudience($item['target_audience'])) ?></span>
          <?php endif; ?>
        </div>
        <div class="d-flex align-items-center gap-2">
          <?php
          $statusBadge = match($item['approval_status']) {
            'pending'         => '<span class="badge bg-warning text-dark">승인 대기</span>',
            'approved'        => '<span class="badge bg-success">승인됨</span>',
            'published'       => '<span class="badge bg-primary">발행됨</span>',
            'rejected'        => '<span class="badge bg-danger">반려됨</span>',
            'regen_requested' => '<span class="badge bg-info text-dark">재생성 요청</span>',
            'regenerated'     => '<span class="badge bg-secondary">재생성 완료</span>',
            default           => ''
          };
          echo $statusBadge;
          ?>
          <span class="small text-muted"><?= date('Y.m.d H:i', strtotime($item['created_at'])) ?></span>
        </div>
      </div>

      <?php if ($item['title']): ?>
        <h6 class="mb-2"><?= htmlspecialchars($item['title']) ?></h6>
      <?php endif; ?>

      <!-- 콘텐츠 본문 미리보기 -->
      <?php if ($item['body']): ?>
        <div class="content-preview mb-3"><?= htmlspecialchars($item['body']) ?></div>
      <?php endif; ?>

      <!-- 이미지 프롬프트 -->
      <?php if ($item['image_prompt']): ?>
        <div class="mb-3">
          <span class="small text-muted fw-semibold">🎨 이미지 생성 프롬프트</span>
          <div class="content-preview mt-1" style="max-height:100px">
            <?= htmlspecialchars($item['image_prompt']) ?>
          </div>
        </div>
      <?php endif; ?>

      <!-- 발행된 URL -->
      <?php if ($item['content_url']): ?>
        <div class="mb-3">
          <a href="<?= htmlspecialchars($item['content_url']) ?>" target="_blank" class="btn btn-sm btn-outline-info">
            <i class="bi bi-box-arrow-up-right"></i> 발행된 링크 보기
          </a>
        </div>
      <?php endif; ?>

      <!-- CHM 혜택 약속 박스 -->
      <?php if ($bp && in_array($item['approval_status'], ['pending', 'approved'])): ?>
        <?php $statusColor = $bp['status'] === 'promised' ? '#1a3a2a' : '#1e2f1e'; ?>
        <div style="background:<?= $statusColor ?>;border:1px solid #22c55e;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div class="fw-semibold text-success mb-1">
            💚 혜택 약속
            <?php if ($bp['status'] === 'promised'): ?>
              <span class="badge bg-success ms-1">jblogzy 적용 완료</span>
            <?php endif; ?>
          </div>
          <div class="small mb-1">
            <?= htmlspecialchars($bp['benefit_desc']) ?>
          </div>
          <?php if ($bp['benefit_type'] === 'renewal_discount' && $bp['status'] !== 'promised'): ?>
            <div class="small text-warning">⚡ 이메일 승인 시 jblogzy.com 계정에 자동 적용됩니다.</div>
          <?php elseif ($bp['benefit_type'] === 'referral_share'): ?>
            <div class="small text-muted">추천인 시스템이 가입 완료 시 자동 처리합니다.</div>
          <?php endif; ?>
        </div>
      <?php endif; ?>

      <!-- 액션 버튼 -->
      <?php if ($item['approval_status'] === 'pending'): ?>
        <div class="d-flex gap-2">
          <button id="btn-approve-<?= $item['id'] ?>"
                  onclick="handleApproval(<?= $item['id'] ?>, 'approve')"
                  class="btn btn-success btn-sm">
            <i class="bi bi-check-lg"></i> 승인
          </button>
          <button id="btn-reject-<?= $item['id'] ?>"
                  onclick="handleApproval(<?= $item['id'] ?>, 'reject')"
                  class="btn btn-outline-danger btn-sm">
            <i class="bi bi-x-lg"></i> 반려
          </button>
        </div>
      <?php elseif ($item['approval_status'] === 'rejected' && $item['department'] === 'chm'): ?>
        <div class="d-flex gap-2">
          <button onclick="requestRegenerate(<?= $item['id'] ?>)"
                  class="btn btn-outline-warning btn-sm">
            🔄 재생성 요청
          </button>
        </div>
      <?php endif; ?>
    </div>
  <?php endforeach; ?>

</div>

<script src="assets/dashboard.js"></script>
</body>
</html>
