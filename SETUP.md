# jblogzy AI 자동화 팀 - 설치 및 실행 가이드

## 1단계: Node.js 패키지 설치

VS Code 터미널에서 실행:
```
npm install
```

---

## 2단계: 환경변수 설정

`.env.example` 파일을 복사해서 `.env`로 저장하고 실제 값 입력:

```
ANTHROPIC_API_KEY=   ← console.anthropic.com에서 발급
CAFE24_API_URL=      ← https://ehe13.mycafe24.com/ai-team/api/report.php
CAFE24_API_KEY=      ← 아래 3단계에서 DB에 설정한 키
GMAIL_USER=          ← 발송용 Gmail 주소
GMAIL_APP_PASSWORD=  ← Gmail 앱 비밀번호 (16자리)
```

---

## 3단계: 카페24 세팅

### 3-1. 카페24 phpMyAdmin에서 DB 생성
1. 카페24 호스팅 관리자 → 데이터베이스 → phpMyAdmin 접속
2. `cafe24/db/schema.sql` 파일 내용을 전체 복사 → SQL 실행
3. `api_keys` 테이블의 `key_value` 값을 본인만 아는 비밀키로 변경

### 3-2. 카페24 파일 업로드 (FTP)
`cafe24/` 폴더 안의 파일들을 카페24 FTP로 업로드:

```
업로드 목적지: /ai-team/   (루트에 ai-team 폴더 생성 후 업로드)
```

업로드할 파일:
- `config.php` → DB 접속 정보 입력 후 업로드
- `api/auth.php`
- `api/report.php`
- `admin/index.php`
- `admin/content.php`
- `admin/leads.php`
- `admin/approve.php`
- `admin/assets/style.css`
- `admin/assets/dashboard.js`
- `db/schema.sql` (참고용, 업로드 불필요)

### 3-3. config.php 수정
업로드 전 `cafe24/config.php`에서 실제 카페24 DB 정보 입력:
```php
define('DB_NAME', '카페24에서_발급받은_DB명');
define('DB_USER', '카페24_DB_사용자명');
define('DB_PASS', '카페24_DB_비밀번호');
define('ADMIN_PASSWORD', '대시보드_접속_비밀번호');
```

---

## 4단계: 대시보드 접속 확인

브라우저에서 접속:
```
https://ehe13.mycafe24.com/ai-team/admin/
```
설정한 비밀번호로 로그인 → 대시보드 확인

---

## 5단계: 에이전트 단독 테스트

터미널에서 각 에이전트를 개별 테스트:
```
npm run marketing    ← 마케팅팀 에이전트 단독 실행
npm run sales        ← 영업팀 에이전트 단독 실행
npm run chm          ← 고객관리팀 에이전트 단독 실행
```
실행 후 대시보드에서 결과 확인.

---

## 6단계: 전체 테스트 (모든 에이전트 즉시 실행)

```
node agents/orchestrator.js --test
```

---

## 7단계: 24시간 자동 실행 (Windows 작업 스케줄러 등록)

VS Code 터미널에서 관리자 권한으로 실행:
```
schtasks /create /tn "jblogzy-AI-Team" /tr "node \"d:\03. 프로그램\16. auto AI team\agents\orchestrator.js\"" /sc ONSTART /ru SYSTEM
```

또는 PC 시작 시 자동 실행:
- 작업 스케줄러 → 기본 작업 만들기 → 컴퓨터 시작 시 → `node orchestrator.js` 실행

---

## 대시보드 사용법

| 메뉴 | 위치 | 설명 |
|------|------|------|
| 전체 현황 | `/admin/` | 3개 부서 상태 + 활동 피드 |
| 콘텐츠 승인 | `/admin/content.php` | 블로그/인스타 초안 미리보기 후 승인 |
| 리드 현황 | `/admin/leads.php` | 영업팀이 발굴한 잠재고객 + 이메일 초안 확인 후 발송 승인 |

---

## 비용 예상 (월간)

- Anthropic API: 하루 ~10회 Claude 호출 × 30일 × 평균 $0.01 = **약 $3~5/월**
- 카페24 호스팅: 기존 이용 중 (**추가 비용 없음**)
- Gmail SMTP: **무료** (하루 500건 이하)
- Node.js 실행: 로컬 PC (**무료**)
