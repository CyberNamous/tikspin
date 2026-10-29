// TikSpin - player routes. Reached as /api/player/<action>.
//
//   No login needed:   register, login, recover, pinrequest
//   Login needed:      me, logout, acceptterms, changepassword, newpin, changetiktok, changedisplay,
//                      enter, apply, applystatus
//
// Rules this file enforces (the browser is never trusted):
//   * one account per person: unique display username, unique TikTok @username
//   * the 6-digit PIN is shown ONCE (sign-up, recovery, new PIN) and only a keyed hash is stored
//   * PIN tries are limited per ACCOUNT (5 wrong tries lock it for 24 hours), not only per device
//   * a TikTok @username / display username change needs password + PIN and waits 7 days between changes
//   * permanent bans, a streamer's own ban list and disqualifications block entry

import {
  json, cleanLine, cleanHandle, validTikTok, validDisplayName, passwordProblem, norm,
  hashPassword, verifyPassword, hashPin, verifyPin, newPin, randomCode,
  createSession, destroySession, destroyUserSessions,
  limitCheck, limitHit, limitReset, logAction, turnstileOk
} from '../lib/core.js';
import { findBan, banPairsFor, enrollPlayer } from '../lib/enroll.js';
import { checkFollowText, cleanOcr } from '../lib/followcheck.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = DAY_MS;
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const RESET_REQUEST_TTL_MS = DAY_MS;
const MAX_SHOT_CHARS = 450000;
const MAX_APPLY_BODY = 520000;
const MAX_PENDING_PER_STREAMER = 300;
const RESERVED = ['tikspin', 'admin', 'owner', 'operator', 'official', 'support', 'moderator', 'staff'];

const fail = (status, code, error, extra) => json({ ok: false, code, error, ...(extra || {}) }, status);

// ---------------------------------------------------------------- small helpers

const readConfig = async (env) => {
  const { results } = await env.DB.prepare('SELECT key, value FROM system_config').all();
  const c = {};
  for (const r of results) c[r.key] = r.value;
  return {
    email: c.contact_email || '',
    termsVersion: c.terms_global_version || '1',
    changeDays: Math.max(0, Number(c.tiktok_change_days || 7)) || 7
  };
};

const ownerKey = (id) => `p:${id}`;
const pinLockKey = (id) => `pin:${id}`;

const getPlayer = (env, id) => env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(id).first();

const summary = (p, cfg) => ({
  display: p.display_name,
  tiktok: p.tiktok_username,
  status: p.status,
  mustChangePassword: !!p.must_change_password,
  needsTerms: p.terms_version !== cfg.termsVersion,
  tiktokNextChangeAt: p.tiktok_changed_at ? p.tiktok_changed_at + cfg.changeDays * DAY_MS : 0,
  displayNextChangeAt: p.display_changed_at ? p.display_changed_at + cfg.changeDays * DAY_MS : 0
});

const reservedName = (display) => {
  const n = norm(display);
  return RESERVED.some((r) => n.startsWith(r)) || n.includes('tikspin');
};

// A timing-safe stand-in so "no such account" takes as long as "wrong password".
let dummyHash = null;
const getDummyHash = () => (dummyHash ||= hashPassword('not-a-real-password-for-timing'));

const sameMessage = 'Those details do not match.';

// Checks the account's PIN lock. Returns a Response when locked, otherwise null.
const pinLocked = async (env, playerId) => {
  const lock = await limitCheck(env, pinLockKey(playerId), PIN_MAX_FAILS, PIN_LOCK_MS);
  if (lock.ok) return null;
  const hours = Math.max(1, Math.ceil(lock.retryAfter / 3600));
  return fail(429, 'pin-locked', `Too many wrong PIN tries. This is locked for about ${hours} more hour(s). Email the operator if you need help.`, { retryAfter: lock.retryAfter });
};

