/* TikSpin - maintenance control (owner only).
 *
 * One small widget that turns maintenance on or off with a timer. It is used by /maintenance-switch and can be dropped
 * into the owner panel with three lines:
 *
 *   <div id="maintCard"></div>
 *   <script src="/maintenance-control.js"></script>
 *   <script>MaintenanceControl.mount('#maintCard', { getKey: () => YOUR_OWNER_KEY });</script>
 *
 * getKey() returns the owner key the panel already holds. Leave getKey out and the widget shows its own key box.
 * The widget styles itself (classes start with mc-) and picks up the page colours when they exist.
 */
(function () {
  var STYLE_ID = 'mc-style';
  var CSS = [
    '.mc{color:var(--text,#fff);font:inherit;line-height:1.5}',
    '.mc *{box-sizing:border-box}',
    '.mc-card{background:var(--panel,#16102a);border:1px solid var(--line,#33264f);border-radius:16px;padding:16px;margin:0 0 12px}',
    '.mc h3{margin:0 0 6px;font-size:1.05rem;color:var(--pink,#e58bff)}',
    '.mc-muted{color:var(--muted,#b3a9d9);font-size:.9rem}',
    '.mc-pill{display:inline-block;border-radius:99px;padding:3px 12px;font-weight:800;font-size:.85rem}',
    '.mc-pill.on{background:#3a1220;color:#ff7a93}.mc-pill.off{background:#12392a;color:#7be0a4}',
    '.mc-clock{font-size:1.9rem;font-weight:900;letter-spacing:1px;margin:6px 0 2px;font-variant-numeric:tabular-nums}',
    '.mc label{display:block;font-size:.85rem;color:var(--muted,#b3a9d9);margin:14px 0 5px}',
    '.mc input[type=text],.mc input[type=password],.mc input[type=number]{width:100%;border:1px solid var(--line,#33264f);background:#0f0a20;border-radius:10px;padding:12px;font:inherit;color:var(--text,#fff)}',
    '.mc-seg{display:flex;flex-wrap:wrap;gap:8px}',
    '.mc-seg button{flex:1 1 auto;min-width:72px;margin:0;border:1.5px solid var(--line,#33264f);background:transparent;color:var(--muted,#b3a9d9);border-radius:10px;padding:10px 12px;font:inherit;font-weight:700;cursor:pointer;width:auto}',
    '.mc-seg button[aria-pressed=true]{background:#2a1d4d;color:var(--pink,#e58bff);border-color:var(--pink2,#d54bf0)}',
    '.mc-row{display:flex;gap:10px;margin-top:16px}',
    '.mc-btn{flex:1;margin:0;border:0;border-radius:12px;font:inherit;font-weight:800;padding:13px;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--neon,#a23cf0),var(--pink2,#d54bf0));width:auto}',
    '.mc-btn.off{background:#12392a;color:#7be0a4;border:1px solid #1f6b4a}',
    '.mc-btn.ghost{background:transparent;border:1.5px solid var(--line,#33264f);color:var(--pink,#e58bff)}',
    '.mc-btn:disabled{opacity:.6;cursor:wait}',
    '.mc-out{margin-top:12px;min-height:1.4em;font-size:.92rem}',
    '.mc-out.bad{color:#ff7a93}.mc-out.good{color:#7be0a4}',
    '.mc button:focus-visible,.mc input:focus-visible{outline:2px solid var(--pink,#e58bff);outline-offset:2px}',
    '.mc [hidden]{display:none!important}'
  ].join('');

  var PRESETS = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], ['custom', 'Custom'], [0, 'Until I turn it off']];

  function el(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null && c !== false) e.append(c); }
    return e;
  }

  function fmt(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + p(m) + ':' + p(r) : m + ':' + p(r);
  }
  var clock = function (ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

  function mount(target, opts) {
    opts = opts || {};
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return null;
    if (!document.getElementById(STYLE_ID)) { var st = el('style', { id: STYLE_ID }); st.textContent = CSS; document.head.append(st); }

    var state = null, offset = 0, minutes = 30, ticker = 0, poller = 0, busy = false;

    var pill = el('span', { class: 'mc-pill off', text: 'Checking...' });
    var detail = el('div', { class: 'mc-muted' });
    var clockEl = el('div', { class: 'mc-clock', role: 'timer', hidden: true });
    var statusCard = el('div', { class: 'mc-card' }, el('h3', { text: 'Maintenance' }), el('div', null, pill), clockEl, detail);

    var keyIn = opts.getKey ? null : el('input', { type: 'password', id: 'mc-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'The same key as your owner panel' });
    var msgIn = el('input', { type: 'text', id: 'mc-msg', maxlength: '200', placeholder: 'We are updating TikSpin. Back soon!' });
    var minsIn = el('input', { type: 'number', id: 'mc-mins', min: '1', max: '1440', inputmode: 'numeric', placeholder: 'Minutes (1 to 1440)', hidden: true });
    var warn = el('div', { class: 'mc-muted', hidden: true, text: 'TikSpin stays down until you switch maintenance off yourself.' });
    var seg = el('div', { class: 'mc-seg', role: 'group', 'aria-label': 'How long' });
    var out = el('div', { class: 'mc-out', role: 'status', 'aria-live': 'polite' });
    var onBtn = el('button', { type: 'button', class: 'mc-btn', text: 'Turn ON', onclick: function () { send(true, false); } });
    var offBtn = el('button', { type: 'button', class: 'mc-btn off', text: 'Turn OFF now', onclick: function () { send(false, false); } });
    var extBtn = el('button', { type: 'button', class: 'mc-btn ghost', text: 'Add 15 minutes', hidden: true, onclick: function () { send(true, true); } });

    function pick(v) {
      minutes = v;
      Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', String(String(b.dataset.v) === String(v))); });
      minsIn.hidden = v !== 'custom';
      warn.hidden = v !== 0;
      if (v === 'custom') minsIn.focus();
    }
    PRESETS.forEach(function (p) {
      seg.append(el('button', { type: 'button', 'data-v': String(p[0]), 'aria-pressed': 'false', text: p[1], onclick: function () { pick(p[0]); } }));
    });

    var form = el('div', { class: 'mc-card' },
      el('h3', { text: 'Turn maintenance on' }),
      el('div', { class: 'mc-muted', text: 'Every page shows the maintenance screen. TikSpin comes back by itself when the time is up.' }),
      keyIn && el('label', { for: 'mc-key', text: 'Owner key' }), keyIn,
      el('label', { text: 'How long' }), seg, minsIn, warn,
      el('label', { for: 'mc-msg', text: 'Message visitors see (optional)' }), msgIn,
      el('div', { class: 'mc-row' }, onBtn, offBtn), el('div', { class: 'mc-row', style: 'margin-top:10px' }, extBtn), out);

    var root = el('div', { class: 'mc' }, statusCard, form);
    host.replaceChildren(root);
    pick(30);

    function setOut(text, kind) { out.className = 'mc-out' + (kind ? ' ' + kind : ''); out.textContent = text; }

    function render() {
      var s = state, running = !!(s && s.on);
      pill.className = 'mc-pill ' + (running ? 'on' : 'off');
      pill.textContent = running ? 'Maintenance is ON' : 'TikSpin is open';
      extBtn.hidden = !(running && s.until);
      if (!s) { detail.textContent = ''; clockEl.hidden = true; return; }
      if (running && s.until) {
        clockEl.hidden = false;
        detail.textContent = 'Ends by itself at ' + clock(s.until) + '. ' + s.message;
        tick();
      } else if (running) {
        clockEl.hidden = true;
        detail.textContent = 'No end time. It stays on until you turn it off. ' + s.message;
      } else {
        clockEl.hidden = true;
        detail.textContent = s.ended ? 'Maintenance ended by itself. Visitors can use TikSpin normally.' : 'Visitors can use TikSpin normally.';
      }
    }

    function tick() {
      if (!state || !state.on || !state.until) return;
      var left = state.until - (Date.now() + offset);
      if (left <= 0) { clockEl.textContent = '0:00'; load(); return; }
      clockEl.textContent = fmt(left) + ' left';
    }

    function load() {
      return fetch('/api/sitemode/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
        if (!s || !s.ok) throw new Error('bad');
        offset = (s.now || Date.now()) - Date.now(); state = s; render();
      }).catch(function () { pill.className = 'mc-pill on'; pill.textContent = 'Could not load the status'; });
    }

    function send(on, extend) {
      if (busy) return;
      setOut('');
      var done = function (key) {
        if (!key) { setOut('Enter your owner key first.', 'bad'); return; }
        var mins = 0;
        if (on) {
          if (extend) mins = Math.max(Math.ceil(((state && state.until || 0) - (Date.now() + offset)) / 60000), 0) + 15;
          else if (minutes === 'custom') {
            mins = Math.floor(Number(minsIn.value));
            if (!(mins >= 1 && mins <= 1440)) { setOut('Enter a number of minutes from 1 to 1440.', 'bad'); return; }
          } else mins = Number(minutes) || 0;
        }
        busy = true; onBtn.disabled = offBtn.disabled = extBtn.disabled = true;
        fetch('/api/sitemode/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({ on: on, minutes: mins, extend: !!extend, message: extend && !msgIn.value ? (state && state.message !== undefined && state.message) || '' : msgIn.value })
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, d: d }; }); })
          .then(function (res) {
            if (res.status === 200 && res.d.ok) {
              setOut(!on ? 'Maintenance is OFF. TikSpin is open.' : res.d.until ? 'Maintenance is ON until ' + clock(res.d.until) + '. TikSpin returns to normal by itself.' : 'Maintenance is ON. It stays on until you turn it off.', 'good');
              return load();
            }
            setOut(res.status === 401 ? 'That key is not right.' : res.status === 429 ? 'Too many tries. Wait a little and try again.' : (res.d.error || 'That did not work.'), 'bad');
          })
          .catch(function () { setOut('Could not reach TikSpin. Check your connection.', 'bad'); })
          .then(function () { busy = false; onBtn.disabled = offBtn.disabled = extBtn.disabled = false; });
      };
      if (opts.getKey) Promise.resolve(opts.getKey()).then(done, function () { done(''); });
      else done(keyIn.value.trim());
    }

    ticker = setInterval(tick, 1000);
    poller = setInterval(load, 15000);
    load();
    return { refresh: load, destroy: function () { clearInterval(ticker); clearInterval(poller); host.replaceChildren(); } };
  }

  window.MaintenanceControl = { mount: mount };
})();
