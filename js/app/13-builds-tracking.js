/* js/app/13-builds-tracking.js — build re-import diff, daily re-pricing of saved builds.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- build re-import diff -------------------------------------------------------------
// pobtf-lastbuild: fingerprint of the last decoded build {key, cls, ts, slots: {slot:
// {name, sig, sk}}}. Loading a newer version of the same build (same class, at least
// 40% of slots identical — otherwise it's a different build) lists the slots that
// changed, with each one's old price from the cost history and the new price once
// checked. Unchanged slots carry their cost history over to the new version.
var DIFF_MIN_SAME = 0.4;
var buildDiff = null; // {prevTs, total, rows: [{slot, kind, before, after, oldChaos}]}

function itemSig(it) {
  return [it.name || '', it.base || ''].concat((it.mods || []).map(function (m) { return m.line; }).sort()).join('\n');
}
function gearStates() {
  return cards.filter(function (s) { return s !== pastedState && !s.gemSpec && s.item && s.slot; });
}
function buildFingerprint() {
  var fp = {};
  gearStates().forEach(function (s) {
    fp[s.slot] = { name: s.resolvedName || s.item.name || s.item.base || '', sig: itemSig(s.item), sk: slotKey(s) };
  });
  return fp;
}

function computeBuildDiff() {
  buildDiff = null;
  var prev = null;
  try { prev = JSON.parse(localStorage.getItem('pobtf-lastbuild')); } catch (e) { /* none */ }
  var key = buildKey(), cls = build.ascendClass || build.className || '';
  var fp = buildFingerprint();
  if (prev && prev.key === key) return; // same code again: nothing new, keep the older fingerprint
  try { persist('pobtf-lastbuild', JSON.stringify({ key: key, cls: cls, ts: Date.now(), slots: fp })); }
  catch (e) { /* storage full */ }
  if (!prev || !prev.slots || prev.cls !== cls) return;
  var all = Object.keys(prev.slots).concat(Object.keys(fp).filter(function (s) { return !prev.slots[s]; }));
  var same = all.filter(function (s) { return prev.slots[s] && fp[s] && prev.slots[s].sig === fp[s].sig; });
  if (!all.length || same.length / all.length < DIFF_MIN_SAME) return;
  var hist = loadCostHist();
  var prevH = hist[prev.key];
  var lastSnap = prevH && prevH.snaps.length ? prevH.snaps[prevH.snaps.length - 1] : null;
  var rows = all.filter(function (s) { return same.indexOf(s) === -1; }).map(function (s) {
    var b = prev.slots[s], a = fp[s];
    return { slot: s, kind: !b ? 'added' : !a ? 'removed' : 'changed', what: describeChange(b, a),
             oldChaos: b && lastSnap && lastSnap.slots[b.sk] !== undefined ? lastSnap.slots[b.sk] : null };
  });
  // unchanged slots keep their price history in the new version
  if (prevH && !hist[key]) {
    var keep = {};
    same.forEach(function (s) { keep[prev.slots[s].sk] = true; });
    var snaps = prevH.snaps.map(function (sn) {
      var slots = {};
      Object.keys(sn.slots).forEach(function (k) { if (keep[k]) slots[k] = sn.slots[k]; });
      return { ts: sn.ts, league: sn.league, slots: slots };
    }).filter(function (sn) { return Object.keys(sn.slots).length; });
    if (snaps.length) {
      hist[key] = { _ts: Date.now(), snaps: snaps };
      try { persist('pobtf-costhist', JSON.stringify(hist)); } catch (e) { /* storage full */ }
    }
  }
  if (!rows.length) return;
  buildDiff = { prevTs: prev.ts, total: all.length, rows: rows };
  gearStates().forEach(function (s) {
    var r = rows.find(function (x) { return x.slot === s.slot; });
    if (r) s.diffKind = r.kind;
  });
}

