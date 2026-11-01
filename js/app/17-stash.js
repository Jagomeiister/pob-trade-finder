/* js/app/17-stash.js — official Path of Exile login (OAuth) and the Stash value page.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- official login --------------------------------------------------------------------
// GGG's documented OAuth (oauth.py): off until GGG issues the app a client id — the
// Settings block says so and the Stash value page stays out of the nav until signed in.
var OAUTH = { enabled: false, signedIn: false, username: null };

async function refreshOAuth() {
  if (!isGui() || !window.pywebview.api.oauth_status) return;
  try {
    var r = await window.pywebview.api.oauth_status();
    if (r && r.ok) OAUTH = { enabled: !!r.enabled, signedIn: !!r.signedIn, username: r.username || null };
  } catch (e) { /* bridge missing */ }
  renderOAuthSettings();
  if (build) renderNav();
}

function renderOAuthSettings() {
  var btn = document.getElementById('oauth-btn');
  var st = document.getElementById('oauth-status');
  if (!btn || !st) return;
  if (!OAUTH.enabled) {
    btn.disabled = true;
    btn.textContent = 'Sign in with Path of Exile';
    st.textContent = 'Not available yet. Grinding Gear Games isn\'t accepting new apps for its official login right ' +
      'now; it switches on in an update once they approve this one.';
    return;
  }
  btn.disabled = false;
  btn.textContent = OAUTH.signedIn ? 'Sign out' : 'Sign in with Path of Exile';
  st.textContent = OAUTH.signedIn
    ? '✓ Signed in as ' + (OAUTH.username || 'your account') + '. Stash value is in the sidebar under Tools.'
    : 'Opens pathofexile.com in your browser to sign in; the app never sees your password.';
}

async function onOAuthButton() {
  var btn = document.getElementById('oauth-btn');
  if (!OAUTH.enabled || btn.disabled) return;
  if (OAUTH.signedIn) {
    await window.pywebview.api.oauth_logout();
    UI.toast('Signed out of the official login.', 'success');
    return refreshOAuth();
  }
  btn.disabled = true;
  btn.textContent = 'Waiting for you to sign in on pathofexile.com…';
  var r;
  try { r = await window.pywebview.api.oauth_login(); } catch (e) { r = { ok: false, error: e.message }; }
  if (r && r.ok && r.signedIn) UI.toast('Signed in as ' + (r.username || 'your account') + '.', 'success');
  else UI.toast('Sign-in didn\'t complete: ' + ((r && r.error) || 'unknown error'), 'danger');
  refreshOAuth();
}

// ---- Stash value page ------------------------------------------------------------------
// One click values every tab in the selected league through the official API: exchange
// items (currency, fragments, scarabs, essences, cards…) at the hourly feed's prices,
// other items counted. Each run is kept (pobtf-networth) for a chart over time.
var stashRunning = false, stashResult = null;

function loadNetWorth() {
  try { var h = JSON.parse(localStorage.getItem('pobtf-networth')); if (Array.isArray(h)) return h; }
  catch (e) { /* none yet */ }
  return [];
}

function renderStashPage() {
  var page = document.getElementById('stash-page');
  if (!page) return;
  page.textContent = '';
  var league = document.getElementById('league').value;
  var go = UI.button('primary', { label: stashRunning ? 'Valuing… (one request per tab, paced)' : 'Value my stash',
    onClick: runStashValue });
  go.disabled = stashRunning || !OAUTH.signedIn;
  page.appendChild(UI.sectionHeader('Stash value · ' + league, [go]));
  if (!OAUTH.signedIn) {
    page.appendChild(UI.el('div', 'finder-sub', 'Sign in with the official Path of Exile login (⚙ Settings → Account) ' +
      'to value your stash.'));
    return;
  }
  var hist = loadNetWorth().filter(function (h) { return h.league === league; });
  if (!stashResult || stashResult.league !== league) {
    page.appendChild(UI.el('div', 'finder-sub', hist.length
      ? 'Last valued ' + fmtShortDate(hist[hist.length - 1].ts / 1000) + ': ' + fmtEq(hist[hist.length - 1].total, league) +
        '. Value it again to compare.'
      : 'Values currency, fragments, scarabs, essences, divination cards and other exchange items at the hourly ' +
        'exchange prices. Gear, gems and maps are counted but not priced.'));
  }
  if (stashResult && stashResult.league === league) {
    var r = stashResult, panel = UI.panel({ cls: 'stash-summary' });
    var dr = divRate(league);
    panel.body.appendChild(UI.el('div', 'stash-total', fmtEq(r.total, league) +
      (dr && eqMode() !== 'divine' ? ' · ' + fmtCompact(r.total / dr) + ' div' : '')));
    panel.body.appendChild(UI.el('div', 'finder-sub', r.tabs.length + ' tabs · ' + r.unvalued +
      ' items without an exchange price (gear, gems, maps…) not included'));
    page.appendChild(panel.el);
    var grid = UI.el('div', 'stash-grid');
    grid.appendChild(UI.table([
      { key: 'name', label: 'Tab', render: function (t) { return t.name; } },
      { key: 'total', label: 'Value', num: true, sort: function (t) { return t.total; },
        render: function (t) { return fmtEq(t.total, league); } },
      { key: 'items', label: 'Items', num: true, sort: function (t) { return t.items; }, render: function (t) {
        return t.items + (t.unvalued ? ' (' + t.unvalued + ' unpriced)' : ''); } }
    ], r.tabs, { sortable: true, caption: 'Tabs' }));
    grid.appendChild(UI.table([
      { key: 'name', label: 'Item', render: function (l) { return l.name; } },
      { key: 'qty', label: 'Qty', num: true, render: function (l) { return String(l.qty); } },
      { key: 'each', label: 'Each', num: true, render: function (l) { return fmtEq(l.each, league); } },
      { key: 'total', label: 'Total', num: true, sort: function (l) { return l.total; },
        render: function (l) { return fmtEq(l.total, league); } }
    ], r.top, { sortable: true, caption: 'Most valuable' }));
    page.appendChild(grid);
  }
  if (hist.length > 1) {
    var w = UI.panel({ title: 'Stash value over time', cls: 'stash-history' });
    w.body.appendChild(priceChart(hist.map(function (h) { return { t: Math.round(h.ts / 1000), v: h.total,
      sub: fmtEq(h.total, league) }; }), { w: 720, h: 180, label: 'Stash value in chaos' }));
    page.appendChild(w.el);
  }
}

async function runStashValue() {
  if (stashRunning || !OAUTH.signedIn) return;
  var league = document.getElementById('league').value;
  stashRunning = true;
  renderStashPage();
  var r;
  try { r = await window.pywebview.api.stash_value(league); } catch (e) { r = { ok: false, error: e.message }; }
  stashRunning = false;
  if (r && r.ok) {
    stashResult = Object.assign({ league: league }, r);
    var hist = loadNetWorth();
    hist.push({ ts: Date.now(), league: league, total: r.total });
    try { persist('pobtf-networth', JSON.stringify(hist.slice(-200))); } catch (e) { /* storage full */ }
  } else {
    UI.toast('Couldn\'t value the stash: ' + ((r && r.error) || 'unknown error'), 'danger');
    if (/sign in again/.test((r && r.error) || '')) refreshOAuth();
  }
  renderStashPage();
}

document.addEventListener('DOMContentLoaded', function () {
  var b = document.getElementById('oauth-btn');
  if (b) b.addEventListener('click', onOAuthButton);
  document.getElementById('league').addEventListener('change', function () {
    if (document.body.dataset.view === 'stash') renderStashPage();
  });
});
