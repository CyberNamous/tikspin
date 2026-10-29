// TikSpin - streamer routes. Reached as /api/streamer/<action>.
//
//   No login needed:       register (needs an invitation), login, recover, pinrequest
//   Allowed while pending: me, logout, changepassword, newpin, acceptterms
//   Approved only:         generate, current, manage, spin, entry, proofs, proofimage, proofdecision,
//                          schedule, report, log
//
// index.js already blocks pending / suspended / rejected streamers from everything that is not marked
// allowPending, so the handlers below only ever run for the streamer's own, approved account.
// Every query is scoped by the streamer's id, so one streamer can never read or change another's data.
//
// The platform only provides the tools. Follow checks, device badges, disqualifications and name conflicts are the
// streamer's call, and nothing here decides them automatically.

import {
  json, cleanLine, cleanHandle, validTikTok, passwordProblem, sha256Hex,
  hashPassword, verifyPassword, hashPin, verifyPin, newPin, randomCode,
  createSession, destroySession, destroyUserSessions,
  limitCheck, limitHit, limitReset, logAction, turnstileOk
} from '../lib/core.js';
import { enrollPlayer } from '../lib/enroll.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = DAY_MS;
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SPIN_LOCK_MS = 15000;
const RESET_REQUEST_TTL_MS = DAY_MS;
const MAX_SHOT_CHARS = 450000;
const MAX_REPORT_BODY = 520000;
const MAX_SCHEDULED = 3;
const MAX_DAYS_AHEAD = 30;
const REPORT_CATEGORIES = new Set(['fake-account', 'duplicate-accounts', 'abuse', 'other']);
const FOLLOW_TAGS = new Set(['unchecked', 'confirmed', 'not_found']);

const PENDING_MESSAGE = 'Request is being processed. If no progress is made within 24 hours, contact the operator.';
const sameMessage = 'Those details do not match.';

const fail = (status, code, error, extra) => json({ ok: false, code, error, ...(extra || {}) }, status);
const ownerKey = (id) => `s:${id}`;
const pinLockKey = (id) => `spin:${id}`;

let dummyHash = null;
const getDummyHash = () => (dummyHash ||= hashPassword('not-a-real-password-for-timing'));

const readConfig = async (env) => {
  const { results } = await env.DB.prepare('SELECT key, value FROM system_config').all();
  const c = {};
  for (const r of results) c[r.key] = r.value;
  return { email: c.contact_email || '', termsVersion: c.terms_streamer_version || '1' };
};

const getStreamer = (env, id) => env.DB.prepare('SELECT * FROM streamers WHERE id = ?1').bind(id).first();

const summary = (s, cfg) => ({
  display: s.display_name,
  tiktok: s.tiktok_username,
  status: s.status,
  message: s.status === 'pending' ? PENDING_MESSAGE : s.status_note || '',
  mustChangePassword: !!s.must_change_password,
  needsTerms: s.terms_version !== cfg.termsVersion,
  wheelCode: s.wheel_code
});

const pinLocked = async (env, id) => {
  const lock = await limitCheck(env, pinLockKey(id), PIN_MAX_FAILS, PIN_LOCK_MS);
  if (lock.ok) return null;
  const hours = Math.max(1, Math.ceil(lock.retryAfter / 3600));
  return fail(429, 'pin-locked', `Too many wrong PIN tries. This is locked for about ${hours} more hour(s). Email the operator if you need help.`, { retryAfter: lock.retryAfter });
};

const tooManyLogins = (lock) => {
  const res = fail(429, 'slow-down', 'Too many tries. Please wait a little and try again.', { retryAfter: lock.retryAfter });
  res.headers.set('retry-after', String(lock.retryAfter));
  return res;
};

// ---------------------------------------------------------------- invitation, sign-up, login

