// TikSpin - shared helpers used by index.js and every routes/ module.
//
// Secrets this file reads (set with `wrangler secret put NAME`):
//   OWNER_TOKEN   the owner panel key (required)
//   PIN_PEPPER    long random text that protects recovery PINs if the database ever leaks (required)
//   DEVICE_SALT   long random text mixed into device codes so they cannot be reversed into IP addresses (recommended)
//   TURNSTILE_SECRET / TURNSTILE_SITE_KEY   optional bot check for sign-up and feedback (off when not set)
//
// Tables this file touches (defined later in schema.sql):
//   sessions(id, token_hash UNIQUE, role, user_id, created_at, expires_at)
//   rate_limits(key PRIMARY KEY, n, window_start)
//   action_log(id, actor_role, actor_id, action, detail, created_at)
//   players(id, status ...) and streamers(id, status ...)   status is read when a session is checked

// ---------- constants ----------
export const PLAYER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const STREAMER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Workers allow at most 100,000 PBKDF2 rounds. If logins time out on the free plan, this is the number to lower.
const PBKDF2_ROUNDS = 100000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 symbols, no 0/O/1/I/L look-alikes

// ---------- replies ----------
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

export const jsonText = (text, status = 200) =>
  new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

// Returns { body } (always a plain object) or { error: Response }.
export const readJson = async (request, max) => {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) return { error: json({ ok: false, code: 'too-large', error: 'Payload too large.' }, 413) };
  const raw = await request.text();
  if (raw.length > max) return { error: json({ ok: false, code: 'too-large', error: 'Payload too large.' }, 413) };
  if (!raw.trim()) return { body: {} };
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return { body };
  } catch {
    return { error: json({ ok: false, code: 'bad-json', error: 'Invalid request.' }, 400) };
  }
};

// ---------- text helpers ----------
export const cleanLine = (s, n) =>
  String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const cleanHandle = (s) => String(s || '').trim().replace(/^@/, '');
export const validTikTok = (s) => /^[a-zA-Z0-9_.]{2,24}$/.test(s);
export const validDisplayName = (s) => /^[a-zA-Z0-9_]{3,20}$/.test(s);

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'iloveyou123',
  'admin12345', 'letmein1234', 'welcome1234', 'tiktok12345', 'tikspin123', 'roblox12345', 'mobilelegends',
  'abc1234567', '0123456789', 'passw0rd123', 'changeme123', 'monkey12345'
]);

// Returns an error message, or '' when the password is acceptable.
export const passwordProblem = (pw) => {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (s.length > 128) return 'That password is too long (128 characters at most).';
  if (COMMON_PASSWORDS.has(s.toLowerCase())) return 'That password is too common. Choose another.';
  if (/^(.)\1+$/.test(s)) return 'Do not repeat a single character.';
  return '';
};

// ---------- encoding ----------
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (s) => new TextEncoder().encode(s);

export const sha256Hex = async (text) => toHex(await crypto.subtle.digest('SHA-256', enc(text)));

// Compares two byte arrays in constant time.
const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

// Constant-time text comparison that does not leak the length either (both sides are hashed first).
export const tokenMatches = async (supplied, expected) => {
  if (!supplied || !expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc(String(supplied))),
    crypto.subtle.digest('SHA-256', enc(String(expected)))
  ]);
  return sameBytes(new Uint8Array(a), new Uint8Array(b));
};

// ---------- randomness ----------
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// Random text from the easy-to-read alphabet. Rejection sampling keeps every symbol equally likely.
export const randomCode = (length) => {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const x of bytes) {
      if (x < limit && out.length < length) out += CODE_ALPHABET[x % CODE_ALPHABET.length];
    }
  }
  return out;
};

// Random 6-digit PIN (000000-999999), unbiased.
export const newPin = () => {
  const limit = Math.floor(2 ** 32 / 1e6) * 1e6;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < limit) return String(n % 1e6).padStart(6, '0');
  }
};

// ---------- passwords and PINs ----------
export const hashPassword = async (password) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS }, key, 256);
  return `pbkdf2$${PBKDF2_ROUNDS}$${b64(salt)}$${b64(bits)}`;
};

export const verifyPassword = async (password, stored) => {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const rounds = Number(parts[1]);
  if (!Number.isInteger(rounds) || rounds < 1000 || rounds > 100000) return false;
  const key = await crypto.subtle.importKey('raw', enc(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(parts[2]), iterations: rounds }, key, 256
  );
  return sameBytes(new Uint8Array(bits), unb64(parts[3]));
};