// Verifies a PIN. Counts a wrong try against the account.
const checkPin = async (env, player, pin) => {
  const ok = await verifyPin(env, ownerKey(player.id), pin, player.pin_hash);
  if (!ok) await limitHit(env, pinLockKey(player.id), PIN_LOCK_MS);
  return ok;
};

const uniqueColumn = (err) => {
  const m = String((err && err.message) || '');
  if (m.includes('display_lower')) return 'display';
  if (m.includes('tiktok_lower')) return 'tiktok';
  return m.includes('UNIQUE') ? 'other' : '';
};

// ---------------------------------------------------------------- sign up and log in

const register = async ({ request, env, body, device, now }) => {
  // Checked first, so a missing secret can never leave a half-made account behind.
  if (!env.PIN_PEPPER) return fail(503, 'setup', 'TikSpin is not fully set up yet. The operator needs to finish setup.');
  if (!(await turnstileOk(env, body.ts, request))) return fail(400, 'check-failed', 'The bot check did not pass. Please try again.');
  if (body.terms !== true) return fail(400, 'terms', 'You must accept the Terms and Conditions to create an account.');

  const display = String(body.display || '').trim();
  if (!validDisplayName(display)) return fail(400, 'display', 'Display username: 3-20 letters, numbers or underscores.');
  if (reservedName(display)) return fail(400, 'display', 'That display username is not available.');
  const tiktok = cleanHandle(body.tiktok);
  if (!validTikTok(tiktok)) return fail(400, 'tiktok', 'Enter your TikTok username (letters, numbers, dots and underscores).');
  const problem = passwordProblem(body.password);
  if (problem) return fail(400, 'password', problem);

  const dl = display.toLowerCase();
  const tl = tiktok.toLowerCase();
  if (await findBan(env, [['display', dl], ['tiktok', tl]])) {
    return fail(403, 'banned', 'This account is not allowed on TikSpin.');
  }

  const cfg = await readConfig(env);
  const pin = newPin();
  const passwordHash = await hashPassword(String(body.password));
  let id;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO players (display_name, display_lower, password_hash, pin_hash, tiktok_username, tiktok_lower,
                            terms_version, terms_accepted_at, created_at, last_login_at)
       VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?7, ?7)`
    ).bind(display, dl, passwordHash, tiktok, tl, cfg.termsVersion, now).run();
    id = r.meta.last_row_id;
  } catch (err) {
    const col = uniqueColumn(err);
    if (col === 'display') return fail(409, 'display-taken', 'That display username is already taken.');
    if (col === 'tiktok') return fail(409, 'tiktok-taken', 'That TikTok username is already linked to another account.');
    throw err;
  }
  // The PIN hash is tied to the account id, so it is written right after the row exists. Until then it is empty,
  // which can never match a PIN.
  await env.DB.prepare('UPDATE players SET pin_hash = ?1 WHERE id = ?2').bind(await hashPin(env, ownerKey(id), pin), id).run();

  const session = await createSession(env, 'player', id, now);
  await logAction(env, 'player', id, 'register', '', now);
  const player = await getPlayer(env, id);
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt, pin, player: summary(player, cfg) });
};

const login = async ({ env, body, device, now }) => {
  const display = String(body.display || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!display || !password || display.length > 40 || password.length > 128) return fail(400, 'login', sameMessage);

  const devKey = `login:${device}`;
  const acctKey = `loginacct:${display}`;
  for (const key of [devKey, acctKey]) {
    const lock = await limitCheck(env, key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS);
    if (!lock.ok) {
      const res = fail(429, 'slow-down', 'Too many tries. Please wait a little and try again.', { retryAfter: lock.retryAfter });
      res.headers.set('retry-after', String(lock.retryAfter));
      return res;
    }
  }

  const p = await env.DB.prepare('SELECT * FROM players WHERE display_lower = ?1').bind(display).first();
  const ok = p ? await verifyPassword(password, p.password_hash) : (await verifyPassword(password, await getDummyHash()), false);
  if (!ok) {
    await limitHit(env, devKey, LOGIN_WINDOW_MS);
    await limitHit(env, acctKey, LOGIN_WINDOW_MS);
    return fail(401, 'login', sameMessage);
  }
  await limitReset(env, acctKey);
  if (p.status === 'banned') return fail(403, 'banned', 'This account is no longer allowed on TikSpin.');

  const cfg = await readConfig(env);
  const session = await createSession(env, 'player', p.id, now);
  await env.DB.prepare('UPDATE players SET last_login_at = ?1 WHERE id = ?2').bind(now, p.id).run();
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt, player: summary(p, cfg) });
};

const logout = async ({ request, env }) => {
  await destroySession(env, request);
  return json({ ok: true });
};

// ---------------------------------------------------------------- the account page

const me = async ({ env, session, now }) => {
  const cfg = await readConfig(env);
  const p = await getPlayer(env, session.userId);
  const [profiles, follows, entries, removed] = await env.DB.batch([
    env.DB.prepare('SELECT game, handle, ml_user_id, ml_server_id FROM game_profiles WHERE player_id = ?1').bind(p.id),
    env.DB.prepare(
      `SELECT f.status, s.display_name, s.tiktok_username
         FROM follow_proofs f JOIN streamers s ON s.id = f.streamer_id WHERE f.player_id = ?1`
    ).bind(p.id),
    env.DB.prepare(
      `SELECT e.status, e.freeze_reason, g.game, g.status AS gstatus, s.display_name AS sname, s.status AS sstatus, s.wheel_code
         FROM entries e JOIN giveaways g ON g.id = e.giveaway_id JOIN streamers s ON s.id = g.streamer_id
        WHERE e.player_id = ?1 ORDER BY e.id DESC LIMIT 30`
    ).bind(p.id),
    env.DB.prepare(
      `SELECT d.reason, g.game, s.display_name AS sname
         FROM disqualified_entries d JOIN giveaways g ON g.id = d.giveaway_id JOIN streamers s ON s.id = g.streamer_id
        WHERE d.player_id = ?1 ORDER BY d.id DESC LIMIT 30`
    ).bind(p.id)
  ]);
  const giveaways = [
    ...entries.results.map((e) => ({
      game: e.game,
      streamer: e.sname,
      // on_wheel | on_hold | eliminated | winner
      state: e.status === 'alive' ? 'on_wheel' : e.status === 'frozen' ? 'on_hold' : e.status,
      holdReason: e.status === 'frozen' ? e.freeze_reason : '',
      finished: e.gstatus === 'ended',
      paused: e.sstatus !== 'approved',
      wheelCode: e.sstatus === 'approved' ? e.wheel_code : ''
    })),
    ...removed.results.map((d) => ({ game: d.game, streamer: d.sname, state: 'removed', holdReason: d.reason || '', finished: false, paused: false, wheelCode: '' }))
  ];
  return json({
    ok: true,
    player: summary(p, cfg),
    profiles: profiles.results.map((r) => ({ game: r.game, handle: r.handle, userId: r.ml_user_id, serverId: r.ml_server_id })),
    following: follows.results.map((f) => ({ streamer: f.display_name, tiktok: f.tiktok_username, status: f.status })),
    giveaways,
    contactEmail: cfg.email
  });
};

const acceptTerms = async ({ env, session, body, now }) => {
  const cfg = await readConfig(env);
  if (body.accept !== true) return fail(400, 'terms', 'You must accept the Terms and Conditions to continue.');
  await env.DB.prepare('UPDATE players SET terms_version = ?1, terms_accepted_at = ?2 WHERE id = ?3').bind(cfg.termsVersion, now, session.userId).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------- password, PIN, names

const changePassword = async ({ env, session, body, now }) => {
  const p = await getPlayer(env, session.userId);
  if (!(await verifyPassword(String(body.current || ''), p.password_hash))) return fail(401, 'password', 'Your current password is not correct.');
  const problem = passwordProblem(body.next);
  if (problem) return fail(400, 'password', problem);
  if (body.next === body.current) return fail(400, 'password', 'Choose a different password from the current one.');
  await env.DB.prepare('UPDATE players SET password_hash = ?1, must_change_password = 0 WHERE id = ?2')
    .bind(await hashPassword(String(body.next)), p.id).run();
  // Every device is signed out. This one gets a fresh session.
  await destroyUserSessions(env, 'player', p.id);
  const s = await createSession(env, 'player', p.id, now);
  await logAction(env, 'player', p.id, 'change-password', '', now);
  return json({ ok: true, token: s.token, expiresAt: s.expiresAt });
};

const newPinAction = async ({ env, session, body, now }) => {
  const p = await getPlayer(env, session.userId);
  if (!(await verifyPassword(String(body.password || ''), p.password_hash))) return fail(401, 'password', 'Your password is not correct.');
  const pin = newPin();
  await env.DB.prepare('UPDATE players SET pin_hash = ?1 WHERE id = ?2').bind(await hashPin(env, ownerKey(p.id), pin), p.id).run();
  await limitReset(env, pinLockKey(p.id));
  await logAction(env, 'player', p.id, 'new-pin', '', now);
  return json({ ok: true, pin });
};

// Shared by changetiktok and changedisplay: password + PIN + the waiting time.
async function verifyForChange(env, session, body, column, now) {
  const cfg = await readConfig(env);
  const p = await getPlayer(env, session.userId);
  const locked = await pinLocked(env, p.id);
  if (locked) return { error: locked };
  if (!(await verifyPassword(String(body.password || ''), p.password_hash)) || !(await checkPin(env, p, body.pin))) {
    return { error: fail(401, 'verify', 'Your password or PIN is not correct.') };
  }
  const last = p[column];
  if (last && last + cfg.changeDays * DAY_MS > now) {
    return { error: fail(429, 'cooldown', `You can change this once every ${cfg.changeDays} days.`, { nextAt: last + cfg.changeDays * DAY_MS }) };
  }
  return { p, cfg };
}

const changeTikTok = async ({ env, session, body, now }) => {
  const tiktok = cleanHandle(body.tiktok);
  if (!validTikTok(tiktok)) return fail(400, 'tiktok', 'Enter your TikTok username (letters, numbers, dots and underscores).');
  const v = await verifyForChange(env, session, body, 'tiktok_changed_at', now);
  if (v.error) return v.error;
  const { p } = v;
  const tl = tiktok.toLowerCase();
  if (tl === p.tiktok_lower) return fail(400, 'same', 'That is already your TikTok username.');
  if (await findBan(env, [['tiktok', tl]])) return fail(403, 'banned', 'That TikTok username is not allowed on TikSpin.');
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO player_tiktok_history (player_id, old_username, old_lower, changed_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(p.id, p.tiktok_username, p.tiktok_lower, now),
      env.DB.prepare('UPDATE players SET tiktok_username = ?1, tiktok_lower = ?2, tiktok_changed_at = ?3 WHERE id = ?4')
        .bind(tiktok, tl, now, p.id)
    ]);
  } catch (err) {
    if (uniqueColumn(err)) return fail(409, 'tiktok-taken', 'That TikTok username is already linked to another account.');
    throw err;
  }
  await limitReset(env, pinLockKey(p.id));
  await logAction(env, 'player', p.id, 'change-tiktok', '', now);
  // Entries point at the account, so every giveaway already shows the new name.
  return json({ ok: true, tiktok, nextChangeAt: now + v.cfg.changeDays * DAY_MS });
};

const changeDisplay = async ({ env, session, body, now }) => {
  const display = String(body.display || '').trim();
  if (!validDisplayName(display) || reservedName(display)) return fail(400, 'display', 'Display username: 3-20 letters, numbers or underscores, and not a reserved name.');
  const v = await verifyForChange(env, session, body, 'display_changed_at', now);
  if (v.error) return v.error;
  const { p } = v;
  const dl = display.toLowerCase();
  if (dl === p.display_lower && display === p.display_name) return fail(400, 'same', 'That is already your display username.');
  if (await findBan(env, [['display', dl]])) return fail(403, 'banned', 'That display username is not allowed.');
  try {
    await env.DB.prepare('UPDATE players SET display_name = ?1, display_lower = ?2, display_changed_at = ?3 WHERE id = ?4')
      .bind(display, dl, now, p.id).run();
  } catch (err) {
    if (uniqueColumn(err)) return fail(409, 'display-taken', 'That display username is already taken.');
    throw err;
  }
  await limitReset(env, pinLockKey(p.id));
  await logAction(env, 'player', p.id, 'change-display', '', now);
  return json({ ok: true, display, nextChangeAt: now + v.cfg.changeDays * DAY_MS });
};

// ---------------------------------------------------------------- recovery (no login)

// Forgot the password: display username + TikTok @username + the 6-digit PIN. Answers are deliberately vague.
const recover = async ({ env, body, now }) => {
  const display = String(body.display || '').trim().toLowerCase();
  const tl = cleanHandle(body.tiktok).toLowerCase();
  const problem = passwordProblem(body.password);
  if (problem) return fail(400, 'password', problem);
  const p = display ? await env.DB.prepare('SELECT * FROM players WHERE display_lower = ?1').bind(display).first() : null;
  if (!p) {
    await getDummyHash();
    return fail(401, 'recover', sameMessage);
  }
  const locked = await pinLocked(env, p.id);
  if (locked) return locked;
  const pinOk = await checkPin(env, p, body.pin);
  if (!pinOk || p.tiktok_lower !== tl) {
    if (pinOk) await limitHit(env, pinLockKey(p.id), PIN_LOCK_MS); // right PIN, wrong TikTok: still counts
    return fail(401, 'recover', sameMessage);
  }
  const pin = newPin();
  await env.DB.prepare('UPDATE players SET password_hash = ?1, pin_hash = ?2, must_change_password = 0 WHERE id = ?3')
    .bind(await hashPassword(String(body.password)), await hashPin(env, ownerKey(p.id), pin), p.id).run();
  await destroyUserSessions(env, 'player', p.id);
  await limitReset(env, pinLockKey(p.id));
  await limitReset(env, `loginacct:${p.display_lower}`);
  await logAction(env, 'player', p.id, 'recover-password', '', now);
  return json({ ok: true, pin });   // the old PIN is now dead; this one is shown once
};

// Lost the PIN: creates a request code the person emails to the operator. Anyone can ask for any display username,
// so the reply never contains anything private about the account, and unknown names get a code that looks the same.
const pinRequest = async ({ env, body, now }) => {
  const display = String(body.display || '').trim().toLowerCase();
  const cfg = await readConfig(env);
  const p = display && display.length <= 40
    ? await env.DB.prepare('SELECT id, display_name FROM players WHERE display_lower = ?1').bind(display).first()
    : null;
  const shown = p ? p.display_name : String(body.display || '').trim().slice(0, 20);
  let code = `RS-${randomCode(4)}`;
  let expiresAt = now + RESET_REQUEST_TTL_MS;

  if (p) {
    await env.DB.prepare("UPDATE reset_requests SET status = 'cancelled' WHERE account_kind = 'player' AND account_id = ?1 AND status = 'open' AND expires_at <= ?2")
      .bind(p.id, now).run();
    const open = await env.DB.prepare("SELECT request_code, expires_at FROM reset_requests WHERE account_kind = 'player' AND account_id = ?1 AND status = 'open'")
      .bind(p.id).first();
    if (open) {
      code = open.request_code;
      expiresAt = open.expires_at;
    } else {
      for (let i = 0; i < 5; i++) {
        try {
          await env.DB.prepare('INSERT INTO reset_requests (account_kind, account_id, request_code, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind('player', p.id, code, now, expiresAt).run();
          break;
        } catch (err) {
          if (!String(err && err.message).includes('UNIQUE') || i === 4) throw err;
          code = `RS-${randomCode(4)}`;
        }
      }
    }
  }
  return json({
    ok: true,
    code,
    expiresAt,
    email: cfg.email,
    mail: {
      subject: `TikSpin account help ${code}`,
      body: `Request code: ${code}\nDisplay username: ${shown}\nTikTok @username: (write yours here)\nI lost my recovery PIN.\n(Attach a screenshot of your TikTok profile showing the request code in your bio.)`
    }
  });
};

// ---------------------------------------------------------------- entering a giveaway

const ML_IGN = (s) => {
  const t = cleanLine(s, 40);
  return t.length >= 3 && t.length <= 24 ? t : '';
};

// Identity fields can never be turned off by a streamer. Returns { profile } or { error }.
const readProfile = (game, fields) => {
  const f = fields && typeof fields === 'object' ? fields : {};
  if (game === 'roblox') {
    const handle = String(f.roblox_username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(handle)) return { error: 'Enter your Roblox username (3-20 letters, numbers or underscores).' };
    return { profile: { handle, userId: '', serverId: '' } };
  }
  const ign = ML_IGN(f.ign);
  const userId = String(f.user_id || '').trim();
  const serverId = String(f.server_id || '').trim();
  if (!ign) return { error: 'Enter your Mobile Legends IGN (3-24 characters).' };
  if (!/^\d{5,12}$/.test(userId)) return { error: 'Your User ID should be 5-12 digits (numbers only).' };
  if (!/^\d{3,6}$/.test(serverId)) return { error: 'Your Server ID should be 3-6 digits (numbers only).' };
  return { profile: { handle: ign, userId, serverId } };
};

const parseRequirements = (text) => {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const normCode = (s) => String(s || '').replace(/[\s-]+/g, '').toUpperCase();

const findGiveaway = (env, code, now) =>
  /^[A-Z0-9]{6,20}$/.test(code)
    ? env.DB.prepare(
        `SELECT g.id, g.streamer_id, g.game, g.requirements, s.display_name AS streamer_name, s.tiktok_username AS streamer_tiktok
           FROM giveaways g JOIN streamers s ON s.id = g.streamer_id
          WHERE g.code = ?1 AND g.status = 'open' AND g.code_revoked_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at > ?2) AND s.status = 'approved'`
      ).bind(code, now).first()
    : Promise.resolve(null);

const saveProfile = (env, playerId, game, profile, now) =>
  env.DB.prepare(
    `INSERT INTO game_profiles (player_id, game, handle, handle_lower, ml_user_id, ml_server_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(player_id, game) DO UPDATE SET handle = excluded.handle, handle_lower = excluded.handle_lower,
       ml_user_id = excluded.ml_user_id, ml_server_id = excluded.ml_server_id, updated_at = excluded.updated_at`
  ).bind(playerId, game, profile.handle, profile.handle.toLowerCase(), profile.userId, profile.serverId, now).run();

// Everything that must be true before an entry or an application. Returns { error } or the loaded pieces.
async function prepareEntry(env, session, body, now) {
  const cfg = await readConfig(env);
  const player = await getPlayer(env, session.userId);
  if (player.terms_version !== cfg.termsVersion) {
    return { error: fail(403, 'terms', 'Please accept the updated Terms and Conditions first.') };
  }
  const g = await findGiveaway(env, normCode(body.code), now);
  if (!g) return { error: fail(404, 'invalid-code', 'That code is not valid. Check it for typos, or the giveaway may be closed.') };

  const read = readProfile(g.game, body.fields);
  if (read.error) return { error: fail(400, 'fields', read.error) };

  const hostBan = await env.DB.prepare('SELECT 1 AS hit FROM streamer_bans WHERE streamer_id = ?1 AND player_id = ?2').bind(g.streamer_id, player.id).first();
  if (hostBan) return { error: fail(403, 'host-ban', 'The host has removed you from their giveaways.') };
  const already = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM entries WHERE giveaway_id = ?1 AND player_id = ?2)
          + (SELECT COUNT(*) FROM disqualified_entries WHERE giveaway_id = ?1 AND player_id = ?2) AS n`
  ).bind(g.id, player.id).first();
  if (already && already.n > 0) return { error: fail(409, 'entered', 'You already have an entry in this giveaway.') };

  if (await findBan(env, await banPairsFor(env, player, g.game, read.profile))) {
    return { error: fail(403, 'banned', 'This account is not allowed to enter.') };
  }
  const needsProof = parseRequirements(g.requirements).includes('follow_proof');
  const proof = needsProof
    ? await env.DB.prepare('SELECT status FROM follow_proofs WHERE player_id = ?1 AND streamer_id = ?2').bind(player.id, g.streamer_id).first()
    : null;
  return { cfg, player, g, profile: read.profile, needsProof, proof };
}

