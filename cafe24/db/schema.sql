-- jblogzy AI 자동화 팀 데이터베이스 스키마
-- 카페24 phpMyAdmin에서 실행하거나 MySQL 클라이언트로 가져오기

CREATE DATABASE IF NOT EXISTS jblogzy_ai_team
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE jblogzy_ai_team;

-- 에이전트 작업 로그 (모든 부서의 활동 기록)
CREATE TABLE IF NOT EXISTS agent_tasks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  department    VARCHAR(20) NOT NULL COMMENT 'sales | marketing | chm',
  task_type     VARCHAR(100) NOT NULL COMMENT '작업 유형 (lead_discovery, content_creation 등)',
  status        VARCHAR(20) NOT NULL DEFAULT 'completed' COMMENT 'running | completed | error',
  summary       TEXT COMMENT '한 줄 요약 (대시보드 피드용)',
  detail        LONGTEXT COMMENT '상세 결과 (JSON 또는 HTML)',
  content_url   VARCHAR(500) COMMENT '발행된 실제 URL',
  error_message TEXT COMMENT '에러 발생 시 메시지',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_department (department),
  INDEX idx_created_at (created_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 콘텐츠 승인 대기열 (마케팅팀 + 영업팀이 생성한 콘텐츠)
CREATE TABLE IF NOT EXISTS content_queue (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  department       VARCHAR(20) NOT NULL,
  content_type     VARCHAR(50) NOT NULL COMMENT 'blog_post | email | sns_caption | image_prompt',
  title            VARCHAR(500),
  body             LONGTEXT,
  image_prompt     TEXT COMMENT 'AI 이미지 생성용 프롬프트',
  target_platform  VARCHAR(50) COMMENT 'naver_blog | instagram | email',
  target_audience  VARCHAR(200) COMMENT '타겟 업종/대상',
  content_url      VARCHAR(500) COMMENT '발행된 경우 URL',
  approval_status  VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending | approved | rejected | published',
  approved_at      TIMESTAMP NULL,
  published_at     TIMESTAMP NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_approval (approval_status),
  INDEX idx_department (department),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 영업팀 잠재고객(리드) 리스트
CREATE TABLE IF NOT EXISTS leads (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  industry      VARCHAR(100) COMMENT '업종 (외식업, 미용실, 헬스장 등)',
  platform      VARCHAR(50) COMMENT '발굴 플랫폼 (instagram, facebook, naver_blog)',
  contact       VARCHAR(200) COMMENT '이메일 또는 SNS 계정',
  contact_type  VARCHAR(20) DEFAULT 'email' COMMENT 'email | sns_dm',
  source_url    VARCHAR(500) COMMENT '발굴된 프로필/게시글 URL',
  email_status  VARCHAR(20) DEFAULT 'pending' COMMENT 'pending | approved | sent | opened | replied | unsubscribed',
  email_subject VARCHAR(500) COMMENT '발송된 이메일 제목',
  email_body    LONGTEXT COMMENT '발송된 이메일 본문',
  sent_at       TIMESTAMP NULL,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_industry (industry),
  INDEX idx_email_status (email_status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- API 접근 키 관리
CREATE TABLE IF NOT EXISTS api_keys (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  key_value  VARCHAR(64) NOT NULL UNIQUE,
  label      VARCHAR(100) COMMENT '키 설명 (예: local-dev, production)',
  is_active  TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 초기 API 키 삽입 (실제 운영 시 아래 값을 변경할 것)
INSERT INTO api_keys (key_value, label) VALUES
  ('CHANGE_THIS_SECRET_KEY_32CHARS_MIN', 'local-dev');
