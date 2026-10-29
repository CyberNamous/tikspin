// TikSpin - owner routes. Reached as /api/owner/<action>. index.js only lets the owner key through.
//
//   dashboard                 counts and the owner's notices
//   invite / invitations / inviterevoke      one-time streamer invitation links
//   streamers / streamerdecision / streamerlog   approve, reject, suspend, unsuspend, delete
//   resets / resetdo          account reset requests that arrived by email
//   cases / caseevidence / casedecision / bans / unban   Permanent Ban cases (evidence-based, decided by hand)
//   posts / post              "TikSpin Official" homepage posts (plain text)
//   feedback / feedbackaction the one-way feedback inbox
//   cards / cardhide          hide a streamer's homepage card
//   settings / settingsave    contact email, Support link, thresholds, terms versions
//   playersearch / playerdelete   find a player, delete an account on request
//
// Nothing here happens automatically. Reports only fill a queue, and a ban or removal is always the owner's click.

import {
  json, cleanLine, cleanHandle, validTikTok, sha256Hex, randomToken, randomCode, newPin,
  hashPassword, hashPin, destroyUserSessions, limitReset, logAction
} from '../lib/core.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const fail = (status, code, error) => json({ ok: false, code, error }, status);
const profileUrl = (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`;
const intOr = (v, d) => (Number.isInteger(Number(v)) && String(v).trim() !== '' ? Number(v) : d);

const readSettings = async (env) => {
  const { results } = await env.DB.prepare('SELECT key, value FROM system_config').all();
  const c = {};
  for (const r of results) c[r.key] = r.value;
  return c;
};

// ---------------------------------------------------------------- dashboard

const dashboard = async ({ env, now }) => {
  const c = await readSettings(env);
  const threshold = Math.max(1, intOr(c.report_threshold, 2));
  const [pending, resets, feedback, cases, alerts] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM streamers WHERE status = 'pending'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reset_requests WHERE status = 'open' AND expires_at > ?1").bind(now),
    env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE is_read = 0'),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM reports WHERE status = 'open'
        GROUP BY COALESCE(reported_player_id, subject_tiktok_lower)
       HAVING COUNT(DISTINCT COALESCE(reporter_streamer_id, -id)) >= ?1)`
    ).bind(threshold),
    env.DB.prepare('SELECT id, message, created_at FROM live_alerts WHERE streamer_id IS NULL ORDER BY id DESC LIMIT 20')
  ]);
  return json({
    ok: true,
    pendingStreamers: pending.results[0].n,
    openResets: resets.results[0].n,
    unreadFeedback: feedback.results[0].n,
    casesReady: cases.results[0].n,
    reportThreshold: threshold,
    // Setup checklist for the owner panel. Only yes/no, never the secret values themselves.
    setup: {
      pinPepper: !!env.PIN_PEPPER,
      deviceSalt: !!env.DEVICE_SALT,
      contactEmail: !!c.contact_email,
      botCheck: !!env.TURNSTILE_SECRET
    },
    alerts: alerts.results.map((a) => ({ id: a.id, message: a.message, at: a.created_at }))
  });
};

const alertsClear = async ({ env }) => {
  await env.DB.prepare('DELETE FROM live_alerts WHERE streamer_id IS NULL').run();
  return json({ ok: true });
};

// ---------------------------------------------------------------- invitations