// "Rift Corona → Crown of Eyes", or for the same item the mod lines that differ
function describeChange(b, a) {
  if (!b) return a.name;
  if (!a) return b.name;
  if (b.name !== a.name) return b.name + ' → ' + a.name;
  var before = b.sig.split('\n').slice(2), after = a.sig.split('\n').slice(2);
  var lines = after.filter(function (l) { return before.indexOf(l) === -1; }).map(function (l) { return '+ ' + l; })
    .concat(before.filter(function (l) { return after.indexOf(l) === -1; }).map(function (l) { return '− ' + l; }));
  if (!lines.length) return a.name + ': base or details changed';
  return a.name + ': ' + lines.slice(0, 4).join(' · ') + (lines.length > 4 ? ' · +' + (lines.length - 4) + ' more' : '');
}

function diffSlotLink(slot) {
  var s = diffStateFor(slot);
  if (!s) return document.createTextNode(slot);
  var b = UI.el('button', 'link-btn', slot);
  b.type = 'button';
  b.title = 'Show this slot';
  b.addEventListener('click', function () {
    var sec = s.card && s.card.closest('.tab-section');
    if (!sec) return;
    setView(sec.dataset.tab);
    selectSlot(sec, s.card);
  });
  return b;
}

function diffStateFor(slot) {
  return gearStates().find(function (s) { return s.slot === slot; });
}

function renderBuildDiff() {
  var root = document.getElementById('results');
  var box = document.getElementById('build-diff');
  if (!buildDiff) { if (box) box.remove(); return; }
  if (!box) {
    box = UI.el('section', 'panel build-diff');
    box.id = 'build-diff';
    root.insertBefore(box, root.firstChild);
  }
  box.textContent = '';
  var league = document.getElementById('league').value;
  var rows = buildDiff.rows;
  var toPrice = rows.filter(function (r) { var s = diffStateFor(r.slot); return s && s.cheapestChaos === undefined; });
  var priceBtn = UI.button('secondary', { size: 'sm', label: toPrice.length ? 'Price changed slots (' + toPrice.length + ')' : 'All changed slots priced',
    onClick: async function () {
      priceBtn.disabled = true;
      for (var i = 0; i < toPrice.length; i++) {
        var s = diffStateFor(toPrice[i].slot);
        if (!s || !buildDiff) break;
        priceBtn.textContent = 'Checking ' + (i + 1) + '/' + toPrice.length + '…';
        await checkPrice(s, true);
      }
      renderBuildDiff();
    } });
  priceBtn.disabled = !toPrice.length || !isGui();
  var close = UI.iconButton('✕', 'Hide the changes list', { size: 'sm', onClick: function () {
    buildDiff = null;
    gearStates().forEach(function (s) { delete s.diffKind; });
    renderBuildDiff();
    refreshSlotLists();
  } });
  box.appendChild(UI.sectionHeader('Changed since the version you loaded ' + fmtShortDate(buildDiff.prevTs / 1000) +
    ' · ' + rows.length + ' of ' + buildDiff.total + ' slots', [priceBtn, close]));
  var dWas = 0, dNow = 0, both = 0;
  var t = UI.table([
    { key: 'slot', label: 'Slot', render: function (r) { return diffSlotLink(r.slot); } },
    { key: 'kind', label: 'Change', render: function (r) {
      return UI.chip(r.kind === 'added' ? 'New slot' : r.kind === 'removed' ? 'Removed' : 'Changed',
        r.kind === 'removed' ? 'neutral' : 'accent');
    } },
    { key: 'what', label: 'What changed', render: function (r) { return UI.el('span', 'diff-what', r.what); } },
    { key: 'was', label: 'Was', num: true, render: function (r) { return r.oldChaos !== null ? fmtEq(r.oldChaos, league) : '—'; } },
    { key: 'now', label: 'Costs now', num: true, render: function (r) {
      var s = r.kind !== 'removed' && diffStateFor(r.slot);
      return s && s.cheapestChaos !== undefined ? fmtEq(s.cheapestChaos, league) : r.kind === 'removed' ? '—' : 'not checked';
    } },
    { key: 'delta', label: 'Difference', num: true, render: function (r) {
      var s = r.kind !== 'removed' && diffStateFor(r.slot);
      var now = s && s.cheapestChaos !== undefined ? s.cheapestChaos : (r.kind === 'removed' ? 0 : null);
      var was = r.oldChaos !== null ? r.oldChaos : (r.kind === 'added' ? 0 : null);
      if (now === null || was === null) return '—';
      dWas += was; dNow += now; both++;
      var d = now - was;
      return (d > 0 ? '+' : d < 0 ? '−' : '±') + fmtEq(Math.abs(d), league);
    } }
  ], rows);
  box.appendChild(t);
  var foot = UI.el('div', 'finder-sub');
  foot.textContent = both
    ? 'Net change across the ' + both + ' slot' + (both > 1 ? 's' : '') + ' with both prices: ' +
      (dNow - dWas > 0 ? '+' : dNow - dWas < 0 ? '−' : '±') + fmtEq(Math.abs(dNow - dWas), league) +
      '. "Was" is the cheapest listing when you last priced the old version.'
    : '"Was" is the cheapest listing when you last priced the old version; price the changed slots to compare.';
  box.appendChild(foot);
}

