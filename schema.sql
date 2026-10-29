-- TikSpin (global) - database schema for Cloudflare D1. Fresh install, no migration needed.
-- You normally do not run this by hand: the Worker creates every table by itself the first time it starts
-- (lib/schema.js holds this same SQL). This file is a readable copy and is safe to run more than once.
-- Use a NEW, EMPTY database named "tikspin" (not tikspin_vip).


-- =====================================================================================================
-- Settings and shared limiters
-- =====================================================================================================

-- Small owner-editable settings. The code falls back to the defaults below if a key is missing.
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO system_config (key, value) VALUES
  ('contact_email', ''),               -- official email shown on the site; set it here, no redeploy needed
  ('support_url', ''),                 -- optional "Support Us" link (Ko-fi, PayPal ...)
  ('support_enabled', '0'),            -- 1 shows the Support Us button
  ('report_threshold', '2'),           -- separate streamers needed before a report case opens
  ('tiktok_change_days', '7'),         -- days between TikTok @username changes
  ('invite_ttl_hours', '48'),          -- how long an invitation link works
  ('terms_global_version', '1'),       -- bump to ask everyone to accept again
  ('terms_streamer_version', '1');

-- One counter per key, used for every "too many tries" rule: logins, PIN tries, the code box, feedback, the bot.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,                -- e.g. 'code:<device>' or 'pin:<player id>'
  n INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Login sessions. Only a hash of the token is stored, never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('player', 'streamer')),
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (role, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- Who did what and when. Helps the owner judge a "my account was hacked" case and undo changes.
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_role TEXT NOT NULL,            -- streamer | player | owner
  actor_id INTEGER,
  action TEXT NOT NULL,                -- e.g. disqualify, generate_link, login
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_actor ON action_log (actor_role, actor_id, created_at);


-- =====================================================================================================
-- Streamers
-- =====================================================================================================

-- One-time invitation links made by the owner. Only a hash of the link is stored.
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  for_tiktok_lower TEXT,               -- optional: the link only works for this TikTok username
  note TEXT,                           -- owner's own note, e.g. who it was sent to
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_streamer_id INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS streamers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tiktok_username TEXT NOT NULL,       -- also the login name
  tiktok_lower TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,                       -- recovery PIN, stored as a keyed hash
  must_change_password INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  status_note TEXT,                    -- owner's reason for a rejection or suspension
  wheel_code TEXT NOT NULL UNIQUE,     -- random code for this streamer's read-only wheel link
  invite_id INTEGER,
  terms_version TEXT NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  suspended_at INTEGER,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_streamers_status ON streamers (status);


-- =====================================================================================================
-- Players
-- =====================================================================================================

-- One account per person, usable with every streamer.
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,          -- public: shown on the wheel
  display_lower TEXT NOT NULL UNIQUE,  -- unique across the whole site
  password_hash TEXT NOT NULL,
  pin_hash TEXT NOT NULL,              -- 6-digit recovery PIN, stored as a keyed hash
  must_change_password INTEGER NOT NULL DEFAULT 0,
  tiktok_username TEXT NOT NULL,       -- private: only the streamer of a giveaway they entered, and the owner, can see it
  tiktok_lower TEXT NOT NULL UNIQUE,
  tiktok_changed_at INTEGER,           -- for the "once every 7 days" rule
  display_changed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  terms_version TEXT NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Old TikTok @usernames. Kept so ban checks and conflict checks still see the earlier name.
CREATE TABLE IF NOT EXISTS player_tiktok_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  old_username TEXT NOT NULL,
  old_lower TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tiktok_history_player ON player_tiktok_history (player_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_history_lower ON player_tiktok_history (old_lower);

-- Saved game details, so the next giveaway is mostly one tap. One profile per game per player.
-- Roblox: handle = Roblox username.  Mobile Legends: handle = IGN, plus User ID and Server ID.
-- Not unique across players on purpose: two accounts claiming the same name is caught inside a giveaway
-- and frozen for the streamer to decide.
CREATE TABLE IF NOT EXISTS game_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('roblox', 'ml')),
  handle TEXT NOT NULL,
  handle_lower TEXT NOT NULL,
  ml_user_id TEXT NOT NULL DEFAULT '',
  ml_server_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (player_id, game)
);
CREATE INDEX IF NOT EXISTS idx_game_profiles_handle ON game_profiles (game, handle_lower);
CREATE INDEX IF NOT EXISTS idx_game_profiles_ml ON game_profiles (ml_user_id, ml_server_id);


