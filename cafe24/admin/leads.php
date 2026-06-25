<?php
// 영업팀 리드 현황 페이지

session_start();
require_once __DIR__ . '/../config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header('Location: index.php');
    exit;
}

$pdo = getDbConnection();

// CSV 다운로드
if (($_GET['action'] ?? '') === 'csv') {
    $csvFilter = $_GET['filter'] ?? 'all';
    $allowedCsvFilters = ['pending', 'approved', 'sent', 'replied', 'all'];
    if (!in_array($csvFilter, $allowedCsvFilters)) $csvFilter = 'all';
    $csvWhere = $csvFilter === 'all' ? '' : 'WHERE email_status = ?';
    $csvStmt = $pdo->prepare("SELECT industry, contact, contact_type, platform, source_url, email_status, email_subject, created_at FROM leads $csvWhere ORDER BY created_at DESC");
    $csvFilter === 'all' ? $csvStmt->execute() : $csvStmt->execute([$csvFilter]);
    $rows = $csvStmt->fetchAll(PDO::FETCH_ASSOC);

    $filename = 'jblogzy_leads_' . date('Ymd_His') . '.csv';
    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Cache-Control: no-cache');
    // BOM for Excel Korean charset
    echo "\xEF\xBB\xBF";
    $out = fopen('php://output', 'w');
    fputcsv($out, ['업종', '연락처', '연락유형', '플랫폼', '소스URL', '이메일상태', '이메일제목', '발굴일']);
    foreach ($rows as $row) {
        fputcsv($out, [
            $row['industry'], $row['contact'], $row['contact_type'] ?? 'email',
            $row['platform'], $row['source_url'], $row['email_status'],
            $row['email_subject'], $row['created_at'],
        ]);
    }
    fclose($out);
    exit;
}

$filter = $_GET['filter'] ?? 'pending';
$allowedFilters = ['pending', 'guess', 'approved', 'sent', 'replied', 'all'];
if (!in_array($filter, $allowedFilters)) $filter = 'pending';

$where = $filter === 'all' ? '' : 'WHERE email_status = ?';
$stmt = $pdo->prepare("SELECT * FROM leads $where ORDER BY created_at DESC LIMIT 100");
$filter === 'all' ? $stmt->execute() : $stmt->execute([$filter]);
$leads = $stmt->fetchAll();