// on build load: show what it cost when it was last priced
function showLastBuildCost() {
  var el = document.getElementById('build-cost');
  if (!el) return;
  var league = document.getElementById('league').value;
  var h = loadCostHist()[buildKey()];
  var last = h && h.snaps.filter(function (s) { return s.league === league; }).pop();
  el.textContent = '';
  if (!last) { el.classList.add('hidden'); return; }
  var sum = 0, n = 0;
  Object.keys(last.slots).forEach(function (k) { sum += last.slots[k]; n++; });
  el.classList.remove('hidden');
  el.textContent = 'Last priced ' + fmtShortDate(last.ts / 1000) + ': ' + fmtEq(sum, league);
  el.title = 'Cheapest listings for ' + n + ' slot' + (n > 1 ? 's' : '') + '. Check prices to compare with today.';
}

// ---- saved builds: daily background re-price ----------------------------------------
// A tracked saved build re-runs, once a day, the searches last run for the slots in its
// latest cost snapshot (pobtf-history keeps each slot's search) at background pace —
// the bridge skips them during any rate-limit cooldown — and adds the result to the
// build's cost history. Optional alert: total at or under a price, once per crossing.
// lib entry: b.track = {on, below, unit: 'c'|'div', lastRun, last: {ts, total, n}, fired}
var TRACK_EVERY_MS = 24 * 3600 * 1000, trackRunning = false;

function trackableSlots(b) {
  var key = codeKey(b.code);
  var h = loadCostHist()[key], hist = loadHistory()[key] || {};
  var last = h && h.snaps.length ? h.snaps[h.snaps.length - 1] : null;
  if (!last) return [];
  return Object.keys(last.slots).map(function (sk) {
    var e = (hist[sk] || [])[0];
    return e && e.payloadStr ? { sk: sk, payloadStr: e.payloadStr } : null;
  }).filter(Boolean);
}

function cheapestChaos(listings, league) {
  var best = null;
  (listings || []).forEach(function (li) {
    var rate = RATES[league] && RATES[league][li.currency];
    if (li.amount == null || rate === undefined) return;
    var c = li.amount * rate;
    if (best === null || c < best) best = c;
  });
  return best;
}

async function runTrackedBuilds() {
  if (trackRunning || !isGui() || !market) return; // market = chaos rates for every currency
  var due = loadBuildLib().filter(function (b) {
    return b.track && b.track.on && Date.now() - (b.track.lastRun || 0) > TRACK_EVERY_MS;
  })[0];
  if (!due) return;
  trackRunning = true;
  try { await repriceSavedBuild(due); } finally { trackRunning = false; }
}

async function repriceSavedBuild(b) {
  var league = document.getElementById('league').value;
  var todo = trackableSlots(b), slots = {}, n = 0;
  for (var i = 0; i < todo.length; i++) {
    var r;
    try { r = await window.pywebview.api.trade_search(league, todo[i].payloadStr, true); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      if (/cooldown|rate limit/i.test((r && r.error) || '')) return; // try again next hour
      continue;
    }
    var c = cheapestChaos(r.listings, league);
    if (c !== null) { slots[todo[i].sk] = Math.round(c * 10) / 10; n++; }
  }
  var lib = loadBuildLib();
  var entry = lib.find(function (x) { return x.code === b.code; });
  if (!entry || !entry.track) return;
  entry.track.lastRun = Date.now();
  if (n) {
    var h = storeCostSnapshot(codeKey(b.code), league, slots);
    var trend = buildCostTrend(h, league);
    var total = 0;
    Object.keys(slots).forEach(function (k) { total += slots[k]; });
    entry.track.last = { ts: Date.now(), total: total, n: n, change: trend ? trend.change : null };
    trackAlert(entry, total, league);
  }
  saveBuildLib(lib);
  refreshBuildSelect();
}

