/* js/app/14-basket-live.js — basket, sold watcher, live search.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- shopping basket ------------------------------------------------------------
// button that copies text built at click time, with a brief confirmation
function copyButton(label, textFn) {
  var btn = UI.button('secondary');
  btn.textContent = label;
  btn.title = 'Copy as text — paste into Discord, notes, or a message to a friend';
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    var text = textFn();
    var done = function () { btn.textContent = '✔ Copied'; setTimeout(function () { btn.textContent = label; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  });
  return btn;
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
  ta.remove();
}

function loadBasket() {
  try { return JSON.parse(localStorage.getItem('pobtf-basket')) || []; }
  catch (e) { return []; }
}
function saveBasket(b) {
  try { persist('pobtf-basket', JSON.stringify(b.slice(0, 40))); }
  catch (e) { /* fine */ }
}
function pinToBasket(li, state) {
  var b = loadBasket();
  // link back to the trade-site search that produced this listing (frozen at
  // search time, so later UI tweaks don't change what the pin points at)
  var tradeUrl = null;
  var ps = state && state.priceState;
  if (ps && ps.payloadStr && ps.league) {
    tradeUrl = 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(ps.league) +
               '?q=' + encodeURIComponent(ps.payloadStr);
  }
  b.push({ name: li.name, base: li.base, amount: li.amount, currency: li.currency,
           account: li.account, whisper: li.whisper, tradeUrl: tradeUrl, ts: Date.now() });
  saveBasket(b);
  renderBasket();
  UI.toast('Pinned to your basket in the Upgrade planner.', 'success',
    { action: { label: 'View', onClick: function () { setView('planner'); window.scrollTo(0, 0); } } });
}
function renderBasket() {
  updateNavCounts();
  var box = document.getElementById('basket');
  var b = loadBasket();
  if (!b.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  var league = document.getElementById('league').value;
  var total = 0, totalKnown = true;
  b.forEach(function (it) {
    var rate = RATES[league] && RATES[league][it.currency];
    if (it.amount !== null && it.amount !== undefined && rate !== undefined) total += it.amount * rate;
    else totalKnown = false;
  });
  var copyList = copyButton('📋 Copy list', function () {
    var lines = ['Shopping list (' + league + ')' + (total ? ' — ' + (totalKnown ? '' : '≥ ') + fmtEq(total, league) : '')];
    b.forEach(function (it) {
      lines.push('- ' + ((it.name ? it.name + ' ' : '') + it.base) + ' — ' + it.account + ' — ' +
        ((it.amount !== null && it.amount !== undefined) ? it.amount + ' ' + it.currency : 'no price'));
      if (it.whisper) lines.push('  ' + it.whisper);
      if (it.tradeUrl) lines.push('  ' + it.tradeUrl);
    });
    return lines.join('\n');
  });
  var clear = UI.button('secondary', { label: 'Clear', onClick: function () {
    UI.confirmDanger('Clear the basket?', 'All ' + b.length + ' pinned item(s) will be removed.', 'Clear basket')
      .then(function (ok) { if (ok) { saveBasket([]); renderBasket(); } });
  } });
  box.appendChild(UI.sectionHeader('Shopping basket — ' + b.length + ' item(s)' +
    (total ? ' · ' + (totalKnown ? '' : '≥ ') + fmtEq(total, league) : ''), [copyList, clear]));

  function basketActions(it, idx) {
    var row = UI.el('span', 'row-acts');
    if (it.tradeUrl) {
      var tl = UI.button('secondary', { size: 'sm' });
      tl.textContent = '↗ Trade';
      tl.title = 'Open the search that found this item on the trade site';
      tl.addEventListener('click', function () { openUrl(it.tradeUrl); });
      row.appendChild(tl);
    }
    if (it.whisper && isGui()) {
      var w = UI.button('secondary', { size: 'sm' });
      w.textContent = '⚡ Whisper';
      w.addEventListener('click', function () { sendPoeChat(w, it.whisper, '⚡ Whisper'); });
      row.appendChild(w);
    }
    row.appendChild(UI.iconButton('✕', 'Remove from basket', { variant: 'secondary', size: 'sm', onClick: function () {
      UI.confirmDanger('Remove from basket?', ((it.name ? it.name + ' ' : '') + it.base) + ' — ' + it.account, 'Remove')
        .then(function (ok) {
          if (!ok) return;
          var cur = loadBasket();
          cur.splice(idx, 1);
          saveBasket(cur);
          renderBasket();
        });
    } }));
    return row;
  }
  var indexed = b.map(function (it, idx) { return { it: it, idx: idx }; });
  box.appendChild(UI.table([
    { key: 'item', label: 'Item', render: function (r) { return (r.it.name ? r.it.name + ' ' : '') + r.it.base; } },
    { key: 'seller', label: 'Seller', render: function (r) { return r.it.account; } },
    { key: 'price', label: 'Price', num: true, render: function (r) {
      return (r.it.amount !== null && r.it.amount !== undefined) ? r.it.amount + ' ' + r.it.currency : 'no price';
    } },
    { key: 'acts', label: '', render: function (r) { return basketActions(r.it, r.idx); } }
  ], indexed));
}

// ---- sold watcher: periodically re-check open results, grey out listings ------
// that have disappeared (sold/delisted) until the next manual Check price.
// One shared timer, round-robin over cards with open results — one API call
// per tick keeps rate limits safe no matter how many result panels are open.
var soldWatcherTimer = null;
var soldWatcherIdx = 0;

function ensureSoldWatcher() {
  if (soldWatcherTimer || !isGui()) return;
  soldWatcherTimer = setInterval(soldWatcherTick, window.SOLD_WATCH_MS || 60000);
}

async function soldWatcherTick() {
  var watchable = cards.filter(function (s) { return s.priceState && !s.live; });
  if (!watchable.length) return;
  var state = watchable[soldWatcherIdx++ % watchable.length];
  try {
    // re-run the exact query that produced the displayed listings — NOT a
    // rebuild from current controls, which may have been tweaked since
    var ps = state.priceState;
    if (!ps.payloadStr) return;
    var res = await window.pywebview.api.trade_search(ps.league, ps.payloadStr);
    if (!res.ok || state.priceState !== ps) return;
    var alive = {};
    (res.ids || []).forEach(function (i) { alive[i] = 1; });
    state.priceBox.querySelectorAll('.listing[data-lid]').forEach(function (el) {
      if (!alive[el.dataset.lid] && !el.classList.contains('sold')) {
        el.classList.add('sold');
        var nm = el.querySelector('.listing-name');
        if (nm) {
          var b = document.createElement('span');
          b.className = 'badge sold-badge';
          b.textContent = 'sold / delisted';
          nm.appendChild(b);
        }
      }
    });
  } catch (e) { /* transient — try again next tick */ }
}

// ---- live search: poll for new listings, ding on arrival (desktop app only) ----
var liveCount = 0;
var audioCtx = null;
var HAS_SESSION = false; // POESESSID saved -> instant WebSocket live search

// fill the character dropdown, current league first, then by level
function populateCharSelect(characters) {
  var league = document.getElementById('league').value;
  var sorted = characters.slice().sort(function (a, b) {
    var al = a.league === league ? 0 : 1, bl = b.league === league ? 0 : 1;
    return al !== bl ? al - bl : (b.level || 0) - (a.level || 0);
  });
  var sel = document.getElementById('char-select');
  sel.innerHTML = '';
  sorted.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c.name;
    o.textContent = (c.league === league ? '★ ' : '') + c.name +
      ' (' + c.league + ' lvl ' + c.level + ' ' + c['class'] + ')';
    sel.appendChild(o);
  });
  sel.classList.remove('hidden');
  document.getElementById('char-compare').classList.remove('hidden');
}

