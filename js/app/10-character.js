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

// ---- gem setups: each PoB link group finds your best link group on ANY worn item, so a
// setup PoB keeps in the body armour still counts when you run it in your helmet. Each of
// your link groups fills one PoB group (best matches claim first, like tree jewels).
var GEM_WHERE = Object.assign({}, INV_SLOT, { Weapon2: 'Weapon 1 Swap', Offhand2: 'Weapon 2 Swap' });
// [{item, where, label, links, gems: [{name, level, quality}], sockets: [{c, gem}]}] from the
// worn gear. label names the link group: "Boots", or "Boots A" / "Boots B" when the item has
// several, so the gem tags and the socket picture point at the same group
var charLinks = [];
var gemGroupViews = []; // makeGemsCard: {group, card, row, gemRows: [{gem, el}]} per PoB link group

function setCharLinks(items) {
  charLinks = [];
  items.forEach(function (it, n) {
    var where = GEM_WHERE[it.inventoryId];
    var groups = it.linkGroups || [];
    if (!where) return;
    groups.forEach(function (g, k) {
      charLinks.push({ item: n, where: where, links: g.links, gems: g.gems || [], sockets: g.sockets || [],
                       label: where + (groups.length > 1 ? ' ' + String.fromCharCode(65 + k) : ''),
                       // for the socket colour helper
                       reqs: it.reqs || {}, quality: it.quality || 0, corrupted: !!it.corrupted,
                       itemSockets: groups.reduce(function (s, x) { return s.concat(x.sockets || []); }, []) });
    });
  });
}

function gemKey(name) { return String(name || '').toLowerCase().replace(/ support$/, '').trim(); }
// "herald of ice" / "purity of fire" are separate gems, not transfigured versions of each other
var NATURAL_OF_BASE = /^(herald|purity|orb|sigil|eye|wave|tornado|fist)$/;

// how well a gem you have stands in for the build's: 1 the same gem (or its Awakened/Vaal
// upgrade), 0.5 a near version (plain instead of Awakened/Vaal, another transfigured
// version), 0 a different gem
function gemFit(want, have) {
  var w = gemKey(want), h = gemKey(have);
  if (w === h || h === 'awakened ' + w || h === 'vaal ' + w) return 1;
  if (w === 'awakened ' + h || w === 'vaal ' + h) return 0.5;
  if (w.indexOf(h + ' of ') === 0 || h.indexOf(w + ' of ') === 0) return 0.5;
  var wb = w.split(' of ')[0];
  if (w.indexOf(' of ') > 0 && h.indexOf(' of ') > 0 && wb === h.split(' of ')[0] && !NATURAL_OF_BASE.test(wb)) return 0.5;
  return 0;
}

// a PoB group against one of your link groups: { score, full, variants, missing, low, options, linksShort }
function groupFit(gems, cg, offGems) {
  var used = {}, pick = {}, full = 0, variants = [], missing = [], low = [];
  // same gems first, then near versions: a build running both "Summon Stone Golem" and its
  // transfigured version mustn't lose the exact match to whichever is listed first
  [1, 0.5].forEach(function (need) {
    gems.forEach(function (g, gi) {
      if (gi in pick) return;
      cg.gems.forEach(function (h, i) {
        if (gi in pick || used[i] || gemFit(g.name, h.name) !== need) return;
        used[i] = true;
        pick[gi] = { h: h, fit: need };
      });
    });
  });
  gems.forEach(function (g, gi) {
    var p = pick[gi];
    if (!p) { missing.push(g.name); return; }
    var h = p.h;
    if (p.fit === 1) {
      full++;
      if ((h.level || 0) < (g.level || 0) || (h.quality || 0) < (g.quality || 0)) {
        low.push(h.name + ' ' + (h.level || 0) + '/' + (h.quality || 0) + ' (build ' + g.level + '/' + g.quality + ')');
      }
    } else {
      variants.push(h.name + ' instead of ' + g.name);
    }
  });
  // your gems that are one of PoB's unticked options for this group (swap-ins, not wrong gems)
  var options = [];
  cg.gems.forEach(function (h, i) {
    if (used[i]) return;
    if ((offGems || []).some(function (o) { return gemFit(o.name, h.name) === 1; })) options.push(h.name);
  });
  var total = gems.length || 1;
  return { score: (full + variants.length * 0.5) / total, full: full, total: gems.length,
           picked: gems.map(function (g, gi) { return pick[gi] ? pick[gi].fit : 0; }),
           variants: variants, missing: missing, low: low, options: options,
           linksShort: cg.links < Math.min(6, gems.length) };
}