function trackAlert(entry, total, league) {
  var t = entry.track;
  if (t.below == null) return;
  var dr = divRate(league);
  var v = t.unit === 'div' ? (dr ? total / dr : null) : total;
  if (v === null) return;
  var hit = v <= t.below;
  var name = String(entry.name || 'Saved build').split(' · ')[0];
  if (hit && !t.fired) {
    var msg = name + ' now costs ' + fmtCompact(v) + (t.unit === 'div' ? ' div' : 'c') +
      ' (alert: ' + t.below + (t.unit === 'div' ? ' div' : 'c') + ' or less)';
    UI.toast('🔔 ' + msg, 'info', { timeout: 0, action: { label: 'Open build', onClick: function () {
      document.getElementById('pob-input').value = entry.code;
      onDecode();
    } } });
    if (PREFS.notify !== false && window.pywebview.api.notify) {
      window.pywebview.api.notify('Build price alert', msg).then(function () {}, function () {});
    }
  }
  t.fired = hit;
}

// inline settings under a saved build card: track daily + optional price alert
function trackForm(b, idx) {
  var t = b.track || {};
  var form = UI.el('div', 'track-form');
  var onLab = UI.el('label', 'check');
  var on = UI.input({ type: 'checkbox' });
  on.checked = !!t.on;
  onLab.appendChild(on);
  onLab.appendChild(document.createTextNode(' Re-price this build once a day'));
  form.appendChild(onLab);
  var row = UI.el('div', 'track-row');
  var below = UI.input({ type: 'number', cls: 'min-input', min: 0, step: 'any', ariaLabel: 'Alert when it costs at most',
                         value: t.below == null ? '' : t.below, placeholder: '—' });
  var unit = UI.select([['div', 'divine'], ['c', 'chaos']], t.unit || 'div', { ariaLabel: 'Alert unit' });
  UI.field('Alert at or under', below, { parent: row });
  row.appendChild(unit);
  form.appendChild(row);
  var n = trackableSlots(b).length;
  form.appendChild(UI.el('div', 'finder-sub', n
    ? 'Re-runs your last search for each of ' + n + ' priced slot' + (n > 1 ? 's' : '') + ' while the app is open, ' +
      'at a slow pace that never competes with your own searches.'
    : 'Price this build once first (open it, Check all prices) so tracking knows what to search for.'));
  form.appendChild(UI.button('primary', { size: 'sm', label: 'Save', onClick: function () {
    var lib = loadBuildLib();
    var e = lib[idx];
    if (!e || e.code !== b.code) return;
    var v = parseFloat(below.value);
    e.track = Object.assign(e.track || {}, { on: on.checked, below: isFinite(v) && v > 0 ? v : null, unit: unit.value, fired: false });
    saveBuildLib(lib);
    refreshBuildSelect();
    UI.toast(on.checked ? 'Tracking ' + String(b.name).split(' · ')[0] + ': the first re-price starts shortly, then once a day.'
      : 'Tracking off.', 'success');
    if (on.checked) setTimeout(runTrackedBuilds, 5000);
  } }));
  return form;
}

// item name that jumps to its slot (planner tables)
function slotLink(state) {
  var b = UI.el('button', 'link-btn', state.resolvedName || state.item.name || state.item.base || state.slot);
  b.type = 'button';
  b.title = 'Show this slot';
  b.addEventListener('click', function () {
    var sec = state.card && state.card.closest('.tab-section');
    if (!sec) return;
    setView(sec.dataset.tab);
    if (sec.classList.contains('master-detail')) selectSlot(sec, state.card);
    window.scrollTo(0, 0);
  });
  return b;
}

var solverResTarget = 300, solverLifeTarget = 0, solverResult = null;