async function refreshSessionStatus(deep) {
  if (!isGui() || !window.pywebview.api.session_status) return;
  try {
    var r = await window.pywebview.api.session_status();
    HAS_SESSION = !!(r && r.set);
    var el = document.getElementById('sessid-status');
    if (!el) return;
    if (!HAS_SESSION) { el.textContent = ''; return; }
    if (deep && window.pywebview.api.session_validate) {
      // live check against GGG — expired sessions show up here instead of
      // failing silently when a live search tries to connect
      var v = await window.pywebview.api.session_validate();
      if (v && v.ok && v.valid) {
        el.textContent = '🟢 session active — instant alerts on';
      } else if (v && v.ok) {
        HAS_SESSION = false;
        el.textContent = '🔴 session expired — save a fresh POESESSID';
      } // network errors: leave the last known state alone
    } else {
      el.textContent = '🟢 instant alerts on';
    }
  } catch (e) { /* browser mode */ }
}

function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no sound */ }
  }
}

function playDing() {
  if (!audioCtx || !PREFS.sound) return;
  try {
    var peak = Math.max(0.02, Math.min(1, (parseInt(PREFS.volume, 10) || 25) / 100));
    var t = audioCtx.currentTime;
    [880, 1320].forEach(function (freq, i) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(peak, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.4);
    });
  } catch (e) { /* ignore */ }
}

