// TikSpin - public routes (no login needed). Reached as /api/<action>.
//
//   GET  /api/home        homepage feed: official posts, active giveaway previews, upcoming giveaways, support link
//   GET  /api/wheel       read-only wheel view of one streamer's giveaway (?code=<wheel code>)
//   POST /api/codecheck   checks a giveaway join code and returns what that giveaway asks for
//   POST /api/feedback    one-way feedback (no names, no contact details)
//   POST /api/bot         the helper bot
//
// Nothing here ever returns a join code, a TikTok @username of a player, a device code or a password.

import KB from '../llm.json';
import { createBot, fill } from '../llm.js';
import { json, jsonText, cacheGet, limitCheck, limitHit, turnstileOk } from '../lib/core.js';

const BOT = createBot(KB);

const HOME_TTL_MS = 5000;
const WHEEL_TTL_MS = 3000;
const UPCOMING_GRACE_MS = 2 * 60 * 60 * 1000;   // a scheduled card stays up to 2 hours past its time
const ENDED_VISIBLE_MS = 24 * 60 * 60 * 1000;   // an ended giveaway stays viewable for 24 hours (to show the winner)
const ALERT_TTL_MS = 120000;
const CODE_FAIL_MAX = 20;
const CODE_FAIL_WINDOW_MS = 15 * 60 * 1000;
const BOT_MAX = 40;
const BOT_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_MAX_UNREAD = 500;
const FEEDBACK_CATEGORIES = new Set(['bug', 'idea', 'complaint', 'other']);