const entryReply = (res) =>
  res.ok
    ? json({ ok: true, status: res.status, message: res.status === 'frozen' ? 'Your entry is on hold. The host will review it.' : "You're on the wheel!" })
    : fail(409, res.code, res.error);

const enter = async ({ env, session, body, device, now }) => {
  const prep = await prepareEntry(env, session, body, now);
  if (prep.error) return prep.error;
  const { player, g, profile, needsProof, proof } = prep;

  let source = 'no-proof';
  if (needsProof) {
    if (proof && proof.status === 'approved') {
      source = 'saved-proof';
    } else if (proof && proof.status === 'pending') {
      return fail(409, 'pending', 'You already have an application waiting for the host.');
    } else if (proof && proof.status === 'rejected') {
      return fail(403, 'proof-rejected', 'The host did not accept your earlier proof. You can send a new screenshot for review.', { canApply: true });
    } else {
      const failed = checkFollowText(cleanOcr(body.ocrText), { name: g.streamer_name, username: g.streamer_tiktok });
      if (failed) return fail(422, failed.code, failed.error, { canApply: true });
      await env.DB.prepare(
        `INSERT INTO follow_proofs (player_id, streamer_id, giveaway_id, method, status, device_hash, created_at, decided_at)
         VALUES (?1, ?2, ?3, 'scan', 'approved', ?4, ?5, ?5)
         ON CONFLICT(player_id, streamer_id) DO NOTHING`
      ).bind(player.id, g.streamer_id, g.id, device, now).run();
      source = 'scan';
    }
  }
  await saveProfile(env, player.id, g.game, profile, now);
  const res = await enrollPlayer(env, g, player, profile, { source, device, now });
  if (res.ok) await logAction(env, 'player', player.id, 'enter', `giveaway ${g.id}`, now);
  return entryReply(res);
};