async function toggleLive(state) {
  if (!isGui()) { UI.toast('Live search needs the desktop app (run PoB Trade Finder.bat).', 'warn'); return; }
  if (state.live) { stopLive(state); return; }
  if (liveCount >= 2) { UI.toast('Max 2 live searches at once — GGG rate limits.', 'warn'); return; }
  var payload = buildTradePayload(state);
  if (!payload) return;
  initAudio();
  liveCount++;
  // freeze the query at go-live: mid-session control changes must not shift
  // the result window (that would make old listings look "new")
  state.live = { seen: null, timer: null, found: 0, subId: null,
                 mode: HAS_SESSION ? 'ws' : 'poll',
                 payloadStr: JSON.stringify(payload),
                 league: document.getElementById('league').value };
  state.liveBtn.textContent = '⏹ Stop live';
  state.liveBtn.classList.add('live-active');
  state.liveBox.classList.remove('hidden');
  state.liveBox.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'live-head';
  head.textContent = state.live.mode === 'ws'
    ? '🟢 INSTANT — connecting to the live-search WebSocket…'
    : '🔴 LIVE — watching for new listings…';
  var feed = document.createElement('div');
  state.liveBox.appendChild(head);
  state.liveBox.appendChild(feed);
  state.live.head = head;
  state.live.feed = feed;
  if (state.live.mode === 'ws') startWsLive(state);
  else liveTick(state);
}

function stopLive(state) {
  if (!state.live) return;
  clearTimeout(state.live.timer);
  clearInterval(state.live.timer);
  if (state.live.subId && isGui() && window.pywebview.api.live_stop) {
    window.pywebview.api.live_stop(state.live.subId).then(function () {}, function () {});
  }
  state.live = null;
  liveCount--;
  if (state.liveBtn) {
    state.liveBtn.textContent = '🔴 Go live';
    state.liveBtn.classList.remove('live-active');
  }
  if (state.liveBox && state.live === null) {
    var h = state.liveBox.querySelector('.live-head');
    if (h) h.textContent = '⏹ live stopped';
  }
}

// Windows toast for live hits — only when the app is in the background
// (the in-app ding and highlight cover the foreground case)
function notifyLiveHit(state, listings, freshCount) {
  if (PREFS.notify === false || !isGui() || !window.pywebview.api.notify || document.hasFocus()) return;
  var cheapest = null;
  (listings || []).forEach(function (li) {
    if (li.amount == null) return;
    var rate = RATES[document.getElementById('league').value] && RATES[document.getElementById('league').value][li.currency];
    var chaos = rate !== undefined ? li.amount * rate : null;
    if (!cheapest || (chaos !== null && (cheapest.chaos === null || chaos < cheapest.chaos))) cheapest = { li: li, chaos: chaos };
  });
  var title = freshCount + ' new listing' + (freshCount > 1 ? 's' : '') + ' — ' + (state.slot || 'live search');
  var body = cheapest
    ? ((cheapest.li.name ? cheapest.li.name + ' ' : '') + cheapest.li.base + ' for ' + cheapest.li.amount + ' ' + cheapest.li.currency)
    : 'Open PoB Trade Finder to see it';
  window.pywebview.api.notify(title, body).then(function () {}, function () {});
}

