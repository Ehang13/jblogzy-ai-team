<?php
// 네이버 계정 관리 페이지
session_start();
require_once __DIR__ . '/../config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header('Location: index.php'); exit;
}

$pdo = getDbConnection();

$accounts = [];
try {
    $pdo->exec("CREATE TABLE IF NOT EXISTS naver_accounts (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        blog_id      VARCHAR(100) NOT NULL UNIQUE,
        cookies      TEXT NOT NULL,
        is_active    TINYINT(1) DEFAULT 1,
        last_post_at DATETIME NULL,
        post_count   INT DEFAULT 0,
        error_count  INT DEFAULT 0,
        last_error   TEXT NULL,
        created_at   DATETIME DEFAULT NOW()
    )");
    $accounts = $pdo->query("SELECT id, blog_id, is_active, post_count, error_count, last_post_at, last_error, created_at FROM naver_accounts ORDER BY created_at ASC")->fetchAll();
} catch (PDOException $e) {}
?>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>네이버 계정 관리 - jblogzy AI 팀</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="assets/style.css">
  <style>
    #add-form textarea::placeholder { color: #64748b; }
    #add-form textarea, #add-form input[type=text] { color: #e2e8f0 !important; }
  </style>
</head>
<body>

<nav class="navbar navbar-dark px-4 py-3" style="background:#0f172a;border-bottom:1px solid #1e3a5f;">
  <a href="index.php" class="navbar-brand fw-bold">← jblogzy AI 팀</a>
  <span class="text-white fw-semibold">🔑 네이버 계정 관리</span>
  <button class="btn btn-sm btn-primary" onclick="toggleAddForm()">+ 계정 추가</button>
</nav>

<div class="container-fluid px-4 py-4">

  <!-- 계정 추가 폼 -->
  <div id="add-form" style="display:none" class="feed-container mb-4 p-4">
    <h6 class="fw-bold mb-3">새 네이버 계정 등록</h6>
    <div class="mb-3">
      <label class="small text-muted mb-1 d-block">블로그 ID <span class="text-danger">*</span></label>
      <input type="text" id="new-blog-id" class="form-control form-control-sm"
             placeholder="예: myblog123"
             style="background:#0f172a;border-color:#475569;color:#e2e8f0;max-width:300px">
    </div>
    <div class="mb-3">
      <label class="small text-muted mb-1 d-block">
        쿠키 (base64) <span class="text-danger">*</span>
        <span class="ms-2 text-muted" style="font-weight:normal">
          — 로컬에서 <code style="color:#93c5fd">node scripts/save_naver_cookies.js</code> 실행 후 출력된 값 붙여넣기
        </span>
      </label>
      <textarea id="new-cookies" class="form-control form-control-sm" rows="4"
                placeholder="W3sibmFtZSI6Ik5JRF9BVVQi..."
                style="background:#0f172a;border-color:#475569;color:#e2e8f0;resize:vertical;font-family:monospace;font-size:.75rem"></textarea>
    </div>
    <button class="btn btn-sm btn-primary" onclick="addAccount()">저장</button>
    <button class="btn btn-sm btn-outline-secondary ms-2" onclick="toggleAddForm()">취소</button>
  </div>

  <!-- 쿠키 갱신 폼 (동적 생성) -->
  <div id="update-cookie-form" style="display:none" class="feed-container mb-4 p-4">
    <h6 class="fw-bold mb-2">쿠키 갱신 — <span id="update-blog-label" style="color:#93c5fd"></span></h6>
    <div class="small text-muted mb-3">
      로컬에서 <code style="color:#93c5fd">node scripts/save_naver_cookies.js</code> 실행 후 출력된 base64 값을 붙여넣으세요.
    </div>
    <textarea id="update-cookies-val" class="form-control form-control-sm mb-3" rows="4"
              placeholder="W3sibmFtZSI6Ik5JRF9BVVQi..."
              style="background:#0f172a;border-color:#475569;color:#e2e8f0;resize:vertical;font-family:monospace;font-size:.75rem"></textarea>
    <input type="hidden" id="update-account-id">
    <button class="btn btn-sm btn-warning" onclick="submitCookieUpdate()">갱신</button>
    <button class="btn btn-sm btn-outline-secondary ms-2" onclick="closeUpdateForm()">취소</button>
  </div>

  <!-- 계정 목록 -->
  <?php if (empty($accounts)): ?>
    <div class="feed-container p-4 text-center">
      <div style="font-size:2.5rem;margin-bottom:12px">🔑</div>
      <div class="fw-semibold mb-1">등록된 네이버 계정이 없습니다</div>
      <div class="small text-muted">계정을 추가하면 환경변수(NAVER_BLOG_ID) 대신 DB 계정을 round-robin으로 사용합니다.</div>
    </div>
  <?php else: ?>
    <div style="background:var(--bg-card);border-radius:12px;border:1px solid var(--border);overflow:hidden">
      <table class="table table-dark table-hover mb-0">
        <thead>
          <tr>
            <th>블로그 ID</th>
            <th>상태</th>
            <th>발행 수</th>
            <th>오류 수</th>
            <th>마지막 발행</th>
            <th>마지막 오류</th>
            <th>등록일</th>
            <th>액션</th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($accounts as $acc): ?>
          <tr id="acc-row-<?= (int)$acc['id'] ?>">
            <td>
              <a href="https://blog.naver.com/<?= htmlspecialchars($acc['blog_id']) ?>" target="_blank"
                 class="text-info text-decoration-none fw-semibold">
                <?= htmlspecialchars($acc['blog_id']) ?>
              </a>
            </td>
            <td>
              <?php if ($acc['is_active']): ?>
                <span class="badge bg-success">활성</span>
              <?php else: ?>
                <span class="badge bg-danger">비활성</span>
              <?php endif; ?>
            </td>
            <td style="color:#4ade80"><?= (int)$acc['post_count'] ?></td>
            <td style="color:<?= $acc['error_count'] > 0 ? '#f87171' : '#64748b' ?>">
              <?= (int)$acc['error_count'] ?>
            </td>
            <td style="color:#94a3b8;font-size:.85rem">
              <?= $acc['last_post_at'] ? date('m.d H:i', strtotime($acc['last_post_at'])) : '-' ?>
            </td>
            <td style="color:#f87171;font-size:.75rem;max-width:200px">
              <?= $acc['last_error'] ? htmlspecialchars(mb_strimwidth($acc['last_error'], 0, 60, '...')) : '-' ?>
            </td>
            <td style="color:#64748b;font-size:.8rem">
              <?= date('m.d', strtotime($acc['created_at'])) ?>
            </td>
            <td>
              <div class="d-flex gap-1">
                <button class="btn btn-sm btn-outline-warning py-0"
                  onclick="openCookieUpdate(<?= (int)$acc['id'] ?>, '<?= htmlspecialchars($acc['blog_id']) ?>')">
                  쿠키 갱신
                </button>
                <button class="btn btn-sm btn-outline-danger py-0"
                  onclick="deleteAccount(<?= (int)$acc['id'] ?>, '<?= htmlspecialchars($acc['blog_id']) ?>')">
                  삭제
                </button>
              </div>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <div class="small text-muted mt-3">
      총 <?= count($accounts) ?>개 계정 — 포스팅 시 마지막 발행이 가장 오래된 활성 계정부터 순환 사용됩니다.
      오류 3회 누적 시 자동 비활성화됩니다.
    </div>
  <?php endif; ?>

