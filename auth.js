const encoder = new TextEncoder();
const reply = (data, headers, status = 200) => Response.json(data, { status, headers });
const validPassword = value => typeof value === 'string' && Array.from(value).length >= 8 && value.length <= 256;
const validUsername = value => typeof value === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(value);

export async function cryptoHash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function numericalID() {
  const array = new Uint32Array(2);
  crypto.getRandomValues(array);
  // Values 1,000,000,000 through 9,999,999,999: always exactly ten digits.
  const random = (BigInt(array[0]) << 32n) | BigInt(array[1]);
  const range = 9000000000n;
  const limit = (1n << 64n) - ((1n << 64n) % range);
  return random >= limit ? numericalID() : String(1000000000n + random % range);
}

async function signature(payload, passwordHash) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(passwordHash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const result = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function createSession(user) {
  const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const payload = `${user.user_id}.${expires}`;
  return `${payload}.${await signature(payload, user.password_hash)}`;
}

// Auth owns verification. Streamer operations consume only its validated numeric ID.
// Binding signatures to the password hash invalidates every old session after recovery.
export async function verifyViewer(env, token, claimedID) {
  if (typeof token !== 'string' || typeof claimedID !== 'string' || !/^\d{10}$/.test(claimedID)) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== claimedID || !/^\d{10}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
  const expiry = Number(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now || expiry > now + 12 * 60 * 60 + 60) return false;
  const user = await env.DB.prepare('SELECT password_hash FROM users WHERE user_id = ?').bind(claimedID).first();
  return !!user && equalHex(await signature(`${parts[0]}.${parts[1]}`, user.password_hash), parts[2]);
}

export async function handleAuth(request, env, url, corsHeaders) {
  const path = url.pathname;
  const routes = ['/api/register/create-account', '/api/register/recover', '/api/register/login', '/api/register/apply-streamer'];
  if (!routes.includes(path)) return reply({ error: 'Route not found.' }, corsHeaders, 404);
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, corsHeaders, 405);
  const body = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'A JSON object is required.' }, corsHeaders, 400);

  if (path === '/api/register/apply-streamer') {
    const handle = typeof body.streamer_name === 'string' ? body.streamer_name.trim() : '';
    if (!/^[A-Za-z0-9_.@-]{2,64}$/.test(handle)) {
      return reply({ error: 'Streamer handle must be 2–64 letters, numbers, dots, underscores, @ or hyphens.' }, corsHeaders, 400);
    }
    try {
      // NULL access keys permit multiple pending applicants under the UNIQUE column.
      await env.DB.prepare("INSERT INTO streamers (streamer_name, streamer_id, status) VALUES (?, NULL, 'PENDING')").bind(handle).run();
      return reply({ message: 'Application received. The operator will provide your key after approval.' }, corsHeaders, 201);
    } catch (error) {
      if (/UNIQUE constraint failed: streamers.streamer_name/i.test(error.message)) {
        return reply({ error: 'This streamer handle has already applied.' }, corsHeaders, 409);
      }
      throw error;
    }
  }

  if (!validUsername(body.username)) return reply({ error: 'Username must be 3–32 letters, numbers or underscores.' }, corsHeaders, 400);

  if (path === '/api/register/create-account') {
    if (!validPassword(body.password)) return reply({ error: 'Password must contain at least 8 characters and at most 256 UTF-16 units.' }, corsHeaders, 400);
    if (typeof body.pin !== 'string' || !/^\d{6}$/.test(body.pin)) return reply({ error: 'Recovery PIN must be exactly 6 digits.' }, corsHeaders, 400);
    if (typeof body.secret_answer !== 'string' || !body.secret_answer.trim() || body.secret_answer.length > 256) {
      return reply({ error: 'A secret answer of 1–256 characters is required.' }, corsHeaders, 400);
    }
    const fields = ['tiktok_username', 'roblox_username', 'ml_id', 'ml_server'];
    for (const field of fields) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 100)) {
        return reply({ error: `${field} must be text of at most 100 characters.` }, corsHeaders, 400);
      }
    }
    const [passwordHash, pinHash, answerHash] = await Promise.all([
      cryptoHash(body.password), cryptoHash(body.pin), cryptoHash(body.secret_answer)
    ]);
    // Both pre-check and unique constraint protect against random collisions and races.
    for (let attempt = 0; attempt < 128; attempt++) {
      const userID = numericalID();
      if (await env.DB.prepare('SELECT id FROM users WHERE user_id = ?').bind(userID).first()) continue;
      try {
        await env.DB.prepare(
          'INSERT INTO users (user_id, username, password_hash, pin_hash, secret_answer_hash, tiktok_username, roblox_username, ml_id, ml_server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(userID, body.username, passwordHash, pinHash, answerHash, ...fields.map(field => body[field] || '')).run();
        return reply({ message: 'Account created. You can now log in.' }, corsHeaders, 201);
      } catch (error) {
        if (/UNIQUE constraint failed: users.username/i.test(error.message)) return reply({ error: 'Username is already registered.' }, corsHeaders, 409);
        if (/UNIQUE constraint failed: users.user_id/i.test(error.message)) continue;
        throw error;
      }
    }
    return reply({ error: 'Unable to allocate a unique ID right now. Please retry.' }, corsHeaders, 503);
  }

  if (path === '/api/register/recover') {
    if (typeof body.pin !== 'string' || !/^\d{6}$/.test(body.pin) || typeof body.secret_answer !== 'string' || body.secret_answer.length > 256) {
      return reply({ error: 'A 6-digit PIN and secret answer are required.' }, corsHeaders, 400);
    }
    const user = await env.DB.prepare('SELECT user_id, pin_hash, secret_answer_hash FROM users WHERE username = ?').bind(body.username).first();
    const [pinHash, answerHash] = await Promise.all([cryptoHash(body.pin), cryptoHash(body.secret_answer)]);
    if (!user || !equalHex(user.pin_hash, pinHash) || !equalHex(user.secret_answer_hash, answerHash)) {
      return reply({ error: 'Recovery details do not match.' }, corsHeaders, 401);
    }
    if (!validPassword(body.new_password)) return reply({ error: 'New password must contain at least 8 characters and at most 256 UTF-16 units.' }, corsHeaders, 400);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?')
      .bind(await cryptoHash(body.new_password), user.user_id).run();
    return reply({ message: 'Password replaced. Log in with your new password.' }, corsHeaders);
  }

  if (typeof body.password !== 'string' || body.password.length > 256) return reply({ error: 'Invalid login credentials.' }, corsHeaders, 401);
  const user = await env.DB.prepare('SELECT user_id, username, password_hash FROM users WHERE username = ?').bind(body.username).first();
  const passwordHash = await cryptoHash(body.password);
  if (!user || !equalHex(passwordHash, user.password_hash)) return reply({ error: 'Invalid login credentials.' }, corsHeaders, 401);
  return reply({ username: user.username, user_id: user.user_id, session_token: await createSession(user), expires_in: 43200 }, corsHeaders);
}
