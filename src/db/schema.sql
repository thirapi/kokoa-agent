CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_conversations_chat_id
  ON conversations(chat_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(chat_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  trigger_at INTEGER NOT NULL,
  recurring INTEGER DEFAULT 0,
  interval_seconds INTEGER DEFAULT 0,
  last_triggered INTEGER DEFAULT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS gha_context (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'code',
  repo TEXT NOT NULL DEFAULT '',
  history TEXT DEFAULT '[]',
  memories TEXT DEFAULT '[]',
  task_plan TEXT DEFAULT 'null',
  previous_result TEXT DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER DEFAULT (unixepoch()),
  consumed_at INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_gha_context_chat_id ON gha_context (chat_id);
CREATE INDEX IF NOT EXISTS idx_gha_context_status ON gha_context (status);

CREATE TABLE IF NOT EXISTS chat_locks (
  chat_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'locked',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_reminders_trigger
  ON reminders(trigger_at);

CREATE TABLE IF NOT EXISTS spaces_pending (
  chat_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS task_traces (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  runtime TEXT,
  prompt TEXT,
  status TEXT,
  duration_ms INTEGER,
  events TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_task_traces_chat ON task_traces(chat_id, created_at);

CREATE TABLE IF NOT EXISTS remote_jobs (
  chat_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  prompt TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Status per chat yang sering ditulis (dedupe update & rate limit). Dipindah dari KV
-- (kuota gratis 1.000 tulis/hari) ke D1 (100.000 tulis/hari).
CREATE TABLE IF NOT EXISTS chat_state (
  chat_id TEXT PRIMARY KEY,
  last_update_id TEXT,
  last_request_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
