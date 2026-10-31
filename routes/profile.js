// TikSpin - streamer profiles and streamer search (Phase 2).
//
//   publicActions   -> /api/profile/...           anyone may call (read only)
//     list   GET  ?q=      approved streamers with a public profile, optional search by name or @username
//     get    GET  ?h=      one public profile: bio, live giveaways, upcoming giveaways
//   streamerActions -> /api/streamer-profile/...  a logged-in, approved streamer
//     mine   GET           the streamer's own profile settings
//     save   POST          bio (one short line, links removed), a built-in avatar and cover, and the public on/off switch
//
// The one table this file needs is created here on first use, so schema.js does not have to change
// (schema.js only builds the database when it is brand new).

import { json, cacheGet, cleanLine, cleanHandle, validTikTok } from '../lib/core.js';

const LIST_TTL_MS = 5000;
const PROFILE_TTL_MS = 5000;
const UPCOMING_GRACE_MS = 2 * 60 * 60 * 1000;   // same grace as the homepage
const BIO_MAX = 160;
const SEARCH_MAX = 24;
const LIST_LIMIT = 30;
// Built-in look: files in public/profiles/avatars (a01..) and public/profiles/covers (c01..).
// If you add artwork later, raise these two numbers.
export const AVATAR_COUNT = 12;
export const COVER_COUNT = 8;

