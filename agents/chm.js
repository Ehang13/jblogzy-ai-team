// 고객관리팀(CHM) 에이전트 - 매일 오후 6시 실행
// 회원 데이터 분석 → 이탈 위험도 점수 → 맞춤 리텐션 이메일 초안 생성

import 'dotenv/config';
import { ask, askJson } from '../core/claude.js';
import { send, notifyStart, notifyError } from '../core/reporter.js';

const DEPARTMENT = 'chm';

const RISK_LEVELS = {
  HIGH:   { min: 70, label: '높음', badge: '🔴', action: '즉시 연락' },
  MEDIUM: { min: 40, label: '중간', badge: '🟡', action: '리뉴얼 안내' },
  LOW:    { min: 0,  label: '낮음', badge: '🟢', action: '감사 인사' },
};

// 이메일에 포함할 혜택을 고정 — Claude가 임의로 수치를 만들지 않도록
const BENEFIT_RULES = {
  MEDIUM: {
    type:  'renewal_discount',
    value: '10',
    desc:  '다음 갱신 시 10% 할인',
  },
  LOW: {
    type:  'referral_share',
    value: null,
    desc:  '추천인 링크로 지인 초대 시 추천인·피추천인 각 10% 혜택 (자동 적용)',
  },
};

const CAFE24_API_BASE = process.env.CAFE24_API_URL.replace('/report.php', '');
const CAFE24_API_KEY  = process.env.CAFE24_API_KEY;

/**
 * 회원 데이터 조회 - jblogzy API
 */
async function fetchMemberData() {
  const res = await fetch(process.env.JBLOGZY_API_URL, {
    headers: { 'X-Api-Key': process.env.JBLOGZY_API_KEY },
  });
  if (!res.ok) throw new Error(`jblogzy API 오류: ${res.status}`);
  const { members } = await res.json();
  return members.slice(0, 30);
}

/**
 * 자동 승인 설정 조회
 */
async function isChmAutoApproveEnabled() {
  try {
    const res = await fetch(
      `${CAFE24_API_BASE}/get_setting.php?key=chm_auto_approve`,
      { headers: { 'X-Api-Key': CAFE24_API_KEY } },
    );
    const { value } = await res.json();
    return value === '1';
  } catch {
    return false;
  }
}

/**
 * 재생성 요청된 회원 ID 목록 조회 (cafe24 대시보드)
 */
async function fetchRegenMemberIds() {
  try {
    const res = await fetch(`${CAFE24_API_BASE}/fetch_regen_requests.php`, {
      headers: { 'X-Api-Key': CAFE24_API_KEY },
    });
    if (!res.ok) return [];
    const { items } = await res.json();
    return items ?? [];   // [{content_queue_id, member_id}]
  } catch {
    return [];
  }
}

/**
 * 이탈 위험도 점수 계산 (Claude Haiku)
 */
async function scoreChurnRisk(member) {
  const daysSinceLogin = member.never_logged_in ? 9999 : (member.days_since_login ?? 0);
  const daysToExpiry   = member.expires_at
    ? Math.floor((new Date(member.expires_at) - Date.now()) / 86400000)
    : null;

  const result = await askJson(`
아래 jblogzy 회원의 이탈 위험도를 0~100 점수로 평가해주세요.

회원 정보:
- 요금제: ${member.plan}
- 구독 상태: ${member.sub_status}
- 남은 구독일: ${daysToExpiry !== null ? daysToExpiry + '일' : '정보 없음'}
- 마지막 로그인: ${member.never_logged_in ? '한 번도 로그인 안 함' : daysSinceLogin + '일 전'}
- 네이버 블로그 연동: ${member.naver_blog_id ? '완료' : '미완료'}
- 가입 후 경과일: ${member.days_since_join}일

JSON 형식으로 출력:
{"score": 숫자, "reason": "한 줄 이유", "recommended_action": "권장 액션"}`, true);

  return { ...result, daysToExpiry, daysSinceLogin };
}

/**
 * 리텐션 이메일 초안 생성
 * 혜택 수치는 BENEFIT_RULES에서 주입 — Claude가 임의로 생성하지 않음
 */
