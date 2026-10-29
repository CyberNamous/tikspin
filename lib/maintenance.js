// TikSpin - daily cleanup, run by the cron trigger (see index.js `scheduled`).
//
// This is where the promises in the Terms are kept: entry data is removed after a giveaway ends, evidence and
// screenshots do not linger, and old technical records do not pile up. It only ever deletes things that are
// expired or finished, and it logs counts, never names.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export async function runMaintenance(env, now) {
  const db = env.DB;
  // Each step: [label, statement]. They run together in one batch.
  const steps = [
    // --- sign-in and limits
    ['sessions', db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now)],
    ['orphan sessions', db.prepare(
      `DELETE FROM sessions WHERE (role = 'player' AND user_id NOT IN (SELECT id FROM players))
                               OR (role = 'streamer' AND user_id NOT IN (SELECT id FROM streamers))`)],
    // the longest limiter window is the 24-hour PIN lock
    ['rate limits', db.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(now - 25 * HOUR)],

    // --- invitations and reset requests
    ['invitations', db.prepare(
      `DELETE FROM invitations WHERE created_at < ?1
         AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < ?2)`).bind(now - 30 * DAY, now - 30 * DAY)],
    ['reset requests expired', db.prepare("UPDATE reset_requests SET status = 'cancelled' WHERE status = 'open' AND expires_at <= ?1").bind(now)],
    ['reset requests old', db.prepare("DELETE FROM reset_requests WHERE status != 'open' AND created_at < ?1").bind(now - 30 * DAY)],
    ['orphan reset requests', db.prepare(
      `DELETE FROM reset_requests WHERE (account_kind = 'player' AND account_id NOT IN (SELECT id FROM players))
                                     OR (account_kind = 'streamer' AND account_id NOT IN (SELECT id FROM streamers))`)],

    // --- giveaways: a passed deadline closes entries; an ended giveaway is removed 24 hours later
    // (the 24 hours let players and viewers still see the winner). Entries and disqualifications go with it.
    ['deadline closes', db.prepare(
      "UPDATE giveaways SET status = 'closed', closed_at = expires_at WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?1").bind(now)],
    ['ended giveaways', db.prepare("DELETE FROM giveaways WHERE status = 'ended' AND ended_at < ?1").bind(now - DAY)],
    ['scheduled', db.prepare('DELETE FROM scheduled_giveaways WHERE starts_at < ?1').bind(now - 2 * HOUR)],

    // --- screenshots and evidence
    ['stale reviews', db.prepare(
      `UPDATE follow_proofs SET status = 'rejected', reject_reason = 'The host did not decide within 7 days.', screenshot = NULL, decided_at = ?1
        WHERE status = 'pending' AND created_at < ?2`).bind(now, now - 7 * DAY)],
    ['leftover screenshots', db.prepare("UPDATE follow_proofs SET screenshot = NULL WHERE status != 'pending' AND screenshot IS NOT NULL")],
    ['leftover evidence', db.prepare("UPDATE reports SET evidence = NULL WHERE status != 'open' AND evidence IS NOT NULL")],
    ['old decided reports', db.prepare("DELETE FROM reports WHERE status != 'open' AND decided_at < ?1").bind(now - 180 * DAY)],

    // --- small things
    ['feedback', db.prepare('DELETE FROM feedback WHERE created_at < ?1').bind(now - 90 * DAY)],
    ['wheel alerts', db.prepare('DELETE FROM live_alerts WHERE streamer_id IS NOT NULL AND created_at < ?1').bind(now - HOUR)],
    ['owner alerts', db.prepare('DELETE FROM live_alerts WHERE streamer_id IS NULL AND created_at < ?1').bind(now - 30 * DAY)],
    ['action log', db.prepare('DELETE FROM action_log WHERE created_at < ?1').bind(now - 90 * DAY)]
  ];

  const results = await db.batch(steps.map((s) => s[1]));
  const summary = {};
  steps.forEach((s, i) => {
    const n = results[i] && results[i].meta ? results[i].meta.changes : 0;
    if (n) summary[s[0]] = n;
  });
  console.log('Maintenance done:', JSON.stringify(summary));
  return summary;
}
