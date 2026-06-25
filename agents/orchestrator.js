// CEO 오케스트레이터 - 모든 부서 에이전트를 스케줄에 맞춰 실행
// 실행: node agents/orchestrator.js  또는  npm start

import 'dotenv/config';
import cron from 'node-cron';
import { run as runSales }     from './sales.js';
import { run as runMarketing } from './marketing.js';
import { run as runChm }       from './chm.js';
import { sendMail }            from '../core/mailer.js';

const API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const API_KEY  = process.env.CAFE24_API_KEY;
const TIMEZONE = 'Asia/Seoul';

// 발송 속도 제한: 10분 cron당 최대 5건, 건당 90초 간격
const EMAIL_BATCH_SIZE = 5;
const EMAIL_DELAY_MS   = 90_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendApprovedChmEmails() {
  try {
    const res = await fetch(`${API_BASE}/fetch_approved_chm_emails.php`, {
      headers: { 'X-Api-Key': API_KEY },
    });
    const { emails } = await res.json();
    if (!emails?.length) return;

    const batch = emails.slice(0, EMAIL_BATCH_SIZE);
    console.log(`[CHM발송] 승인된 리텐션 이메일 ${emails.length}건 중 ${batch.length}건 발송`);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      try {
        await sendMail({
          to:      item.to,
          subject: item.subject,
          html:    item.body.replace(/\n/g, '<br>'),
          text:    item.body,
        });
        await fetch(`${API_BASE}/mark_chm_sent.php`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
          body:    JSON.stringify({ content_queue_id: item.id }),
        });
        console.log(`[CHM발송] ✓ ${item.to}`);
      } catch (e) {
        console.error(`[CHM발송] ✖ ${item.to} 실패:`, e.message);
      }
      if (i < batch.length - 1) await sleep(EMAIL_DELAY_MS);
    }
  } catch (e) {
    console.error('[CHM발송] 오류:', e.message);
  }
}

async function sendApprovedEmails() {
  try {
    const res = await fetch(`${API_BASE}/fetch_approved_leads.php`, {
      headers: { 'X-Api-Key': API_KEY },
    });
    const { leads } = await res.json();
    if (!leads?.length) return;

    const batch = leads.slice(0, EMAIL_BATCH_SIZE);
    console.log(`[메일발송] 승인된 리드 ${leads.length}건 중 ${batch.length}건 발송`);

    for (let i = 0; i < batch.length; i++) {
      const lead = batch[i];
      try {
        await sendMail({
          to:      lead.contact,
          subject: lead.email_subject,
          html:    lead.email_body.replace(/\n/g, '<br>'),
          text:    lead.email_body,
        });
        await fetch(`${API_BASE}/mark_lead_sent.php`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
          body:    JSON.stringify({ lead_id: lead.id }),
        });
        console.log(`[메일발송] ✓ ${lead.contact}`);
      } catch (e) {
        console.error(`[메일발송] ✖ ${lead.contact} 실패:`, e.message);
      }
      // 마지막 건 제외하고 대기
      if (i < batch.length - 1) await sleep(EMAIL_DELAY_MS);
    }
  } catch (e) {
    console.error('[메일발송] 오류:', e.message);
  }
}

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   🤖 jblogzy AI 자동화 팀 가동 시작      ║');
console.log('╚══════════════════════════════════════════╝');
console.log('');
console.log('📅 실행 스케줄:');
console.log('  · 영업팀   (salesAgent)      - 매일 08:00 / 12:00 / 16:00 / 20:00 (4회)');
console.log('  · 마케팅팀 (marketingAgent)  - 매일 10:00');
console.log('  · 고객관리팀(chmAgent)       - 매일 18:00');
console.log('  · 이메일발송                 - 10분마다 (최대 5건/회, 90초 간격)');
console.log('');
console.log(`⏰ 현재 시각: ${new Date().toLocaleString('ko-KR', { timeZone: TIMEZONE })}`);
console.log('');

// 안전 래퍼 - 에이전트 에러가 전체 프로세스를 중단시키지 않도록
async function safeRun(name, fn) {
  console.log(`\n▶ [${new Date().toLocaleTimeString('ko-KR')}] ${name} 시작`);
  try {
    await fn();
    console.log(`■ [${new Date().toLocaleTimeString('ko-KR')}] ${name} 완료`);
  } catch (err) {
    console.error(`✖ [${new Date().toLocaleTimeString('ko-KR')}] ${name} 오류:`, err.message);
  }
}

// 승인된 이메일 발송 - 10분마다 (배치 5건, 건당 90초 간격)
cron.schedule('*/10 * * * *', async () => {
  await sendApprovedEmails();
  await sendApprovedChmEmails();
}, { timezone: TIMEZONE });

// 영업팀 - 하루 4회 (08:00 / 12:00 / 16:00 / 20:00), 매 실행마다 새 지역
cron.schedule('0 8,12,16,20 * * *', () => {
  safeRun('영업팀 에이전트', runSales);
}, { timezone: TIMEZONE });

// 마케팅팀 - 매일 오전 10:00
cron.schedule('0 10 * * *', () => {
  safeRun('마케팅팀 에이전트', runMarketing);
}, { timezone: TIMEZONE });

// 고객관리팀 - 매일 오후 18:00
cron.schedule('0 18 * * *', () => {
  safeRun('고객관리팀 에이전트', runChm);
}, { timezone: TIMEZONE });

// 시작 시 즉시 테스트 실행 여부 체크 (--test 플래그)
const testMode = process.argv.includes('--test');
if (testMode) {
  console.log('🧪 테스트 모드: 모든 에이전트를 즉시 순차 실행합니다.\n');
  (async () => {
    await safeRun('영업팀 에이전트 (테스트)',     runSales);
    await safeRun('마케팅팀 에이전트 (테스트)',   runMarketing);
    await safeRun('고객관리팀 에이전트 (테스트)', runChm);
    console.log('\n✅ 전체 테스트 완료. 대시보드를 확인하세요.\n');
    process.exit(0);
  })();
} else {
  console.log('⏳ 스케줄 대기 중... (중지: Ctrl+C)\n');
}