// The link is shown ONCE. Only its hash is stored, so it cannot be shown again later.
const invite = async ({ env, body, now }) => {
  const c = await readSettings(env);
  const hours = Math.min(720, Math.max(1, intOr(body.hours, intOr(c.invite_ttl_hours, 48))));
  let forTikTok = null;
  if (body.forTiktok) {
    const h = cleanHandle(body.forTiktok);
    if (!validTikTok(h)) return fail(400, 'tiktok', 'That TikTok username does not look right.');
    forTikTok = h.toLowerCase();
  }
  const token = randomToken();
  await env.DB.prepare('INSERT INTO invitations (token_hash, for_tiktok_lower, note, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256Hex(token), forTikTok, cleanLine(body.note, 100), now, now + hours * 60 * 60 * 1000).run();
  return json({ ok: true, path: `/streamer?invite=${token}`, expiresAt: now + hours * 60 * 60 * 1000, forTiktok: forTikTok || '' });
};

const invitations = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.for_tiktok_lower, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at, s.display_name AS used_by
       FROM invitations i LEFT JOIN streamers s ON s.id = i.used_by_streamer_id ORDER BY i.id DESC LIMIT 100`
  ).all();
  return json({
    ok: true,
    invitations: results.map((i) => ({
      id: i.id, forTiktok: i.for_tiktok_lower || '', note: i.note || '', createdAt: i.created_at, expiresAt: i.expires_at,
      usedBy: i.used_by || '',
      status: i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at <= now ? 'expired' : 'open'
    }))
  });
};

const inviteRevoke = async ({ env, body, now }) => {
  await env.DB.prepare('UPDATE invitations SET revoked_at = ?1 WHERE id = ?2 AND used_at IS NULL AND revoked_at IS NULL').bind(now, Number(body.id)).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------- streamers

const streamers = async ({ env, url }) => {
  const status = url.searchParams.get('status') || '';
  const where = ['pending', 'approved', 'rejected', 'suspended'].includes(status) ? 'WHERE s.status = ?1' : '';
  const stmt = env.DB.prepare(
    `SELECT s.id, s.tiktok_username, s.display_name, s.status, s.status_note, s.created_at, s.approved_at, s.suspended_at, s.last_login_at,
            (SELECT COUNT(*) FROM giveaways g WHERE g.streamer_id = s.id) AS giveaways
       FROM streamers s ${where}
      ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'suspended' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, s.created_at DESC LIMIT 200`
  );
  const { results } = await (where ? stmt.bind(status) : stmt).all();
  return json({
    ok: true,
    streamers: results.map((s) => ({
      id: s.id, tiktok: s.tiktok_username, profileUrl: profileUrl(s.tiktok_username), display: s.display_name, status: s.status,
      note: s.status_note || '', createdAt: s.created_at, approvedAt: s.approved_at || 0, suspendedAt: s.suspended_at || 0,
      lastLoginAt: s.last_login_at || 0, giveaways: s.giveaways
    }))
  });
};

// op: approve | reject | suspend | unsuspend | delete
// Suspending hides the streamer's posts and cards and pauses their giveaways. Nothing is deleted, so the review can
// finish. Deleting (a verified hacked account, or a removal) wipes the account; it carries no penalty and the TikTok
// username becomes free to register again.
const streamerDecision = async ({ env, body, now }) => {
  const s = await env.DB.prepare('SELECT id, tiktok_username, tiktok_lower, status FROM streamers WHERE id = ?1').bind(Number(body.id)).first();
  if (!s) return fail(404, 'none', 'That streamer no longer exists.');
  const op = String(body.op || '');
  const note = cleanLine(body.note, 200);

  if (op === 'approve') {
    await env.DB.prepare("UPDATE streamers SET status = 'approved', approved_at = ?1, suspended_at = NULL, status_note = NULL WHERE id = ?2").bind(now, s.id).run();
  } else if (op === 'reject') {
    await env.DB.prepare("UPDATE streamers SET status = 'rejected', status_note = ?1 WHERE id = ?2").bind(note || 'Your request was not approved.', s.id).run();
    await destroyUserSessions(env, 'streamer', s.id);
  } else if (op === 'suspend') {
    await env.DB.prepare("UPDATE streamers SET status = 'suspended', suspended_at = ?1, status_note = ?2 WHERE id = ?3").bind(now, note || 'This account is under review. Contact the operator.', s.id).run();
  } else if (op === 'unsuspend') {
    await env.DB.prepare("UPDATE streamers SET status = 'approved', suspended_at = NULL, status_note = NULL WHERE id = ?1 AND status = 'suspended'").bind(s.id).run();
  } else if (op === 'delete') {
    // Typing the username is a guard against deleting the wrong account by mistake.
    if (cleanHandle(body.confirm).toLowerCase() !== s.tiktok_lower) return fail(400, 'confirm', 'Type the streamer\'s TikTok username to confirm.');
    await destroyUserSessions(env, 'streamer', s.id);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reset_requests WHERE account_kind = 'streamer' AND account_id = ?1").bind(s.id),
      env.DB.prepare('DELETE FROM streamers WHERE id = ?1').bind(s.id)   // giveaways, entries, schedule and proofs go with it
    ]);
  } else {
    return fail(400, 'op', 'Unknown action.');
  }
  await logAction(env, 'owner', null, `streamer-${op}`, `${s.tiktok_username}`, now);
  return json({ ok: true });
};

// What the account did and when. Helps tell a real takeover from an excuse.
const streamerLog = async ({ env, url }) => {
  const { results } = await env.DB.prepare("SELECT action, detail, created_at FROM action_log WHERE actor_role = 'streamer' AND actor_id = ?1 ORDER BY id DESC LIMIT 100")
    .bind(Number(url.searchParams.get('id'))).all();
  return json({ ok: true, log: results.map((r) => ({ action: r.action, detail: r.detail || '', at: r.created_at })) });
};

// ---------------------------------------------------------------- account resets (requests that came by email)

const resets = async ({ env, url, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.account_kind, r.account_id, r.request_code, r.created_at, r.expires_at,
            CASE r.account_kind WHEN 'player' THEN (SELECT display_name FROM players WHERE id = r.account_id)
                                ELSE (SELECT display_name FROM streamers WHERE id = r.account_id) END AS display,
            CASE r.account_kind WHEN 'player' THEN (SELECT tiktok_username FROM players WHERE id = r.account_id)
                                ELSE (SELECT tiktok_username FROM streamers WHERE id = r.account_id) END AS tiktok
       FROM reset_requests r WHERE r.status = 'open' AND r.expires_at > ?1 ORDER BY r.created_at DESC LIMIT 100`
  ).bind(now).all();
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  const rows = results
    .filter((r) => r.display && (!q || [r.request_code, r.display, r.tiktok].some((v) => String(v || '').toLowerCase().includes(q))))
    .map((r) => ({
      id: r.id, kind: r.account_kind, code: r.request_code, display: r.display, tiktok: r.tiktok,
      profileUrl: profileUrl(r.tiktok), createdAt: r.created_at, expiresAt: r.expires_at
    }));
  return json({ ok: true, requests: rows });
};