// Returns the id if it is one of the built-in files, otherwise '' (meaning: use the default look).
export const pickPreset = (value, letter, count) => {
  const m = new RegExp(`^${letter}(\\d{2})$`).exec(String(value || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= count ? m[0] : '';
};

const notFound = () => json({ ok: false, code: 'not-found', error: 'This profile is not available.' }, 404);
const profileUrl = (username) => `https://www.tiktok.com/@${encodeURIComponent(username)}`;
const likePattern = (s) => '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

let ready = null;
export const ensureTables = (env) => {
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS streamer_profiles (
           streamer_id INTEGER PRIMARY KEY REFERENCES streamers (id) ON DELETE CASCADE,
           bio TEXT NOT NULL DEFAULT '',
           avatar TEXT NOT NULL DEFAULT '',
           cover TEXT NOT NULL DEFAULT '',
           is_public INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL
         )`
      ),
      // Platform follows (not the TikTok follow proof used inside giveaways). Removed with either account.
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS streamer_follows (
           player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
           streamer_id INTEGER NOT NULL REFERENCES streamers (id) ON DELETE CASCADE,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (player_id, streamer_id)
         )`
      ),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_follows_streamer ON streamer_follows (streamer_id)'),
      // A viewer profile is private until the player turns it on.
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS player_profiles (
           player_id INTEGER PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
           avatar TEXT NOT NULL DEFAULT '',
           is_public INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         )`
      )
    ]).then(async () => {
      // Tables created by an earlier version lack the avatar and cover columns. Adding one that already exists just errors, which is fine.
      for (const sql of [
        "ALTER TABLE streamer_profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE streamer_profiles ADD COLUMN cover TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE player_profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"
      ]) await env.DB.prepare(sql).run().catch(() => {});
    }).catch((err) => { ready = null; throw err; });
  }
  return ready;
};

// ---------------------------------------------------------------- public: search / list

async function loadList(env, q) {
  const rows = await env.DB.prepare(
    `SELECT s.display_name, s.tiktok_username, COALESCE(p.bio, '') AS bio, COALESCE(p.avatar, '') AS avatar,
            (SELECT COUNT(*) FROM streamer_follows f WHERE f.streamer_id = s.id) AS followers,
            EXISTS (SELECT 1 FROM giveaways g
                     WHERE g.streamer_id = s.id AND g.show_on_home = 1 AND g.hidden_by_owner = 0
                       AND g.status IN ('open', 'closed')) AS live
       FROM streamers s LEFT JOIN streamer_profiles p ON p.streamer_id = s.id
      WHERE s.status = 'approved' AND COALESCE(p.is_public, 1) = 1
        AND (?1 = '' OR s.tiktok_lower LIKE ?2 ESCAPE '\\' OR LOWER(s.display_name) LIKE ?2 ESCAPE '\\')
      ORDER BY live DESC, s.display_name COLLATE NOCASE ASC
      LIMIT ${LIST_LIMIT}`
  ).bind(q, likePattern(q)).all();
  return {
    ok: true,
    streamers: rows.results.map((r) => ({
      name: r.display_name,
      tiktok: r.tiktok_username,
      bio: r.bio.slice(0, 80),
      avatar: r.avatar,
      followers: r.followers,
      live: !!r.live
    }))
  };
}

const list = async ({ env, url }) => {
  await ensureTables(env);
  const q = cleanLine(url.searchParams.get('q') || '', SEARCH_MAX).toLowerCase();
  return json(await cacheGet(`plist:${q}`, LIST_TTL_MS, () => loadList(env, q)));
};

// ---------------------------------------------------------------- public: one profile

async function loadProfile(env, lower, now) {
  const s = await env.DB.prepare(
    `SELECT s.id, s.display_name, s.tiktok_username, s.wheel_code, s.approved_at, s.created_at, COALESCE(p.bio, '') AS bio,
            COALESCE(p.avatar, '') AS avatar, COALESCE(p.cover, '') AS cover
       FROM streamers s LEFT JOIN streamer_profiles p ON p.streamer_id = s.id
      WHERE s.tiktok_lower = ?1 AND s.status = 'approved' AND COALESCE(p.is_public, 1) = 1
      LIMIT 1`
  ).bind(lower).first();
  if (!s) return null;

  const [live, next, fol] = await env.DB.batch([
    env.DB.prepare(
      `SELECT g.game, g.status, g.expires_at, g.code_revoked_at,
              (SELECT COUNT(*) FROM entries e WHERE e.giveaway_id = g.id AND e.status != 'frozen') AS players
         FROM giveaways g
        WHERE g.streamer_id = ?1 AND g.show_on_home = 1 AND g.hidden_by_owner = 0 AND g.status IN ('open', 'closed')
        ORDER BY g.opened_at DESC LIMIT 3`
    ).bind(s.id),
    env.DB.prepare(
      `SELECT c.game, c.starts_at, c.note
         FROM scheduled_giveaways c
        WHERE c.streamer_id = ?1 AND c.show_on_home = 1 AND c.hidden_by_owner = 0 AND c.giveaway_id IS NULL AND c.starts_at > ?2
        ORDER BY c.starts_at ASC LIMIT 5`
    ).bind(s.id, now - UPCOMING_GRACE_MS),
    env.DB.prepare('SELECT COUNT(*) AS n FROM streamer_follows WHERE streamer_id = ?1').bind(s.id)
  ]);

  return {
    ok: true,
    name: s.display_name,
    tiktok: s.tiktok_username,
    profileUrl: profileUrl(s.tiktok_username),
    bio: s.bio,
    avatar: s.avatar,
    cover: s.cover,
    since: s.approved_at || s.created_at,
    followers: fol.results[0].n,
    live: live.results.map((g) => ({
      game: g.game,
      status: g.status === 'open' && !g.code_revoked_at && (!g.expires_at || g.expires_at > now) ? 'open' : 'running',
      players: g.players,
      wheelCode: s.wheel_code
    })),
    upcoming: next.results.map((u) => ({ game: u.game, startsAt: u.starts_at, note: u.note || '' }))
  };
}

const getProfile = async ({ env, url, now }) => {
  const handle = cleanHandle(url.searchParams.get('h') || '');
  if (!validTikTok(handle)) return notFound();
  await ensureTables(env);
  const lower = handle.toLowerCase();
  const out = await cacheGet(`profile:${lower}`, PROFILE_TTL_MS, () => loadProfile(env, lower, now));
  return out ? json(out) : notFound();
};

// ---------------------------------------------------------------- streamer: own settings

const mine = async ({ env, session }) => {
  await ensureTables(env);
  const s = await env.DB.prepare(
    `SELECT s.display_name, s.tiktok_username, COALESCE(p.bio, '') AS bio, COALESCE(p.avatar, '') AS avatar,
            COALESCE(p.cover, '') AS cover, COALESCE(p.is_public, 1) AS is_public
       FROM streamers s LEFT JOIN streamer_profiles p ON p.streamer_id = s.id WHERE s.id = ?1`
  ).bind(session.userId).first();
  if (!s) return json({ ok: false, code: 'not-found', error: 'Account not found.' }, 404);
  return { ok: true, name: s.display_name, bio: s.bio, avatar: s.avatar, cover: s.cover, isPublic: !!s.is_public, url: `/s/${encodeURIComponent(s.tiktok_username)}` };
};

const save = async ({ env, session, body, now }) => {
  await ensureTables(env);
  // One short plain-text line. Web addresses are removed, like the notes on scheduled giveaways.
  const bio = cleanLine(String(body.bio || '').replace(/https?:\/\/\S+|www\.\S+/gi, ' '), BIO_MAX);
  const isPublic = body.isPublic === false ? 0 : 1;
  const avatar = pickPreset(body.avatar, 'a', AVATAR_COUNT);
  const cover = pickPreset(body.cover, 'c', COVER_COUNT);
  await env.DB.prepare(
    `INSERT INTO streamer_profiles (streamer_id, bio, avatar, cover, is_public, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (streamer_id) DO UPDATE SET bio = excluded.bio, avatar = excluded.avatar, cover = excluded.cover,
         is_public = excluded.is_public, updated_at = excluded.updated_at`
  ).bind(session.userId, bio, avatar, cover, isPublic, now).run();
  return { ok: true, bio, avatar, cover, isPublic: !!isPublic };
};

export const publicActions = {
  list: { method: 'GET', h: list },
  get: { method: 'GET', h: getProfile }
};

export const streamerActions = {
  mine: { method: 'GET', h: mine },
  save: { h: save, maxBody: 1000, limit: { key: 'sprofile', max: 30, windowMs: 10 * 60 * 1000, by: 'session' } }
};