const register = async ({ request, env, body, device, now }) => {
  // Checked first, so a missing secret can never leave a half-made account behind.
  if (!env.PIN_PEPPER) return fail(503, 'setup', 'TikSpin is not fully set up yet. The operator needs to finish setup.');
  if (!(await turnstileOk(env, body.ts, request))) return fail(400, 'check-failed', 'The bot check did not pass. Please try again.');
  if (body.terms !== true) return fail(400, 'terms', 'You must accept the Streamer Terms and the Global Terms to register.');

  const display = cleanLine(body.display, 40);
  const tiktok = cleanHandle(body.tiktok);
  if (display.length < 2) return fail(400, 'display', 'Enter your TikTok display name exactly as it appears on your profile.');
  if (!validTikTok(tiktok)) return fail(400, 'tiktok', 'Enter your TikTok username (letters, numbers, dots and underscores).');
  const problem = passwordProblem(body.password);
  if (problem) return fail(400, 'password', problem);

  const failKey = `invfail:${device}`;
  const lock = await limitCheck(env, failKey, 10, LOGIN_WINDOW_MS);
  if (!lock.ok) return tooManyLogins(lock);

  const tl = tiktok.toLowerCase();
  const invite = await env.DB.prepare('SELECT id, for_tiktok_lower FROM invitations WHERE token_hash = ?1')
    .bind(await sha256Hex(String(body.invite || ''))).first();
  if (!invite) {
    await limitHit(env, failKey, LOGIN_WINDOW_MS);
    return fail(403, 'invite', 'This invitation link is not valid, was already used, or has expired.');
  }
  if (invite.for_tiktok_lower && invite.for_tiktok_lower !== tl) {
    return fail(403, 'invite-name', 'This invitation was made for a different TikTok username.');
  }
  // Claim the invitation first. Only one request can win, so a link can never be used twice.
  const claim = await env.DB.prepare(
    'UPDATE invitations SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1'
  ).bind(now, invite.id).run();
  if (claim.meta.changes !== 1) {
    await limitHit(env, failKey, LOGIN_WINDOW_MS);
    return fail(403, 'invite', 'This invitation link is not valid, was already used, or has expired.');
  }

  const cfg = await readConfig(env);
  const pin = newPin();
  let id;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO streamers (tiktok_username, tiktok_lower, display_name, password_hash, pin_hash, status, wheel_code,
                              invite_id, terms_version, terms_accepted_at, created_at)
       VALUES (?1, ?2, ?3, ?4, '', 'pending', ?5, ?6, ?7, ?8, ?8)`
    ).bind(tiktok, tl, display, await hashPassword(String(body.password)), randomCode(12), invite.id, cfg.termsVersion, now).run();
    id = r.meta.last_row_id;
  } catch (err) {
    await env.DB.prepare('UPDATE invitations SET used_at = NULL WHERE id = ?1').bind(invite.id).run();   // give the link back
    if (String(err && err.message).includes('UNIQUE')) return fail(409, 'tiktok-taken', 'That TikTok username is already registered.');
    throw err;
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE streamers SET pin_hash = ?1 WHERE id = ?2').bind(await hashPin(env, ownerKey(id), pin), id),
    env.DB.prepare('UPDATE invitations SET used_by_streamer_id = ?1 WHERE id = ?2').bind(id, invite.id),
    env.DB.prepare('INSERT INTO live_alerts (streamer_id, message, created_at) VALUES (NULL, ?1, ?2)')
      .bind(`New streamer request: ${display} (@${tiktok})`, now)
  ]);
  const session = await createSession(env, 'streamer', id, now);
  await logAction(env, 'streamer', id, 'register', '', now);
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt, pin, streamer: summary(await getStreamer(env, id), cfg) });
};

const login = async ({ env, body, device, now }) => {
  const tl = cleanHandle(body.tiktok).toLowerCase();
  const password = String(body.password || '');
  if (!tl || !password || tl.length > 40 || password.length > 128) return fail(400, 'login', sameMessage);

  const devKey = `slogin:${device}`;
  const acctKey = `sloginacct:${tl}`;
  for (const key of [devKey, acctKey]) {
    const lock = await limitCheck(env, key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS);
    if (!lock.ok) return tooManyLogins(lock);
  }
  const s = await env.DB.prepare('SELECT * FROM streamers WHERE tiktok_lower = ?1').bind(tl).first();
  const ok = s ? await verifyPassword(password, s.password_hash) : (await verifyPassword(password, await getDummyHash()), false);
  if (!ok) {
    await limitHit(env, devKey, LOGIN_WINDOW_MS);
    await limitHit(env, acctKey, LOGIN_WINDOW_MS);
    return fail(401, 'login', sameMessage);
  }
  await limitReset(env, acctKey);

  // Every status may log in, so the page can show the right message (pending, under review, not approved).
  const cfg = await readConfig(env);
  const session = await createSession(env, 'streamer', s.id, now);
  await env.DB.prepare('UPDATE streamers SET last_login_at = ?1 WHERE id = ?2').bind(now, s.id).run();
  await logAction(env, 'streamer', s.id, 'login', '', now);
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt, streamer: summary(s, cfg) });
};

const logout = async ({ request, env }) => {
  await destroySession(env, request);
  return json({ ok: true });
};

const me = async ({ env, session }) => {
  const cfg = await readConfig(env);
  return json({ ok: true, streamer: summary(await getStreamer(env, session.userId), cfg), contactEmail: cfg.email });
};

const acceptTerms = async ({ env, session, body, now }) => {
  const cfg = await readConfig(env);
  if (body.accept !== true) return fail(400, 'terms', 'You must accept the terms to continue.');
  await env.DB.prepare('UPDATE streamers SET terms_version = ?1, terms_accepted_at = ?2 WHERE id = ?3').bind(cfg.termsVersion, now, session.userId).run();
  return json({ ok: true });
};

const changePassword = async ({ env, session, body, now }) => {
  const s = await getStreamer(env, session.userId);
  if (!(await verifyPassword(String(body.current || ''), s.password_hash))) return fail(401, 'password', 'Your current password is not correct.');
  const problem = passwordProblem(body.next);
  if (problem) return fail(400, 'password', problem);
  if (body.next === body.current) return fail(400, 'password', 'Choose a different password from the current one.');
  await env.DB.prepare('UPDATE streamers SET password_hash = ?1, must_change_password = 0 WHERE id = ?2')
    .bind(await hashPassword(String(body.next)), s.id).run();
  await destroyUserSessions(env, 'streamer', s.id);
  const fresh = await createSession(env, 'streamer', s.id, now);
  await logAction(env, 'streamer', s.id, 'change-password', '', now);
  return json({ ok: true, token: fresh.token, expiresAt: fresh.expiresAt });
};

const newPinAction = async ({ env, session, body, now }) => {
  const s = await getStreamer(env, session.userId);
  if (!(await verifyPassword(String(body.password || ''), s.password_hash))) return fail(401, 'password', 'Your password is not correct.');
  const pin = newPin();
  await env.DB.prepare('UPDATE streamers SET pin_hash = ?1 WHERE id = ?2').bind(await hashPin(env, ownerKey(s.id), pin), s.id).run();
  await limitReset(env, pinLockKey(s.id));
  await logAction(env, 'streamer', s.id, 'new-pin', '', now);
  return json({ ok: true, pin });
};

// Forgot the password: TikTok username + the 6-digit PIN. A takeover is handled differently: the owner deletes
// the hacked account and the streamer registers again.
const recover = async ({ env, body, now }) => {
  const tl = cleanHandle(body.tiktok).toLowerCase();
  const problem = passwordProblem(body.password);
  if (problem) return fail(400, 'password', problem);
  const s = tl ? await env.DB.prepare('SELECT * FROM streamers WHERE tiktok_lower = ?1').bind(tl).first() : null;
  if (!s) {
    await getDummyHash();
    return fail(401, 'recover', sameMessage);
  }
  const locked = await pinLocked(env, s.id);
  if (locked) return locked;
  if (!(await verifyPin(env, ownerKey(s.id), body.pin, s.pin_hash))) {
    await limitHit(env, pinLockKey(s.id), PIN_LOCK_MS);
    return fail(401, 'recover', sameMessage);
  }
  const pin = newPin();
  await env.DB.prepare('UPDATE streamers SET password_hash = ?1, pin_hash = ?2, must_change_password = 0 WHERE id = ?3')
    .bind(await hashPassword(String(body.password)), await hashPin(env, ownerKey(s.id), pin), s.id).run();
  await destroyUserSessions(env, 'streamer', s.id);
  await limitReset(env, pinLockKey(s.id));
  await limitReset(env, `sloginacct:${s.tiktok_lower}`);
  await logAction(env, 'streamer', s.id, 'recover-password', '', now);
  return json({ ok: true, pin });
};

// Lost PIN or password and no way back in: a request code to email to the operator, who checks it by hand.
const pinRequest = async ({ env, body, now }) => {
  const tl = cleanHandle(body.tiktok).toLowerCase();
  const cfg = await readConfig(env);
  const s = tl && tl.length <= 40 ? await env.DB.prepare('SELECT id, tiktok_username FROM streamers WHERE tiktok_lower = ?1').bind(tl).first() : null;
  let code = `RS-${randomCode(4)}`;
  let expiresAt = now + RESET_REQUEST_TTL_MS;
  if (s) {
    await env.DB.prepare("UPDATE reset_requests SET status = 'cancelled' WHERE account_kind = 'streamer' AND account_id = ?1 AND status = 'open' AND expires_at <= ?2").bind(s.id, now).run();
    const open = await env.DB.prepare("SELECT request_code, expires_at FROM reset_requests WHERE account_kind = 'streamer' AND account_id = ?1 AND status = 'open'").bind(s.id).first();
    if (open) {
      code = open.request_code;
      expiresAt = open.expires_at;
    } else {
      for (let i = 0; i < 5; i++) {
        try {
          await env.DB.prepare('INSERT INTO reset_requests (account_kind, account_id, request_code, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind('streamer', s.id, code, now, expiresAt).run();
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
      subject: `TikSpin streamer account help ${code}`,
      body: `Request code: ${code}\nTikTok username: ${cleanHandle(body.tiktok).slice(0, 30)}\nI need help getting back into my streamer account.\n(Put the request code in your TikTok bio for a short while and attach a screenshot of your profile.)`
    }
  });
};

// ---------------------------------------------------------------- giveaways

// The streamer's current giveaway: running (open/closed), or the latest one if it ended.
const latestGiveaway = (env, streamerId) =>
  env.DB.prepare('SELECT * FROM giveaways WHERE streamer_id = ?1 ORDER BY id DESC LIMIT 1').bind(streamerId).first();

const runningGiveaway = (env, streamerId) =>
  env.DB.prepare("SELECT * FROM giveaways WHERE streamer_id = ?1 AND status IN ('open', 'closed') LIMIT 1").bind(streamerId).first();

const parseList = (text) => {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

// The identity fields of each game are fixed. A streamer only chooses whether a follow screenshot is needed.
const BASE_REQUIREMENTS = { roblox: ['roblox_username'], ml: ['ign', 'user_id', 'server_id'] };

const generate = async ({ env, session, body, now }) => {
  const game = String(body.game || '');
  if (!BASE_REQUIREMENTS[game]) return fail(400, 'game', 'Choose Roblox or Mobile Legends.');
  const requirements = [...BASE_REQUIREMENTS[game], ...(body.followProof === false ? [] : ['follow_proof'])];

  let expiresAt = null;
  if (body.minutes !== undefined && body.minutes !== null && body.minutes !== '') {
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 7 * 24 * 60) return fail(400, 'minutes', 'The entry deadline must be between 5 minutes and 7 days.');
    expiresAt = now + minutes * 60 * 1000;
  }
  let scheduled = null;
  if (body.scheduledId) {
    scheduled = await env.DB.prepare('SELECT id FROM scheduled_giveaways WHERE id = ?1 AND streamer_id = ?2 AND giveaway_id IS NULL')
      .bind(Number(body.scheduledId), session.userId).first();
    if (!scheduled) return fail(404, 'scheduled', 'That scheduled giveaway no longer exists.');
  }

  let id = 0;
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = randomCode(10);
    try {
      const r = await env.DB.prepare(
        `INSERT INTO giveaways (streamer_id, game, requirements, code, status, show_on_home, opened_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7)`
      ).bind(session.userId, game, JSON.stringify(requirements), code, body.showOnHome === true ? 1 : 0, now, expiresAt).run();
      id = r.meta.last_row_id;
      break;
    } catch (err) {
      const msg = String(err && err.message);
      if (msg.includes('one_running_giveaway') || msg.includes('giveaways.streamer_id')) {
        return fail(409, 'running', 'You already have a giveaway running. End or delete it before making a new link.');
      }
      if (!msg.includes('UNIQUE') || i === 4) throw err;   // a code clash: try another code
    }
  }
  if (scheduled) await env.DB.prepare('UPDATE scheduled_giveaways SET giveaway_id = ?1 WHERE id = ?2').bind(id, scheduled.id).run();
  await logAction(env, 'streamer', session.userId, 'generate-link', `${game} giveaway ${id}`, now);
  return json({ ok: true, giveaway: { id, game, code, path: `/join/${code}`, requirements, expiresAt } });
};

// Everything the panel needs in one go.
const current = async ({ env, session, now }) => {
  const sid = session.userId;
  const g = await latestGiveaway(env, sid);
  const [scheduled, bans] = await env.DB.batch([
    env.DB.prepare('SELECT id, game, starts_at, note, show_on_home, hidden_by_owner FROM scheduled_giveaways WHERE streamer_id = ?1 AND giveaway_id IS NULL ORDER BY starts_at ASC').bind(sid),
    env.DB.prepare('SELECT b.player_id, b.reason, p.display_name FROM streamer_bans b JOIN players p ON p.id = b.player_id WHERE b.streamer_id = ?1 ORDER BY b.id DESC LIMIT 200').bind(sid)
  ]);
  const extra = {
    scheduled: scheduled.results.map((c) => ({ id: c.id, game: c.game, startsAt: c.starts_at, note: c.note || '', showOnHome: !!c.show_on_home, hiddenByOwner: !!c.hidden_by_owner })),
    bans: bans.results.map((b) => ({ playerId: b.player_id, name: b.display_name, reason: b.reason || '' }))
  };
  if (!g) return json({ ok: true, giveaway: null, entries: [], disqualified: [], pendingProofs: 0, ...extra });

  const [entries, disq, proofs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT e.id, e.player_id, e.game_handle, e.ml_user_id, e.ml_server_id, e.identity_key, e.status, e.freeze_reason,
              e.follow_tag, e.source, e.device_hash, e.created_at, p.display_name, p.tiktok_username, p.tiktok_changed_at
         FROM entries e JOIN players p ON p.id = e.player_id WHERE e.giveaway_id = ?1 ORDER BY e.id ASC LIMIT 1000`
    ).bind(g.id),
    env.DB.prepare('SELECT id, player_id, display_name, tiktok_username, game_handle, reason, disqualified_at FROM disqualified_entries WHERE giveaway_id = ?1 ORDER BY id DESC LIMIT 200').bind(g.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM follow_proofs WHERE streamer_id = ?1 AND status = 'pending'").bind(sid)
  ]);

  // Device badges: names of other entries that came from the same device. A hint for the streamer, never a block.
  const byDevice = new Map();
  for (const e of entries.results) {
    if (!e.device_hash) continue;
    if (!byDevice.has(e.device_hash)) byDevice.set(e.device_hash, []);
    byDevice.get(e.device_hash).push(e.display_name);
  }
  const counts = { alive: 0, frozen: 0, eliminated: 0, winner: 0, total: entries.results.length };
  const list = entries.results.map((e) => {
    counts[e.status] = (counts[e.status] || 0) + 1;
    const same = e.device_hash ? byDevice.get(e.device_hash).filter((n) => n !== e.display_name) : [];
    return {
      id: e.id, playerId: e.player_id, name: e.display_name, tiktok: e.tiktok_username,
      tiktokChangedAt: e.tiktok_changed_at || 0, handle: e.game_handle, mlUserId: e.ml_user_id, mlServerId: e.ml_server_id,
      identity: e.identity_key, status: e.status, freezeReason: e.freeze_reason || '', followTag: e.follow_tag,
      source: e.source, sameDevice: same, joinedAt: e.created_at
    };
  });
  const requirements = parseList(g.requirements);
  return json({
    ok: true,
    giveaway: {
      id: g.id, game: g.game, code: g.code, path: `/join/${g.code}`, status: g.status, codeRevoked: !!g.code_revoked_at,
      showOnHome: !!g.show_on_home, hiddenByOwner: !!g.hidden_by_owner, openedAt: g.opened_at, expiresAt: g.expires_at || null,
      requirements, followProof: requirements.includes('follow_proof'),
      spin: { id: g.spin_id, command: g.wheel_command, landed: g.last_landed, out: parseList(g.out_list) },
      counts
    },
    entries: list,
    disqualified: disq.results.map((d) => ({ id: d.id, playerId: d.player_id, name: d.display_name, tiktok: d.tiktok_username, handle: d.game_handle, reason: d.reason || '', at: d.disqualified_at })),
    pendingProofs: proofs.results[0] ? proofs.results[0].n : 0,
    ...extra
  });
};

