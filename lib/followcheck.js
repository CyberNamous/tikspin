// TikSpin - checks the text read from a player's "I follow this streamer" screenshot.
//
// The reading itself (OCR) happens on the player's phone. The server only judges the text it is sent, and it is
// strict: the streamer's display name and @username must appear, and the profile button must say "Following".
// When this check fails, the player can send the screenshot to the streamer for manual review instead.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

// Fuzzy "does the OCR text contain this label" check. Only letters and digits are compared,
// so OCR noise like "@", "_" or stray symbols never breaks a match.
export const fuzzyHas = (text, target, maxDist) => {
  const hay = norm(text);
  const t = norm(target);
  if (!t) return false;
  if (hay.includes(t)) return true;
  if (maxDist < 1 || t.length < 7) return false;
  for (let i = 0; i < hay.length; i++) {
    for (let d = -maxDist; d <= maxDist; d++) {
      const len = t.length + d;
      if (len > 0 && i + len <= hay.length && lev(hay.substr(i, len), t) <= maxDist) return true;
    }
  }
  return false;
};

const isFollowingToken = (tok) =>
  tok.length >= 7 && tok.length <= 11 && (tok.startsWith('followin') || lev(tok, 'following') <= 2);
const isMessageToken = (tok) => tok.length >= 6 && tok.length <= 8 && lev(tok, 'message') <= 1;

// The grey stat labels (Following / Followers / Likes) are low contrast and often missed by OCR, so they are
// not relied on. The reliable signal is the button row: when you follow someone it reads "Message  Following".
// When you do not follow, that button says "Follow" instead. Mutual follows show "Friends".
export const followState = (text) => {
  const tokens = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const count = tokens.filter(isFollowingToken).length;
  const friends = tokens.some((t) => t === 'friends' || (t.length >= 6 && lev(t, 'friends') <= 1));
  let button = false;
  tokens.forEach((t, i) => {
    if (!isMessageToken(t)) return;
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) if (isFollowingToken(tokens[j])) button = true;
  });
  return { count, friends, button, following: button || count >= 2 || (count >= 1 && friends) };
};

// streamer = { name, username }. Returns null when the text passes, otherwise { code, error }.
export const checkFollowText = (text, streamer) => {
  if (!fuzzyHas(text, streamer.name, 1)) {
    return { code: 'streamer', error: `We could not find the streamer name "${streamer.name}" in the screenshot.` };
  }
  if (!fuzzyHas(text, streamer.username, streamer.username.length >= 10 ? 2 : 1)) {
    return { code: 'streamer', error: `We could not find the username @${streamer.username} in the screenshot.` };
  }
  const f = followState(text);
  if (!f.following) {
    return {
      code: 'follow',
      error: f.count >= 1
        ? 'The screenshot shows a Follow button, not Following. Follow the streamer on TikTok first, then take a new screenshot.'
        : 'We could not find the word "Following" in the screenshot. Make sure the whole profile header is visible.'
    };
  }
  return null;
};

export const cleanOcr = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.:+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