// The scan could not confirm the follow, so the screenshot goes to the streamer. The entry is made when the
// streamer approves it. The screenshot is deleted once the streamer decides.
const apply = async ({ env, session, body, device, now }) => {
  const prep = await prepareEntry(env, session, body, now);
  if (prep.error) return prep.error;
  const { player, g, profile, needsProof, proof } = prep;
  if (!needsProof) return fail(400, 'not-needed', 'This giveaway does not ask for a follow screenshot.');
  if (proof && proof.status === 'approved') return fail(400, 'not-needed', 'You already have an approved follow proof for this streamer. Just enter.');
  if (proof && proof.status === 'pending') return fail(409, 'pending', 'You already have an application waiting for the host.');

  const shot = String(body.screenshot || '');
  if (shot.length > MAX_SHOT_CHARS || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot)) {
    return fail(400, 'screenshot', 'The screenshot is missing or too large.');
  }
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM follow_proofs WHERE streamer_id = ?1 AND status = 'pending'").bind(g.streamer_id).first();
  if (waiting && waiting.n >= MAX_PENDING_PER_STREAMER) {
    return fail(429, 'busy', 'This host has too many applications waiting. Please try again in a few minutes.');
  }
  await saveProfile(env, player.id, g.game, profile, now);
  await env.DB.prepare(
    `INSERT INTO follow_proofs (player_id, streamer_id, giveaway_id, method, status, note, reason, ocr_excerpt, screenshot, device_hash, created_at)
     VALUES (?1, ?2, ?3, 'manual', 'pending', ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(player_id, streamer_id) DO UPDATE SET giveaway_id = excluded.giveaway_id, method = 'manual', status = 'pending',
       note = excluded.note, reason = excluded.reason, ocr_excerpt = excluded.ocr_excerpt, screenshot = excluded.screenshot,
       device_hash = excluded.device_hash, reject_reason = NULL, created_at = excluded.created_at, decided_at = NULL`
  ).bind(player.id, g.streamer_id, g.id, cleanLine(body.note, 300), cleanLine(body.reason, 200), cleanOcr(body.ocrText).slice(0, 600), shot, device, now).run();
  await logAction(env, 'player', player.id, 'apply', `giveaway ${g.id}`, now);
  return json({ ok: true, status: 'pending' });
};