// a build gem outside the matched group: socketed in the same item but another link group
// ("unlinked"), on another worn item ("elsewhere"), or nowhere in your worn gear ("missing")
function gemWhere(gem, best) {
  var elsewhere = null;
  for (var i = 0; i < charLinks.length; i++) {
    var c = charLinks[i];
    if (best && i === best.i) continue;
    if (!c.gems.some(function (h) { return gemFit(gem.name, h.name) > 0; })) continue;
    if (best && c.item === best.c.item) return { state: 'unlinked', link: c };
    if (!elsewhere) elsewhere = c;
  }
  return elsewhere ? { state: 'elsewhere', link: elsewhere } : { state: 'missing' };
}

var GEM_LINK_CHIP = { // text + tone per gem state, never colour alone; %s = the link group
  linked: ['linked · %s', 'success', 'In the link group matched to this setup'],
  near: ['near version · %s', 'warn', 'A near version of this gem is in the matched link group'],
  unlinked: ['not linked · %s', 'warn', 'Socketed in the same item, but in a separate link group'],
  elsewhere: ['in %s', 'warn', 'You have it, but not linked with this setup'],
  missing: ['missing', 'danger', 'Not in any gear you are wearing']
};

// your sockets, item by item: each link group a chain of socket dots joined by a gold bar, the
// gem in each socket beside its dot. The group matched to this setup is outlined; gems that
// belong to the setup are bright, the rest dimmed
function gemLinksViz(v, best, links) {
  var items = [];
  if (best) items.push(best.c.item);
  links.forEach(function (c) { if (items.indexOf(c.item) === -1) items.push(c.item); });
  if (!items.length) return null;
  var NAMES = { R: 'Red', G: 'Green', B: 'Blue', W: 'White', A: 'Abyssal', DV: 'Resonator' };
  var inSetup = function (name) {
    return !!name && v.group.gems.some(function (g) { return gemFit(g.name, name) > 0; });
  };
  var wrap = UI.el('div', 'gem-links-viz');
  items.forEach(function (n) {
    var groups = charLinks.filter(function (c) { return c.item === n; });
    var box = UI.el('div', 'glv-item');
    box.appendChild(UI.el('div', 'glv-item-name', 'Your ' + groups[0].where));
    var row = UI.el('div', 'glv-groups');
    groups.forEach(function (c) {
      var matched = best && c === best.c;
      var g = UI.el('div', 'glv-group' + (matched ? ' matched' : ''));
      var head = UI.el('div', 'glv-head', (c.label !== c.where ? 'Link ' + c.label.slice(-1) + ' · ' : '') + c.links + 'L');
      if (matched) head.appendChild(UI.chip('this setup', 'success'));
      g.appendChild(head);
      var chain = UI.el('div', 'glv-chain' + (c.sockets.length > 1 ? ' linked' : ''));
      c.sockets.forEach(function (s) {
        var r = UI.el('div', 'glv-sock' + (s.gem ? (inSetup(s.gem) ? ' in-setup' : ' other') : ' empty'));
        var dot = UI.el('span', 'sock sock-' + s.c);
        dot.title = (NAMES[s.c] || s.c) + ' socket';
        r.appendChild(dot);
        r.appendChild(UI.el('span', 'glv-gem', s.gem || 'empty'));
        chain.appendChild(r);
      });
      g.appendChild(chain);
      row.appendChild(g);
    });
    box.appendChild(row);
    wrap.appendChild(box);
  });
  return wrap;
}

// ---- socket colours (3.29+): any gem fits any socket; a gem in a socket of its own colour
// gets +10% quality. Sockets are white unless they roll red / green / blue (in proportion to
// the item's attribute requirements). GGG hasn't published the chances, so this says what you
// have and what the game offers, never odds.
var GEM_COLOUR = null; // gem name -> 'r' | 'g' | 'b' | 'w' (data/gemcolours.js)
function gemColour(name) {
  if (!GEM_COLOUR) {
    GEM_COLOUR = {};
    var src = window.POE_GEM_COLOURS || {};
    Object.keys(src).forEach(function (c) { src[c].split('|').forEach(function (n) { GEM_COLOUR[n.toLowerCase()] = c; }); });
  }
  return GEM_COLOUR[String(name || '').toLowerCase()] || null;
}
var SOCK_WORD = { r: 'red', g: 'green', b: 'blue' };
var BENCH_NON_WHITE = { 2: 5, 3: 20, 4: 75 }; // "At Least N Non-White Sockets": Chromatic Orbs (3.29 bench)

