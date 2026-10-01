'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 数据库初始化（幂等）
db.exec(`
CREATE TABLE IF NOT EXISTS scripts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  original_srt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,          -- 原稿中的序号（从 1 开始）
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL,
  UNIQUE(script_id, seq)
);

CREATE TABLE IF NOT EXISTS branches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'revision',  -- revision | merged
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 演员名单（每份稿件登记，归属按分支片段独立指定）
CREATE TABLE IF NOT EXISTS actors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(script_id, name)
);

CREATE TABLE IF NOT EXISTS branch_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,          -- 分支内顺序（从 1 开始）
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES actors(id) ON DELETE SET NULL, -- 演员归属（可空=未归属）
  rev        INTEGER NOT NULL DEFAULT 1, -- 片段修订计数：文案/时码任一变化即 +1，用于豁免失效（归属变化不推进 rev）
  translation TEXT,                     -- 译文（NULL=未录入；供海外演员的双语字幕）
  translation_reviewed INTEGER NOT NULL DEFAULT 0 -- 译文复核状态：0 待复核 / 1 已复核（空译文不可复核）
);

-- 来源关联：
-- 拆分：一个来源片段关联到多个分支片段
-- 合并：多个来源片段关联到同一个分支片段
CREATE TABLE IF NOT EXISTS segment_sources (
  branch_segment_id INTEGER NOT NULL REFERENCES branch_segments(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
  PRIMARY KEY (branch_segment_id, source_id)
);

-- 质检规则（每份稿件一份当前配置）
CREATE TABLE IF NOT EXISTS qc_rules (
  script_id          INTEGER PRIMARY KEY REFERENCES scripts(id) ON DELETE CASCADE,
  current_version_id INTEGER NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 质检规则版本归档：规则内容每次实质变化新增一行，豁免按版本生效
CREATE TABLE IF NOT EXISTS qc_rule_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id        INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version_no       INTEGER NOT NULL,
  min_duration_ms  INTEGER,
  max_duration_ms  INTEGER,
  max_cps          REAL,
  min_gap_ms       INTEGER,
  banned_words_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(script_id, version_no)
);

-- 质检报告（每次手动生成一份快照；拆分/合并/编辑后旧快照按 state_hash 判定失效）
CREATE TABLE IF NOT EXISTS qc_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  rule_version_id INTEGER NOT NULL REFERENCES qc_rule_versions(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,             -- 生成时分支片段（序号/时码/文案）指纹
  timeline_issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS qc_hits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES qc_reports(id) ON DELETE CASCADE,
  rule_type  TEXT NOT NULL,             -- duration | cps | gap | banned
  ord        INTEGER NOT NULL,          -- 命中时片段序号（间隔类取后一条）
  source_seqs_json TEXT NOT NULL DEFAULT '[]', -- 原稿来源序号（间隔类为两条并集）
  hit_key    TEXT NOT NULL,             -- 命中指纹：片段id@rev + 规则要素
  message    TEXT NOT NULL,
  start_ms   INTEGER,
  end_ms     INTEGER,
  text_excerpt TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

-- 质检豁免：仅对该分支当时的片段内容、时码与规则版本有效
CREATE TABLE IF NOT EXISTS qc_exemptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  rule_version_id INTEGER NOT NULL REFERENCES qc_rule_versions(id) ON DELETE CASCADE,
  hit_key    TEXT NOT NULL,
  rule_type  TEXT NOT NULL,
  start_segment_id INTEGER NOT NULL REFERENCES branch_segments(id) ON DELETE CASCADE,
  start_seg_rev    INTEGER NOT NULL,
  end_segment_id   INTEGER REFERENCES branch_segments(id) ON DELETE CASCADE,
  end_seg_rev      INTEGER,
  ord_at_creation  INTEGER NOT NULL,
  source_seqs_json TEXT NOT NULL DEFAULT '[]',
  hit_message TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- 排练交付包：在修订/合并分支上一次签发、内容不可变的可下载交付包（ZIP）
-- 整包与各文件内容均落库，重下永远得到签发时的同一字节；删除稿件时级联清理。
CREATE TABLE IF NOT EXISTS deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id       INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  branch_id       INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  issued_at       TEXT NOT NULL,                 -- 签发时间（ISO-8601，UTC）
  segment_count   INTEGER NOT NULL,
  state_hash      TEXT NOT NULL,                 -- 签发时分支一致状态指纹（片段身份/时码/文案/来源/演员/译文/rev）
  rule_version_id INTEGER REFERENCES qc_rule_versions(id) ON DELETE SET NULL,
  rule_version_no INTEGER,                       -- 签发时质检规则版本号（冗余留档，规则版本被删也不影响清单可读）
  zip_size        INTEGER NOT NULL,
  zip_sha256      TEXT NOT NULL,
  zip_bytes       BLOB NOT NULL,                 -- 签发时落库的整包字节（重下载永远得到同一字节）
  manifest_json   TEXT NOT NULL                  -- 完整清单（机器可读 JSON 留档）
);

CREATE TABLE IF NOT EXISTS delivery_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,                  -- 包内顺序
  role        TEXT NOT NULL,                     -- srt | bilingual_srt | cue_sheet | manifest
  filename    TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  content     BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_script ON deliveries(script_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_branch ON deliveries(branch_id);
CREATE INDEX IF NOT EXISTS idx_delivery_files_delivery ON delivery_files(delivery_id);

CREATE INDEX IF NOT EXISTS idx_source_segments_script ON source_segments(script_id);
CREATE INDEX IF NOT EXISTS idx_branches_script ON branches(script_id);
CREATE INDEX IF NOT EXISTS idx_actors_script ON actors(script_id);
CREATE INDEX IF NOT EXISTS idx_branch_segments_branch ON branch_segments(branch_id);
CREATE INDEX IF NOT EXISTS idx_segment_sources_bs ON segment_sources(branch_segment_id);
CREATE INDEX IF NOT EXISTS idx_segment_sources_src ON segment_sources(source_id);
CREATE INDEX IF NOT EXISTS idx_qc_rule_versions_script ON qc_rule_versions(script_id);
CREATE INDEX IF NOT EXISTS idx_qc_reports_branch ON qc_reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_qc_hits_report ON qc_hits(report_id);
CREATE INDEX IF NOT EXISTS idx_qc_exemptions_branch ON qc_exemptions(branch_id);
`);