-- =====================================================================================================
-- Giveaways
-- =====================================================================================================

-- One row per giveaway. The wheel state that used to sit in system_config now lives on each giveaway.
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL REFERENCES streamers (id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('roblox', 'ml')),
  requirements TEXT NOT NULL,          -- JSON list chosen when the link was made, e.g. ["ign","user_id","server_id","follow_proof"]
  code TEXT NOT NULL UNIQUE,           -- random join code shared by everyone
  code_revoked_at INTEGER,             -- set when the streamer revokes the code
  status TEXT NOT NULL DEFAULT 'open'  -- open: taking entries | closed: wheel only | ended: finished
    CHECK (status IN ('open', 'closed', 'ended')),
  show_on_home INTEGER NOT NULL DEFAULT 0,   -- the streamer's opt-in for the homepage preview
  hidden_by_owner INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL,
  expires_at INTEGER,                  -- optional entry deadline
  closed_at INTEGER,
  ended_at INTEGER,
  -- wheel state (was system_config in the VIP version)
  spin_id INTEGER NOT NULL DEFAULT 0,
  wheel_command TEXT NOT NULL DEFAULT 'idle',   -- idle | spin_winner | spin_elim
  last_landed TEXT NOT NULL DEFAULT '',
  force_reset INTEGER NOT NULL DEFAULT 1,
  last_spin_at INTEGER NOT NULL DEFAULT 0,
  out_list TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_giveaways_streamer ON giveaways (streamer_id, status);
CREATE INDEX IF NOT EXISTS idx_giveaways_home ON giveaways (show_on_home, status);
-- A streamer can have only one open or closed (running) giveaway at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_running_giveaway ON giveaways (streamer_id) WHERE status IN ('open', 'closed');

