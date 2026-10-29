// llm.js - the TikSpin helper engine.
//
// Self-contained and fully offline: it matches a player's message against the topics in llm.json
// (keywords, phrases, typos, Taglish) and returns a prepared answer. It never calls an outside AI,
// never reads the database and never changes anything. All it returns is text, suggestion chips and,
// for a few topics, a "request" flag. The server decides what that flag allows and validates everything.

const MAX_MESSAGE = 300;

// Topics that open a form on the page. The page does the form, and the server checks everything again.
//   tiktok  change TikTok @username     name  change display username
//   recover forgot password (PIN)       pin   lost PIN (email request code)
const REQUEST_KINDS = ['tiktok', 'name', 'recover', 'pin'];

const strip = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Lowercase, drop accents, keep letters/digits, and keep "@" and "&" as their own tokens.
export const normalize = (s) =>
  strip(s).replace(/[@&]/g, ' $& ').replace(/[^a-z0-9@&]+/g, ' ').replace(/\s+/g, ' ').trim();

// Clean raw input from a player. Returns '' when there is nothing usable.
export const cleanMessage = (s) =>
  typeof s !== 'string' ? '' : s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);

// Edit distance where swapping two neighbouring letters ("regsiter") counts as one typo.
const lev = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};

// Does the player's message contain this single word, allowing a typo or a shared stem?
const tokenHit = (tokens, word) => {
  if (tokens.includes(word)) return 'exact';
  if (word.length < 5) return '';
  const tol = word.length >= 9 ? 2 : 1;
  for (const t of tokens) {
    if (t.length < 4) continue;
    if (Math.abs(t.length - word.length) <= tol && lev(t, word) <= tol) return 'fuzzy';
    if (t.length >= 5 && (word.startsWith(t) || t.startsWith(word))) return 'fuzzy';
  }
  return '';
};

export function validateKb(kb) {
  const problems = [];
  const ids = new Set();
  (kb.topics || []).forEach((t) => {
    if (!t.id || ids.has(t.id)) problems.push(`duplicate or missing id: ${t.id}`);
    ids.add(t.id);
    if (!t.answer) problems.push(`${t.id}: no answer`);
    if (!Array.isArray(t.keywords) || !t.keywords.length) problems.push(`${t.id}: no keywords`);
    if (t.request && !REQUEST_KINDS.includes(t.request)) problems.push(`${t.id}: unknown request kind ${t.request}`);
  });
  (kb.topics || []).forEach((t) => (t.related || []).forEach((r) => { if (!ids.has(r)) problems.push(`${t.id}: related topic ${r} does not exist`); }));
  return problems;
}

export function createBot(kb) {
  const stop = new Set((kb.stopwords || []).map(normalize));
  const minScore = typeof kb.min_score === 'number' ? kb.min_score : 1.9;
  const byId = new Map();

  const topics = (kb.topics || []).map((t, order) => {
    const compiled = (t.keywords || []).map((k) => {
      const text = normalize(k);
      const words = text.split(' ').filter(Boolean);
      return { text, words, sig: words.filter((w) => !stop.has(w)), phrase: words.length > 1 };
    }).filter((k) => k.text);
    const topic = { ...t, order, weight: t.weight || 1, compiled };
    byId.set(t.id, topic);
    return topic;
  });

  const scoreTopic = (topic, padded, tokens) => {
    let score = 0;
    for (const k of topic.compiled) {
      if (k.phrase) {
        if (padded.includes(` ${k.text} `)) score += Math.min(7, 1.6 * k.words.length + 0.8);
        else if (k.sig.length >= 2 && k.sig.every((w) => tokenHit(tokens, w))) score += 1.1 * k.sig.length;
      } else {
        const hit = tokenHit(tokens, k.text);
        if (hit === 'exact') score += 2;
        else if (hit === 'fuzzy') score += 1.4;
      }
    }
    return score * topic.weight;
  };

  const suggest = (ids, selfId) =>
    ids.filter((id) => id !== selfId && byId.has(id)).slice(0, 3).map((id) => {
      const t = byId.get(id);
      return t.ask || t.title;
    });

  return {
    enabled: kb.enabled !== false,
    name: kb.name || 'Helper',
    greeting: kb.greeting || '',
    quick: kb.quick || [],

    // Returns { id, type: 'answer' | 'request' | 'fallback', text, kind, suggestions, score }.
    // Text still contains {placeholders}; the server fills them with live values.
    reply(message) {
      const msg = cleanMessage(message);
      if (!msg) return null;
      const norm = normalize(msg);
      const padded = ` ${norm} `;
      const tokens = norm.split(' ').filter((w) => w && !stop.has(w));

      const ranked = topics
        .map((t) => ({ t, score: scoreTopic(t, padded, tokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.t.order - b.t.order);

      const best = ranked[0];
      // A one- or two-word message with a single typo ('regsiter') is still a clear question.
      const needed = tokens.length <= 2 ? Math.min(minScore, 1.35) : minScore;
      if (!best || best.score < needed) {
        const near = ranked.slice(0, 3).map((r) => r.t.ask || r.t.title);
        return { id: 'fallback', type: 'fallback', text: kb.fallback || '', kind: null, suggestions: near.length ? near : kb.quick || [], score: best ? best.score : 0 };
      }
      const t = best.t;
      const related = suggest(t.related || [], t.id);
      const runnerUp = ranked[1] && ranked[1].score >= minScore && ranked[1].score >= best.score * 0.85 ? ranked[1].t : null;
      if (runnerUp && !related.includes(runnerUp.ask || runnerUp.title)) related.push(runnerUp.ask || runnerUp.title);
      return { id: t.id, type: t.request ? 'request' : 'answer', text: t.answer, kind: t.request || null, suggestions: related.slice(0, 3), score: best.score };
    }
  };
}

// Replace {placeholders} with live values. Unknown placeholders become empty text.
export const fill = (text, vars) => String(text || '').replace(/\{([a-z_]+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
