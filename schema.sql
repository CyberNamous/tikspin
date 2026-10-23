PRAGMA foreign_keys = ON;

CREATE TABLE streamers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_name TEXT UNIQUE,
    streamer_id TEXT UNIQUE,
    status TEXT DEFAULT 'PENDING'
);

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    username TEXT UNIQUE,
    password_hash TEXT,
    pin_hash TEXT,
    secret_answer_hash TEXT,
    tiktok_username TEXT,
    roblox_username TEXT,
    ml_id TEXT,
    ml_server TEXT
);

CREATE TABLE giveaways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id TEXT,
    giveaway_name TEXT,
    giveaway_mode TEXT,
    entry_code TEXT,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    giveaway_id INTEGER,
    user_id TEXT,
    UNIQUE(giveaway_id, user_id)
);

CREATE TABLE news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entries_giveaway ON entries(giveaway_id);
CREATE INDEX idx_streamers_status ON streamers(status);
CREATE INDEX idx_giveaways_active ON giveaways(is_active, id);
CREATE INDEX idx_giveaways_streamer ON giveaways(streamer_id, is_active);
CREATE INDEX idx_news_posted ON news(posted_at DESC, id DESC);
