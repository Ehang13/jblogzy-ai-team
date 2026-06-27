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

async function fetchMyDirectiveInstructions() {
  try {
    const res = await fetch(
      `${CAFE24_API_BASE}/api/get_active_directives.php?department=chm`,
      { headers: { 'X-Api-Key': CAFE24_API_KEY } },
    );
    if (!res.ok) return '';
    const list = await res.json();
    return list
      .filter(d => d.my_instruction)
      .map(d => `[CEO 지시] ${d.title}: ${d.my_instruction}`)
      .join('\n');
  } catch { return ''; }
}

/**
 * 회원 데이터 전체 조회 - jblogzy API (유료 + 체험 분리)
 */
async function fetchAllMembers() {
  const res = await fetch(process.env.JBLOGZY_API_URL, {
    headers: { 'X-Api-Key': process.env.JBLOGZY_API_KEY },
  });
  if (!res.ok) throw new Error(`jblogzy API 오류: ${res.status}`);
  const { members } = await res.json();
  return members;
}

/**
 * 체험 회원 전환 이메일 생성 (온보딩 D+1 / 전환유도 D+2)
 */
async function generateTrialEmail(member, emailType) {
  const prompts = {
    onboarding: `당신은 jblogzy.com 고객관리팀 담당자입니다.
아래 회원이 어제 가입하여 3일 무료 체험 첫날입니다.
따뜻하고 환영하는 톤으로 첫 블로그 글 작성을 도와주세요.

[회원 정보]
- 이름: ${member.name}

[이메일 방향]
- 따뜻한 환영 인사
- jblogzy 핵심 사용법 1-2줄 (네이버 블로그 연동 → AI 원고 생성 → 예약 발행)
- 오늘 바로 해볼 수 있는 행동 1가지 제안
- 3일 체험 기간임을 자연스럽게 언급

[필수 규칙]
- "보장", "확정", "100%" 같은 단언적 표현 금지
- 자영업자의 실질적 시간 절약을 신뢰감 있는 톤으로 강조
- 전체 250자 이내
- 수신거부 문구 포함

형식:
제목: [제목]
---
[본문]`,

    conversion: `당신은 jblogzy.com 고객관리팀 담당자입니다.
아래 회원의 3일 무료 체험이 내일 종료됩니다.
구체적인 사용 사례를 중심으로 유료 전환을 자연스럽게 유도해주세요.

[회원 정보]
- 이름: ${member.name}

[요금제 안내 — 아래 수치만 사용, 임의 변경 금지]
- Basic: 월 39,000원 (AI 원고 월 90회, 예약 포스팅)
- Premium: 월 69,000원 (AI 원고 월 300회, 방문자 유입 품앗이) ← 가장 인기
- Business: 월 79,000원 (AI 원고 월 600회, 다계정 관리)
- 전환 링크: https://jblogzy.com

[이메일 방향]
- 체험 종료 D-1 알림 (부담 없는 친근한 톤)
- 직접 블로그 운영 시 소요 시간 vs jblogzy 활용 시 절약 시간 비교 (구체적 예시)
- Premium 요금제를 자연스럽게 추천 (이유 포함)

[필수 규칙]
- "보장", "확정", "100%" 금지
- 요금제 수치는 위 내용만 사용
- 전체 300자 이내
- 수신거부 문구 포함

형식:
제목: [제목]
---
[본문]`,
  };

  const raw = await ask(prompts[emailType], 900);
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
    subject: subject || `${member.name}님, jblogzy 체험 안내드립니다`,
    body:    bodyLines.join('\n').trim(),
  };
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
/**
 * 최근 30일 내 이메일 발송된 회원 ID 집합 조회 (중복 방지)
 */
