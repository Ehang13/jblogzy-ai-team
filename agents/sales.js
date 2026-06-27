// 영업팀 에이전트 - 24/7 연속 수집 (sales.yml: 6시간 루프 × 4회/일)
// 네이버 플레이스에서 동 단위로 업체 크롤링 → 블로그 있는 전체 업체 리드 수집

import 'dotenv/config';
import { ask, askFast } from '../core/claude.js';
import { send, notifyStart, notifyError } from '../core/reporter.js';
import { chromium } from 'playwright';

const DEPARTMENT      = 'sales';
const INDUSTRIES_PER_RUN = 3;
const CAFE24_API_BASE = process.env.CAFE24_API_URL?.replace('/report.php', '');
const CAFE24_API_KEY  = process.env.CAFE24_API_KEY;

async function fetchMyDirectiveInstructions() {
  try {
    const res = await fetch(
      `${CAFE24_API_BASE}/api/get_active_directives.php?department=sales`,
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

// ─────────────────────────────────────────────
// 전체 업종 리스트 (15개)
// ─────────────────────────────────────────────
export const ALL_INDUSTRIES = [
  { id: 'food',       name: '외식업 (맛집/카페)',            naverKeyword: '카페',       painPoints: '매일 바쁜 가게 운영 틈틈이 블로그까지 관리하기 너무 힘드시죠' },
  { id: 'beauty',     name: '미용 (헤어/네일/속눈썹)',       naverKeyword: '헤어샵',     painPoints: '고객 관리와 시술에 집중하느라 온라인 마케팅 신경 쓰기 어려우시죠' },
  { id: 'fitness',    name: '피트니스 (헬스/필라테스/요가)', naverKeyword: '필라테스',   painPoints: '수업 준비와 회원 관리로 바쁜데 블로그까지 신경 쓰기 힘드시죠' },
  { id: 'medical',    name: '병원/의원 (치과/한의원/피부과)',naverKeyword: '한의원',     painPoints: '환자 진료에 집중하다 보면 온라인 마케팅은 뒷전이 되기 쉬우시죠' },
  { id: 'orthopedic', name: '정형외과',                         naverKeyword: '정형외과',   painPoints: '환자 케어에 바빠 병원 블로그 관리가 어려우시죠' },
  { id: 'eyeclinic',  name: '안과',                             naverKeyword: '안과',       painPoints: '진료에 집중하다 보면 온라인 홍보를 신경 쓰기 어려우시죠' },
  { id: 'plastic',    name: '성형외과',                         naverKeyword: '성형외과',   painPoints: '시술 케어로 바빠 블로그 마케팅을 따로 관리하기 어려우시죠' },
  { id: 'education',  name: '교육 (학원/과외)',               naverKeyword: '학원',       painPoints: '수업 준비와 학생 관리만으로도 시간이 부족하시죠' },
  { id: 'pet',        name: '반려동물 (동물병원/펫샵)',       naverKeyword: '동물병원',   painPoints: '동물 케어에 집중하다 보면 블로그 관리가 어려우시죠' },
  { id: 'interior',   name: '인테리어/시공',                  naverKeyword: '인테리어',   painPoints: '현장 작업으로 바빠 포트폴리오 블로그 업로드가 밀리시죠' },
  { id: 'realestate', name: '부동산/공인중개사',              naverKeyword: '공인중개사', painPoints: '매물 관리로 바빠 블로그 마케팅에 신경 쓰기 어려우시죠' },
  { id: 'lodging',    name: '숙박업 (펜션/게스트하우스)',     naverKeyword: '펜션',       painPoints: '손님 맞이로 바빠 예약 유치 블로그 관리가 어려우시죠' },
  { id: 'auto',       name: '자동차 (정비/세차)',             naverKeyword: '자동차정비', painPoints: '작업 현장에서 바빠 블로그 업로드가 늘 밀리시죠' },
  { id: 'studio',     name: '사진관/스튜디오',                naverKeyword: '사진관',     painPoints: '촬영과 편집으로 바빠 포트폴리오 블로그 관리가 어려우시죠' },
  { id: 'flower',     name: '꽃집/화원',                      naverKeyword: '꽃집',       painPoints: '꽃 관리와 제작으로 바빠 블로그 업로드가 어려우시죠' },
  { id: 'wellness',   name: '건강/웰니스 (마사지/스파)',      naverKeyword: '마사지',     painPoints: '시술로 바빠 온라인 홍보를 신경 쓰기 어려우시죠' },
  { id: 'clothing',   name: '의류/패션 (쇼핑몰)',            naverKeyword: '의류매장',   painPoints: '상품 관리와 CS로 바빠 블로그 마케팅이 어려우시죠' },
  { id: 'kids',       name: '아동/육아 (키즈카페/유아교육)', naverKeyword: '키즈카페',   painPoints: '아이들 케어로 바빠 블로그 운영이 어려우시죠' },
];

// ─────────────────────────────────────────────
// 전국 동 단위 지역 리스트 (~300개)
// ─────────────────────────────────────────────
export const ALL_REGIONS = [
  // 서울 강남·서초
  '역삼동', '삼성동', '청담동', '논현동', '신사동', '압구정동', '개포동', '대치동', '도곡동', '수서동',
  '서초동', '반포동', '방배동', '잠원동', '양재동',
  // 서울 송파·강동
  '잠실동', '가락동', '문정동', '방이동', '오금동', '거여동', '마천동',
  '천호동', '성내동', '길동', '둔촌동', '강일동', '명일동', '암사동',
  // 서울 마포·용산
  '합정동', '망원동', '연남동', '서교동', '상수동', '공덕동', '아현동', '대흥동', '성산동',
  '이태원동', '한남동', '이촌동', '원효로동', '청파동', '후암동',
  // 서울 영등포·구로·금천
  '여의도동', '당산동', '문래동', '양평동', '신길동', '대림동', '영등포동',
  '구로동', '신도림동', '고척동', '개봉동',
  '시흥동', '독산동', '가산동',
  // 서울 중구·종로
  '명동', '충무로', '을지로', '남대문로', '회현동', '신당동', '황학동',
  '종로', '삼청동', '인사동', '창신동', '숭인동', '혜화동', '평창동',
  // 서울 성동·광진
  '성수동', '왕십리동', '행당동', '응봉동', '금호동', '옥수동',
  '구의동', '자양동', '중곡동', '광장동', '화양동', '군자동',
  // 서울 동대문·중랑·성북
  '휘경동', '회기동', '용두동', '신설동', '제기동', '전농동',
  '면목동', '상봉동', '중화동', '묵동',
  '정릉동', '길음동', '석관동', '동선동', '안암동', '하월곡동', '종암동',
  // 서울 강북·도봉·노원
  '수유동', '미아동', '번동', '우이동',
  '쌍문동', '창동', '방학동', '도봉동',
  '상계동', '중계동', '하계동', '공릉동', '월계동',
  // 서울 은평·서대문·강서·양천
  '불광동', '갈현동', '응암동', '녹번동', '역촌동',
  '홍은동', '홍제동', '남가좌동', '북가좌동', '연희동',
  '화곡동', '가양동', '등촌동', '마곡동', '방화동',
  '목동', '신정동', '신월동',
  // 서울 동작·관악
  '노량진동', '상도동', '사당동', '대방동', '신대방동',
  '신림동', '봉천동', '낙성대동', '관악동',
  // 부산
  '해운대동', '중동', '우동', '좌동', '반여동', '재송동', '송정동',
  '부전동', '전포동', '범전동', '양정동', '거제동', '가야동', '개금동',
  '대연동', '용호동', '문현동', '감만동', '우암동',
  '동래동', '온천동', '명장동', '사직동', '수안동',
  '연산동', '연제동',
  '광안동', '남천동', '수영동', '민락동',
  '당리동', '괴정동', '하단동', '감천동',
  '화명동', '금곡동', '구포동', '덕천동',
  '기장읍', '정관읍',
  // 대구
  '성당동', '용산동', '본리동', '월성동', '감삼동', '두류동', '진천동',
  '범어동', '수성동', '만촌동', '황금동', '두산동', '지산동',
  '동인동', '삼덕동', '남산동', '대봉동',
  '신천동', '효목동', '방촌동',
  '내당동', '비산동',
  // 인천
  '구월동', '간석동', '만수동', '논현동', '서창동',
  '부평동', '삼산동', '갈산동', '십정동', '청천동',
  '연수동', '송도동', '청학동', '동춘동',
  '주안동', '용현동', '학익동', '도화동',
  '가정동', '신현동', '검단동',
  // 광주
  '치평동', '화정동', '농성동', '쌍촌동', '유덕동',
  '운암동', '문흥동', '두암동', '신안동', '중흥동',
  '봉선동', '월산동', '주월동', '효천동',
  '충장로', '계림동', '산수동',
  // 대전
  '둔산동', '탄방동', '월평동', '괴정동', '도마동', '관저동',
  '봉명동', '궁동', '노은동', '관평동', '학하동', '반석동',
  '은행동', '대흥동', '선화동', '목동',
  // 수도권
  '인계동', '영통동', '세류동', '정자동', '매탄동',
  '야탑동', '서현동', '이매동', '신흥동',
  '마두동', '장항동', '주엽동', '백석동', '화정동',
  '평촌동', '비산동', '호계동',
  '중동', '상동', '역곡동',
  '풍덕천동', '신갈동', '기흥동', '구성동',
  '동탄동', '능동', '반월동',
  // 기타 주요 도시
  '의창동', '상남동', '합성동', '봉곡동',
  '복대동', '가경동', '분평동', '성화동',
  '효자동', '진북동', '완산동', '인후동',
  '연동', '노형동', '이도동', '삼도동',
];

// ─────────────────────────────────────────────
// 영업팀 자동 승인 설정 조회
// ─────────────────────────────────────────────
async function isSalesAutoApproveEnabled() {
  try {
    const base = process.env.CAFE24_API_URL.replace('/report.php', '');
    const res  = await fetch(`${base}/get_setting.php?key=sales_auto_approve`, {
      headers: { 'X-Api-Key': process.env.CAFE24_API_KEY },
    });
    const json = await res.json();
    return json.value === '1';
  } catch { return false; }
}


// ─────────────────────────────────────────────
// map.naver.com 검색 + API 인터셉트로 place ID 수집
// ─────────────────────────────────────────────
async function getPlaceIdsFromSearch(page, query) {
  const placeIds = new Set();

  const handler = async (response) => {
    try {
      const text = await response.text();
      const matches = text.match(/"id":"(\d{7,13})"/g) ?? [];
      for (const m of matches) {
        const id = m.match(/"id":"(\d+)"/)?.[1];
        if (id) placeIds.add(id);
      }
    } catch {}
  };

  page.on('response', handler);
  await page.goto(
    `https://map.naver.com/p/search/${encodeURIComponent(query)}`,
    { waitUntil: 'domcontentloaded', timeout: 20000 }
  );
  await page.waitForTimeout(4000);

  // 다음 페이지 버튼을 끝까지 클릭하며 전체 업체 수집
  for (let pageNum = 2; pageNum <= 20; pageNum++) {
    const nextBtn = page.locator([
      'a[aria-label="다음 페이지"]',
      '.place_btn_paging a:last-child',
      'button.eUTV2:last-child',
      '.pagination a:last-child',
    ].join(', ')).first();
    const visible = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) break;
    await nextBtn.click();
    await page.waitForTimeout(3000);
    console.log(`    → 페이지 ${pageNum} 로드 (누적 ${placeIds.size}개)`);
  }

  page.off('response', handler);
  console.log(`    → 총 ${placeIds.size}개 place ID 수집`);
  return [...placeIds];
}

// 블로그 URL에서 blog ID 추출
function extractBlogId(url) {
  if (!url) return null;
  const m = url.match(/blog\.naver\.com\/([^/?&#]+)/);
  return m ? m[1] : null;
}

// 전화번호에서 모바일(010)만 추출
function extractMobile(text) {
  const m = text?.match(/010[-\s]?\d{3,4}[-\s]?\d{4}/);
  return m ? m[0].replace(/\s/g, '') : null;
}

// ─────────────────────────────────────────────
// Playwright로 네이버 플레이스 페이지에서 블로그 ID 수집
// ─────────────────────────────────────────────
async function getBlogIdFromPlace(page, placeId) {
  try {
    // 네이버 플레이스 실제 콘텐츠는 pcmap.place.naver.com iframe에 있음
    // → 해당 URL로 직접 접근하면 iframe 없이 동일 내용 로드
    await page.goto(`https://pcmap.place.naver.com/place/${placeId}/home`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForTimeout(6000); // React SPA 완전 로드 대기

    // 업체명 추출
    const businessName = await page.evaluate(() => {
      const h1 = document.querySelector('h1, [class*="name"], [class*="title"]');
      return h1?.textContent?.trim() ?? null;
    });

    // 케이스 A: blog.naver.com 링크 직접 노출
    const directBlogLink = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="blog.naver.com"]'));
      // MyBlog.naver (로그인 안내 링크) 제외
      const real = anchors.find(a => !a.href.includes('MyBlog') && !a.href.includes('section.blog'));
      return real?.href ?? null;
    });
    if (directBlogLink) return { blogId: extractBlogId(directBlogLink), source: 'direct', businessName };

    // 케이스 B: "블로그" 텍스트 버튼 클릭
    const blogBtn = page.locator('a:has-text("블로그"), button:has-text("블로그")').first();
    if (await blogBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
        blogBtn.click(),
      ]);
      if (newPage) {
        await newPage.waitForLoadState('domcontentloaded').catch(() => {});
        const blogUrl = newPage.url();
        await newPage.close();
        const blogId = extractBlogId(blogUrl);
        if (blogId) return { blogId, source: 'button', businessName };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// 리드 발굴 (업종 + 지역 조합)
// ─────────────────────────────────────────────
async function discoverLeads(browser, industry, region) {
  const query = `${region} ${industry.naverKeyword}`;
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  let placeIds = [];
  try {
    placeIds = await getPlaceIdsFromSearch(page, query);
  } catch (err) {
    console.error(`    ⚠ 검색 오류:`, err.message);
    await context.close();
    return [];
  }
  console.log(`    네이버 플레이스 검색: ${placeIds.length}개 업체 place ID 수집`);

  const leads = [];
  const seenBlogIds = new Set();

  for (const placeId of placeIds) {
    const result = await getBlogIdFromPlace(page, placeId);
    if (!result?.blogId || seenBlogIds.has(result.blogId)) continue;
    seenBlogIds.add(result.blogId);

    const placeUrl = `https://map.naver.com/p/entry/place/${placeId}`;
    const blogUrl  = `https://blog.naver.com/${result.blogId}`;

    console.log(`    📍 placeId ${placeId} → blog: ${result.blogId} (${result.source})`);

    leads.push({
      businessName: result.businessName || result.blogId,
      blogId:       result.blogId,
      blogUrl,
      mobile:       null,
      placeUrl,
    });
  }

  await context.close();
  return leads;
}

// ─────────────────────────────────────────────
// 업종·지역 맞춤 제안 이메일 생성
// ─────────────────────────────────────────────
async function generateProposalEmail(industry, lead, region, directiveContext) {
  const prompt = `당신은 jblogzy.com 영업팀 담당자입니다.
jblogzy는 자영업자들이 AI로 5분 만에 네이버 블로그 포스팅을 완성할 수 있는 서비스입니다.
${directiveContext ? `\n[CEO 지시 사항 — 최우선 반영]\n${directiveContext}\n` : ''}
[대상]
- 업체명: ${lead.businessName}
- 업종: ${industry.name}
- 지역: ${region}
- 네이버 블로그: ${lead.blogUrl}

[이메일 구성]
- 제목: 상대방 상황에 공감하는 제목
- 본문:
  1. 자기소개 (2문장 이내)
  2. 공감: "${industry.painPoints}"
  3. jblogzy 핵심 가치 3가지 (간결하게)
  4. 3일 무료 체험 제안 + jblogzy.com CTA
  5. 수신거부 안내 (필수)

[규칙]
- "보장", "반드시", "무조건" 같은 단언적 표현 금지
- 업체명으로 개인화
- 전체 300자 이내
- 형식: 제목: [제목]\n---\n[본문]`;

  return askFast(prompt, 400);
}

function parseEmailDraft(raw) {
  const lines = raw.split('\n');
  let subject = '';
  const bodyLines = [];
  let bodyStarted = false;
  for (const line of lines) {
    if (!bodyStarted && line.startsWith('제목:')) {
      subject = line.replace('제목:', '').trim();
    } else if (line.includes('---')) {
      bodyStarted = true;
    } else if (bodyStarted) {
      bodyLines.push(line);
    }
  }
  return {
    subject: subject || '안녕하세요, jblogzy입니다',
    body:    bodyLines.join('\n').trim(),
  };
}

// ─────────────────────────────────────────────
// 1개 동 × N개 업종 크롤링 후 리드 저장
// ─────────────────────────────────────────────
async function crawlAndReport(browser, region, industries, autoApprove, directiveContext) {
  let cycleLeads = 0;
  for (const industry of industries) {
    console.log(`  → [${industry.name}] 리드 발굴 중...`);
    try {
      const leads = await discoverLeads(browser, industry, region);
      for (const lead of leads) {
        const rawEmail = await generateProposalEmail(industry, lead, region, directiveContext);
        const { subject, body } = parseEmailDraft(rawEmail);

        for (const [emailDomain, emailStatus] of [['naver.com', 'pending'], ['gmail.com', 'guess']]) {
          const email = `${lead.blogId}@${emailDomain}`;
          await send({
            department:        DEPARTMENT,
            task_type:         '리드 발굴',
            status:            'completed',
            summary:           `[${industry.name}][${region}] ${lead.businessName} 리드 발굴 (${email})`,
            lead_industry:     industry.name,
            lead_platform:     'naver_place',
            lead_contact:      email,
            lead_contact_type: 'email',
            lead_email_status: autoApprove ? 'approved' : emailStatus,
            lead_source_url:   lead.placeUrl,
            lead_email_subject: subject,
            lead_email_body:   body,
          });
          cycleLeads++;
        }
        if (lead.mobile) {
          await send({
            department:        DEPARTMENT,
            task_type:         '리드 발굴',
            status:            'completed',
            summary:           `[${industry.name}][${region}] ${lead.businessName} 전화 리드 (${lead.mobile})`,
            lead_industry:     industry.name,
            lead_platform:     'naver_place',
            lead_contact:      lead.mobile,
            lead_contact_type: 'phone',
            lead_source_url:   lead.placeUrl,
          });
        }
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`  ✅ [${industry.name}] ${leads.length}개 업체 완료`);
    } catch (err) {
      console.error(`  ❌ [${industry.name}] 오류:`, err.message);
      await notifyError(DEPARTMENT, `리드 발굴 (${industry.name})`, err);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return cycleLeads;
}

// ─────────────────────────────────────────────
// 메인 실행 (시간 제한 루프)
// ─────────────────────────────────────────────
export async function run() {
  console.log('\n📊 [영업팀] 리드 발굴 시작 (네이버 플레이스 크롤링)');

  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    await notifyError(DEPARTMENT, '환경변수 누락', new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 .env에 없습니다'));
    return;
  }

  await notifyStart(DEPARTMENT, '리드 발굴');

  // SALES_LONG_RUN=true(sales.yml): 5.5시간 루프 / 없으면 1.3시간(morning-bundle 안전 마진)
  const IS_LONG_RUN = !!process.env.SALES_LONG_RUN;
  const deadline    = Date.now() + (IS_LONG_RUN ? 5.5 : 1.3) * 60 * 60 * 1000;
  const GROUPS      = Math.ceil(ALL_INDUSTRIES.length / INDUSTRIES_PER_RUN);

  let cycle      = 0;
  let totalLeads = 0;
  const browser  = await chromium.launch({ headless: true });

  try {
    const directiveContext = await fetchMyDirectiveInstructions();
    if (directiveContext) console.log(`  → CEO 지시 반영: ${directiveContext.slice(0, 80)}`);

    while (Date.now() < deadline) {
      const autoApprove = await isSalesAutoApproveEnabled(); // 매 사이클마다 재조회 (런타임 설정 변경 즉시 반영)
      console.log(`  자동 승인: ${autoApprove ? 'ON' : 'OFF'}`);

      const region     = ALL_REGIONS[cycle % ALL_REGIONS.length];
      const groupIdx   = cycle % GROUPS;
      const industries = ALL_INDUSTRIES.slice(
        groupIdx * INDUSTRIES_PER_RUN,
        (groupIdx + 1) * INDUSTRIES_PER_RUN,
      );

      console.log(`\n[사이클 ${cycle + 1}] ${region} / ${industries.map(i => i.name).join(', ')}`);
      await send({
        department: DEPARTMENT, task_type: '리드 발굴', status: 'running',
        summary: `[사이클 ${cycle + 1}] ${region} / ${industries.map(i => i.name).join(', ')} 크롤링 중...`,
      });
      const cycleLeads = await crawlAndReport(browser, region, industries, autoApprove, directiveContext);
      totalLeads += cycleLeads;

      await send({
        department: DEPARTMENT,
        task_type:  '사이클 완료',
        status:     'completed',
        summary:    `[사이클 ${cycle + 1}] ${region} (${industries.map(i => i.name).join(', ')}) ${cycleLeads}개 리드 수집`,
      });

      cycle++;
    }
  } finally {
    await browser.close();
  }

  await send({
    department: DEPARTMENT,
    task_type:  '영업 세션 완료',
    status:     'completed',
    summary:    `총 ${cycle}개 사이클 완료, ${totalLeads}개 리드 수집. 대시보드에서 검토 후 발송 승인해주세요.`,
  });

  console.log(`\n📊 [영업팀] 완료 - ${cycle}개 사이클, 총 ${totalLeads}개 리드\n`);
}

if (process.argv[1].endsWith('sales.js')) {
  run().catch(console.error);
}
