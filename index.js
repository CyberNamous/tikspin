// TikSpin - Worker entry (router).
//
// This file only decides WHO may call WHAT. The actual work lives in modules:
//   lib/core.js         helpers: json, request body, device code, sessions, owner check, rate limits, cache
//   lib/maintenance.js  daily cleanup (cron)
//   lib/schema.js       creates the database tables by itself on first start (no manual SQL step)
//   routes/public.js    homepage feed, wheel view, code check, feedback, helper bot
//   routes/player.js    player accounts, entering giveaways, PIN / TikTok change
//   routes/streamer.js  streamer registration, giveaways, entries, schedule, reports
//   routes/profile.js   streamer profiles and streamer search (also creates the profile and follow tables)
//   routes/follow.js    platform follows and viewer profiles
//   routes/owner.js     invitations, approvals, suspensions, resets, reports, posts, feedback inbox
//
// Each routes module exports `actions`: { actionName: { h, ...options } }
//   h(ctx)               handler. Returns a Response (or a plain object, which is sent as JSON).
//   method               'POST' (default) or 'GET'
//   auth: 'none'         skip the group's login requirement (register, login, recover ...)
//   allowPending: true   streamer actions a not-yet-approved streamer may still use
//   maxBody              largest JSON body in characters (default 20000)
//   limit                { key, max, windowMs, by: 'device' | 'session' }  per-action rate limit
// ctx = { request, env, url, now, device, session, body }

import { json, deviceHashFor, readJson, getSession, ownerOk, limitCheck, limitHit, bustCache } from './lib/core.js';
import { runMaintenance } from './lib/maintenance.js';
import { ensureSchema } from './lib/schema.js';
import * as pub from './routes/public.js';
import * as player from './routes/player.js';
import * as streamer from './routes/streamer.js';
import * as owner from './routes/owner.js';
import * as profile from './routes/profile.js';
import * as follow from './routes/follow.js';

const DEFAULT_MAX_BODY = 20000;
const OWNER_FAIL_MAX = 10;
const OWNER_FAIL_WINDOW_MS = 15 * 60 * 1000;
const ACTION_RE = /^[a-z][a-z0-9-]{0,40}$/;

// Order matters: the specific prefixes come before the public '/api/'.
const GROUPS = [
  { prefix: '/api/player/', auth: 'player', actions: player.actions },
  { prefix: '/api/streamer/', auth: 'streamer', actions: streamer.actions },
  { prefix: '/api/owner/', auth: 'owner', actions: owner.actions },
  { prefix: '/api/streamer-profile/', auth: 'streamer', actions: profile.streamerActions },
  { prefix: '/api/profile/', auth: 'none', actions: profile.publicActions },
  { prefix: '/api/player-profile/', auth: 'player', actions: follow.playerActions },
  { prefix: '/api/viewer/', auth: 'none', actions: follow.viewerActions },
  { prefix: '/api/', auth: 'none', actions: pub.actions }
];

// Pretty links that are not real files. The Worker serves the right page and the page reads the code from the URL.
//   /join/<code>   -> homepage (the giveaway join view)
//   /wheel/<code>  -> wheel page (read-only view of one giveaway)
//   /s/<username>  -> a streamer's public profile page
//   /u/<name>      -> a viewer's public profile page (only when the player made it public)
const PAGES = [
  { re: /^\/join(\/[^/]*)?$/, target: '/' },
  { re: /^\/wheel\/[^/]+$/, target: '/wheel' },
  { re: /^\/s\/[^/]+$/, target: '/profile' },
  { re: /^\/u\/[^/]+$/, target: '/viewer' }
];

// Messages the pages show for blocked accounts.
const STREAMER_BLOCKS = {
  pending: 'Request is being processed. If no progress is made within 24 hours, contact the operator.',
  suspended: 'This account is under review. Contact the operator.',
  rejected: 'This registration request was not approved. Contact the operator if you think this is a mistake.'
};

const fail = (status, code, error, extra) => json({ ok: false, code, error, ...(extra || {}) }, status);

const tooMany = (lock) => {
  const res = fail(429, 'slow-down', 'Too many tries. Please wait a little and try again.', { retryAfter: lock.retryAfter });
  res.headers.set('retry-after', String(lock.retryAfter));
  return res;
};