// op: close | reopen | revoke | end | delete | home-on | home-off
const manage = async ({ env, session, body, now }) => {
  const sid = session.userId;
  const g = await latestGiveaway(env, sid);
  if (!g) return fail(404, 'none', 'You do not have a giveaway.');
  const op = String(body.op || '');

  if (op === 'delete') {
    // Entries and disqualifications go with it. Reports already filed keep their own copy of the evidence.
    await env.DB.prepare('DELETE FROM giveaways WHERE id = ?1 AND streamer_id = ?2').bind(g.id, sid).run();
    await logAction(env, 'streamer', sid, 'delete-giveaway', `giveaway ${g.id}`, now);
    return json({ ok: true });
  }
  if (g.status === 'ended') return fail(409, 'ended', 'This giveaway has ended.');

  if (op === 'close') {
    await env.DB.prepare("UPDATE giveaways SET status = 'closed', closed_at = ?1 WHERE id = ?2 AND status = 'open'").bind(now, g.id).run();
  } else if (op === 'reopen') {
    await env.DB.prepare("UPDATE giveaways SET status = 'open', closed_at = NULL WHERE id = ?1 AND status = 'closed'").bind(g.id).run();
  } else if (op === 'revoke') {
    await env.DB.prepare('UPDATE giveaways SET code_revoked_at = ?1 WHERE id = ?2').bind(now, g.id).run();
  } else if (op === 'end') {
    await env.DB.batch([
      env.DB.prepare("UPDATE giveaways SET status = 'ended', ended_at = ?1 WHERE id = ?2").bind(now, g.id),
      env.DB.prepare(
        "UPDATE follow_proofs SET status = 'rejected', reject_reason = 'The giveaway ended.', screenshot = NULL, decided_at = ?1 WHERE giveaway_id = ?2 AND status = 'pending'"
      ).bind(now, g.id)
    ]);
  } else if (op === 'home-on' || op === 'home-off') {
    await env.DB.prepare('UPDATE giveaways SET show_on_home = ?1 WHERE id = ?2').bind(op === 'home-on' ? 1 : 0, g.id).run();
  } else {
    return fail(400, 'op', 'Unknown action.');
  }
  await logAction(env, 'streamer', sid, `giveaway-${op}`, `giveaway ${g.id}`, now);
  return json({ ok: true });
};