// 오늘 통계
$today = date('Y-m-d');
$stmtStats = $pdo->prepare('
    SELECT
        COUNT(*) AS total,
        SUM(email_status = "sent") AS sent,
        SUM(email_status = "pending") AS pending_count,
        SUM(email_status = "replied") AS replied
    FROM leads
    WHERE DATE(created_at) = ?
');
$stmtStats->execute([$today]);
$stats = $stmtStats->fetch();

$industryColors = [
    '외식업 (맛집/카페)'             => 'success',
    '미용 (헤어/네일/속눈썹)'        => 'danger',
    '피트니스 (헬스/필라테스/요가)'  => 'warning',
    '병원/의원 (치과/한의원/피부과)' => 'info',
    '정형외과'                        => 'primary',
    '안과'                            => 'info',
    '성형외과'                        => 'danger',
    '교육 (학원/과외)'               => 'warning',
    '반려동물 (동물병원/펫샵)'       => 'success',
    '인테리어/시공'                   => 'cyan',
    '부동산/공인중개사'               => 'primary',
    '숙박업 (펜션/게스트하우스)'     => 'info',
    '자동차 (정비/세차)'             => 'warning',
    '사진관/스튜디오'                 => 'danger',
    '꽃집/화원'                       => 'success',
    '건강/웰니스 (마사지/스파)'      => 'teal',
    '의류/패션 (쇼핑몰)'            => 'primary',
    '아동/육아 (키즈카페/유아교육)' => 'orange',
];
?>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>영업팀 리드 현황 - jblogzy AI 팀</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>

<nav class="navbar navbar-dark px-4 py-3" style="background:#0f172a;border-bottom:1px solid #1e3a5f;">
  <a href="index.php" class="navbar-brand fw-bold">← jblogzy AI 팀</a>
  <span class="text-white fw-semibold">📊 영업팀 리드 현황</span>
  <div class="d-flex gap-2">
    <a href="?action=csv&filter=all" class="btn btn-sm btn-outline-success">
      <i class="bi bi-download"></i> 전체 CSV 다운로드
    </a>
    <a href="?action=csv&filter=<?= $filter ?>" class="btn btn-sm btn-outline-info">
      <i class="bi bi-download"></i> 현재 필터 CSV
    </a>
  </div>
</nav>

<div class="container-fluid px-4 py-4">

  <!-- 오늘 통계 -->
  <div class="row g-3 mb-4">
    <?php foreach ([
      ['label'=>'오늘 발굴', 'value'=>$stats['total'], 'color'=>'text-info'],
      ['label'=>'발송 대기', 'value'=>$stats['pending_count'], 'color'=>'text-warning'],
      ['label'=>'발송 완료', 'value'=>$stats['sent'], 'color'=>'text-success'],
      ['label'=>'응답 수신', 'value'=>$stats['replied'], 'color'=>'text-primary'],
    ] as $s): ?>
      <div class="col-6 col-md-3">
        <div class="stat-card">
          <div class="stat-value <?= $s['color'] ?>"><?= $s['value'] ?? 0 ?></div>
          <div class="stat-label"><?= $s['label'] ?></div>
        </div>
      </div>
    <?php endforeach; ?>
  </div>

  <!-- 필터 -->
  <div class="mb-3">
    <?php foreach (['pending'=>'발송 대기','guess'=>'Gmail 추정','approved'=>'발송 승인','sent'=>'발송됨','replied'=>'응답 옴','all'=>'전체'] as $f => $label): ?>
      <a href="?filter=<?= $f ?>"
         class="btn btn-sm me-1 <?= $f === $filter ? 'btn-success' : 'btn-outline-secondary' ?>">
        <?= $label ?>
      </a>
    <?php endforeach; ?>
  </div>

  <!-- 리드 테이블 -->
  <?php if (empty($leads)): ?>
    <div class="text-center text-muted py-5">
      <div style="font-size:3rem">📋</div>
      <p class="mt-2">해당 상태의 리드가 없습니다.</p>
    </div>
  <?php else: ?>
    <div style="background:var(--bg-card);border-radius:12px;border:1px solid var(--border);overflow:hidden;">
      <table class="table table-dark table-hover mb-0">
        <thead>
          <tr>
            <th>업종</th>
            <th>연락처</th>
            <th>플랫폼</th>
            <th>이메일 초안</th>
            <th>발굴 경로</th>
            <th>상태</th>
            <th>발굴일</th>
            <th>액션</th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($leads as $lead): ?>
            <tr id="lead-row-<?= $lead['id'] ?>">
              <td>
                <?php $color = $industryColors[$lead['industry']] ?? 'secondary'; ?>
                <span class="badge bg-<?= $color ?>"><?= htmlspecialchars($lead['industry'] ?? '-') ?></span>
              </td>
              <td>
                <span class="small"><?= htmlspecialchars($lead['contact'] ?? '-') ?></span>
              </td>
              <td style="color:#94a3b8;font-size:.85rem"><?= htmlspecialchars($lead['platform'] ?: 'naver_place') ?></td>
              <td>
                <?php if ($lead['email_body']): ?>
                  <button class="btn btn-sm btn-outline-info py-0"
                          onclick="showEmailPreview(<?= $lead['id'] ?>, this)">
                    미리보기
                  </button>
                  <div id="email-preview-<?= $lead['id'] ?>" class="content-preview mt-2" style="display:none;max-height:200px">
                    <strong><?= htmlspecialchars($lead['email_subject'] ?? '') ?></strong>
                    <hr style="border-color:#334155">
                    <?= htmlspecialchars($lead['email_body']) ?>
                  </div>
                <?php else: ?>
                  <span class="text-muted small">없음</span>
                <?php endif; ?>
              </td>
              <td>
                <?php if ($lead['source_url']): ?>
                  <a href="<?= htmlspecialchars($lead['source_url']) ?>" target="_blank"
                     class="btn btn-sm btn-outline-secondary py-0">
                    <i class="bi bi-link-45deg"></i>
                  </a>
                <?php else: ?>
                  <span class="text-muted">-</span>
                <?php endif; ?>
              </td>
              <td class="status-badge">
                <?php
                $statusMap = [
                    'pending'     => ['warning', '대기'],
                    'approved'    => ['info',    '승인됨'],
                    'sent'        => ['success', '발송됨'],
                    'replied'     => ['primary', '응답 옴'],
                    'unsubscribed'=> ['secondary','수신거부'],
                ];
                [$color, $label] = $statusMap[$lead['email_status']] ?? ['secondary', $lead['email_status']];
                ?>
                <span class="badge bg-<?= $color ?>"><?= $label ?></span>
              </td>
              <td style="color:#94a3b8;font-size:.85rem"><?= $lead['created_at'] ? date('m.d', strtotime($lead['created_at'])) : '-' ?></td>
              <td>
                <?php if ($lead['email_status'] === 'pending'): ?>
                  <button onclick="approveLead(<?= $lead['id'] ?>)"
                          class="btn btn-sm btn-success py-0">
                    발송 승인
                  </button>
                <?php endif; ?>
              </td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  <?php endif; ?>

</div>

<script src="assets/dashboard.js"></script>
<script>
function showEmailPreview(id, btn) {
  const el = document.getElementById('email-preview-' + id);
  if (el.style.display === 'none') {
    el.style.display = 'block';
    btn.textContent = '닫기';
  } else {
    el.style.display = 'none';
    btn.textContent = '미리보기';
  }
}
</script>
</body>
</html>