// one of your link groups: { gems, matched, want: {r,g,b}, have: {r,g,b,w} } — gems are the
// coloured ones (white gems never get the bonus)
function socketColourFit(c) {
  var want = { r: 0, g: 0, b: 0 }, have = { r: 0, g: 0, b: 0, w: 0 }, gems = 0, matched = 0;
  c.sockets.forEach(function (s) {
    var sc = String(s.c || 'W').toLowerCase();
    if (sc in have) have[sc]++;
    var gc = s.gem ? gemColour(s.gem) : null;
    if (!gc || gc === 'w') return;
    gems++;
    want[gc]++;
    if (gc === sc) matched++;
  });
  return { gems: gems, matched: matched, want: want, have: have };
}

function socketColourHelp(c) {
  var fit = socketColourFit(c);
  if (!fit.gems) return null;
  var box = UI.el('div', 'sock-help' + (fit.matched === fit.gems ? ' is-done' : ''));
  var head = UI.el('div', 'sock-help-head');
  head.appendChild(UI.el('b', null, 'Socket colours'));
  head.appendChild(UI.chip(fit.matched + ' / ' + fit.gems + ' gems in their colour',
    fit.matched === fit.gems ? 'success' : 'neutral'));
  head.title = 'Since 3.29 any gem works in any socket; one in a socket of its own colour gets +10% quality.';
  box.appendChild(head);
  if (fit.matched === fit.gems) return box;
  var tips = UI.el('ul', 'sock-help-list');
  function tip(text) { tips.appendChild(UI.el('li', null, text)); }
  // what you'd want vs what the link group has
  var need = Object.keys(fit.want).filter(function (k) { return fit.want[k]; }).map(function (k) {
    return fit.want[k] + ' ' + SOCK_WORD[k];
  });
  tip('This link group wants ' + need.join(', ') + '. Only +10% gem quality is at stake: the gems work as they are.');
  // where the colours come from on this item
  var r = c.reqs || {}, total = (r.str || 0) + (r.dex || 0) + (r.int || 0);
  if (total) {
    var lean = [['str', 'red'], ['dex', 'green'], ['int', 'blue']].filter(function (a) { return r[a[0]]; })
      .map(function (a) { return a[1]; });
    var lacking = Object.keys(fit.want).filter(function (k) { return fit.want[k] && lean.indexOf(SOCK_WORD[k]) === -1; });
    tip('Non-white sockets on this base roll ' + lean.join(' / ') + ' (its attribute requirements)' +
      (lacking.length ? '; ' + lacking.map(function (k) { return SOCK_WORD[k]; }).join(' and ') +
        ' sockets are unlikely here' : '') + '.');
  }
  var coloured = c.itemSockets.filter(function (s) { return /^[RGB]$/i.test(s.c); }).length;
  var wantTotal = fit.want.r + fit.want.g + fit.want.b;
  var k = Math.max(2, Math.min(4, wantTotal));
  if (wantTotal > coloured && BENCH_NON_WHITE[k]) {
    tip('Crafting bench: "At Least ' + k + ' Non-White Sockets" for ' + BENCH_NON_WHITE[k] + ' Chromatic Orbs' +
      (c.corrupted ? ' (plus ' + BENCH_NON_WHITE[k] + ' Vaal Orbs: the item is corrupted)' : '') +
      '. It sets how many sockets get a colour, not which colour.');
  }
  tip(c.corrupted
    ? 'Corrupted: normal Chromatic Orbs can\'t be used; Tainted Chromatic Orbs can.'
    : 'Chromatic Orb: at least one socket always comes out non-white; higher item quality (this one: ' +
      (c.quality || 0) + '%) gives more.');
  if (fit.want.r && fit.want.g && fit.want.b && !c.corrupted) {
    tip('Omen of Trichromatism: your next Chromatic Orb gives at least one red, one green and one blue socket.');
  }
  box.appendChild(tips);
  return box;
}

