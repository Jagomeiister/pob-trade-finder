/* js/app/10-character.js — character import, gear-gap diff, value my gear.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- character import + gear-gap diff ------------------------------------------
var charGear = null; // slot name -> equipped item (bridge shape)
var charName_ = '';

// ---- value my gear: price what the imported character is wearing -------------
// Uniques search by name; rares search for similar items (same base type, any N-1
// of their mods at ≥85% of each roll). One search per item through the shared
// rate limiter. "Similar listings" is an estimate — rares are notoriously hard to price.
var VALUE_ROLL_PCT = 0.85;
var VALUE_SLOT_ORDER = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots',
                        'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5'];

function valuePayload(it, slot) {
  var status = document.getElementById('trade-status').value;
  var filters = { trade_filters: { filters: { sale_type: { option: 'priced' } } } };
  if (it.frameType === 3) { // unique
    var q = { status: { option: status }, name: resolveUniqueName(it.name), type: it.base, filters: filters };
    return { query: q, sort: { price: 'asc' } };
  }
  var stats = [];
  [['explicitMods', 'explicit', false, false], ['craftedMods', 'explicit', true, false],
   ['fracturedMods', 'explicit', false, true], ['implicitMods', 'implicit', false, false]].forEach(function (spec) {
    (it[spec[0]] || []).forEach(function (line) {
      if (line && typeof line === 'object') line = line.description || '';
      if (!line) return;
      var m = Matcher.matchMod(statIndex, { line: line, kind: spec[1], crafted: spec[2], fractured: spec[3] }, slot);
      if (!m || spec[0] === 'implicitMods' || spec[0] === 'craftedMods') return; // base/bench mods don't set value
      var f = { id: m.entry.id };
      if (m.avg !== null && m.avg !== undefined && !m.fixedText) {
        var v = m.avg * VALUE_ROLL_PCT;
        f.value = m.avg < 0 ? { max: roundMin(m.avg * VALUE_ROLL_PCT) } : { min: roundMin(v) };
      }
      if (!stats.some(function (s) { return s.id === f.id; })) stats.push(f);
    });
  });
  var q2 = { status: { option: status }, filters: filters, type: it.base };
  if (stats.length) {
    q2.stats = [{ type: 'count', value: { min: Math.max(1, stats.length - 1) }, filters: stats.slice(0, 10) }];
  }
  return { query: q2, sort: { price: 'asc' } };
}

async function valueMyGear(btn) {
  if (!charGear || !isGui()) return;
  if (btn._batch) { runBatch(btn); return; } // second click = stop
  var box = document.getElementById('gear-value');
  box.classList.remove('hidden');
  box.textContent = '';
  var league = document.getElementById('league').value;
  var head = document.createElement('div');
  head.className = 'cost-head';
  head.textContent = 'Your gear (' + charName_ + ') — cheapest similar listings';
  box.appendChild(head);
  var slots = VALUE_SLOT_ORDER.filter(function (s) { return charGear[s]; });
  var rows = {}, total = 0, priced = 0;
  slots.forEach(function (s) {
    var it = charGear[s];
    var row = document.createElement('div');
    row.className = 'cost-row';
    row.innerHTML = '<span class="cost-slot">' + esc(s) + '</span><span class="cost-item">' +
      esc((it.name ? it.name + ' ' : '') + it.base) + '</span><span class="cost-amt">queued</span>';
    box.appendChild(row);
    rows[s] = row;
  });
  var totalRow = document.createElement('div');
  totalRow.className = 'cost-row cost-total';
  box.appendChild(totalRow);
  var idle = btn.textContent;
  await runBatch(btn, idle, slots.length, async function (i) {
      var s = slots[i], it = charGear[s], amt = rows[s].querySelector('.cost-amt');
      amt.textContent = 'checking…';
      var payload = valuePayload(it, s);
      try {
        var res = await window.pywebview.api.trade_search(league, JSON.stringify(payload));
        if (!res.ok) {
          amt.textContent = '❌ ' + String(res.error).slice(0, 60);
          return isCooldownError(res.error) ? false : undefined; // a cooldown ends the batch
        }
        var curs = [];
        res.listings.forEach(function (li) { if (li.currency && curs.indexOf(li.currency) === -1) curs.push(li.currency); });
        var rates = await craftRates(league, curs);
        var best = null;
        res.listings.forEach(function (li) {
          var r = rates[li.currency];
          if (li.amount != null && r !== undefined && (best === null || li.amount * r < best)) best = li.amount * r;
        });
        var url = 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) + '?q=' + encodeURIComponent(JSON.stringify(payload));
        amt.textContent = '';
        var a = document.createElement('a');
        a.href = '#';
        a.textContent = best === null ? (res.total ? 'no priced match' : 'no similar listings') :
          fmtEq(best, league) + ' · ' + res.total + ' similar';
        a.title = 'Open these similar listings on the trade site';
        a.addEventListener('click', (function (u) { return function (e) { e.preventDefault(); openUrl(u); }; })(url));
        amt.appendChild(a);
        if (best !== null) { total += best; priced++; }
      } catch (e) {
        amt.textContent = '❌ ' + (e.message || e);
      }
      totalRow.innerHTML = '<span class="cost-slot">TOTAL</span><span class="cost-item">' + priced + ' of ' +
        slots.length + ' items priced (estimate)</span><span class="cost-amt">' + fmtEq(total, league) + '</span>';
  });
}
var INV_SLOT = { Helm: 'Helmet', BodyArmour: 'Body Armour', Gloves: 'Gloves', Boots: 'Boots',
                 Amulet: 'Amulet', Ring: 'Ring 1', Ring2: 'Ring 2', Belt: 'Belt',
                 Weapon: 'Weapon 1', Offhand: 'Weapon 2' };

function slotForInv(it) {
  if (it.inventoryId === 'Flask') return 'Flask ' + ((it.x || 0) + 1);
  return INV_SLOT[it.inventoryId] || null;
}

// stat-tail -> value map for an equipped item's mods
function equippedStats(equipped, slot) {
  var tails = {};
  [['implicitMods', 'implicit'], ['explicitMods', 'explicit'], ['craftedMods', 'crafted'],
   ['fracturedMods', 'fractured'], ['enchantMods', 'implicit']].forEach(function (pair) {
    (equipped[pair[0]] || []).forEach(function (line) {
      // newer character-window responses wrap mods as {description, flags}
      if (line && typeof line === 'object') line = line.description || '';
      if (typeof line !== 'string' || !line) return;
      var m = Matcher.matchMod(statIndex, {
        line: line, kind: pair[1] === 'implicit' ? 'implicit' : 'explicit',
        crafted: pair[0] === 'craftedMods', fractured: pair[0] === 'fracturedMods'
      }, slot);
      if (m) {
        var tail = m.entry.id.split('.').pop().split('|')[0];
        if (!(tail in tails) || (m.avg !== null && m.avg > tails[tail])) tails[tail] = m.avg;
      }
    });
  });
  return tails;
}

// What you have that this card could be: the slot itself, both ring slots for a ring
// (worn the other way round still counts), and every jewel in your tree for a jewel (any
// socket: where the build puts it doesn't matter). Each tree jewel is matched once.
var charJewels = [];     // get_character_passives jewels (tree sockets), read with the gear
var charPassives_ = null; // the whole answer, reused by the Skill tree compare
var charJewelClaims = {}; // jewel index -> card claiming it (one jewel can't fill two cards)
function charCandidates(state) {
  if (/^Ring [12]$/.test(state.slot)) {
    return ['Ring 1', 'Ring 2'].map(function (s) { return charGear[s] ? { it: charGear[s], where: s } : null; }).filter(Boolean);
  }
  if (/jewel/i.test(state.slot)) {
    return (charJewels || []).map(function (it, i) { return { it: it, where: 'tree', jewel: i }; })
      .filter(function (c) { return !(c.jewel in charJewelClaims) || charJewelClaims[c.jewel] === state; });
  }
  return charGear[state.slot] ? [{ it: charGear[state.slot], where: state.slot }] : [];
}

// how well an item you have covers this card: { status, score, have, total, missing, lowRolls }
function charScore(state, equipped) {
  if (state.unique) {
    var same = equipped.name === state.item.name;
    return { status: same ? 'diff-matched' : 'diff-missing', score: same ? 2 : 0 };
  }
  var eq = equippedStats(equipped, state.slot);
  var total = 0, have = 0, lowRolls = 0, missing = [];
  state.rows.forEach(function (r) {
    if (!r.cb.checked || !r.match) return;
    total++;
    var tail = r.match.entry.id.split('.').pop().split('|')[0];
    if (tail in eq) {
      have++;
      var min = parseFloat(r.minInput.value);
      if (!isNaN(min) && min > 0 && eq[tail] !== null && eq[tail] < min) lowRolls++;
    } else {
      missing.push(r.mod.line);
    }
  });
  if (!total) return { status: null, score: 0, total: 0 };
  return { status: (have === total && !lowRolls) ? 'diff-matched' : (have * 2 >= total) ? 'diff-close' : 'diff-missing',
           score: (have - lowRolls * 0.5) / total, have: have, total: total, missing: missing, lowRolls: lowRolls };
}

function renderCharDiff(state) {
  if (!state.card) return; // gem panels have no card element
  var old = state.card.querySelector('.char-diff');
  if (old) old.remove();
  state.card.classList.remove('diff-matched', 'diff-close', 'diff-missing');
  state.charMatch = null;
  if (!charGear) return;

  var strip = document.createElement('div');
  strip.className = 'char-diff';
  var best = null;
  charCandidates(state).forEach(function (c) {
    var s = charScore(state, c.it);
    if (!best || s.score > best.s.score) best = { c: c, s: s };
  });
  var isJewel = /jewel/i.test(state.slot);
  var status;
  if (!best) {
    status = 'diff-missing';
    strip.innerHTML = '<b>You:</b> <span class="miss">' + (isJewel ? 'no jewel like this in your tree'
      : 'nothing equipped in this slot') + '</span>';
  } else {
    var equipped = best.c.it, s = best.s;
    if (isJewel && s.score > 0) charJewelClaims[best.c.jewel] = state;
    state.charMatch = equipped;
    var where = best.c.where === 'tree' ? ' <span class="finder-sub">(in your tree)</span>'
      : best.c.where !== state.slot ? ' <span class="finder-sub">(your ' + esc(best.c.where) + ')</span>' : '';
    if (state.unique) {
      status = s.status;
      strip.innerHTML = '<b>You:</b> ' + esc((equipped.name || equipped.base)) + where +
        (s.score ? ' <span class="ok">— matches the build</span>'
                 : ' <span class="miss">— build wants ' + esc(state.item.name) + '</span>');
    } else {
      if (!s.total) { strip.remove(); return; }
      status = s.status;
      strip.innerHTML = '<b>You:</b> ' + esc(equipped.name || equipped.base) + where +
        ' — <span class="' + (s.have === s.total ? 'ok' : 'miss') + '">' + s.have + '/' + s.total + ' target mods</span>' +
        (s.missing.length ? ' · missing: <span class="miss">' + esc(s.missing.slice(0, 3).join(' · ')) +
          (s.missing.length > 3 ? ' +' + (s.missing.length - 3) : '') + '</span>' : '') +
        (s.lowRolls ? ' · <span class="miss">' + s.lowRolls + ' low roll(s)</span>' : '');
      // upgrade finder: search only items at least as good as yours on every ticked stat
      var up = document.createElement('label');
      up.className = 'toggle upgrade-toggle';
      up.title = 'Raise each ticked mod\'s minimum to your equipped roll — searches, price checks and live alerts then only show upgrades';
      var upCb = document.createElement('input');
      upCb.type = 'checkbox';
      upCb.checked = !!state.upgradeOnly;
      upCb.addEventListener('change', function () {
        state.upgradeOnly = upCb.checked;
        if (state.upgradeOnly && isGui() && state.priceBtn) checkPrice(state);
      });
      up.appendChild(upCb);
      up.appendChild(document.createTextNode(' ⬆ Upgrades only'));
      strip.appendChild(document.createTextNode(' '));
      strip.appendChild(up);
    }
  }
  state.card.classList.add(status);
  state.card.insertBefore(strip, state.card.children[1]);
}

function applyCharDiff() {
  charJewelClaims = {};
  // jewels: best-matching cards claim their jewel first, so a weak match can't take a jewel
  // that another card matches exactly
  var jewelCards = cards.filter(function (s) { return s.card && /jewel/i.test(s.slot); });
  var ranked = jewelCards.map(function (s) {
    var top = 0;
    (charJewels || []).forEach(function (it) { top = Math.max(top, charGear ? charScore(s, it).score : 0); });
    return { s: s, top: top };
  }).sort(function (a, b) { return b.top - a.top; });
  ranked.forEach(function (r) { renderCharDiff(r.s); });
  cards.forEach(function (s) { if (jewelCards.indexOf(s) === -1) renderCharDiff(s); });
  refreshSlotLists();
}