// PINs are only 6 digits, so a plain hash could be reversed in seconds. They are stored as an HMAC with a secret
// pepper that lives in a Worker secret, not in the database. `owner` ties the hash to one account.
export const hashPin = async (env, owner, pin) => {
  if (!env.PIN_PEPPER) throw new Error('PIN_PEPPER secret is not set.');
  const key = await crypto.subtle.importKey('raw', enc(env.PIN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc(`${owner}:${pin}`)));
};

export const verifyPin = async (env, owner, pin, storedHex) => {
  if (!/^\d{6}$/.test(String(pin || '')) || !storedHex) return false;
  const calc = await hashPin(env, owner, String(pin));
  return sameBytes(enc(calc), enc(String(storedHex)));
};

// ---------- device code ----------
// A one-way code made from IP + browser, salted with a secret. Only this code is ever stored, never the IP address.
export const deviceHashFor = async (request, env) => {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  return (await sha256Hex(`${(env && env.DEVICE_SALT) || ''}|${ip}|${ua}`)).slice(0, 32);
};

// ---------- owner ----------
export const ownerOk = async (env, request) => {
  if (!env || !env.OWNER_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return tokenMatches(supplied, env.OWNER_TOKEN);
};

// ---------- sessions ----------
const bearer = (request) => {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
};

// role is 'player' or 'streamer'. Returns { id, role, userId, status } or null.
export const getSession = async (env, request, role) => {
  const token = bearer(request);
  if (!token || token.length > 100) return null;
  const table = role === 'streamer' ? 'streamers' : 'players';
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, s.user_id AS uid, u.status AS status
       FROM sessions s JOIN ${table} u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.role = ?2 AND s.expires_at > ?3 LIMIT 1`
  ).bind(await sha256Hex(token), role, Date.now()).first();
  if (!row) return null;
  return { id: row.sid, role, userId: row.uid, status: row.status };
};

// Returns the plain token to send to the browser. Only its hash is stored.
export const createSession = async (env, role, userId, now) => {
  const token = randomToken();
  const ttl = role === 'streamer' ? STREAMER_SESSION_MS : PLAYER_SESSION_MS;
  await env.DB.prepare('INSERT INTO sessions (token_hash, role, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256Hex(token), role, userId, now, now + ttl).run();
  return { token, expiresAt: now + ttl };
};

export const destroySession = async (env, request) => {
  const token = bearer(request);
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
};

// "Log out of all devices": used by resets, suspensions and password changes.
export const destroyUserSessions = (env, role, userId) =>
  env.DB.prepare('DELETE FROM sessions WHERE role = ?1 AND user_id = ?2').bind(role, userId).run();

// ---------- rate limits ----------
// limitCheck only looks; limitHit counts one try. Keep them separate so callers can count only failures.
export const limitCheck = async (env, key, max, windowMs) => {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT n, window_start FROM rate_limits WHERE key = ?1').bind(key).first();
  if (!row || now - row.window_start >= windowMs || row.n < max) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)) };
};

export const limitHit = (env, key, windowMs) => {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO rate_limits (key, n, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       n = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE n + 1 END,
       window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`
  ).bind(key, now, windowMs).run();
};

export const limitReset = (env, key) => env.DB.prepare('DELETE FROM rate_limits WHERE key = ?1').bind(key).run();

// ---------- short-lived cache for public pages ----------
// Each Worker instance keeps its own copy, so a copy can be a few seconds old. That is fine for the homepage feed.
const cache = new Map();

export const cacheGet = async (key, ttlMs, load) => {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await load();
  if (cache.size >= 500) cache.clear(); // stops guessed keys from growing memory without limit
  cache.set(key, { at: now, value });
  return value;
};

export const bustCache = () => cache.clear();

// ---------- bot check (Cloudflare Turnstile) ----------
// Stops scripts from mass-creating accounts or flooding forms. Off until TURNSTILE_SECRET is set, so it can be
// switched on later without changing code. The page widget needs TURNSTILE_SITE_KEY (sent to pages by /api/home).
export const turnstileOk = async (env, token, request) => {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
};

// ---------- action log ----------
// Who did what and when. Helps tell a real account takeover from an excuse, and lets the owner undo changes.
export const logAction = (env, actorRole, actorId, action, detail, now) =>
  env.DB.prepare('INSERT INTO action_log (actor_role, actor_id, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(actorRole, actorId, action, String(detail || '').slice(0, 300), now).run();