// op: password | close. After checking the proof by hand, "password" gives the account a temporary password and a
// new PIN. Both are returned ONCE, to pass on by email. The person must choose a new password at next login.
const resetDo = async ({ env, body, now }) => {
  const r = await env.DB.prepare("SELECT * FROM reset_requests WHERE id = ?1 AND status = 'open'").bind(Number(body.id)).first();
  if (!r) return fail(404, 'none', 'That request was already handled.');
  if (body.op === 'close') {
    await env.DB.prepare("UPDATE reset_requests SET status = 'cancelled', handled_at = ?1 WHERE id = ?2").bind(now, r.id).run();
    return json({ ok: true });
  }
  if (body.op !== 'password') return fail(400, 'op', 'Unknown action.');

  const isPlayer = r.account_kind === 'player';
  const table = isPlayer ? 'players' : 'streamers';
  const acct = await env.DB.prepare(`SELECT id, display_name, tiktok_username, tiktok_lower${isPlayer ? ', display_lower' : ''} FROM ${table} WHERE id = ?1`).bind(r.account_id).first();
  if (!acct) {
    await env.DB.prepare("UPDATE reset_requests SET status = 'cancelled', handled_at = ?1 WHERE id = ?2").bind(now, r.id).run();
    return fail(404, 'none', 'That account no longer exists.');
  }
  const temp = randomCode(12);
  const pin = newPin();
  const owner = `${isPlayer ? 'p' : 's'}:${acct.id}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET password_hash = ?1, pin_hash = ?2, must_change_password = 1 WHERE id = ?3`)
      .bind(await hashPassword(temp), await hashPin(env, owner, pin), acct.id),
    env.DB.prepare("UPDATE reset_requests SET status = 'done', handled_at = ?1 WHERE id = ?2").bind(now, r.id)
  ]);
  await destroyUserSessions(env, r.account_kind, acct.id);
  await limitReset(env, isPlayer ? `pin:${acct.id}` : `spin:${acct.id}`);
  await limitReset(env, isPlayer ? `loginacct:${acct.display_lower}` : `sloginacct:${acct.tiktok_lower}`);
  await logAction(env, 'owner', null, `reset-${r.account_kind}`, acct.tiktok_username, now);
  return json({ ok: true, account: { kind: r.account_kind, display: acct.display_name, tiktok: acct.tiktok_username }, tempPassword: temp, pin });
};

// ---------------------------------------------------------------- Permanent Ban cases