async function generateRetentionEmail(member, riskData) {
  const riskLevel = riskData.score >= 70 ? 'HIGH' : riskData.score >= 40 ? 'MEDIUM' : 'LOW';
  const benefit   = BENEFIT_RULES[riskLevel] ?? null;

  const benefitInstruction = (() => {
    if (!benefit) return '';
    if (riskLevel === 'MEDIUM') {
      return `\n- 갱신 혜택 문구 (그대로 사용): "${benefit.desc}"`;
    }
    if (riskLevel === 'LOW') {
      const refUrl = member.referral_url ?? 'https://jblogzy.com (내 계정 → 추천인 링크)';
      return `\n- 추천 링크 안내: 지인을 ${refUrl} 링크로 초대하시면 추천인·피추천인 각 10% 혜택이 자동 적용됩니다`;
    }
    return '';
  })();

  const emailContext = {
    HIGH: {
      tone:  '걱정되는 마음에 먼저 연락드리는 따뜻한 톤',
      focus: `마지막 접속 후 ${riskData.daysSinceLogin}일이 지났는데 잘 지내고 계신지 안부 + jblogzy에서 무엇이 어려운지 여쭤보기 + 1:1 사용 지원 제안`,
    },
    MEDIUM: {
      tone:  '구독 갱신을 자연스럽게 안내하는 친근한 톤',
      focus: `구독 만료 ${riskData.daysToExpiry}일 전 안내 + 지금까지 작성하신 포스팅 성과 요약 + 갱신 시 특별 혜택 안내`,
    },
    LOW: {
      tone:  '열심히 사용해주셔서 감사하다는 진심 어린 톤',
      focus: '꾸준히 사용해주셔서 감사 + 새로운 기능 안내 + 지인 추천 이벤트 소개',
    },
  };

  const ctx = emailContext[riskLevel];

  const prompt = `당신은 jblogzy.com 고객관리팀 담당자입니다.

아래 회원에게 보낼 리텐션 이메일을 작성해주세요.

[회원 정보]
- 이름: ${member.name}
- 요금제: ${member.plan}
- 마지막 로그인: ${member.never_logged_in ? '한 번도 로그인 안 함' : riskData.daysSinceLogin + '일 전'}
- 이탈 위험도: ${riskData.score}점 (${RISK_LEVELS[riskLevel].label})

[이메일 방향]
- 톤: ${ctx.tone}
- 핵심 내용: ${ctx.focus}${benefitInstruction}

[필수 규칙]
- "보장", "반드시" 같은 단언적 표현 금지
- ${member.name}님을 직접 호칭하여 개인화
- 전체 250자 이내
- 수신거부 안내 포함
- 혜택 수치나 조건은 위에 명시된 내용만 사용하고 임의로 변경하지 않음

형식:
제목: [제목]
---
[본문]`;

  const raw = await ask(prompt, 800);
  const lines = raw.split('\n');
  let subject = '';
  const bodyLines = [];
  let started = false;

  for (const line of lines) {
    if (!started && line.startsWith('제목:')) {
      subject = line.replace('제목:', '').trim();
    } else if (line.includes('---')) {
      started = true;
    } else if (started) {
      bodyLines.push(line);
    }
  }

  return {
    subject:   subject || `${member.name}님, jblogzy 팀입니다`,
    body:      bodyLines.join('\n').trim(),
    riskLevel,
    benefit,
  };
}

