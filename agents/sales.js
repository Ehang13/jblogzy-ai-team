// 영업팀 에이전트 - 매일 오전 9시 실행
// 네이버 플레이스에서 업체 블로그 ID 수집 → 이메일 후보 생성 → 제안 이메일 초안 생성
// 3개 업종 × 1개 지역 조합으로 매일 자동 순환 (24시간 무인 운영)

import 'dotenv/config';
import { ask, askFast } from '../core/claude.js';
import { send, notifyStart, notifyError } from '../core/reporter.js';
import { chromium } from 'playwright';

const DEPARTMENT = 'sales';
const LEADS_PER_INDUSTRY = 5;

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
// 전국 구/동 단위 지역 리스트 (40개+)
// ─────────────────────────────────────────────
const ALL_REGIONS = [
  '서울 강남구', '서울 서초구', '서울 마포구', '서울 강서구', '서울 송파구',
  '서울 관악구', '서울 강동구', '서울 영등포구', '서울 중구', '서울 종로구',
  '서울 노원구', '서울 은평구',
  '부산 해운대구', '부산 부산진구', '부산 동래구', '부산 남구', '부산 북구', '부산 사상구',
  '대구 달서구', '대구 수성구', '대구 중구', '대구 동구',
  '인천 남동구', '인천 부평구', '인천 미추홀구', '인천 연수구',
  '광주 서구', '광주 북구', '광주 남구',
  '대전 서구', '대전 유성구', '대전 중구',
  '수원시', '성남시 분당구', '고양시 일산', '안양시', '부천시', '용인시',
  '창원시', '청주시', '전주시', '제주시',
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
// 날짜 기반 결정론적 순환 (파일 불필요 → GitHub Actions 호환)
// ─────────────────────────────────────────────
function pickTodaysIndustries() {
  return [...ALL_INDUSTRIES]; // 매 실행마다 전체 18개
}

function dayOfYearKST() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const start = new Date(kst.getFullYear(), 0, 0);
  return Math.floor((kst - start) / 86400000);
}

function pickTodaysRegion() {
  return ALL_REGIONS[dayOfYearKST() % ALL_REGIONS.length];
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
  await page.waitForTimeout(5000);
  page.off('response', handler);

  return [...placeIds].slice(0, 20);
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
    if (leads.length >= LEADS_PER_INDUSTRY) break;

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
async function generateProposalEmail(industry, lead, region) {
  const prompt = `당신은 jblogzy.com 영업팀 담당자입니다.
jblogzy는 자영업자들이 AI로 5분 만에 네이버 블로그 포스팅을 완성할 수 있는 서비스입니다.

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

  return ask(prompt, 1000);
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
// 메인 실행
// ─────────────────────────────────────────────
export async function run() {
  console.log('\n📊 [영업팀] 잠재 고객 발굴 시작 (네이버 플레이스 실제 크롤링)');

  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    await notifyError(DEPARTMENT, '환경변수 누락', new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 .env에 없습니다'));
    return;
  }

  await notifyStart(DEPARTMENT, '일일 리드 발굴');

  const autoApprove = await isSalesAutoApproveEnabled();
  console.log(`  자동 승인: ${autoApprove ? 'ON' : 'OFF'}`);

  const todaysIndustries = pickTodaysIndustries();
  const todaysRegion     = pickTodaysRegion();

  console.log(`  오늘 지역: ${todaysRegion}`);
  console.log(`  오늘 업종: ${todaysIndustries.map(i => i.name).join(', ')}`);

  // Playwright 브라우저 1회 생성 후 전 업종 공유 (성능 최적화)
  const browser = await chromium.launch({ headless: true });
  let totalLeads = 0;

  try {
    for (const industry of todaysIndustries) {
      console.log(`\n  → [${industry.name}] 리드 발굴 중...`);
      try {
        const leads = await discoverLeads(browser, industry, todaysRegion);

        for (const lead of leads) {
          const rawEmail = await generateProposalEmail(industry, lead, todaysRegion);
          const { subject, body } = parseEmailDraft(rawEmail);

          // naver.com → pending (계정 존재 확실), gmail.com → guess (추정 주소)
          // 자동승인 ON 이면 두 주소 모두 approved로 바로 저장
          for (const [emailDomain, emailStatus] of [['naver.com', 'pending'], ['gmail.com', 'guess']]) {
            const email = `${lead.blogId}@${emailDomain}`;
            await send({
              department:          DEPARTMENT,
              task_type:           '리드 발굴',
              status:              'completed',
              summary:             `[${industry.name}][${todaysRegion}] ${lead.businessName} 리드 발굴 (${email})`,
              lead_industry:       industry.name,
              lead_platform:       'naver_place',
              lead_contact:        email,
              lead_contact_type:   'email',
              lead_email_status:   autoApprove ? 'approved' : emailStatus,
              lead_source_url:     lead.placeUrl,
              lead_email_subject:  subject,
              lead_email_body:     body,
            });
            totalLeads++;
          }

          // 모바일 전화번호가 있으면 별도 리드로 저장
          if (lead.mobile) {
            await send({
              department:        DEPARTMENT,
              task_type:         '리드 발굴',
              status:            'completed',
              summary:           `[${industry.name}][${todaysRegion}] ${lead.businessName} 전화 리드 (${lead.mobile})`,
              lead_industry:     industry.name,
              lead_platform:     'naver_place',
              lead_contact:      lead.mobile,
              lead_contact_type: 'phone',
              lead_source_url:   lead.placeUrl,
            });
          }

          await new Promise(r => setTimeout(r, 500));
        }

        console.log(`  ✅ [${industry.name}] ${leads.length}개 업체 → ${leads.length * 2}개 이메일 리드 완료`);

      } catch (err) {
        console.error(`  ❌ [${industry.name}] 오류:`, err.message);
        await notifyError(DEPARTMENT, `리드 발굴 (${industry.name})`, err);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await browser.close();
  }

  await send({
    department: DEPARTMENT,
    task_type:  '일일 영업 완료',
    status:     'completed',
    summary:    `[${todaysRegion}] 오늘 총 ${totalLeads}개 리드 발굴 완료 (${todaysIndustries.map(i => i.name).join(', ')}). 대시보드에서 검토 후 발송 승인해주세요.`,
  });

  console.log(`\n📊 [영업팀] 완료 - 총 ${totalLeads}개 리드\n`);
}

if (process.argv[1].endsWith('sales.js')) {
  run().catch(console.error);
}