// 旧库迁移：为已存在的 branch_segments 补 rev 列
const segCols = db.prepare('PRAGMA table_info(branch_segments)').all();
if (!segCols.some((c) => c.name === 'rev')) {
  db.exec('ALTER TABLE branch_segments ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
}
// 旧库迁移：演员归属列（旧行默认 NULL=未归属）
if (!segCols.some((c) => c.name === 'actor_id')) {
  db.exec('ALTER TABLE branch_segments ADD COLUMN actor_id INTEGER');
}
// 旧库迁移：双语译文列（旧行默认 NULL=未录入译文、待复核）
if (!segCols.some((c) => c.name === 'translation')) {
  db.exec('ALTER TABLE branch_segments ADD COLUMN translation TEXT');
}
if (!segCols.some((c) => c.name === 'translation_reviewed')) {
  db.exec('ALTER TABLE branch_segments ADD COLUMN translation_reviewed INTEGER NOT NULL DEFAULT 0');
}

// 旧库迁移：交付包整包字节列（交付功能首次引入时补上；旧库无交付行）
const deliveryCols = db.prepare('PRAGMA table_info(deliveries)').all();
if (deliveryCols.length && !deliveryCols.some((c) => c.name === 'zip_bytes')) {
  db.exec('ALTER TABLE deliveries ADD COLUMN zip_bytes BLOB');
}

// 以下索引依赖 actor_id，须在迁移补列之后创建
db.exec('CREATE INDEX IF NOT EXISTS idx_branch_segments_actor ON branch_segments(actor_id);');

module.exports = db;