// A case is one player with open reports. By default only cases with reports from enough DIFFERENT streamers show
// (the threshold is a setting). Evidence is what the owner judges, not the count.
const cases = async ({ env, url }) => {
  const c = await readSettings(env);
  const threshold = url.searchParams.get('all') === '1' ? 1 : Math.max(1, intOr(c.report_threshold, 2));
  const [subjects, reports] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(reported_player_id, subject_tiktok_lower) AS k, reported_player_id AS pid, MIN(subject_display) AS display,
              MIN(subject_tiktok_lower) AS tt, COUNT(DISTINCT COALESCE(reporter_streamer_id, -id)) AS reporters, MAX(created_at) AS latest
         FROM reports WHERE status = 'open' GROUP BY k HAVING reporters >= ?1 ORDER BY latest DESC LIMIT 50`
    ).bind(threshold),
    env.DB.prepare(
      `SELECT r.id, r.reported_player_id, r.subject_tiktok_lower, r.reporter_name, r.category, r.details, r.created_at, (r.evidence IS NOT NULL) AS has_evidence
         FROM reports r WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 500`
    )
  ]);
  const list = [];
  for (const s of subjects.results) {
    const mine = reports.results.filter((r) => (s.pid ? r.reported_player_id === s.pid : r.reported_player_id === null && r.subject_tiktok_lower === s.tt));
    const player = s.pid ? await env.DB.prepare('SELECT display_name, tiktok_username, status FROM players WHERE id = ?1').bind(s.pid).first() : null;
    list.push({
      playerId: s.pid || 0,
      display: player ? player.display_name : s.display,
      tiktok: player ? player.tiktok_username : s.tt,
      accountGone: !player,
      reporters: s.reporters,
      reports: mine.map((r) => ({ id: r.id, reporter: r.reporter_name, category: r.category, details: r.details || '', at: r.created_at, hasEvidence: !!r.has_evidence }))
    });
  }
  return json({ ok: true, threshold, cases: list });
};

const caseEvidence = async ({ env, url }) => {
  const row = await env.DB.prepare("SELECT evidence FROM reports WHERE id = ?1 AND status = 'open'").bind(Number(url.searchParams.get('id'))).first();
  if (!row || !row.evidence) return fail(404, 'none', 'No evidence is stored for that report.');
  return json({ ok: true, evidence: row.evidence });
};

// Everything a ban should cover: names now and before, plus saved game accounts and the names copied into reports.
async function banIdentifiers(env, subject) {
  const ids = new Set();
  const add = (kind, value) => value && ids.add(`${kind}\u0000${String(value).toLowerCase()}`);
  add('display', subject.display);
  add('tiktok', subject.tiktok);
  if (subject.playerId) {
    const [p, hist, prof] = await env.DB.batch([
      env.DB.prepare('SELECT display_lower, tiktok_lower FROM players WHERE id = ?1').bind(subject.playerId),
      env.DB.prepare('SELECT old_lower FROM player_tiktok_history WHERE player_id = ?1').bind(subject.playerId),
      env.DB.prepare('SELECT game, handle_lower, ml_user_id, ml_server_id FROM game_profiles WHERE player_id = ?1').bind(subject.playerId)
    ]);
    if (p.results[0]) {
      add('display', p.results[0].display_lower);
      add('tiktok', p.results[0].tiktok_lower);
    }
    for (const h of hist.results) add('tiktok', h.old_lower);
    for (const g of prof.results) {
      if (g.game === 'roblox') add('roblox', g.handle_lower);
      else if (g.ml_user_id) add('ml', `${g.ml_user_id}-${g.ml_server_id}`);
    }
  }
  return [...ids].map((x) => x.split('\u0000'));
}

// op: ban | dismiss. Applies to every open report on the same player.
const caseDecision = async ({ env, body, now }) => {
  const rep = await env.DB.prepare("SELECT id, reported_player_id, subject_display, subject_tiktok_lower FROM reports WHERE id = ?1 AND status = 'open'").bind(Number(body.reportId)).first();
  if (!rep) return fail(404, 'none', 'That case was already decided.');
  const note = cleanLine(body.note, 300);
  const sameSubject = rep.reported_player_id
    ? { sql: 'reported_player_id = ?1', value: rep.reported_player_id }
    : { sql: 'reported_player_id IS NULL AND subject_tiktok_lower = ?1', value: rep.subject_tiktok_lower };

  if (body.op === 'dismiss') {
    await env.DB.prepare(`UPDATE reports SET status = 'dismissed', evidence = NULL, decision_note = ?2, decided_at = ?3 WHERE status = 'open' AND ${sameSubject.sql}`)
      .bind(sameSubject.value, note, now).run();
    await logAction(env, 'owner', null, 'case-dismiss', rep.subject_display, now);
    return json({ ok: true });
  }
  if (body.op !== 'ban') return fail(400, 'op', 'Unknown action.');

  const idents = await banIdentifiers(env, { playerId: rep.reported_player_id, display: rep.subject_display, tiktok: rep.subject_tiktok_lower });
  const ban = await env.DB.prepare('INSERT INTO permanent_bans (reason, report_id, banned_at) VALUES (?1, ?2, ?3)').bind(note || 'Reported by several streamers', rep.id, now).run();
  const banId = ban.meta.last_row_id;
  const steps = idents.map(([kind, value]) =>
    env.DB.prepare('INSERT OR IGNORE INTO ban_identifiers (ban_id, kind, value_lower) VALUES (?1, ?2, ?3)').bind(banId, kind, value));
  steps.push(env.DB.prepare(`UPDATE reports SET status = 'banned', evidence = NULL, decision_note = ?2, decided_at = ?3 WHERE status = 'open' AND ${sameSubject.sql}`).bind(sameSubject.value, note, now));
  if (rep.reported_player_id) {
    steps.push(env.DB.prepare("UPDATE players SET status = 'banned' WHERE id = ?1").bind(rep.reported_player_id));
    steps.push(env.DB.prepare('DELETE FROM entries WHERE player_id = ?1').bind(rep.reported_player_id));   // cannot win anything
  }
  await env.DB.batch(steps);
  if (rep.reported_player_id) await destroyUserSessions(env, 'player', rep.reported_player_id);
  await logAction(env, 'owner', null, 'case-ban', rep.subject_display, now);
  return json({ ok: true, covered: idents.length });
};

const bans = async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.reason, b.banned_at, (SELECT group_concat(kind || ':' || value_lower, ', ') FROM ban_identifiers WHERE ban_id = b.id) AS covers
       FROM permanent_bans b ORDER BY b.id DESC LIMIT 100`
  ).all();
  return json({ ok: true, bans: results.map((b) => ({ id: b.id, reason: b.reason || '', at: b.banned_at, covers: b.covers || '' })) });
};

