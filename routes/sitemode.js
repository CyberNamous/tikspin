// TikSpin - maintenance mode (the site-wide on/off switch, with an automatic end time).
//
//   /api/sitemode/status   GET   anyone: {on, message, until, since, now, contact, ended}. The maintenance page uses it.
//   /api/sitemode/set      POST  owner only: turn maintenance on or off.
//                                {on: true, minutes: 30, message: "..."}  -> on for 30 minutes, then TikSpin returns to normal by itself
//                                {on: true}                               -> on until the owner turns it off
//                                {on: true, minutes: 15, extend: true}    -> keep the original start, end 15 minutes from now
//                                {on: false}                              -> off now
//
// The switch lives in the existing system_config table (maintenance_on, maintenance_message, maintenance_until,
// maintenance_since), so no redeploy and no new table. The end time is checked on every request, so a timed
// maintenance stops at the minute it should, with no scheduled job. index.js reads it through getMaintenance().
//
// Flip it by hand in the D1 console if you ever need to:
//   INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_on', '0');   -- off right now

import { json, cacheGet, bustCache } from '../lib/core.js';

const STATE_TTL_MS = 5000;
const MESSAGE_MAX = 200;
const MINUTES_MAX = 24 * 60;
export const DEFAULT_MESSAGE = 'We are making some improvements. Please check back soon.';
const OFF = { on: false, ended: false, message: DEFAULT_MESSAGE, until: 0, since: 0, contact: '' };

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function loadRaw(env) {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM system_config WHERE key IN ('maintenance_on', 'maintenance_message', 'maintenance_until', 'maintenance_since', 'contact_email')"
  ).all();
  const cfg = {};
  for (const r of rows.results) cfg[r.key] = r.value;
  const num = (v) => Math.max(Number(v) || 0, 0);
  return {
    on: cfg.maintenance_on === '1',
    message: clean(cfg.maintenance_message, MESSAGE_MAX) || DEFAULT_MESSAGE,
    until: num(cfg.maintenance_until),
    since: num(cfg.maintenance_since),
    contact: clean(cfg.contact_email, 120)
  };
}

// The effective state right now. A timed maintenance whose end time has passed counts as OFF, with no job needed.
// Never throws: if the database cannot be read, the site stays open (a broken switch must not take TikSpin down).
export async function getMaintenance(env) {
  let raw;
  try {
    raw = await cacheGet('sitemode', STATE_TTL_MS, () => loadRaw(env));
  } catch {
    return OFF;
  }
  const running = raw.on && (raw.until === 0 || raw.until > Date.now());
  return { ...raw, on: running, ended: raw.on && !running };
}

const status = async ({ env }) => {
  const s = await getMaintenance(env);
  return json({ ok: true, ...s, now: Date.now() });
};

const set = async ({ env, body, now }) => {
  const on = body.on === true;
  const message = clean(body.message, MESSAGE_MAX);
  const minutes = Math.min(Math.max(Math.floor(Number(body.minutes) || 0), 0), MINUTES_MAX);
  let since = on ? now : 0;
  if (on && body.extend === true) {
    const current = await getMaintenance(env);
    if (current.on && current.since) since = current.since;
  }
  const until = on && minutes > 0 ? now + minutes * 60 * 1000 : 0;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_on', ?1)").bind(on ? '1' : '0'),
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_message', ?1)").bind(message),
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_until', ?1)").bind(until ? String(until) : ''),
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_since', ?1)").bind(since ? String(since) : '')
  ]);
  bustCache();
  return { ok: true, on, message: message || DEFAULT_MESSAGE, until, since, now };
};

export const actions = {
  status: { method: 'GET', h: status },
  set: { auth: 'owner', h: set, maxBody: 1000 }
};