const profileUrl = (username) => `https://www.tiktok.com/@${encodeURIComponent(username)}`;
const streamerCard = (name, username) => ({ name, tiktok: username, profileUrl: profileUrl(username) });
const parseList = (text) => {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const normCode = (s) => String(s || '').replace(/[\s-]+/g, '').toUpperCase();

// ---------------------------------------------------------------- homepage feed

async function loadHome(env, now) {
  const [posts, active, upcoming, cfg] = await env.DB.batch([
    env.DB.prepare(
      'SELECT id, title, body, link, pinned, created_at FROM posts WHERE hidden = 0 ORDER BY pinned DESC, created_at DESC LIMIT 5'
    ),
    env.DB.prepare(
      `SELECT g.id, g.game, g.status, s.display_name, s.tiktok_username, s.wheel_code,
              (SELECT COUNT(*) FROM entries e WHERE e.giveaway_id = g.id AND e.status != 'frozen') AS players
         FROM giveaways g JOIN streamers s ON s.id = g.streamer_id
        WHERE g.show_on_home = 1 AND g.hidden_by_owner = 0 AND g.status IN ('open', 'closed') AND s.status = 'approved'
        ORDER BY g.opened_at DESC LIMIT 6`
    ),
    env.DB.prepare(
      `SELECT c.id, c.game, c.starts_at, c.note, s.display_name, s.tiktok_username
         FROM scheduled_giveaways c JOIN streamers s ON s.id = c.streamer_id
        WHERE c.show_on_home = 1 AND c.hidden_by_owner = 0 AND c.giveaway_id IS NULL
          AND c.starts_at > ?1 AND s.status = 'approved'
        ORDER BY c.starts_at ASC LIMIT 10`
    ).bind(now - UPCOMING_GRACE_MS),
    env.DB.prepare(
      "SELECT key, value FROM system_config WHERE key IN ('contact_email', 'support_url', 'support_enabled', 'terms_global_version', 'terms_streamer_version')"
    )
  ]);
  const c = {};
  for (const row of cfg.results) c[row.key] = row.value;
  const supportOn = c.support_enabled === '1' && /^https:\/\//.test(c.support_url || '');

  return JSON.stringify({
    ok: true,
    posts: posts.results.map((p) => ({
      id: p.id, title: p.title, body: p.body, link: p.link || '', pinned: !!p.pinned, createdAt: p.created_at
    })),
    // Information only. There is no join code here: the code box is the one way in.
    active: active.results.map((g) => ({
      game: g.game,
      status: g.status === 'open' ? 'open' : 'running',
      players: g.players,
      streamer: streamerCard(g.display_name, g.tiktok_username),
      wheelCode: g.wheel_code
    })),
    upcoming: upcoming.results.map((u) => ({
      game: u.game,
      startsAt: u.starts_at,           // one exact moment; the page shows it in the visitor's own time zone
      note: u.note || '',
      streamer: streamerCard(u.display_name, u.tiktok_username)
    })),
    support: supportOn ? { url: c.support_url } : null,
    contactEmail: c.contact_email || (KB.vars && KB.vars.email) || '',
    terms: { global: c.terms_global_version || '1', streamer: c.terms_streamer_version || '1' },
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || ''
  });
}

const home = async ({ env, now }) => jsonText(await cacheGet('home', HOME_TTL_MS, () => loadHome(env, now)));

// ---------------------------------------------------------------- read-only wheel

async function loadWheel(env, code, now) {
  const s = await env.DB.prepare('SELECT id, display_name, tiktok_username, status FROM streamers WHERE wheel_code = ?1')
    .bind(code).first();
  if (!s || (s.status !== 'approved' && s.status !== 'suspended')) {
    return { status: 404, text: JSON.stringify({ ok: false, code: 'not-found', error: 'This wheel link is not valid.' }) };
  }
  const streamer = streamerCard(s.display_name, s.tiktok_username);
  if (s.status === 'suspended') {
    // Suspended streamers: everything is paused and nothing about the giveaway is shown.
    return { status: 200, text: JSON.stringify({ ok: true, paused: true, streamer, message: 'This giveaway is paused.' }) };
  }
  const g = await env.DB.prepare(
    `SELECT id, game, status, expires_at, code_revoked_at, spin_id, wheel_command, last_landed, force_reset, out_list
       FROM giveaways
      WHERE streamer_id = ?1 AND (status IN ('open', 'closed') OR (status = 'ended' AND ended_at > ?2))
      ORDER BY id DESC LIMIT 1`
  ).bind(s.id, now - ENDED_VISIBLE_MS).first();
  if (!g) {
    return { status: 200, text: JSON.stringify({ ok: true, streamer, registration: 'none', entries: [], out: [], alerts: [], command: 'idle', spin_id: 0, target: '', force_reset: true }) };
  }
  const [entries, alerts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.display_name AS name, e.status
         FROM entries e JOIN players p ON p.id = e.player_id
        WHERE e.giveaway_id = ?1 AND e.status IN ('alive', 'eliminated', 'winner') ORDER BY e.id ASC`
    ).bind(g.id),
    env.DB.prepare('SELECT id, message, created_at FROM live_alerts WHERE streamer_id = ?1 AND created_at > ?2 ORDER BY id DESC LIMIT 5')
      .bind(s.id, now - ALERT_TTL_MS)
  ]);
  const accepting = g.status === 'open' && !g.code_revoked_at && (!g.expires_at || g.expires_at > now);
  return {
    status: 200,
    text: JSON.stringify({
      ok: true,
      streamer,
      game: g.game,
      registration: accepting ? 'open' : 'closed',
      ended: g.status === 'ended',
      entries: entries.results,            // display names and wheel status only
      out: parseList(g.out_list),
      alerts: alerts.results,
      command: g.wheel_command || 'idle',
      spin_id: g.spin_id,
      target: g.last_landed || '',
      force_reset: g.force_reset === 1
    })
  };
}

const wheel = async ({ env, url, now }) => {
  const code = normCode(url.searchParams.get('code'));
  if (!/^[A-Z0-9]{8,32}$/.test(code)) {
    return json({ ok: false, code: 'not-found', error: 'This wheel link is not valid.' }, 404);
  }
  const out = await cacheGet(`wheel:${code}`, WHEEL_TTL_MS, () => loadWheel(env, code, now));
  return jsonText(out.text, out.status);
};

// ---------------------------------------------------------------- join code check

const INVALID_CODE = 'That code is not valid. Check it for typos, or the giveaway may be closed.';

const codeCheck = async ({ env, body, device, now }) => {
  const failKey = `codefail:${device}`;
  const lock = await limitCheck(env, failKey, CODE_FAIL_MAX, CODE_FAIL_WINDOW_MS);
  if (!lock.ok) {
    const res = json({ ok: false, code: 'slow-down', error: 'Too many wrong codes. Please wait a few minutes and try again.', retryAfter: lock.retryAfter }, 429);
    res.headers.set('retry-after', String(lock.retryAfter));
    return res;
  }
  const code = normCode(body.code);
  const row = /^[A-Z0-9]{6,20}$/.test(code)
    ? await env.DB.prepare(
        `SELECT g.game, g.requirements, g.expires_at, s.display_name, s.tiktok_username
           FROM giveaways g JOIN streamers s ON s.id = g.streamer_id
          WHERE g.code = ?1 AND g.status = 'open' AND g.code_revoked_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at > ?2) AND s.status = 'approved'`
      ).bind(code, now).first()
    : null;
  // One shared message for every kind of wrong code, so nobody can tell a dead code from a typo.
  if (!row) {
    await limitHit(env, failKey, CODE_FAIL_WINDOW_MS);
    return json({ ok: false, code: 'invalid-code', error: INVALID_CODE }, 404);
  }
  return json({
    ok: true,
    giveaway: {
      game: row.game,
      requirements: parseList(row.requirements),
      expiresAt: row.expires_at || null,
      streamer: streamerCard(row.display_name, row.tiktok_username)
    }
  });
};

// ---------------------------------------------------------------- feedback

const feedback = async ({ request, env, body, now }) => {
  if (!(await turnstileOk(env, body.ts, request))) {
    return json({ ok: false, code: 'check-failed', error: 'The bot check did not pass. Please try again.' }, 400);
  }
  const category = String(body.category || '');
  if (!FEEDBACK_CATEGORIES.has(category)) return json({ ok: false, code: 'category', error: 'Choose a category.' }, 400);
  const message = String(body.message || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ').trim().slice(0, 1000);
  if (message.length < 5) return json({ ok: false, code: 'message', error: 'Please write a little more (at least 5 characters).' }, 400);

  const unread = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE is_read = 0').first();
  if (unread && unread.n >= FEEDBACK_MAX_UNREAD) {
    return json({ ok: false, code: 'busy', error: 'Feedback is very busy right now. Please try again later.' }, 429);
  }
  await env.DB.prepare('INSERT INTO feedback (category, message, is_read, created_at) VALUES (?1, ?2, 0, ?3)')
    .bind(category, message, now).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------- helper bot
// Rules and answers live in llm.js + llm.json. This only serves them. The bot never decides or changes anything:
// for the topics that start a request (TikTok change, recovery) it returns a `kind`, and the page opens the form.
// The server checks everything again when the form is sent.

const bot = async ({ env, body, device, now }) => {
  if (!BOT.enabled) return json({ ok: false, code: 'off', error: 'The helper is turned off right now.' }, 503);

  const cfg = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'contact_email'").first();
  // {host} reads naturally whether or not the player is on a giveaway page. {email} falls back to plain words
  // until the owner has set a contact email in the settings.
  const vars = { ...(KB.vars || {}), status: '', streamer_name: '', host: 'the giveaway host' };
  vars.email = (cfg && cfg.value) || 'the operator';

  // When the player is on a giveaway page, the page sends its code so answers can name the streamer.
  const code = normCode(body.code);
  if (/^[A-Z0-9]{6,20}$/.test(code)) {
    const g = await env.DB.prepare(
      `SELECT g.status, g.expires_at, g.code_revoked_at, s.display_name
         FROM giveaways g JOIN streamers s ON s.id = g.streamer_id
        WHERE g.code = ?1 AND s.status = 'approved'`
    ).bind(code).first();
    if (g) {
      vars.streamer_name = g.display_name;
      vars.host = g.display_name;
      const open = g.status === 'open' && !g.code_revoked_at && (!g.expires_at || g.expires_at > now);
      vars.status = open ? 'Entries are open for this giveaway.' : 'Entries are closed for this giveaway.';
    }
  }

  if (body.init === true) {
    return json({ ok: true, name: BOT.name, text: fill(BOT.greeting, vars), suggestions: BOT.quick });
  }

  const key = `bot:${device}`;
  const lock = await limitCheck(env, key, BOT_MAX, BOT_WINDOW_MS);
  if (!lock.ok) {
    return json({ ok: false, code: 'slow', error: 'You are sending messages too fast. Please wait a few minutes.' }, 429);
  }
  const out = BOT.reply(body.message);
  if (!out) return json({ ok: false, code: 'empty', error: 'Type a question first.' }, 400);
  await limitHit(env, key, BOT_WINDOW_MS);
  return json({ ok: true, type: out.type, kind: out.kind, text: fill(out.text, vars), suggestions: out.suggestions });
};

// ---------------------------------------------------------------- action table (read by index.js)
// home and wheel have no per-device limit on purpose: they are cached, and a limiter would write to the
// database on every poll. The code check, feedback and bot all have limits.
export const actions = {
  home: { method: 'GET', h: home },
  wheel: { method: 'GET', h: wheel },
  codecheck: { h: codeCheck, maxBody: 500, limit: { key: 'code', max: 30, windowMs: 60 * 1000 } },
  feedback: { h: feedback, maxBody: 3000, limit: { key: 'feedback', max: 3, windowMs: 60 * 60 * 1000 } },
  bot: { h: bot, maxBody: 2000 }
};
