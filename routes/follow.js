// TikSpin - platform follows and viewer profiles (Phase 3).
//
//   playerActions -> /api/player-profile/...   a logged-in player
//     mine      GET   {isPublic, url, streamers[]}  the player's own profile settings and who they follow
//     save      POST  {isPublic, avatar}            make the viewer profile public or private (private by default) and pick a built-in avatar
//     status    GET   ?h=<tiktok username>          am I following this streamer?
//     follow    POST  {handle}
//     unfollow  POST  {handle}
//   viewerActions -> /api/viewer/...            anyone may call (read only)
//     get       GET   ?u=<display username>         a public viewer profile: name and how many streamers they follow
//
// "Follow" here is only a TikSpin follow. It is separate from the TikTok follow proof used inside giveaways.
// A streamer only ever sees a follower COUNT, and a viewer profile only ever shows the following COUNT.
// The tables are created by routes/profile.js (ensureTables).

import { json, cacheGet, cleanHandle, validTikTok, validDisplayName } from '../lib/core.js';
import { ensureTables, pickPreset, AVATAR_COUNT } from './profile.js';

const MAX_FOLLOWS = 200;
const VIEWER_TTL_MS = 5000;

const notFound = () => json({ ok: false, code: 'not-found', error: 'This profile is not available.' }, 404);

// A streamer can be followed only while approved and with a public profile (the same rule as the profile page).
const findStreamer = (env, lower) =>
  env.DB.prepare(
    `SELECT s.id FROM streamers s LEFT JOIN streamer_profiles p ON p.streamer_id = s.id
      WHERE s.tiktok_lower = ?1 AND s.status = 'approved' AND COALESCE(p.is_public, 1) = 1 LIMIT 1`
  ).bind(lower).first();

const followerCount = async (env, streamerId) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM streamer_follows WHERE streamer_id = ?1').bind(streamerId).first()).n;

const handleOf = (raw) => {
  const handle = cleanHandle(raw);
  return validTikTok(handle) ? handle.toLowerCase() : '';
};

// ---------------------------------------------------------------- player: own profile