function renderGemDiff(v, best) {
  var strip = UI.el('div', 'char-diff');
  var status, html = '<b>You:</b> ';
  var states = v.group.gems.map(function (g, gi) {
    var fit = best ? best.f.picked[gi] : 0;
    return fit === 1 ? { state: 'linked' } : fit ? { state: 'near' } : gemWhere(g, best);
  });
  function named(state) {
    return v.group.gems.filter(function (g, gi) { return states[gi].state === state; }).map(function (g) { return g.name; });
  }
  var unlinked = named('unlinked'), missing = named('missing');
  var elsewhere = v.group.gems.map(function (g, gi) {
    return states[gi].state === 'elsewhere' ? g.name + ' (your ' + states[gi].link.label + ')' : null;
  }).filter(Boolean);
  if (!best) {
    status = 'diff-missing';
    html += '<span class="miss">no link group with these gems</span>';
  } else {
    var f = best.f, c = best.c;
    status = (!f.missing.length && !f.variants.length && !f.linksShort) ? 'diff-matched'
      : f.score >= 0.5 ? 'diff-close' : 'diff-missing';
    html += 'your ' + esc(c.label) + ' · ' + c.links + 'L' +
      (v.group.slot && v.group.slot !== c.where ? ' <span class="finder-sub">(PoB has it in ' + esc(v.group.slot) + ')</span>' : '') +
      ' — <span class="' + (status === 'diff-matched' ? 'ok' : 'miss') + '">' + f.full + '/' + f.total + ' linked</span>';
  }
  if (unlinked.length) html += ' · <span class="miss">' + unlinked.length + ' socketed but not linked: ' + esc(unlinked.join(' · ')) + '</span>';
  if (elsewhere.length) html += ' · <span class="miss">in another item: ' + esc(elsewhere.join(' · ')) + '</span>';
  if (missing.length) html += ' · missing: <span class="miss">' + esc(missing.join(' · ')) + '</span>';
  if (best) {
    if (f.variants.length) html += ' · <span class="miss">' + esc(f.variants.join(' · ')) + '</span>';
    if (f.options.length) html += ' · running unticked option' + (f.options.length > 1 ? 's' : '') + ': ' + esc(f.options.join(' · '));
    if (f.linksShort) html += ' · <span class="miss">' + c.links + ' links, build uses ' + Math.min(6, f.total) + '</span>';
    if (f.low.length) html += ' · lower: ' + esc(f.low.slice(0, 3).join(' · ')) + (f.low.length > 3 ? ' +' + (f.low.length - 3) : '');
  }
  strip.innerHTML = html;
  v.card.classList.add(status);
  v.row.classList.add(status);
  var viz = gemLinksViz(v, best, states.map(function (s) { return s.link; }).filter(Boolean));
  if (viz) strip.appendChild(viz);
  var colours = best ? socketColourHelp(best.c) : null;
  if (colours) strip.appendChild(colours);
  v.card.insertBefore(strip, v.card.children[1]);
  v.gemRows.forEach(function (gr, gi) {
    var s = states[gi], spec = GEM_LINK_CHIP[s.state];
    var name = gr.el.querySelector('.gem-name');
    if (!name || !spec) return;
    var label = s.link ? s.link.label : best ? best.c.label : '';
    var chip = UI.chip(spec[0].replace('%s', label), spec[1], 'gem-you gem-link-' + s.state);
    chip.title = spec[2];
    name.appendChild(chip);
  });
}

function applyGemDiff() {
  gemGroupViews.forEach(function (v) {
    var old = v.card.querySelector('.char-diff');
    if (old) old.remove();
    v.card.querySelectorAll('.gem-you').forEach(function (e) { e.remove(); });
    ['diff-matched', 'diff-close', 'diff-missing'].forEach(function (d) {
      v.card.classList.remove(d);
      v.row.classList.remove(d);
    });
  });
  if (!charGear) return;
  var ranked = gemGroupViews.map(function (v) {
    var top = 0;
    charLinks.forEach(function (c) { top = Math.max(top, groupFit(v.group.gems, c).score); });
    return { v: v, top: top };
  }).sort(function (a, b) { return b.top - a.top; });
  var claimed = {};
  ranked.forEach(function (r) {
    var best = null;
    charLinks.forEach(function (c, i) {
      if (claimed[i]) return;
      var f = groupFit(r.v.group.gems, c, r.v.group.offGems);
      // one shared support isn't the setup: a lone socket holding the build's Intensify
      // mustn't stand in for a 6-link (single-gem groups need just the one)
      if (f.full + f.variants.length < Math.min(2, f.total)) return;
      var better = !best || f.score > best.f.score ||
        (f.score === best.f.score && (c.where === r.v.group.slot) && best.c.where !== r.v.group.slot);
      if (better) best = { i: i, c: c, f: f };
    });
    if (best) claimed[best.i] = true;
    renderGemDiff(r.v, best);
  });
}

function applyCharDiff() {
  applyGemDiff();
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