// Reversing a ban (for example after an appeal by email) lets the covered names register and enter again.
const unban = async ({ env, body, now }) => {
  const id = Number(body.id);
  const { results } = await env.DB.prepare('SELECT kind, value_lower FROM ban_identifiers WHERE ban_id = ?1').bind(id).all();
  if (!results.length) return fail(404, 'none', 'That ban no longer exists.');
  const steps = [];
  for (const r of results) {
    if (r.kind === 'display') steps.push(env.DB.prepare("UPDATE players SET status = 'active' WHERE status = 'banned' AND display_lower = ?1").bind(r.value_lower));
    if (r.kind === 'tiktok') steps.push(env.DB.prepare("UPDATE players SET status = 'active' WHERE status = 'banned' AND tiktok_lower = ?1").bind(r.value_lower));
  }
  steps.push(env.DB.prepare('DELETE FROM permanent_bans WHERE id = ?1').bind(id));   // its identifiers go with it
  await env.DB.batch(steps);
  await logAction(env, 'owner', null, 'unban', `ban ${id}`, now);
  return json({ ok: true });
};

// ---------------------------------------------------------------- "TikSpin Official" posts (plain text)

const posts = async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT id, title, body, link, pinned, hidden, created_at, updated_at FROM posts ORDER BY pinned DESC, created_at DESC LIMIT 100').all();
  return json({ ok: true, posts: results.map((p) => ({ id: p.id, title: p.title, body: p.body, link: p.link || '', pinned: !!p.pinned, hidden: !!p.hidden, createdAt: p.created_at, updatedAt: p.updated_at })) });
};

const cleanPostText = (s, max) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ').trim().slice(0, max);

