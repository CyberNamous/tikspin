// TikSpin - maintenance mode (the site-wide on/off switch).
//
//   /api/sitemode/status   GET   anyone: {on, message, until, contact}. The maintenance page uses it.
//   /api/sitemode/set      POST  owner only: turn maintenance on or off, with an optional message and "back in N minutes".
//
// The switch lives in the existing system_config table (keys maintenance_on, maintenance_message, maintenance_until),
// so it can be flipped with no redeploy. index.js reads it through getMaintenance(), at most once every few seconds.
//
// You can also flip it by hand in the D1 console:
//   INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_on', '1');   -- on
//   INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_on', '0');   -- off

import { json, cacheGet, bustCache } from '../lib/core.js';

const STATE_TTL_MS = 5000;
const MESSAGE_MAX = 200;
const MINUTES_MAX = 24 * 60;
export const DEFAULT_MESSAGE = 'We are making some improvements. Please check back soon.';

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function loadState(env) {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM system_config WHERE key IN ('maintenance_on', 'maintenance_message', 'maintenance_until', 'contact_email')"
  ).all();
  const cfg = {};
  for (const r of rows.results) cfg[r.key] = r.value;
  const until = Number(cfg.maintenance_until) || 0;
  return {
    on: cfg.maintenance_on === '1',
    message: clean(cfg.maintenance_message, MESSAGE_MAX) || DEFAULT_MESSAGE,
    until: until > 0 ? until : 0,
    contact: clean(cfg.contact_email, 120)
  };
}

// Never throws: if the database cannot be read, the site stays open (a broken switch must not take TikSpin down).
export async function getMaintenance(env) {
  try {
    return await cacheGet('sitemode', STATE_TTL_MS, () => loadState(env));
  } catch {
    return { on: false, message: DEFAULT_MESSAGE, until: 0, contact: '' };
  }
}

const status = async ({ env }) => {
  const s = await getMaintenance(env);
  return json({ ok: true, ...s });
};

const set = async ({ env, body, now }) => {
  const on = body.on === true;
  const message = clean(body.message, MESSAGE_MAX);
  const minutes = Math.min(Math.max(Math.floor(Number(body.minutes) || 0), 0), MINUTES_MAX);
  const until = on && minutes > 0 ? now + minutes * 60 * 1000 : 0;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_on', ?1)").bind(on ? '1' : '0'),
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_message', ?1)").bind(message),
    env.DB.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('maintenance_until', ?1)").bind(until ? String(until) : '')
  ]);
  bustCache();
  return { ok: true, on, message: message || DEFAULT_MESSAGE, until };
};

export const actions = {
  status: { method: 'GET', h: status },
  set: { auth: 'owner', h: set, maxBody: 1000 }
};