export async function run() {
  console.log('\n🤝 [고객관리팀] 회원 이탈 분석 및 리텐션 이메일 생성 시작');

  await notifyStart(DEPARTMENT, '회원 이탈 분석');

  const autoApprove = await isChmAutoApproveEnabled();
  if (autoApprove) console.log('  → 자동 승인 모드 ON');

  // 재생성 요청 항목 먼저 처리
  const regenItems = await fetchRegenMemberIds();
  const regenMemberIds = new Set(regenItems.map(r => String(r.member_id)));
  if (regenItems.length > 0) {
    console.log(`  → 재생성 요청: ${regenItems.length}건`);
  }

  let members;
  try {
    members = await fetchMemberData();
  } catch (err) {
    await notifyError(DEPARTMENT, '회원 데이터 조회', err);
    return;
  }

  // 재생성 대상 우선 배치, 그 외 중복 제거
  const regenMembers = members.filter(m => regenMemberIds.has(String(m.id)));
  const regularMembers = members.filter(m => !regenMemberIds.has(String(m.id)));
  const orderedMembers = [...regenMembers, ...regularMembers];

  console.log(`  → 분석 대상 회원: ${orderedMembers.length}명 (재생성 ${regenMembers.length}명 포함)`);

  const results = { HIGH: 0, MEDIUM: 0, LOW: 0, errors: 0 };

  for (const member of orderedMembers) {
    try {
      const riskData  = await scoreChurnRisk(member);
      const emailData = await generateRetentionEmail(member, riskData);
      const { subject, body, riskLevel, benefit } = emailData;

      const badge = RISK_LEVELS[riskLevel].badge;
      console.log(`  ${badge} ${member.name} - 이탈 위험도 ${riskData.score}점 (${RISK_LEVELS[riskLevel].label})`);

      // 재생성 요청이었다면 원본 항목에 regenerated 표시
      const regenItem = regenItems.find(r => String(r.member_id) === String(member.id));
      if (regenItem) {
        await fetch(`${CAFE24_API_BASE}/mark_regen_done.php`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_API_KEY },
          body:    JSON.stringify({ content_queue_id: regenItem.content_queue_id }),
        }).catch(() => {});
      }

      const benefitFields = benefit ? {
        benefit_type:  benefit.type,
        benefit_value: benefit.value ?? '',
        benefit_desc:  benefit.desc,
      } : {};

      const reportRes = await send({
        department:   DEPARTMENT,
        task_type:    '리텐션 이메일 생성',
        status:       'completed',
        summary:      `${badge} [${member.name}] 이탈 위험도 ${riskData.score}점 - ${RISK_LEVELS[riskLevel].label} / ${RISK_LEVELS[riskLevel].action}`,
        detail:       JSON.stringify({
          memberId:      member.id,
          plan:          member.plan,
          riskScore:     riskData.score,
          riskLevel,
          riskReason:    riskData.reason,
          daysToExpiry:  riskData.daysToExpiry,
          daysSinceLogin: riskData.daysSinceLogin,
        }),
        content_type:    'email',
        content_title:   `[리텐션] ${member.name}님 - 위험도 ${riskData.score}점`,
        content_body:    `받는 사람: ${member.email}\n제목: ${subject}\n\n${body}`,
        target_platform: 'email',
        target_audience: `member_id:${member.id}|${member.plan} 플랜 / 위험도 ${RISK_LEVELS[riskLevel].label}`,
        chm_member_id:   String(member.id),
        ...benefitFields,
      });

      // 자동 승인 모드: 생성 즉시 승인 처리 (혜택 자동 적용 포함)
      if (autoApprove && reportRes?.content_queue_id) {
        await fetch(`${CAFE24_API_BASE}/auto_approve_chm.php`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_API_KEY },
          body:    JSON.stringify({ content_queue_id: reportRes.content_queue_id }),
        }).catch(() => {});
      }

      results[riskLevel]++;
      await new Promise(r => setTimeout(r, 800));

    } catch (err) {
      console.error(`  ❌ [${member.name}] 오류:`, err.message);
      await notifyError(DEPARTMENT, `이탈 분석 (${member.name})`, err);
      results.errors++;
    }
  }

  await send({
    department: DEPARTMENT,
    task_type:  '일일 고객 분석 완료',
    status:     'completed',
    summary:    `오늘 ${orderedMembers.length}명 분석 완료 - 🔴 위험 ${results.HIGH}명, 🟡 중간 ${results.MEDIUM}명, 🟢 양호 ${results.LOW}명`,
  });

  console.log(`🤝 [고객관리팀] 완료 - 위험 ${results.HIGH}명, 중간 ${results.MEDIUM}명, 양호 ${results.LOW}명\n`);
}

// 직접 실행 시 (npm run chm)
if (process.argv[1].endsWith('chm.js')) {
  run().catch(console.error);
}