// op: create | edit | delete | pin | unpin | hide | show
const post = async ({ env, body, now }) => {
  const op = String(body.op || 'create');
  const id = Number(body.id);
  if (op === 'delete') {
    await env.DB.prepare('DELETE FROM posts WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (op === 'pin' || op === 'unpin') {
    await env.DB.prepare('UPDATE posts SET pinned = ?1, updated_at = ?2 WHERE id = ?3').bind(op === 'pin' ? 1 : 0, now, id).run();
    return json({ ok: true });
  }
  if (op === 'hide' || op === 'show') {
    await env.DB.prepare('UPDATE posts SET hidden = ?1, updated_at = ?2 WHERE id = ?3').bind(op === 'hide' ? 1 : 0, now, id).run();
    return json({ ok: true });
  }
  if (op !== 'create' && op !== 'edit') return fail(400, 'op', 'Unknown action.');

  const title = cleanLine(body.title, 80);
  const text = cleanPostText(body.body, 1500);
  const link = String(body.link || '').trim();
  if (!title || !text) return fail(400, 'text', 'A post needs a title and some text.');
  if (link && !/^https:\/\/[^\s<>"']{3,280}$/.test(link)) return fail(400, 'link', 'A link must start with https://');

  if (op === 'edit') {
    await env.DB.prepare('UPDATE posts SET title = ?1, body = ?2, link = ?3, updated_at = ?4 WHERE id = ?5').bind(title, text, link || null, now, id).run();
    return json({ ok: true });
  }
  const r = await env.DB.prepare('INSERT INTO posts (title, body, link, pinned, hidden, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)')
    .bind(title, text, link || null, body.pinned === true ? 1 : 0, now).run();
  return json({ ok: true, id: r.meta.last_row_id });
};

// ---------------------------------------------------------------- feedback inbox

const feedback = async ({ env, url }) => {
  const unread = url.searchParams.get('unread') === '1';
  const { results } = await env.DB.prepare(`SELECT id, category, message, is_read, created_at FROM feedback ${unread ? 'WHERE is_read = 0' : ''} ORDER BY id DESC LIMIT 200`).all();
  return json({ ok: true, feedback: results.map((f) => ({ id: f.id, category: f.category, message: f.message, read: !!f.is_read, at: f.created_at })) });
};

// op: read | unread | delete | deleteread
const feedbackAction = async ({ env, body }) => {
  const id = Number(body.id);
  if (body.op === 'read' || body.op === 'unread') await env.DB.prepare('UPDATE feedback SET is_read = ?1 WHERE id = ?2').bind(body.op === 'read' ? 1 : 0, id).run();
  else if (body.op === 'delete') await env.DB.prepare('DELETE FROM feedback WHERE id = ?1').bind(id).run();
  else if (body.op === 'deleteread') await env.DB.prepare('DELETE FROM feedback WHERE is_read = 1').run();
  else return fail(400, 'op', 'Unknown action.');
  return json({ ok: true });
};

// ---------------------------------------------------------------- homepage cards

const cards = async ({ env, now }) => {
  const [active, upcoming] = await env.DB.batch([
    env.DB.prepare(
      `SELECT g.id, g.game, g.status, g.hidden_by_owner, s.display_name FROM giveaways g JOIN streamers s ON s.id = g.streamer_id
        WHERE g.show_on_home = 1 AND g.status IN ('open', 'closed') ORDER BY g.opened_at DESC LIMIT 50`
    ),
    env.DB.prepare(
      `SELECT c.id, c.game, c.starts_at, c.note, c.hidden_by_owner, s.display_name FROM scheduled_giveaways c JOIN streamers s ON s.id = c.streamer_id
        WHERE c.show_on_home = 1 AND c.giveaway_id IS NULL AND c.starts_at > ?1 ORDER BY c.starts_at ASC LIMIT 50`
    ).bind(now - 2 * 60 * 60 * 1000)
  ]);
  return json({
    ok: true,
    active: active.results.map((g) => ({ id: g.id, game: g.game, status: g.status, streamer: g.display_name, hidden: !!g.hidden_by_owner })),
    upcoming: upcoming.results.map((c) => ({ id: c.id, game: c.game, startsAt: c.starts_at, note: c.note || '', streamer: c.display_name, hidden: !!c.hidden_by_owner }))
  });
};

const cardHide = async ({ env, body }) => {
  const table = body.kind === 'scheduled' ? 'scheduled_giveaways' : body.kind === 'giveaway' ? 'giveaways' : '';
  if (!table) return fail(400, 'kind', 'Unknown card.');
  await env.DB.prepare(`UPDATE ${table} SET hidden_by_owner = ?1 WHERE id = ?2`).bind(body.hidden === true ? 1 : 0, Number(body.id)).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------- settings

const SETTINGS = {
  contact_email: (v) => (v === '' || /^[^\s@<>]{1,64}@[^\s@<>]{1,200}\.[^\s@<>]{2,}$/.test(v) ? v : null),
  support_url: (v) => (v === '' || /^https:\/\/[^\s<>"']{3,280}$/.test(v) ? v : null),
  support_enabled: (v) => (v === '0' || v === '1' ? v : null),
  report_threshold: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10 ? v : null),
  tiktok_change_days: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 90 ? v : null),
  invite_ttl_hours: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 720 ? v : null),
  terms_global_version: (v) => (/^[A-Za-z0-9._-]{1,10}$/.test(v) ? v : null),
  terms_streamer_version: (v) => (/^[A-Za-z0-9._-]{1,10}$/.test(v) ? v : null)
};

const settings = async ({ env }) => {
  const c = await readSettings(env);
  const out = {};
  for (const k of Object.keys(SETTINGS)) out[k] = c[k] || '';
  return json({ ok: true, settings: out });
};

const settingSave = async ({ env, body }) => {
  const check = SETTINGS[String(body.key || '')];
  if (!check) return fail(400, 'key', 'Unknown setting.');
  const value = check(String(body.value ?? '').trim());
  if (value === null) return fail(400, 'value', 'That value is not allowed for this setting.');
  await env.DB.prepare('INSERT INTO system_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(body.key, value).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------- players

const playerSearch = async ({ env, url }) => {
  const q = cleanLine(url.searchParams.get('q'), 40).toLowerCase().replace(/^@/, '');
  if (q.length < 2) return json({ ok: true, players: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const { results } = await env.DB.prepare(
    'SELECT id, display_name, tiktok_username, status, created_at, last_login_at FROM players WHERE display_lower LIKE ?1 OR tiktok_lower LIKE ?1 ORDER BY id DESC LIMIT 20'
  ).bind(like).all();
  return json({ ok: true, players: results.map((p) => ({ id: p.id, display: p.display_name, tiktok: p.tiktok_username, status: p.status, createdAt: p.created_at, lastLoginAt: p.last_login_at || 0 })) });
};

// Deleting an account on request (the Terms promise this by email). Typing the display username guards against mistakes.
// Entries, saved game details and follow proofs go with it. Reports and disqualifications keep their copied names.
const playerDelete = async ({ env, body, now }) => {
  const p = await env.DB.prepare('SELECT id, display_lower FROM players WHERE id = ?1').bind(Number(body.id)).first();
  if (!p) return fail(404, 'none', 'That player no longer exists.');
  if (String(body.confirm || '').trim().toLowerCase() !== p.display_lower) return fail(400, 'confirm', 'Type the display username to confirm.');
  await destroyUserSessions(env, 'player', p.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reset_requests WHERE account_kind = 'player' AND account_id = ?1").bind(p.id),
    env.DB.prepare('DELETE FROM players WHERE id = ?1').bind(p.id)
  ]);
  await logAction(env, 'owner', null, 'player-delete', `player ${p.id}`, now);
  return json({ ok: true });
};

// ---------------------------------------------------------------- action table (read by index.js)

const GET = (h) => ({ method: 'GET', h });
const POST = (h, maxBody) => ({ h, ...(maxBody ? { maxBody } : {}) });

export const actions = {
  dashboard: GET(dashboard),
  alertsclear: POST(alertsClear, 200),

  invite: POST(invite, 1000),
  invitations: GET(invitations),
  inviterevoke: POST(inviteRevoke, 200),

  streamers: GET(streamers),
  streamerdecision: POST(streamerDecision, 1000),
  streamerlog: GET(streamerLog),

  resets: GET(resets),
  resetdo: POST(resetDo, 300),

  cases: GET(cases),
  caseevidence: GET(caseEvidence),
  casedecision: POST(caseDecision, 1000),
  bans: GET(bans),
  unban: POST(unban, 200),

  posts: GET(posts),
  post: POST(post, 4000),

  feedback: GET(feedback),
  feedbackaction: POST(feedbackAction, 300),

  cards: GET(cards),
  cardhide: POST(cardHide, 300),

  settings: GET(settings),
  settingsave: POST(settingSave, 1000),

  playersearch: GET(playerSearch),
  playerdelete: POST(playerDelete, 500)
};