function renderSolver(box, league) {
  var bar = document.createElement('div');
  bar.className = 'solve-bar';
  var lbl = document.createElement('span');
  lbl.className = 'cost-slot';
  lbl.textContent = 'SOLVER';
  lbl.title = 'Cheapest combination of priced listings that still meets build-wide targets — slots trade off against each other';
  bar.appendChild(lbl);
  var resIn = makeMiniInput(bar, 'Total ele res ≥', '300');
  resIn.value = solverResTarget || '';
  resIn.addEventListener('change', function () { solverResTarget = parseFloat(this.value) || 0; });
  var lifeIn = makeMiniInput(bar, 'Total life ≥', '0');
  lifeIn.value = solverLifeTarget || '';
  lifeIn.addEventListener('change', function () { solverLifeTarget = parseFloat(this.value) || 0; });
  var solveBtn = UI.button('secondary', { size: 'sm' });
  solveBtn.textContent = 'Solve cheapest combo';
  solveBtn.addEventListener('click', function () {
    solverResult = solveBudget(solverResTarget || 0, solverLifeTarget || 0);
    renderCostSummary();
  });
  bar.appendChild(solveBtn);
  box.appendChild(bar);

  if (!solverResult) return;
  if (!solverResult.ok) {
    var err = document.createElement('div');
    err.className = 'cost-row';
    err.innerHTML = '<span class="cost-slot"></span><span class="cost-item">' + esc(solverResult.error) + '</span>';
    box.appendChild(err);
    return;
  }
  solverResult.picks.forEach(function (p) {
    var row = document.createElement('div');
    row.className = 'cost-row';
    row.innerHTML = '<span class="cost-slot">' + esc(p.state.slot) + '</span>' +
      '<span class="cost-item">' + esc(((p.cand.li.name ? p.cand.li.name + ' ' : '') + p.cand.li.base)) +
      ' <span class="chaos-eq">res ' + Math.round(p.cand.res) + ' · life ' + Math.round(p.cand.life) + '</span></span>' +
      '<span class="cost-amt">' + fmtEq(p.cand.chaos, league) + '</span>';
    box.appendChild(row);
  });
  var t = solverResult.totals;
  var sumRow = document.createElement('div');
  sumRow.className = 'cost-row cost-total';
  sumRow.innerHTML = '<span class="cost-slot">' + (solverResult.met ? '✔ COMBO' : '⚠ BEST TRY') + '</span>' +
    '<span class="cost-item">res ' + Math.round(t.res) + ' · life ' + Math.round(t.life) +
    (solverResult.met ? '' : ' — targets not reachable with the priced listings (price more pages/slots)') + '</span>' +
    '<span class="cost-amt">' + fmtEq(t.chaos, league) + '</span>';
  box.appendChild(sumRow);
  var pinAll = UI.button('secondary');
  pinAll.textContent = '☆ Pin combo to basket';
  pinAll.addEventListener('click', function () {
    solverResult.picks.forEach(function (p) { pinToBasket(p.cand.li, p.state); });
    pinAll.textContent = '★ Pinned ' + solverResult.picks.length;
  });
  box.appendChild(pinAll);
}

function fmtChaos(v) {
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + 'c';
}

function eqMode() { return document.getElementById('eq-currency').value; }
function divRate(league) { return RATES[league] && RATES[league]['divine']; }

// format a chaos value in the chosen display currency (chaos or divine)
function fmtEq(chaosVal, league) {
  if (eqMode() === 'divine') {
    var dr = divRate(league);
    if (dr && chaosVal >= dr / 10) { // below 0.1 div, chaos reads better than "0 div"
      var d = chaosVal / dr;
      return (d >= 10 ? Math.round(d) : Math.round(d * 100) / 100) + ' div';
    }
  }
  return fmtChaos(chaosVal);
}

function refreshEqDisplays() {
  cards.forEach(function (state) {
    if (!state.priceState) return;
    state.priceBox.querySelectorAll('.chaos-eq').forEach(function (el) { el.remove(); });
    annotateChaosEq(state);
  });
  renderCostSummary();
  renderBasket();
  renderMarket();
}
