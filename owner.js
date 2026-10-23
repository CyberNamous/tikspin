// Intentionally unauthenticated by specification. Protect /api/owner/* externally.
const reply = (data, headers, status = 200) => Response.json(data, { status, headers });
const positiveID = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function accessKey() {
  // Rejection sampling avoids modulo bias while retaining the required six digits.
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= 4294000000);
  return `TKSPIN-${String(sample[0] % 1000000).padStart(6, '0')}`;
}

export async function handleOwner(request, env, url, corsHeaders) {
  const path = url.pathname;
  if (path === '/api/owner/telemetry' && request.method === 'GET') {
    const results = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS count FROM users'),
      env.DB.prepare('SELECT COUNT(*) AS count FROM giveaways WHERE is_active = 1'),
      env.DB.prepare("SELECT id, streamer_name, status FROM streamers WHERE status = 'PENDING' ORDER BY id")
    ]);
    return reply({ users: results[0].results[0].count, open_giveaways: results[1].results[0].count,
      pending_streamers: results[2].results }, corsHeaders);
  }
  if (path === '/api/owner/approve' && request.method === 'POST') {
    const body = await request.json();
    if (!positiveID(body?.id)) return reply({ error: 'A valid applicant ID is required.' }, corsHeaders, 400);
    for (let attempt = 0; attempt < 128; attempt++) {
      const key = accessKey();
      try {
        const row = await env.DB.prepare(
          "UPDATE streamers SET streamer_id = ?, status = 'APPROVED' WHERE id = ? AND status = 'PENDING' RETURNING id, streamer_name, streamer_id, status"
        ).bind(key, Number(body.id)).first();
        if (row) return reply({ streamer: row }, corsHeaders);
        const existing = await env.DB.prepare('SELECT id, streamer_name, streamer_id, status FROM streamers WHERE id = ?')
          .bind(Number(body.id)).first();
        if (!existing) return reply({ error: 'Applicant not found.' }, corsHeaders, 404);
        if (existing.status === 'APPROVED') return reply({ streamer: existing, already_approved: true }, corsHeaders);
        return reply({ error: 'Applicant is not pending.' }, corsHeaders, 409);
      } catch (error) {
        if (/UNIQUE constraint failed: streamers.streamer_id/i.test(error.message)) continue;
        throw error;
      }
    }
    return reply({ error: 'No access key available right now. Retry later.' }, corsHeaders, 503);
  }
  if (path === '/api/owner/post-news' && request.method === 'POST') {
    const body = await request.json();
    // Preserve the raw message; frontend rendering always uses textContent.
    if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 4000) {
      return reply({ error: 'A bulletin must contain 1–4000 characters.' }, corsHeaders, 400);
    }
    const row = await env.DB.prepare('INSERT INTO news (message) VALUES (?) RETURNING id, message, posted_at')
      .bind(body.message).first();
    return reply({ bulletin: row }, corsHeaders, 201);
  }
  if (path === '/api/owner/reveal-winner' && request.method === 'GET') {
    const userID = url.searchParams.get('user_id') || '';
    if (!/^\d{10}$/.test(userID)) return reply({ error: 'UserID must be exactly 10 digits.' }, corsHeaders, 400);
    const profile = await env.DB.prepare(
      'SELECT user_id, username, tiktok_username, roblox_username, ml_id, ml_server FROM users WHERE user_id = ?'
    ).bind(userID).first();
    if (!profile) return reply({ error: 'UserID not found.' }, corsHeaders, 404);
    // Never reveal passwords, PINs, secret answers, or their hashes.
    return reply({ profile }, corsHeaders);
  }
  const known = ['/api/owner/telemetry', '/api/owner/approve', '/api/owner/post-news', '/api/owner/reveal-winner'];
  return reply({ error: known.includes(path) ? 'Method not allowed.' : 'Route not found.' }, corsHeaders,
    known.includes(path) ? 405 : 404);
}
