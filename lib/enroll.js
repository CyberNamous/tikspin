// TikSpin - the one place that puts a player on a giveaway's wheel, and checks permanent bans.
// Used by routes/player.js (self entry) and routes/streamer.js (approving a manual review).

// kind: 'display' | 'tiktok' | 'ml' | 'roblox'.  value: lowercase ('userid-serverid' for ml).
// pairs: [[kind, value], ...]. Returns true when any of them is on a Permanent Ban.
export const findBan = async (env, pairs) => {
  const list = pairs.filter((p) => p[1]);
  if (!list.length) return false;
  const clauses = list.map((_, i) => `(kind = ?${i * 2 + 1} AND value_lower = ?${i * 2 + 2})`).join(' OR ');
  const row = await env.DB.prepare(`SELECT 1 AS hit FROM ban_identifiers WHERE ${clauses} LIMIT 1`)
    .bind(...list.flat()).first();
  return !!row;
};

// Roblox: the lowercase username.  Mobile Legends: 'userid-serverid'. Used to spot two accounts claiming one identity.
export const identityFor = (game, profile) =>
  game === 'roblox' ? profile.handle.toLowerCase() : `${profile.userId}-${profile.serverId}`;

// Everything a ban check needs to know about a player entering a giveaway: names now, old TikTok names, game identity.
export const banPairsFor = async (env, player, game, profile) => {
  const old = await env.DB.prepare('SELECT old_lower FROM player_tiktok_history WHERE player_id = ?1').bind(player.id).all();
  return [
    ['display', player.display_lower],
    ['tiktok', player.tiktok_lower],
    ...old.results.map((r) => ['tiktok', r.old_lower]),
    game === 'roblox' ? ['roblox', profile.handle.toLowerCase()] : ['ml', identityFor('ml', profile)]
  ];
};

// Returns { ok: true, status: 'alive' | 'frozen' } or { ok: false, code, error }.
//   giveaway: { id, streamer_id, game }   player: players row   profile: { handle, userId, serverId }
//   opts: { source, device, now }
// If another player already holds the same game identity in this giveaway, BOTH entries are frozen. The streamer
// decides who is real. The platform never picks a side.
export async function enrollPlayer(env, giveaway, player, profile, opts) {
  const { source, device, now } = opts;
  const identity = identityFor(giveaway.game, profile);

  const banned = await env.DB.prepare('SELECT 1 AS hit FROM streamer_bans WHERE streamer_id = ?1 AND player_id = ?2')
    .bind(giveaway.streamer_id, player.id).first();
  if (banned) return { ok: false, code: 'host-ban', error: 'The host has removed you from their giveaways.' };

  const disq = await env.DB.prepare('SELECT reason FROM disqualified_entries WHERE giveaway_id = ?1 AND player_id = ?2 LIMIT 1')
    .bind(giveaway.id, player.id).first();
  if (disq) return { ok: false, code: 'disqualified', error: 'The host removed you from this giveaway.' };

  try {
    await env.DB.prepare(
      `INSERT INTO entries (giveaway_id, player_id, game_handle, ml_user_id, ml_server_id, identity_key, level,
                            device_hash, status, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 'alive', ?8, ?9)`
    ).bind(giveaway.id, player.id, profile.handle, profile.userId || '', profile.serverId || '', identity, device || '', source, now).run();
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) return { ok: false, code: 'entered', error: 'You are already entered in this giveaway.' };
    throw err;
  }

  const clash = await env.DB.prepare('SELECT 1 AS hit FROM entries WHERE giveaway_id = ?1 AND identity_key = ?2 AND player_id != ?3 LIMIT 1')
    .bind(giveaway.id, identity, player.id).first();
  if (clash) {
    await env.DB.prepare(
      `UPDATE entries SET status = 'frozen',
              freeze_reason = 'The same game account was entered by two different TikSpin accounts.'
        WHERE giveaway_id = ?1 AND identity_key = ?2 AND status = 'alive'`
    ).bind(giveaway.id, identity).run();
    return { ok: true, status: 'frozen' };
  }

  // A public line for the wheel overlay: display name only.
  await env.DB.prepare('INSERT INTO live_alerts (streamer_id, message, created_at) VALUES (?1, ?2, ?3)')
    .bind(giveaway.streamer_id, `${player.display_name} joined the wheel`, now).run();
  return { ok: true, status: 'alive' };
}