const findAction = (path) => {
  for (const group of GROUPS) {
    if (!path.startsWith(group.prefix)) continue;
    const name = path.slice(group.prefix.length);
    if (!ACTION_RE.test(name)) return null;
    if (!Object.prototype.hasOwnProperty.call(group.actions, name)) return null;
    return { group, spec: group.actions[name] };
  }
  return null;
};

// Returns { session } when allowed, or { error: Response } when blocked.
async function authenticate(env, request, kind, spec, device) {
  if (kind === 'none') return { session: null };

  if (kind === 'owner') {
    const key = `owner-auth:${device}`;
    const lock = await limitCheck(env, key, OWNER_FAIL_MAX, OWNER_FAIL_WINDOW_MS);
    if (!lock.ok) return { error: tooMany(lock) };
    if (!(await ownerOk(env, request))) {
      await limitHit(env, key, OWNER_FAIL_WINDOW_MS);
      return { error: fail(401, 'unauthorized', 'Unauthorized.') };
    }
    return { session: { role: 'owner' } };
  }

  const session = await getSession(env, request, kind);
  if (!session) return { error: fail(401, 'login', 'Please log in to continue.') };

  if (kind === 'player' && session.status === 'banned') {
    return { error: fail(403, 'banned', 'This account is no longer allowed on TikSpin.') };
  }
  if (kind === 'streamer' && session.status !== 'approved') {
    if (!(session.status === 'pending' && spec.allowPending)) {
      const message = STREAMER_BLOCKS[session.status] || STREAMER_BLOCKS.suspended;
      return { error: fail(403, session.status || 'blocked', message) };
    }
  }
  return { session };
}

async function handleApi(request, env, url) {
  const found = findAction(url.pathname);
  if (!found) return fail(404, 'not-found', 'Not found.');
  const { group, spec } = found;

  const method = spec.method || 'POST';
  if (request.method !== method) return fail(405, 'method', 'Method not allowed.');

  const device = await deviceHashFor(request, env);
  const auth = await authenticate(env, request, spec.auth || group.auth, spec, device);
  if (auth.error) return auth.error;
  const session = auth.session;

  if (spec.limit) {
    const who = spec.limit.by === 'session' && session && session.id ? `s${session.id}` : device;
    const lock = await limitCheck(env, `${spec.limit.key}:${who}`, spec.limit.max, spec.limit.windowMs);
    if (!lock.ok) return tooMany(lock);
    await limitHit(env, `${spec.limit.key}:${who}`, spec.limit.windowMs);
  }

  let body = {};
  if (method === 'POST') {
    const read = await readJson(request, spec.maxBody || DEFAULT_MAX_BODY);
    if (read.error) return read.error;
    body = read.body;
  }

  const ctx = { request, env, url, now: Date.now(), device, session, body };
  const out = await spec.h(ctx);
  const res = out instanceof Response ? out : json(out);

  // Anything a streamer or the owner changes may change the homepage, so drop the short-lived cache.
  if (method === 'POST' && res.status === 200 && (group.auth === 'streamer' || group.auth === 'owner')) bustCache();
  return res;
}

async function servePage(request, env, url, target) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method', 'Method not allowed.');
  const res = await env.ASSETS.fetch(new Request(new URL(target, url.origin), request));
  const out = new Response(res.body, res);
  // The code sits in the address, so keep it out of referrers, search engines and caches.
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  out.headers.set('cache-control', 'no-store');
  out.headers.set('x-content-type-options', 'nosniff');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);   // creates the tables the first time, then does nothing
        return await handleApi(request, env, url);
      }
      for (const page of PAGES) {
        if (page.re.test(url.pathname)) return await servePage(request, env, url, page.target);
      }
      return await env.ASSETS.fetch(request);
    } catch (err) {
      // Details go to the logs only. Visitors (and the owner) get a short message.
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      if (err && String(err.message).includes('PIN_PEPPER')) {
        return fail(503, 'setup', 'TikSpin is not fully set up yet. The operator needs to finish setup.');
      }
      return fail(500, 'server', 'Something went wrong. Please try again.');
    }
  },

  // Daily cleanup: expired sessions and links, old evidence and feedback, finished giveaways, old scheduled cards.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ensureSchema(env).then(() => runMaintenance(env, Date.now())).catch((err) => {
        console.error('Maintenance error:', err && err.stack ? err.stack : err);
      })
    );
  }
};
