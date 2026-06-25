// 자체 감사 에이전트 - 매주 월요일 09:00 실행
// 지난 7일 부서별 운영 데이터를 분석해 문제점·개선 제안을 대시보드+이메일로 리포트

import 'dotenv/config';
import { ask } from '../core/claude.js';
import { send, notifyError } from '../core/reporter.js';
import { sendMail } from '../core/mailer.js';

const DEPARTMENT  = 'ceo';
const CAFE24_API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const CAFE24_API_KEY  = process.env.CAFE24_API_KEY;
const ADMIN_EMAIL     = process.env.SMTP_USER;

async function fetchAuditData() {
  const res = await fetch(`${CAFE24_API_BASE}/fetch_audit_data.php`, {
    headers: { 'X-Api-Key': CAFE24_API_KEY },
  });
  if (!res.ok) throw new Error(`감사 데이터 조회 실패: ${res.status}`);
  return res.json();
}

function mdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/\n/g, '<br>');
}

export async function run() {
  console.log('\n🔍 [자체 감사] 주간 운영 현황 분석 시작');

  let auditData;
  try {
    auditData = await fetchAuditData();
  } catch (err) {
    await notifyError(DEPARTMENT, '주간 자체 감사', err);
    return;
  }

  console.log(`  → 영업팀 리드 ${auditData.sales.total_leads}건 / 마케팅 ${auditData.marketing.total_contents}건 / CHM ${auditData.chm.total_generated}건`);

  const report = await ask(`
당신은 jblogzy AI 자동화 팀의 품질 감사관입니다.
아래는 지난 7일간 각 부서의 운영 데이터입니다. 이 데이터를 바탕으로 실무 감사 리포트를 작성하세요.

## 운영 데이터
${JSON.stringify(auditData, null, 2)}

## 작성 지침
- 각 부서별로 (영업팀 / 마케팅팀 / 고객관리팀) 아래 세 가지를 분석하세요:
  1. **이상 징후**: 수치 기반으로 발견된 문제 (예: 중복 발송, 특정 업종 편중, 낮은 승인률 등)
  2. **운영 의문점**: "현재 방식이 최선인가?" 형태의 질문 (데이터 근거 필수)
  3. **개선 제안**: 구체적이고 실행 가능한 1~2가지 제안
- 마지막에 **종합 제언** 섹션을 추가하세요
- 문제가 없는 항목은 "이상 없음"으로 간단히 명시
- 모호한 표현 금지, 수치를 직접 인용할 것
- 전체 분량: 500자 내외
`);

  console.log('\n📋 감사 리포트 생성 완료');

  // 대시보드 전송
  await send({
    department: DEPARTMENT,
    task_type:  '주간 자체 감사',
    status:     'completed',
    summary:    `주간 AI팀 자체 감사 완료 (영업 ${auditData.sales.total_leads}건 / 마케팅 ${auditData.marketing.total_contents}건 / CHM ${auditData.chm.total_generated}건)`,
    detail:     report,
  });

  // 관리자 이메일 발송
  if (ADMIN_EMAIL) {
    try {
      await sendMail({
        to:      ADMIN_EMAIL,
        subject: `[jblogzy AI팀] 주간 자체 감사 리포트`,
        html:    mdToHtml(report),
        text:    report,
      });
      console.log(`  → 이메일 발송 완료: ${ADMIN_EMAIL}`);
    } catch (e) {
      console.error('  → 이메일 발송 실패:', e.message);
    }
  }

  console.log('✅ [자체 감사] 완료\n');
}

// 직접 실행 지원
if (process.argv[1].endsWith('reviewer.js')) {
  run().catch(console.error);
}