</div>

<script>
const API_BASE = '../api';

function toggleAddForm() {
  const f = document.getElementById('add-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if (f.style.display === 'block') document.getElementById('new-blog-id').focus();
}

async function addAccount() {
  const blogId  = document.getElementById('new-blog-id').value.trim();
  const cookies = document.getElementById('new-cookies').value.trim();
  if (!blogId)  { alert('블로그 ID를 입력하세요'); return; }
  if (!cookies) { alert('쿠키 값을 입력하세요'); return; }

  const res  = await fetch(API_BASE + '/manage_naver_account.php', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'add', blog_id: blogId, cookies }),
  });
  const data = await res.json();
  if (data.success) { location.reload(); }
  else { alert('등록 실패: ' + (data.error ?? '알 수 없는 오류')); }
}

async function deleteAccount(id, blogId) {
  if (!confirm(`"${blogId}" 계정을 삭제하시겠습니까?`)) return;
  const res  = await fetch(API_BASE + '/manage_naver_account.php', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'delete', id }),
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('acc-row-' + id)?.remove();
  } else {
    alert('삭제 실패: ' + (data.error ?? '알 수 없는 오류'));
  }
}

function openCookieUpdate(id, blogId) {
  document.getElementById('update-account-id').value  = id;
  document.getElementById('update-blog-label').textContent = blogId;
  document.getElementById('update-cookies-val').value = '';
  document.getElementById('update-cookie-form').style.display = 'block';
  document.getElementById('update-cookies-val').focus();
}

function closeUpdateForm() {
  document.getElementById('update-cookie-form').style.display = 'none';
}

async function submitCookieUpdate() {
  const id      = document.getElementById('update-account-id').value;
  const cookies = document.getElementById('update-cookies-val').value.trim();
  if (!cookies) { alert('쿠키 값을 입력하세요'); return; }

  const res  = await fetch(API_BASE + '/manage_naver_account.php', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'update_cookies', id: parseInt(id), cookies }),
  });
  const data = await res.json();
  if (data.success) { location.reload(); }
  else { alert('갱신 실패: ' + (data.error ?? '알 수 없는 오류')); }
}
</script>
</body>
</html>
