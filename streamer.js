import { verifyViewer } from './auth.js';

const reply = (data, headers, status = 200) => Response.json(data, { status, headers });
const validID = value => /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value));
const validKey = key => typeof key === 'string' && /^TKSPIN-\d{6}$/.test(key);

async function approved(env, key) {
  if (!validKey(key)) return false;
  return !!(await env.DB.prepare("SELECT id FROM streamers WHERE streamer_id = ? AND status = 'APPROVED'").bind(key).first());
}

export async function handleStreamer(request, env, url, corsHeaders) {
  const path = url.pathname;
  if (path === '/api/public/news' && request.method === 'GET') {
    const result = await env.DB.prepare('SELECT id, message, posted_at FROM news ORDER BY posted_at DESC, id DESC LIMIT 100').all();
    return reply({ news: result.results }, corsHeaders);
  }
  if (path === '/api/public/giveaways' && request.method === 'GET') {
    // Never serialize the passcode, streamer access key, entries, or viewer profiles.
    const result = await env.DB.prepare(
      'SELECT id, giveaway_name, giveaway_mode FROM giveaways WHERE is_active = 1 ORDER BY id DESC'
    ).all();
    return reply({ giveaways: result.results }, corsHeaders);
  }
  if (path === '/api/public/join' && request.method === 'POST') {
    const body = await request.json();
    if (!body || typeof body !== 'object' || !validID(body.giveaway_id) || typeof body.submitted_code !== 'string' || body.submitted_code.length > 100) {
      return reply({ error: 'A giveaway ID and valid entry code are required.' }, corsHeaders, 400);
    }
    if (!await verifyViewer(env, body.session_token, body.user_id)) {
      return reply({ error: 'Your login expired. Please log in again.' }, corsHeaders, 401);
    }
    // A single conditional insertion enforces the active/code gate at write time.
    const inserted = await env.DB.prepare(
      `INSERT INTO entries (giveaway_id, user_id)
       SELECT id, ? FROM giveaways WHERE id = ? AND is_active = 1 AND entry_code = ?
       ON CONFLICT(giveaway_id, user_id) DO NOTHING RETURNING id`
    ).bind(body.user_id, Number(body.giveaway_id), body.submitted_code).first();
    if (inserted) return reply({ message: 'Entry accepted. Good luck!' }, corsHeaders, 201);
    const giveaway = await env.DB.prepare('SELECT is_active, entry_code FROM giveaways WHERE id = ?').bind(Number(body.giveaway_id)).first();
    if (!giveaway || !giveaway.is_active) return reply({ error: 'This giveaway is closed or unavailable.' }, corsHeaders, 409);
    if (giveaway.entry_code !== body.submitted_code) return reply({ error: 'Incorrect entry passcode.' }, corsHeaders, 403);
    return reply({ message: 'You are already entered.', already_joined: true }, corsHeaders);
  }
  if (path === '/api/streamer/validate-key' && request.method === 'POST') {
    const body = await request.json();
    if (!await approved(env, body?.access_key)) return reply({ error: 'Invalid or unapproved access key.' }, corsHeaders, 401);
    // Only the streamer's own live giveaway metadata is returned for page recovery.
    const live = await env.DB.prepare(
      'SELECT id, giveaway_name, giveaway_mode FROM giveaways WHERE streamer_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1'
    ).bind(body.access_key).first();
    return reply({ approved: true, active_giveaway: live || null }, corsHeaders);
  }
  if (path === '/api/streamer/create' && request.method === 'POST') {
    const body = await request.json();
    if (!await approved(env, body?.access_key)) return reply({ error: 'Invalid or unapproved access key.' }, corsHeaders, 401);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 120 || !['ML', 'ROBLOX'].includes(body.mode) ||
        typeof body.entry_code !== 'string' || !body.entry_code.trim() || body.entry_code.length > 100) {
      return reply({ error: 'Use a title (1–120 characters), one mode (ML or ROBLOX), and an entry passcode (1–100 characters).' }, corsHeaders, 400);
    }
    // Statement-level NOT EXISTS is atomic: one live giveaway per streamer, not one per game.
    const row = await env.DB.prepare(
      `INSERT INTO giveaways (streamer_id, giveaway_name, giveaway_mode, entry_code)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS
       (SELECT 1 FROM giveaways WHERE streamer_id = ? AND is_active = 1)
       RETURNING id, giveaway_name, giveaway_mode, is_active`
    ).bind(body.access_key, title, body.mode, body.entry_code, body.access_key).first();
    if (!row) return reply({ error: 'You already have a live giveaway. Lock its entries before creating another.' }, corsHeaders, 409);
    return reply({ giveaway: row }, corsHeaders, 201);
  }
  if (path === '/api/streamer/lock-wheel' && request.method === 'GET') {
    const key = url.searchParams.get('access_key');
    const giveawayID = url.searchParams.get('giveaway_id');
    if (!validKey(key) || !validID(giveawayID)) return reply({ error: 'Valid access key and giveaway ID required.' }, corsHeaders, 400);
    // D1 batch is a transaction: closure and its exact participant snapshot are indivisible.
    // The UPDATE gate succeeds once. Any later or concurrent caller receives no array.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE giveaways SET is_active = 0 WHERE id = ? AND streamer_id = ? AND is_active = 1
         AND EXISTS (SELECT 1 FROM streamers WHERE streamer_id = ? AND status = 'APPROVED')
         RETURNING id`
      ).bind(Number(giveawayID), key, key),
      env.DB.prepare('SELECT user_id FROM entries WHERE giveaway_id = ? ORDER BY id').bind(Number(giveawayID))
    ]);
    if (!results[0].results.length) return reply({ error: 'Already locked, not found, or access denied. An array can only be downloaded once.' }, corsHeaders, 409);
    const ids = results[1].results.map(row => row.user_id).filter(id => typeof id === 'string' && /^\d{10}$/.test(id));
    return reply({ giveaway_id: Number(giveawayID), user_ids: ids, locked: true }, corsHeaders);
  }
  const routes = ['/api/public/news', '/api/public/giveaways', '/api/public/join', '/api/streamer/validate-key', '/api/streamer/create', '/api/streamer/lock-wheel'];
  return reply({ error: routes.includes(path) ? 'Method not allowed.' : 'Route not found.' }, corsHeaders, routes.includes(path) ? 405 : 404);
}