async function fetchRecentlyContactedIds() {
  try {
    const res = await fetch(
      `${CAFE24_API_BASE}/fetch_recently_contacted.php`,
      { headers: { 'X-Api-Key': CAFE24_API_KEY } },
    );
    const { member_ids } = await res.json();
    return new Set((member_ids ?? []).map(String));
  } catch {
    return new Set();
  }
}

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
async function generateRetentionEmail(member, riskData, directiveContext) {
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
${directiveContext ? `\n[CEO 지시 사항 — 최우선 반영]\n${directiveContext}\n` : ''}
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

function isBusinessHours() {
  const kst  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day  = kst.getDay();   // 0=일, 6=토
  const hour = kst.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

async function isDeptEnabled() {
  try {
    const res  = await fetch(`${CAFE24_API_BASE}/get_setting.php?key=dept_enabled_chm`, {
      headers: { 'X-Api-Key': CAFE24_API_KEY },
    });
    const json = await res.json();
    return json.value !== '0';
  } catch { return true; }
}

export async function run() {
  if (!await isDeptEnabled()) {
    console.log('[고객관리팀] 비활성화 상태 — 실행 건너뜀');
    return;
  }

  if (!isBusinessHours()) {
    console.log('⏰ [고객관리팀] 업무시간 외 (평일 09:00~18:00만 실행) - 종료');
    return;
  }

  console.log('\n🤝 [고객관리팀] 회원 이탈 분석 및 리텐션 이메일 생성 시작');

  await notifyStart(DEPARTMENT, '회원 이탈 분석');

  const autoApprove = await isChmAutoApproveEnabled();
  if (autoApprove) console.log('  → 자동 승인 모드 ON');

  const directiveContext = await fetchMyDirectiveInstructions();
  if (directiveContext) console.log(`  → CEO 지시 반영: ${directiveContext.slice(0, 80)}`);

  await send({ department: DEPARTMENT, task_type: '회원 데이터 조회', status: 'running',
    summary: '회원 데이터 조회 중...' });

  // 재생성 요청 항목 먼저 처리
  const regenItems = await fetchRegenMemberIds();
  const regenMemberIds = new Set(regenItems.map(r => String(r.member_id)));
  if (regenItems.length > 0) {
    console.log(`  → 재생성 요청: ${regenItems.length}건`);
  }

  let allMembers;
  try {
    allMembers = await fetchAllMembers();
  } catch (err) {
    await notifyError(DEPARTMENT, '회원 데이터 조회', err);
    return;
  }

  // 유료 회원 / 체험 회원 분리
  const paidMembers  = allMembers.filter(m => m.sub_status === 'active').slice(0, 30);
  const trialMembers = allMembers.filter(m => m.sub_status === 'trialing');

  await send({ department: DEPARTMENT, task_type: '이탈 위험도 분석', status: 'running',
    summary: `이탈 위험도 분석 중... (유료 ${paidMembers.length}명 / 체험 ${trialMembers.length}명)` });

  // 최근 30일 내 발송된 회원 제외
  const recentlyContacted = await fetchRecentlyContactedIds();

  // 재생성 대상 우선 배치, 그 외 중복 제거
  const regenMembers   = paidMembers.filter(m => regenMemberIds.has(String(m.id)));
  const regularMembers = paidMembers.filter(m =>
    !regenMemberIds.has(String(m.id)) && !recentlyContacted.has(String(m.id))
  );
  const orderedMembers = [...regenMembers, ...regularMembers];

  console.log(`  → 분석 대상 회원: ${orderedMembers.length}명 (재생성 ${regenMembers.length}명 포함, 최근 연락 ${recentlyContacted.size}명 제외)`);

  const results = { HIGH: 0, MEDIUM: 0, LOW: 0, errors: 0 };

  for (const member of orderedMembers) {
    try {
      const riskData  = await scoreChurnRisk(member);
      const riskLevel = riskData.score >= 70 ? 'HIGH' : riskData.score >= 40 ? 'MEDIUM' : 'LOW';
      const badge     = RISK_LEVELS[riskLevel].badge;

      // 발송 기준 필터링 (재생성 요청은 예외)
      const isRegen = regenItems.some(r => String(r.member_id) === String(member.id));
      if (!isRegen) {
        if (riskLevel === 'LOW') {
          console.log(`  ⏭ ${member.name} - LOW 위험도(${riskData.score}점), 발송 제외`);
          results.LOW++;
          continue;
        }
        if (riskLevel === 'MEDIUM' && (riskData.daysToExpiry === null || riskData.daysToExpiry > 7)) {
          console.log(`  ⏭ ${member.name} - MEDIUM이지만 만료 ${riskData.daysToExpiry ?? '?'}일 남음 (7일 초과), 발송 제외`);
          continue;
        }
      }

      const emailData = await generateRetentionEmail(member, riskData, directiveContext);
      const { subject, body, benefit } = emailData;

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

  // ── 체험 회원 전환 이메일 ─────────────────────────────────────────────
  const trialResults = { onboarding: 0, conversion: 0, skipped: 0, errors: 0 };
  if (trialMembers.length > 0) {
    console.log(`\n  📩 체험 회원: ${trialMembers.length}명`);
    for (const member of trialMembers) {
      try {
        const daysSinceJoin = Math.floor((Date.now() - new Date(member.created_at)) / 86400000);
        const emailType = daysSinceJoin === 1 ? 'onboarding'
                        : daysSinceJoin === 2 ? 'conversion'
                        : null;

        if (!emailType) {
          trialResults.skipped++;
          continue;
        }

        const { subject, body } = await generateTrialEmail(member, emailType);
        const label = emailType === 'onboarding' ? '온보딩' : '전환 유도';
        console.log(`  📧 ${member.name} - 체험 D+${daysSinceJoin} ${label}`);

        const trialReportRes = await send({
          department:      DEPARTMENT,
          task_type:       '체험 회원 전환 이메일',
          status:          'completed',
          summary:         `[체험 D+${daysSinceJoin}] ${member.name}님 ${label} 이메일 생성`,
          detail:          JSON.stringify({ memberId: member.id, daysSinceJoin, emailType }),
          content_type:    'trial_email',
          content_title:   `[체험 D+${daysSinceJoin}] ${member.name}님 - ${label}`,
          content_body:    `받는 사람: ${member.email}\n제목: ${subject}\n\n${body}`,
          target_platform: 'email',
          target_audience: `member_id:${member.id}|체험 D+${daysSinceJoin} / ${label}`,
          chm_member_id:   String(member.id),
        });

        if (autoApprove && trialReportRes?.content_queue_id) {
          await fetch(`${CAFE24_API_BASE}/auto_approve_chm.php`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': CAFE24_API_KEY },
            body:    JSON.stringify({ content_queue_id: trialReportRes.content_queue_id }),
          }).catch(() => {});
        }

        trialResults[emailType === 'onboarding' ? 'onboarding' : 'conversion']++;
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.error(`  ❌ [${member.name}] 체험 이메일 오류:`, err.message);
        trialResults.errors++;
      }
    }
  }

  const trialSummary = trialMembers.length > 0
    ? ` | 체험 ${trialMembers.length}명 (온보딩 ${trialResults.onboarding}건, 전환 ${trialResults.conversion}건)`
    : '';

  await send({
    department: DEPARTMENT,
    task_type:  '일일 고객 분석 완료',
    status:     'completed',
    summary:    `오늘 ${orderedMembers.length}명 분석 완료 - 🔴 위험 ${results.HIGH}명, 🟡 중간 ${results.MEDIUM}명, 🟢 양호 ${results.LOW}명${trialSummary}`,
  });

  console.log(`🤝 [고객관리팀] 완료 - 위험 ${results.HIGH}명, 중간 ${results.MEDIUM}명, 양호 ${results.LOW}명${trialSummary}\n`);
}

// 직접 실행 시 (npm run chm)
if (process.argv[1].endsWith('chm.js')) {
  run().catch(console.error);
}