// Where is my follow proof for this giveaway's streamer, and am I entered yet?
const applyStatus = async ({ env, session, url, now }) => {
  const g = await findGiveaway(env, normCode(url.searchParams.get('code')), now);
  if (!g) return fail(404, 'invalid-code', 'That code is not valid. Check it for typos, or the giveaway may be closed.');
  const [proof, entry] = await env.DB.batch([
    env.DB.prepare('SELECT status, reject_reason FROM follow_proofs WHERE player_id = ?1 AND streamer_id = ?2').bind(session.userId, g.streamer_id),
    env.DB.prepare('SELECT status FROM entries WHERE player_id = ?1 AND giveaway_id = ?2').bind(session.userId, g.id)
  ]);
  const p = proof.results[0];
  return json({ ok: true, proof: p ? p.status : 'none', reason: p && p.reject_reason ? p.reject_reason : '', entered: entry.results.length > 0 });
};

// ---------------------------------------------------------------- action table (read by index.js)

export const actions = {
  register: { auth: 'none', h: register, limit: { key: 'register', max: 5, windowMs: 60 * 60 * 1000 } },
  login: { auth: 'none', h: login, maxBody: 1000 },
  recover: { auth: 'none', h: recover, maxBody: 1000, limit: { key: 'recover', max: 10, windowMs: 60 * 60 * 1000 } },
  pinrequest: { auth: 'none', h: pinRequest, maxBody: 500, limit: { key: 'pinrequest', max: 5, windowMs: 60 * 60 * 1000 } },

  me: { method: 'GET', h: me },
  logout: { h: logout },
  acceptterms: { h: acceptTerms },
  changepassword: { h: changePassword, maxBody: 1000, limit: { key: 'pwchange', max: 10, windowMs: 60 * 60 * 1000, by: 'session' } },
  newpin: { h: newPinAction, maxBody: 500, limit: { key: 'newpin', max: 5, windowMs: 60 * 60 * 1000, by: 'session' } },
  changetiktok: { h: changeTikTok, maxBody: 1000 },
  changedisplay: { h: changeDisplay, maxBody: 1000 },
  enter: { h: enter, maxBody: 4000, limit: { key: 'enter', max: 20, windowMs: 10 * 60 * 1000, by: 'session' } },
  apply: { h: apply, maxBody: MAX_APPLY_BODY, limit: { key: 'apply', max: 5, windowMs: 10 * 60 * 1000, by: 'session' } },
  applystatus: { method: 'GET', h: applyStatus }
};