-- A player on a giveaway's wheel. One entry per account per giveaway.
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  game_handle TEXT NOT NULL,           -- Roblox username, or Mobile Legends IGN, as entered
  ml_user_id TEXT NOT NULL DEFAULT '',
  ml_server_id TEXT NOT NULL DEFAULT '',
  identity_key TEXT NOT NULL,          -- Roblox: lowercase username.  Mobile Legends: 'userid-serverid'. Used to spot conflicts.
  level INTEGER NOT NULL DEFAULT 0,    -- in-game level read from the screenshot (0 = not scanned)
  device_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'alive'
    CHECK (status IN ('alive', 'eliminated', 'winner', 'frozen')),
  freeze_reason TEXT,                  -- set when status is frozen, e.g. same Roblox name, different TikTok
  follow_tag TEXT NOT NULL DEFAULT 'unchecked'   -- the streamer's own bookkeeping
    CHECK (follow_tag IN ('unchecked', 'confirmed', 'not_found')),
  source TEXT NOT NULL DEFAULT 'scan', -- scan | manual-approved | saved-proof | no-proof
  created_at INTEGER NOT NULL,
  UNIQUE (giveaway_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_giveaway ON entries (giveaway_id, status);
CREATE INDEX IF NOT EXISTS idx_entries_identity ON entries (giveaway_id, identity_key);
CREATE INDEX IF NOT EXISTS idx_entries_device ON entries (giveaway_id, device_hash);
CREATE INDEX IF NOT EXISTS idx_entries_player ON entries (player_id);

-- Entries the streamer disqualified. Applies to this giveaway only. Names are copied so the list still reads
-- correctly, and player_id is cleared if the player later deletes their account.
CREATE TABLE IF NOT EXISTS disqualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players (id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  tiktok_username TEXT NOT NULL,
  game_handle TEXT NOT NULL,
  reason TEXT,
  device_hash TEXT,
  disqualified_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disq_giveaway ON disqualified_entries (giveaway_id);
CREATE INDEX IF NOT EXISTS idx_disq_player ON disqualified_entries (giveaway_id, player_id);

-- A player's follow proof for one streamer. Needed once; later giveaways by the same streamer skip it.
-- Pending rows hold the screenshot for the streamer's manual review. The screenshot is cleared once decided.
CREATE TABLE IF NOT EXISTS follow_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  streamer_id INTEGER NOT NULL REFERENCES streamers (id) ON DELETE CASCADE,
  giveaway_id INTEGER REFERENCES giveaways (id) ON DELETE SET NULL,   -- the giveaway it was filed for
  method TEXT NOT NULL CHECK (method IN ('scan', 'manual')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  note TEXT,
  reason TEXT,                         -- why the scan could not decide
  ocr_excerpt TEXT,
  screenshot TEXT,
  device_hash TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE (player_id, streamer_id)
);
CREATE INDEX IF NOT EXISTS idx_follow_proofs_review ON follow_proofs (streamer_id, status);

-- Each streamer's own ban list. It only affects that streamer's giveaways.
CREATE TABLE IF NOT EXISTS streamer_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL REFERENCES streamers (id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (streamer_id, player_id)
);

-- Giveaways a streamer plans for later. Shown on the homepage only when the streamer ticked "Show on homepage".
CREATE TABLE IF NOT EXISTS scheduled_giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL REFERENCES streamers (id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('roblox', 'ml')),
  starts_at INTEGER NOT NULL,          -- one exact moment; each visitor sees it in their own time zone
  note TEXT,                           -- plain text, short
  show_on_home INTEGER NOT NULL DEFAULT 0,
  hidden_by_owner INTEGER NOT NULL DEFAULT 0,
  giveaway_id INTEGER REFERENCES giveaways (id) ON DELETE SET NULL,   -- filled in when the streamer starts it
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_giveaways (starts_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_streamer ON scheduled_giveaways (streamer_id);


-- =====================================================================================================
-- Moderation (owner)
-- =====================================================================================================

-- Streamer reports against players. A case opens once enough DIFFERENT streamers have reported the same player.
-- The player and streamer links are cleared if either account is deleted, and the copied names keep the case readable.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reported_player_id INTEGER REFERENCES players (id) ON DELETE SET NULL,
  reporter_streamer_id INTEGER REFERENCES streamers (id) ON DELETE SET NULL,
  reporter_name TEXT NOT NULL,
  subject_display TEXT NOT NULL,
  subject_tiktok_lower TEXT NOT NULL,
  category TEXT NOT NULL,              -- e.g. fake-account, duplicate-accounts, abuse, other
  details TEXT,
  evidence TEXT,                       -- screenshots; deleted when the case is decided
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'banned', 'dismissed')),
  decision_note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_player ON reports (reported_player_id, status);
-- One open report per streamer per player, so several reports from one streamer count once.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_report_each ON reports (reported_player_id, reporter_streamer_id) WHERE status = 'open';

-- Platform-wide Permanent Bans. Only the owner creates them, after reviewing reports.
CREATE TABLE IF NOT EXISTS permanent_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT,
  report_id INTEGER REFERENCES reports (id) ON DELETE SET NULL,
  banned_at INTEGER NOT NULL
);

-- Everything a ban covers: display username, TikTok @username (current and old), Mobile Legends ID, Roblox username.
-- Checked when someone registers or enters. Device codes are never used, to avoid banning the wrong people.
CREATE TABLE IF NOT EXISTS ban_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ban_id INTEGER NOT NULL REFERENCES permanent_bans (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('display', 'tiktok', 'ml', 'roblox')),
  value_lower TEXT NOT NULL,           -- Mobile Legends is stored as 'userid-serverid'
  UNIQUE (kind, value_lower)
);

-- "I lost my PIN / password" requests started from the login page. The person emails the request code to the
-- official address with proof; the owner checks it by hand and resets the account.
CREATE TABLE IF NOT EXISTS reset_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_kind TEXT NOT NULL CHECK (account_kind IN ('player', 'streamer')),
  account_id INTEGER NOT NULL,
  request_code TEXT NOT NULL UNIQUE,   -- e.g. RS-48K2
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  handled_at INTEGER
);
-- One open request per account.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_reset ON reset_requests (account_kind, account_id) WHERE status = 'open';

-- Short notices. With a streamer_id: public lines shown on that streamer's wheel (display names only, e.g. "Ann joined").
-- Without one: notices for the owner panel.
CREATE TABLE IF NOT EXISTS live_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER REFERENCES streamers (id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_streamer ON live_alerts (streamer_id, created_at);


-- =====================================================================================================
-- Homepage content
-- =====================================================================================================

-- "TikSpin Official" posts. Plain text only. Written by the owner.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,                           -- optional, must be https://
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts (hidden, pinned, created_at);

-- One-way feedback from the homepage. No names or contact details are collected.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('bug', 'idea', 'complaint', 'other')),
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_inbox ON feedback (is_read, created_at);