// ---------------------------------------------------------------- the wheel

const currentOut = (g) => {
  const out = parseList(g.out_list);
  if (g.wheel_command === 'spin_elim' && g.last_landed && !out.some((n) => n.toLowerCase() === g.last_landed.toLowerCase())) {
    out.push(g.last_landed);   // the last knock-out joins the list when the next spin starts
  }
  return out;
};

const pickAlive = (env, giveawayId, out) =>
  env.DB.prepare(
    `SELECT e.id, p.display_name, p.tiktok_username
       FROM entries e JOIN players p ON p.id = e.player_id
      WHERE e.giveaway_id = ?1 AND e.status = 'alive' AND lower(p.display_name) NOT IN (SELECT lower(value) FROM json_each(?2))
      ORDER BY RANDOM() LIMIT 1`
  ).bind(giveawayId, JSON.stringify(out)).first();

// kind: winner | elim | reset
const spin = async ({ env, session, body, now }) => {
  const g = await runningGiveaway(env, session.userId);
  if (!g) return fail(404, 'none', 'You do not have a running giveaway.');
  const kind = String(body.kind || '');

  if (kind === 'reset') {
    await env.DB.batch([
      env.DB.prepare("UPDATE entries SET status = 'alive' WHERE giveaway_id = ?1 AND status IN ('alive', 'eliminated', 'winner')").bind(g.id),
      env.DB.prepare("UPDATE giveaways SET wheel_command = 'idle', last_landed = '', force_reset = 1, last_spin_at = 0, out_list = '[]' WHERE id = ?1").bind(g.id)
    ]);
    await logAction(env, 'streamer', session.userId, 'reset-wheel', `giveaway ${g.id}`, now);
    return json({ ok: true });
  }
  if (kind !== 'winner' && kind !== 'elim') return fail(400, 'kind', 'Unknown action.');

  const out = currentOut(g);
  const pick = await pickAlive(env, g.id, out);
  if (!pick) return fail(409, 'nobody', kind === 'winner' ? 'No survivors left to crown.' : 'Nobody is left to knock out.');
  // Only one spin at a time: the first request claims the lock, a second one is refused.
  const claim = await env.DB.prepare('UPDATE giveaways SET last_spin_at = ?1 WHERE id = ?2 AND last_spin_at <= ?3').bind(now, g.id, now - SPIN_LOCK_MS).run();
  if (claim.meta.changes !== 1) return fail(409, 'busy', 'A spin is already in progress. Wait a few seconds.');

  const steps = [
    env.DB.prepare(
      "UPDATE giveaways SET out_list = ?1, wheel_command = ?2, last_landed = ?3, force_reset = 0, spin_id = spin_id + 1 WHERE id = ?4"
    ).bind(JSON.stringify(out), kind === 'winner' ? 'spin_winner' : 'spin_elim', pick.display_name, g.id)
  ];
  if (kind === 'winner') steps.push(env.DB.prepare("UPDATE entries SET status = 'winner' WHERE id = ?1").bind(pick.id));
  await env.DB.batch(steps);
  await logAction(env, 'streamer', session.userId, kind === 'winner' ? 'spin-winner' : 'spin-elim', `giveaway ${g.id}`, now);
  return json({ ok: true, [kind === 'winner' ? 'winner' : 'target']: pick.display_name, tiktok: pick.tiktok_username });
};