const mine = async ({ env, session }) => {
  await ensureTables(env);
  const [me, follows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.display_name, COALESCE(v.avatar, '') AS avatar, COALESCE(v.is_public, 0) AS is_public
         FROM players p LEFT JOIN player_profiles v ON v.player_id = p.id WHERE p.id = ?1`
    ).bind(session.userId),
    env.DB.prepare(
      `SELECT s.display_name, s.tiktok_username,
              EXISTS (SELECT 1 FROM giveaways g WHERE g.streamer_id = s.id AND g.show_on_home = 1
                       AND g.hidden_by_owner = 0 AND g.status IN ('open', 'closed')) AS live
         FROM streamer_follows f JOIN streamers s ON s.id = f.streamer_id
        WHERE f.player_id = ?1 AND s.status = 'approved'
        ORDER BY f.created_at DESC LIMIT ${MAX_FOLLOWS}`
    ).bind(session.userId)
  ]);
  const p = me.results[0];
  if (!p) return json({ ok: false, code: 'not-found', error: 'Account not found.' }, 404);
  return {
    ok: true,
    name: p.display_name,
    isPublic: !!p.is_public,
    avatar: p.avatar,
    url: `/u/${encodeURIComponent(p.display_name)}`,
    streamers: follows.results.map((r) => ({ name: r.display_name, tiktok: r.tiktok_username, live: !!r.live }))
  };
};

const save = async ({ env, session, body, now }) => {
  await ensureTables(env);
  const isPublic = body.isPublic === true ? 1 : 0;
  const avatar = pickPreset(body.avatar, 'a', AVATAR_COUNT);
  await env.DB.prepare(
    `INSERT INTO player_profiles (player_id, avatar, is_public, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (player_id) DO UPDATE SET avatar = excluded.avatar, is_public = excluded.is_public, updated_at = excluded.updated_at`
  ).bind(session.userId, avatar, isPublic, now).run();
  return { ok: true, isPublic: !!isPublic, avatar };
};

// ---------------------------------------------------------------- player: follow / unfollow

const status = async ({ env, session, url }) => {
  await ensureTables(env);
  const lower = handleOf(url.searchParams.get('h') || '');
  if (!lower) return notFound();
  const row = await env.DB.prepare(
    `SELECT 1 AS yes FROM streamer_follows f JOIN streamers s ON s.id = f.streamer_id
      WHERE f.player_id = ?1 AND s.tiktok_lower = ?2 LIMIT 1`
  ).bind(session.userId, lower).first();
  return { ok: true, following: !!row };
};

const follow = async ({ env, session, body, now }) => {
  await ensureTables(env);
  const lower = handleOf(body.handle);
  const s = lower ? await findStreamer(env, lower) : null;
  if (!s) return notFound();
  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM streamer_follows WHERE player_id = ?1').bind(session.userId).first();
  const already = await env.DB.prepare('SELECT 1 AS yes FROM streamer_follows WHERE player_id = ?1 AND streamer_id = ?2').bind(session.userId, s.id).first();
  if (!already && have.n >= MAX_FOLLOWS) {
    return json({ ok: false, code: 'limit', error: `You can follow up to ${MAX_FOLLOWS} streamers. Unfollow one first.` }, 400);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO streamer_follows (player_id, streamer_id, created_at) VALUES (?1, ?2, ?3)')
    .bind(session.userId, s.id, now).run();
  return { ok: true, following: true, followers: await followerCount(env, s.id) };
};

// Unfollowing works even if the streamer has since been hidden or suspended, so nobody is stuck following.
const unfollow = async ({ env, session, body }) => {
  await ensureTables(env);
  const lower = handleOf(body.handle);
  const s = lower ? await env.DB.prepare('SELECT id FROM streamers WHERE tiktok_lower = ?1').bind(lower).first() : null;
  if (!s) return notFound();
  await env.DB.prepare('DELETE FROM streamer_follows WHERE player_id = ?1 AND streamer_id = ?2').bind(session.userId, s.id).run();
  return { ok: true, following: false, followers: await followerCount(env, s.id) };
};

// ---------------------------------------------------------------- public: a viewer profile

async function loadViewer(env, lower) {
  const row = await env.DB.prepare(
    `SELECT p.id, p.display_name, v.avatar FROM players p JOIN player_profiles v ON v.player_id = p.id
      WHERE p.display_lower = ?1 AND p.status = 'active' AND v.is_public = 1 LIMIT 1`
  ).bind(lower).first();
  if (!row) return null;
  const n = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM streamer_follows f JOIN streamers s ON s.id = f.streamer_id
      WHERE f.player_id = ?1 AND s.status = 'approved'`
  ).bind(row.id).first();
  return { ok: true, name: row.display_name, avatar: row.avatar, following: n.n };
}

const viewer = async ({ env, url }) => {
  const name = String(url.searchParams.get('u') || '').trim();
  if (!validDisplayName(name)) return notFound();
  await ensureTables(env);
  const lower = name.toLowerCase();
  const out = await cacheGet(`viewer:${lower}`, VIEWER_TTL_MS, () => loadViewer(env, lower));
  return out ? json(out) : notFound();
};

export const playerActions = {
  mine: { method: 'GET', h: mine },
  save: { h: save, maxBody: 500, limit: { key: 'pprofile', max: 20, windowMs: 10 * 60 * 1000, by: 'session' } },
  status: { method: 'GET', h: status },
  follow: { h: follow, maxBody: 500, limit: { key: 'pfollow', max: 60, windowMs: 10 * 60 * 1000, by: 'session' } },
  unfollow: { h: unfollow, maxBody: 500, limit: { key: 'pfollow', max: 60, windowMs: 10 * 60 * 1000, by: 'session' } }
};

export const viewerActions = {
  get: { method: 'GET', h: viewer }
};
