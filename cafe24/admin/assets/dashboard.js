// 대시보드 자동 갱신 및 UI 인터랙션

const REFRESH_INTERVAL = 30000; // 30초

function updateLastUpdatedTime() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = '마지막 갱신: ' + new Date().toLocaleTimeString('ko-KR');
}

// 30초마다 페이지 새로고침 (피드 업데이트)
function scheduleRefresh() {
  setTimeout(() => {
    window.location.reload();
  }, REFRESH_INTERVAL);
}

// 콘텐츠 승인/반려 처리 (content.php에서 사용)
async function handleApproval(contentId, action) {
  const btn = document.getElementById(`btn-${action}-${contentId}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '처리 중...';
  }

  try {
    const res = await fetch('approve.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_id: contentId, action }),
    });
    const data = await res.json();

    if (data.success) {
      const card = document.getElementById(`content-card-${contentId}`);
      if (card) {
        card.style.opacity = '0.4';
        card.style.transition = 'opacity 0.4s';
        setTimeout(() => card.remove(), 400);
      }
    } else {
      alert('처리 실패: ' + (data.error || '알 수 없는 오류'));
      if (btn) { btn.disabled = false; btn.textContent = action === 'approve' ? '승인' : '반려'; }
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
    if (btn) { btn.disabled = false; }
  }
}

// 영업팀 자동 승인 토글
async function toggleSalesAutoApprove(enabled) {
  const label = document.getElementById('salesAutoApproveLabel');
  try {
    const res = await fetch('../api/set_setting.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: 'sales_auto_approve', value: enabled ? '1' : '0' }),
    });
    const data = await res.json();
    if (data.success) {
      if (label) {
        label.textContent = enabled ? '자동 승인 ON' : '수동 승인';
        label.className   = `badge ${enabled ? 'bg-success' : 'bg-secondary'}`;
      }
    } else {
      alert('설정 변경 실패: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// 마케팅팀 자동 승인 토글
async function toggleMarketingAutoApprove(enabled) {
  const label = document.getElementById('marketingAutoApproveLabel');
  try {
    const res = await fetch('../api/set_setting.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: 'marketing_auto_approve', value: enabled ? '1' : '0' }),
    });
    const data = await res.json();
    if (data.success) {
      if (label) {
        label.textContent = enabled ? '자동 승인 ON' : '수동 승인';
        label.className   = `badge ${enabled ? 'bg-success' : 'bg-secondary'}`;
      }
    } else {
      alert('설정 변경 실패: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// CHM 자동 승인 토글
async function toggleAutoApprove(enabled) {
  const label = document.getElementById('autoApproveLabel');
  try {
    const res = await fetch('../api/set_setting.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: 'chm_auto_approve', value: enabled ? '1' : '0' }),
    });
    const data = await res.json();
    if (data.success) {
      if (label) {
        label.textContent = enabled ? '자동 승인 ON' : '수동 승인';
        label.className   = `badge ${enabled ? 'bg-success' : 'bg-secondary'}`;
      }
    } else {
      alert('설정 변경 실패: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// 마케팅팀 대기 중 전체 반려
async function bulkRejectMarketing() {
  if (!confirm('대기 중인 마케팅팀 콘텐츠를 모두 반려하시겠습니까?')) return;
  try {
    const res  = await fetch('../api/bulk_reject_marketing.php', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`${data.rejected}건이 반려 처리되었습니다.`);
      window.location.reload();
    } else {
      alert('오류: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// CHM 대기 중 전체 반려
async function bulkRejectChm() {
  if (!confirm('대기 중인 고객관리팀 이메일을 모두 반려하시겠습니까?')) return;
  try {
    const res  = await fetch('../api/bulk_reject_chm.php', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`${data.rejected}건이 반려 처리되었습니다.`);
      window.location.reload();
    } else {
      alert('오류: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// CHM 이메일 재생성 요청 (content.php에서 사용)
async function requestRegenerate(contentId) {
  if (!confirm('이 이메일 초안을 재생성 요청하시겠습니까?\n다음 고객관리팀 실행 시 자동으로 새 초안이 생성됩니다.')) return;

  try {
    const res = await fetch('../api/regenerate_content.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content_id: contentId }),
    });
    const data = await res.json();

    if (data.success) {
      const card = document.getElementById(`content-card-${contentId}`);
      if (card) {
        const badge = card.querySelector('.badge.bg-danger');
        if (badge) badge.outerHTML = '<span class="badge bg-info text-dark">재생성 요청</span>';
        const btn = card.querySelector('button[onclick]');
        if (btn) btn.remove();
      }
    } else {
      alert('오류: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// 리드 발송 승인 처리 (leads.php에서 사용)
async function approveLead(leadId) {
  if (!confirm('이 리드에게 제안 이메일을 발송하시겠습니까?')) return;

  try {
    const res = await fetch('approve_lead.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId }),
    });
    const data = await res.json();

    if (data.success) {
      const row = document.getElementById(`lead-row-${leadId}`);
      if (row) {
        row.querySelector('.status-badge').outerHTML =
          '<span class="badge bg-success">발송 승인</span>';
      }
    } else {
      alert('오류: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('네트워크 오류가 발생했습니다.');
  }
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  updateLastUpdatedTime();
  scheduleRefresh();
});
