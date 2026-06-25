# cafe24 FTP 자동 배포 스크립트
# 실행: .\deploy.ps1

$FTP_HOST = "ftp://ehe13.mycafe24.com"
$FTP_USER = "ehe13"
$FTP_PASS = "Godlovesyou13!"
$REMOTE_BASE = "/ai-team"
$LOCAL_BASE  = "$PSScriptRoot\cafe24"

function Upload-File($localPath, $remotePath) {
    $uri     = "$FTP_HOST$remotePath"
    $request = [System.Net.FtpWebRequest]::Create($uri)
    $request.Method      = [System.Net.WebRequestMethods+Ftp]::UploadFile
    $request.Credentials = New-Object System.Net.NetworkCredential($FTP_USER, $FTP_PASS)
    $request.UseBinary   = $true
    $request.UsePassive  = $true
    $request.KeepAlive   = $false

    $content = [System.IO.File]::ReadAllBytes($localPath)
    $request.ContentLength = $content.Length
    $stream = $request.GetRequestStream()
    $stream.Write($content, 0, $content.Length)
    $stream.Close()

    try {
        $response = $request.GetResponse()
        $response.Close()
        return $true
    } catch {
        return $false
    }
}

# 배포할 파일 목록 (로컬 상대경로 → 서버 경로)
$files = @(
    @{ local = "config.php";                    remote = "$REMOTE_BASE/config.php" },
    @{ local = "setup.php";                     remote = "$REMOTE_BASE/setup.php" },
    @{ local = "api\report.php";                remote = "$REMOTE_BASE/api/report.php" },
    @{ local = "api\fetch_approved_leads.php";  remote = "$REMOTE_BASE/api/fetch_approved_leads.php" },
    @{ local = "api\mark_lead_sent.php";        remote = "$REMOTE_BASE/api/mark_lead_sent.php" },
    @{ local = "api\fetch_regen_requests.php";       remote = "$REMOTE_BASE/api/fetch_regen_requests.php" },
    @{ local = "api\mark_regen_done.php";            remote = "$REMOTE_BASE/api/mark_regen_done.php" },
    @{ local = "api\get_setting.php";                remote = "$REMOTE_BASE/api/get_setting.php" },
    @{ local = "api\set_setting.php";                remote = "$REMOTE_BASE/api/set_setting.php" },
    @{ local = "api\bulk_reject_chm.php";            remote = "$REMOTE_BASE/api/bulk_reject_chm.php" },
    @{ local = "api\auto_approve_chm.php";           remote = "$REMOTE_BASE/api/auto_approve_chm.php" },
    @{ local = "api\fetch_approved_chm_emails.php";  remote = "$REMOTE_BASE/api/fetch_approved_chm_emails.php" },
    @{ local = "api\mark_chm_sent.php";              remote = "$REMOTE_BASE/api/mark_chm_sent.php" },
    @{ local = "api\regenerate_content.php";    remote = "$REMOTE_BASE/api/regenerate_content.php" },
    @{ local = "admin\index.php";               remote = "$REMOTE_BASE/admin/index.php" },
    @{ local = "admin\approve.php";             remote = "$REMOTE_BASE/admin/approve.php" },
    @{ local = "admin\approve_lead.php";        remote = "$REMOTE_BASE/admin/approve_lead.php" },
    @{ local = "admin\content.php";             remote = "$REMOTE_BASE/admin/content.php" },
    @{ local = "admin\department.php";          remote = "$REMOTE_BASE/admin/department.php" },
    @{ local = "admin\leads.php";               remote = "$REMOTE_BASE/admin/leads.php" },
    @{ local = "admin\assets\dashboard.js";     remote = "$REMOTE_BASE/admin/assets/dashboard.js" },
    @{ local = "admin\assets\style.css";        remote = "$REMOTE_BASE/admin/assets/style.css" }
)

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  jblogzy AI 팀 cafe24 배포" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

$ok = 0; $fail = 0

foreach ($f in $files) {
    $localFull = Join-Path $LOCAL_BASE $f.local
    if (-not (Test-Path $localFull)) {
        Write-Host "  SKIP  $($f.local) (파일 없음)" -ForegroundColor DarkGray
        continue
    }
    $success = Upload-File $localFull $f.remote
    if ($success) {
        Write-Host "  OK    $($f.local)" -ForegroundColor Green
        $ok++
    } else {
        Write-Host "  FAIL  $($f.local)" -ForegroundColor Red
        $fail++
    }
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  완료: $ok 성공, $fail 실패" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Yellow" })
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if ($fail -eq 0) {
    Write-Host "다음 단계:" -ForegroundColor White
    Write-Host "  1. https://ehe13.mycafe24.com/ai-team/setup.php?token=setup2024jblogzy 접속 → benefit_promises 테이블 생성" -ForegroundColor Gray
    Write-Host "  2. https://ehe13.mycafe24.com/ai-team/admin/ 에서 대시보드 확인" -ForegroundColor Gray
    Write-Host ""
}
