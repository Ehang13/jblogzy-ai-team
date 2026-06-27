// 승인된 영업 리드 + CHM 리텐션 이메일 발송
// GitHub Actions send-emails.yml 에서 직접 실행

import 'dotenv/config';
import { sendMail } from '../core/mailer.js';

function mdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')   // **bold**
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')            // *italic*
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,                 // [text](url)
             '<a href="$2" style="color:#3b82f6">$1</a>')
    .replace(/\n/g, '<br>');
}

const API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const API_KEY  = process.env.CAFE24_API_KEY;

const BATCH_SIZE = 42;   // 1회 최대 42건 (하루 12회 × 42 = 504건)
const DELAY_MS   = 60_000; // 건당 60초 간격

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendApprovedLeads() {
  const res  = await fetch(`${API_BASE}/fetch_approved_leads.php`, { headers: { 'X-Api-Key': API_KEY } });
  const { leads } = await res.json();
  if (!leads?.length) { console.log('[영업] 발송 대기 리드 없음'); return; }

  const batch = leads.slice(0, BATCH_SIZE);
  console.log(`[영업] ${leads.length}건 중 ${batch.length}건 발송`);

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    try {
      await sendMail({ to: lead.contact, subject: lead.email_subject,
                       html: mdToHtml(lead.email_body), text: lead.email_body });
      await fetch(`${API_BASE}/mark_lead_sent.php`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      console.log(`[영업] ✓ ${lead.contact}`);
    } catch (e) {
      console.error(`[영업] ✖ ${lead.contact}:`, e.message);
    }
    if (i < batch.length - 1) await sleep(DELAY_MS);
  }
}

async function sendApprovedChmEmails() {
  const res  = await fetch(`${API_BASE}/fetch_approved_chm_emails.php`, { headers: { 'X-Api-Key': API_KEY } });
  const { emails } = await res.json();
  if (!emails?.length) { console.log('[CHM] 발송 대기 이메일 없음'); return; }

  const batch = emails.slice(0, BATCH_SIZE);
  console.log(`[CHM] ${emails.length}건 중 ${batch.length}건 발송`);

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    try {
      await sendMail({ to: item.to, subject: item.subject,
                       html: mdToHtml(item.body), text: item.body });
      await fetch(`${API_BASE}/mark_chm_sent.php`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ content_queue_id: item.id }),
      });
      console.log(`[CHM] ✓ ${item.to}`);
    } catch (e) {
      console.error(`[CHM] ✖ ${item.to}:`, e.message);
    }
    if (i < batch.length - 1) await sleep(DELAY_MS);
  }
}

console.log('\n📨 이메일 발송 시작');
await sendApprovedLeads();
await sendApprovedChmEmails();
console.log('📨 이메일 발송 완료\n');