// shared renderer for freshly-arrived live listings (polling or WebSocket)
function renderLiveFresh(state, session, listings, freshCount) {
  playDing();
  notifyLiveHit(state, listings, freshCount);
  session.found += freshCount;
  var tails = tailsFor(state);
  var stamp = document.createElement('div');
  stamp.className = 'live-stamp';
  stamp.textContent = '— ' + freshCount + ' new @ ' + new Date().toLocaleTimeString() + ' —';
  session.feed.insertBefore(stamp, session.feed.firstChild);
  listings.slice().reverse().forEach(function (li) {
    var card = listingCard(li, tails, state);
    card.classList.add('live-new');
    session.feed.insertBefore(card, session.feed.firstChild);
  });
  session.head.textContent = (session.mode === 'ws' ? '🟢 INSTANT — ' : '🔴 LIVE — ') +
    session.found + ' new listing(s) found so far';
}

async function startWsLive(state) {
  var session = state.live;
  try {
    var res = await window.pywebview.api.live_start(session.league, session.payloadStr);
    if (state.live !== session) {
      if (res && res.ok) window.pywebview.api.live_stop(res.subId).then(function () {}, function () {});
      return;
    }
    if (!res.ok) {
      session.mode = 'poll';
      session.head.textContent = '🔴 LIVE (polling — instant unavailable: ' + res.error + ')';
      liveTick(state);
      return;
    }
    session.subId = res.subId;
    session.head.textContent = '🟢 INSTANT — ' + res.total +
      ' existing listings, new ones alert the moment they appear';
    session.timer = setInterval(function () { wsPoll(state, session); }, 1500);
  } catch (e) {
    if (state.live === session) {
      session.mode = 'poll';
      session.head.textContent = '🔴 LIVE (polling — ' + e.message + ')';
      liveTick(state);
    }
  }
}

async function wsPoll(state, session) {
  if (state.live !== session) return;
  try {
    var r = await window.pywebview.api.live_poll(session.subId);
    if (state.live !== session || !r.ok) return;
    if (r.status && r.status.indexOf('error') === 0) {
      session.head.textContent = '🟠 INSTANT (reconnect needed) — ' + r.status +
        ' — is your POESESSID still valid?';
      return;
    }
    if (r.ids && r.ids.length) {
      var r2 = await window.pywebview.api.trade_fetch(session.subId, JSON.stringify(r.ids.slice(0, 10)));
      if (r2.ok && state.live === session && r2.listings.length) {
        renderLiveFresh(state, session, r2.listings, r.ids.length);
      }
    }
  } catch (e) { /* transient — next poll */ }
}

async function liveTick(state) {
  var session = state.live; // identity: a stop+restart must not revive this chain
  if (!session) return;
  try {
    var res = await window.pywebview.api.trade_search(session.league, session.payloadStr);
    if (res.ok && state.live === session) {
      var ids = res.ids || [];
      if (session.seen === null) {
        session.seen = {};
        ids.forEach(function (i) { session.seen[i] = 1; });
        session.head.textContent = '🔴 LIVE — ' + res.total + ' existing listings, watching for new ones (checks ~20s)';
      } else {
        var fresh = ids.filter(function (i) { return !session.seen[i]; });
        ids.forEach(function (i) { session.seen[i] = 1; });
        if (fresh.length) {
          var r2 = await window.pywebview.api.trade_fetch(res.searchId, JSON.stringify(fresh.slice(0, 10)));
          if (r2.ok && state.live === session) {
            renderLiveFresh(state, session, r2.listings, fresh.length);
          }
        }
      }
    }
  } catch (e) {
    // rate-limit cooldowns are worth surfacing; other errors just retry
    if (state.live === session && /cooldown|rate.?limit/i.test(e.message || '')) {
      session.head.textContent = '🔴 LIVE (paused) — ' + e.message;
    }
  }
  if (state.live === session) {
    session.timer = setTimeout(function () { liveTick(state); }, window.LIVE_INTERVAL_MS || 30000);
  }
}