// ---------------------------------------------------------------- entries (all decisions are the streamer's)

// op: disqualify | ban | unfreeze | tag | restore | unban
const entry = async ({ env, session, body, now }) => {
  const sid = session.userId;
  const op = String(body.op || '');
  const reason = cleanLine(body.reason, 200);

  if (op === 'unban') {
    await env.DB.prepare('DELETE FROM streamer_bans WHERE streamer_id = ?1 AND player_id = ?2').bind(sid, Number(body.playerId)).run();
    await logAction(env, 'streamer', sid, 'unban', `player ${Number(body.playerId)}`, now);
    return json({ ok: true });
  }

  if (op === 'restore') {
    const d = await env.DB.prepare(
      `SELECT d.id, d.player_id, g.id AS gid, g.streamer_id, g.game, g.status
         FROM disqualified_entries d JOIN giveaways g ON g.id = d.giveaway_id
        WHERE d.id = ?1 AND g.streamer_id = ?2`
    ).bind(Number(body.id), sid).first();
    if (!d || !d.player_id) return fail(404, 'none', 'That entry no longer exists.');
    if (d.status === 'ended') return fail(409, 'ended', 'This giveaway has ended.');
    const player = await env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(d.player_id).first();
    const prof = await env.DB.prepare('SELECT handle, ml_user_id, ml_server_id FROM game_profiles WHERE player_id = ?1 AND game = ?2').bind(d.player_id, d.game).first();
    if (!player || !prof) return fail(409, 'no-profile', 'This player no longer has saved game details, so they have to enter again.');
    await env.DB.prepare('DELETE FROM disqualified_entries WHERE id = ?1').bind(d.id).run();
    const res = await enrollPlayer(env, { id: d.gid, streamer_id: sid, game: d.game }, player, { handle: prof.handle, userId: prof.ml_user_id, serverId: prof.ml_server_id }, { source: 'restored', device: '', now });
    await logAction(env, 'streamer', sid, 'restore-entry', `player ${d.player_id}`, now);
    return res.ok ? json({ ok: true, status: res.status }) : fail(409, res.code, res.error);
  }

  const e = await env.DB.prepare(
    `SELECT e.id, e.player_id, e.giveaway_id, e.game_handle, e.device_hash, e.status, p.display_name, p.tiktok_username
       FROM entries e JOIN giveaways g ON g.id = e.giveaway_id JOIN players p ON p.id = e.player_id
      WHERE e.id = ?1 AND g.streamer_id = ?2`
  ).bind(Number(body.id), sid).first();
  if (!e) return fail(404, 'none', 'That entry no longer exists.');

  if (op === 'tag') {
    const tag = String(body.tag || '');
    if (!FOLLOW_TAGS.has(tag)) return fail(400, 'tag', 'Unknown tag.');
    await env.DB.prepare('UPDATE entries SET follow_tag = ?1 WHERE id = ?2').bind(tag, e.id).run();
    return json({ ok: true });
  }
  if (op === 'unfreeze') {
    // Reinstating one entry never touches the other one in a conflict. The streamer decides each separately.
    await env.DB.prepare("UPDATE entries SET status = 'alive', freeze_reason = NULL WHERE id = ?1 AND status = 'frozen'").bind(e.id).run();
    await logAction(env, 'streamer', sid, 'unfreeze', `entry ${e.id}`, now);
    return json({ ok: true });
  }
  if (op === 'disqualify' || op === 'ban') {
    const steps = [
      env.DB.prepare('INSERT INTO disqualified_entries (giveaway_id, player_id, display_name, tiktok_username, game_handle, reason, device_hash, disqualified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(e.giveaway_id, e.player_id, e.display_name, e.tiktok_username, e.game_handle, reason, e.device_hash, now),
      env.DB.prepare('DELETE FROM entries WHERE id = ?1').bind(e.id)
    ];
    if (op === 'ban') {
      steps.push(env.DB.prepare('INSERT OR IGNORE INTO streamer_bans (streamer_id, player_id, reason, created_at) VALUES (?1, ?2, ?3, ?4)').bind(sid, e.player_id, reason, now));
    }
    await env.DB.batch(steps);
    await logAction(env, 'streamer', sid, op === 'ban' ? 'ban-player' : 'disqualify', `player ${e.player_id}`, now);
    return json({ ok: true });
  }
  return fail(400, 'op', 'Unknown action.');
};

// ---------------------------------------------------------------- follow proofs waiting for review

const proofs = async ({ env, session }) => {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.note, f.reason, f.created_at, p.display_name, p.tiktok_username, g.game
       FROM follow_proofs f JOIN players p ON p.id = f.player_id LEFT JOIN giveaways g ON g.id = f.giveaway_id
      WHERE f.streamer_id = ?1 AND f.status = 'pending' ORDER BY f.created_at ASC LIMIT 50`
  ).bind(session.userId).all();
  return json({ ok: true, proofs: results.map((r) => ({ id: r.id, name: r.display_name, tiktok: r.tiktok_username, game: r.game || '', note: r.note || '', reason: r.reason || '', at: r.created_at })) });
};

const proofImage = async ({ env, session, url }) => {
  const row = await env.DB.prepare("SELECT screenshot FROM follow_proofs WHERE id = ?1 AND streamer_id = ?2 AND status = 'pending'")
    .bind(Number(url.searchParams.get('id')), session.userId).first();
  if (!row || !row.screenshot) return fail(404, 'none', 'That screenshot is no longer available.');
  return json({ ok: true, screenshot: row.screenshot });
};

const proofDecision = async ({ env, session, body, now }) => {
  const sid = session.userId;
  const f = await env.DB.prepare("SELECT id, player_id, giveaway_id, device_hash FROM follow_proofs WHERE id = ?1 AND streamer_id = ?2 AND status = 'pending'")
    .bind(Number(body.id), sid).first();
  if (!f) return fail(404, 'none', 'That application was already handled.');

  if (body.approve !== true) {
    await env.DB.prepare("UPDATE follow_proofs SET status = 'rejected', reject_reason = ?1, screenshot = NULL, decided_at = ?2 WHERE id = ?3")
      .bind(cleanLine(body.reason, 200) || 'Not accepted by the host.', now, f.id).run();
    await logAction(env, 'streamer', sid, 'reject-proof', `player ${f.player_id}`, now);
    return json({ ok: true });
  }
  // The screenshot is deleted as soon as the streamer decides.
  await env.DB.prepare("UPDATE follow_proofs SET status = 'approved', screenshot = NULL, decided_at = ?1 WHERE id = ?2").bind(now, f.id).run();
  await logAction(env, 'streamer', sid, 'approve-proof', `player ${f.player_id}`, now);

  const g = f.giveaway_id ? await env.DB.prepare("SELECT id, streamer_id, game FROM giveaways WHERE id = ?1 AND streamer_id = ?2 AND status != 'ended'").bind(f.giveaway_id, sid).first() : null;
  if (!g) return json({ ok: true, entered: false });
  const player = await env.DB.prepare('SELECT * FROM players WHERE id = ?1').bind(f.player_id).first();
  const prof = await env.DB.prepare('SELECT handle, ml_user_id, ml_server_id FROM game_profiles WHERE player_id = ?1 AND game = ?2').bind(f.player_id, g.game).first();
  if (!player || !prof) return json({ ok: true, entered: false });
  const res = await enrollPlayer(env, g, player, { handle: prof.handle, userId: prof.ml_user_id, serverId: prof.ml_server_id }, { source: 'manual-approved', device: f.device_hash || '', now });
  return json({ ok: true, entered: res.ok, status: res.ok ? res.status : '', note: res.ok ? '' : res.error });
};

// ---------------------------------------------------------------- scheduling

// Notes are plain text. Anything that looks like a link is removed (the TikTok profile link is added by the platform).
const cleanNote = (s) => cleanLine(String(s || '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ''), 140);

// op: create | edit | cancel
const schedule = async ({ env, session, body, now }) => {
  const sid = session.userId;
  const op = String(body.op || 'create');

  if (op === 'cancel') {
    await env.DB.prepare('DELETE FROM scheduled_giveaways WHERE id = ?1 AND streamer_id = ?2 AND giveaway_id IS NULL').bind(Number(body.id), sid).run();
    return json({ ok: true });
  }
  if (op !== 'create' && op !== 'edit') return fail(400, 'op', 'Unknown action.');

  const game = String(body.game || '');
  if (!BASE_REQUIREMENTS[game]) return fail(400, 'game', 'Choose Roblox or Mobile Legends.');
  const startsAt = Number(body.startsAt);
  if (!Number.isFinite(startsAt) || startsAt <= now) return fail(400, 'time', 'Pick a time in the future.');
  if (startsAt > now + MAX_DAYS_AHEAD * DAY_MS) return fail(400, 'time', `You can schedule up to ${MAX_DAYS_AHEAD} days ahead.`);
  const note = cleanNote(body.note);
  const home = body.showOnHome === true ? 1 : 0;

  if (op === 'edit') {
    const r = await env.DB.prepare('UPDATE scheduled_giveaways SET game = ?1, starts_at = ?2, note = ?3, show_on_home = ?4 WHERE id = ?5 AND streamer_id = ?6 AND giveaway_id IS NULL')
      .bind(game, Math.round(startsAt), note, home, Number(body.id), sid).run();
    return r.meta.changes === 1 ? json({ ok: true }) : fail(404, 'none', 'That scheduled giveaway no longer exists.');
  }
  const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduled_giveaways WHERE streamer_id = ?1 AND giveaway_id IS NULL AND starts_at > ?2').bind(sid, now - 2 * 60 * 60 * 1000).first();
  if (open && open.n >= MAX_SCHEDULED) return fail(409, 'limit', `You can have up to ${MAX_SCHEDULED} upcoming giveaways. Cancel one first.`);
  const r = await env.DB.prepare('INSERT INTO scheduled_giveaways (streamer_id, game, starts_at, note, show_on_home, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(sid, game, Math.round(startsAt), note, home, now).run();
  await logAction(env, 'streamer', sid, 'schedule', `scheduled ${r.meta.last_row_id}`, now);
  return json({ ok: true, id: r.meta.last_row_id });
};

// ---------------------------------------------------------------- reports to the owner

// A streamer can only report a player who is (or was) in one of their own giveaways. One open report per streamer
// per player, so several reports from one streamer count once. The owner decides what happens.
const report = async ({ env, session, body, now }) => {
  const sid = session.userId;
  const category = String(body.category || '');
  if (!REPORT_CATEGORIES.has(category)) return fail(400, 'category', 'Choose a category.');
  const details = String(body.details || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ').trim().slice(0, 1000);
  if (details.length < 10) return fail(400, 'details', 'Please describe what happened (at least 10 characters).');
  const shot = String(body.evidence || '');
  if (shot && (shot.length > MAX_SHOT_CHARS || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot))) {
    return fail(400, 'evidence', 'The screenshot is too large or not a valid image.');
  }

  const row = body.entryId
    ? await env.DB.prepare('SELECT e.player_id FROM entries e JOIN giveaways g ON g.id = e.giveaway_id WHERE e.id = ?1 AND g.streamer_id = ?2').bind(Number(body.entryId), sid).first()
    : await env.DB.prepare('SELECT d.player_id FROM disqualified_entries d JOIN giveaways g ON g.id = d.giveaway_id WHERE d.id = ?1 AND g.streamer_id = ?2').bind(Number(body.disqualifiedId), sid).first();
  if (!row || !row.player_id) return fail(404, 'none', 'You can only report players from your own giveaways.');
  const player = await env.DB.prepare('SELECT id, display_name, tiktok_lower FROM players WHERE id = ?1').bind(row.player_id).first();
  const me = await getStreamer(env, sid);
  if (!player) return fail(404, 'none', 'That player no longer exists.');

  try {
    await env.DB.prepare(
      `INSERT INTO reports (reported_player_id, reporter_streamer_id, reporter_name, subject_display, subject_tiktok_lower, category, details, evidence, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9)`
    ).bind(player.id, sid, me.display_name, player.display_name, player.tiktok_lower, category, details, shot || null, now).run();
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) return fail(409, 'already', 'You already have an open report on this player.');
    throw err;
  }
  await env.DB.prepare('INSERT INTO live_alerts (streamer_id, message, created_at) VALUES (NULL, ?1, ?2)').bind(`New report on ${player.display_name} from ${me.display_name}`, now).run();
  await logAction(env, 'streamer', sid, 'report', `player ${player.id}`, now);
  return json({ ok: true });
};

// The streamer's own action log (also what the owner looks at after a suspected takeover).
const log = async ({ env, session }) => {
  const { results } = await env.DB.prepare('SELECT action, detail, created_at FROM action_log WHERE actor_role = ?1 AND actor_id = ?2 ORDER BY id DESC LIMIT 50')
    .bind('streamer', session.userId).all();
  return json({ ok: true, log: results.map((r) => ({ action: r.action, detail: r.detail || '', at: r.created_at })) });
};

// ---------------------------------------------------------------- action table (read by index.js)

export const actions = {
  register: { auth: 'none', h: register, maxBody: 2000, limit: { key: 'sregister', max: 5, windowMs: 60 * 60 * 1000 } },
  login: { auth: 'none', h: login, maxBody: 1000 },
  recover: { auth: 'none', h: recover, maxBody: 1000, limit: { key: 'srecover', max: 10, windowMs: 60 * 60 * 1000 } },
  pinrequest: { auth: 'none', h: pinRequest, maxBody: 500, limit: { key: 'spinrequest', max: 5, windowMs: 60 * 60 * 1000 } },

  me: { method: 'GET', allowPending: true, h: me },
  logout: { allowPending: true, h: logout },
  acceptterms: { allowPending: true, h: acceptTerms },
  changepassword: { allowPending: true, h: changePassword, maxBody: 1000, limit: { key: 'spwchange', max: 10, windowMs: 60 * 60 * 1000, by: 'session' } },
  newpin: { allowPending: true, h: newPinAction, maxBody: 500, limit: { key: 'snewpin', max: 5, windowMs: 60 * 60 * 1000, by: 'session' } },

  generate: { h: generate, maxBody: 1000 },
  current: { method: 'GET', h: current },
  manage: { h: manage, maxBody: 500 },
  spin: { h: spin, maxBody: 500 },
  entry: { h: entry, maxBody: 1000 },
  proofs: { method: 'GET', h: proofs },
  proofimage: { method: 'GET', h: proofImage },
  proofdecision: { h: proofDecision, maxBody: 1000 },
  schedule: { h: schedule, maxBody: 2000 },
  report: { h: report, maxBody: MAX_REPORT_BODY, limit: { key: 'sreport', max: 10, windowMs: 60 * 60 * 1000, by: 'session' } },
  log: { method: 'GET', h: log }
};
