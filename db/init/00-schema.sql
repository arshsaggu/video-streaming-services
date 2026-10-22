-- Schema for the Video Streaming System.
-- Runs once, on first start of an empty MySQL data volume.
-- Application services never run DDL; they get least-privilege users (see 01-users.sh).

CREATE DATABASE IF NOT EXISTS auth CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS media CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth.users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,   -- werkzeug scrypt hashes are ~162 chars
  role          VARCHAR(16)  NOT NULL DEFAULT 'viewer',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
);

CREATE TABLE IF NOT EXISTS media.videos (
  id            CHAR(36)        NOT NULL,
  title         VARCHAR(120)    NOT NULL,
  description   VARCHAR(1000)   NOT NULL DEFAULT '',
  content_type  VARCHAR(40)     NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL,
  sha256        CHAR(64)        NOT NULL,
  uploaded_by   VARCHAR(32)     NOT NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_videos_created_at (created_at),
  KEY idx_videos_uploaded_by (uploaded_by)
);
