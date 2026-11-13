/* js/app/45-beastrecipes.js — the Bestiary recipe browser (Cheat sheets → Bestiary): every beast
   recipe from the sheet's wiki table, filtered by the kind of item it works on, with each beast's
   price (the beast board's poe.ninja snapshot, 42-priceboards.js) and the recipe's total. Click a
   beast to see every recipe that uses it. The js/app/ files are one program split by feature:
   they load in order (index.html) and share their top-level names. */
'use strict';

// ==== recipes from the sheet ========================================================
// The table has no item-class column, so the kind is read from the recipe's own words (its Type
// and Recipe cells). A recipe can have more than one kind ("Shield or Quiver"); one that names no
// item kind is "Any item".
var BR_KINDS = [
  ['flask', 'Flask', /\bflasks?\b/i],
  ['map', 'Map', /\bmaps?\b/i],
  ['talisman', 'Talisman', /\btalisman/i],
  ['gem', 'Gem', /\bgems?\b/i],
  ['jewel', 'Jewel', /\bjewels?\b|watcher's eye/i],
  ['helmet', 'Helmet', /\bhelmet/i],
  ['body', 'Body armour', /\bbody armour/i],
  ['gloves', 'Gloves', /\bgloves\b/i],
  ['boots', 'Boots', /\bboots\b/i],
  ['ring', 'Ring', /\brings?\b/i],
  ['amulet', 'Amulet', /\bamulets?\b/i],
  ['belt', 'Belt', /\bbelts?\b/i],
  ['weapon', 'Weapon', /\b(bow|claw|dagger|mace|sceptre|staff|sword|axe|wand)s?\b/i],
  ['offhand', 'Shield / Quiver', /\b(shield|quiver)s?\b/i],
  ['influenced', 'Influenced item', /\b(crusader|hunter|redeemer|shaper|warlord|elder) item/i],
  ['aspect', 'Aspect skill', /\baspect\b/i],
  ['currency', 'Currency', /\bcurrency\b|\bscarab|\bthread/i],
  ['portal', 'Portal', /\bportal/i],
];
var BR_ANY = ['any', 'Any item'];

function brKinds(type, recipe) {
  var text = type + ' ' + recipe, out = [];
  BR_KINDS.forEach(function (k) { if (k[2].test(text)) out.push(k[0]); });
  return out.length ? out : [BR_ANY[0]];
}
function brKindLabel(id) {
  if (id === BR_ANY[0]) return BR_ANY[1];
  var k = BR_KINDS.filter(function (x) { return x[0] === id; })[0];
  return k ? k[1] : id;
}
// [{ type, recipe, beasts: [names], any: 'Any Creature (…)' | '', kinds: [ids], i }]
function brRecipes() {
  var t = pbTable('bestiary', /^Recipes/i);
  if (!t) return [];
  var tc = pbCol(t, /^Type/i, 0), rc = pbCol(t, /^Recipe/i, 1), bc = pbCol(t, /^Beasts/i, 2);
  return t.rows.map(function (r, i) {
    var beasts = [], any = '';
    String(r[bc] || '').split(/\s+\+\s+/).forEach(function (b) {
      b = b.trim();
      if (!b) return;
      if (/^Any /i.test(b)) any = b; else beasts.push(b);
    });
    var type = String(r[tc] || ''), recipe = String(r[rc] || '');
    return { type: type, recipe: recipe, beasts: beasts, any: any, kinds: brKinds(type, recipe), i: i };
  });
}
// beast name (normalised) → chaos price, from the snapshot the beast board uses
function brPrices() {
  var r = pbBeastsNow(), out = {};
  ((r && r.items) || []).forEach(function (b) {
    if (b && b[0] && b[1] != null && isFinite(b[1])) out[pbNorm(b[0])] = +b[1];
  });
  return { by: out, div: r && r.divine, has: !!(r && (r.items || []).length) };
}
// a recipe's cost: the priced beasts added up, and how many have no price
function brCost(rec, P) {
  var sum = 0, missing = 0;
  rec.beasts.forEach(function (b) {
    var c = P.by[pbNorm(b)];
    if (c == null) missing++; else sum += c;
  });
  return { sum: sum, missing: missing, known: rec.beasts.length - missing };
}

// ==== the browser ===================================================================
var BR_VIEW = {}; // per window: { kind, beast, q, sort, all } (kept while the app runs)
var BR_LIMIT = 40, BR_LIMIT_OV = 10;

function brMount(host, ctx) {
  var ov = !!ctx.overlay;
  var st = BR_VIEW[ov ? 'ov' : 'app'] = BR_VIEW[ov ? 'ov' : 'app'] || { kind: 'all', beast: '', q: '', sort: 'sheet', all: false };
  var recipes = brRecipes();
  var root = UI.el('div', 'br' + (ov ? ' is-overlay' : ''));
  host.appendChild(root);
  if (!recipes.length) { root.appendChild(UI.el('div', 'mech-empty', 'The Bestiary recipe table is missing.')); return; }

  var kindsBox = UI.el('div', 'br-kinds');
  kindsBox.setAttribute('role', 'group');
  kindsBox.setAttribute('aria-label', 'Show recipes for this kind of item');
  var bar = UI.el('div', 'br-bar');
  var beastBar = UI.el('div', 'br-beast');
  var list = UI.el('div', 'br-list');
  var foot = UI.el('div', 'mech-foot');
  root.appendChild(kindsBox);
  root.appendChild(bar);
  root.appendChild(beastBar);
  root.appendChild(list);
  root.appendChild(foot);

  bar.appendChild(UI.el('span', 'pb-bar-label', 'Sort'));
  bar.appendChild(UI.segmented([['sheet', 'By type'], ['cost', 'Cheapest']], st.sort, {
    ariaLabel: 'Sort the recipes', onChange: function (v) { st.sort = v; st.all = false; draw(); } }));
  if (!ov) {
    var search = mechSearch('Search recipes and beasts', function (q) { st.q = q; st.all = false; draw(); });
    search.value = st.q;
    bar.appendChild(search);
  } else {
    st.q = '';
  }

  function kindChip(id, label, n) {
    var b = UI.el('button', 'mech-tag br-kind', label + ' ' + n);
    b.type = 'button';
    b.dataset.kind = id;
    b.setAttribute('aria-pressed', st.kind === id ? 'true' : 'false');
    b.setAttribute('aria-label', label + ', ' + n + ' recipe' + (n === 1 ? '' : 's'));
    b.addEventListener('click', function () { st.kind = id; st.all = false; draw(); });
    return b;
  }

  function draw() {
    var P = brPrices();
    // kind chips with counts (for the beast picked, when there is one)
    var pool = recipes.filter(function (r) {
      return !st.beast || r.beasts.some(function (b) { return pbNorm(b) === st.beast; });
    });
    kindsBox.textContent = '';
    kindsBox.appendChild(kindChip('all', 'All', pool.length));
    BR_KINDS.map(function (k) { return [k[0], k[1]]; }).concat([BR_ANY]).forEach(function (k) {
      var n = pool.filter(function (r) { return r.kinds.indexOf(k[0]) !== -1; }).length;
      if (n) kindsBox.appendChild(kindChip(k[0], k[1], n));
    });
    if (st.kind !== 'all' && !pool.some(function (r) { return r.kinds.indexOf(st.kind) !== -1; })) st.kind = 'all';

    // the beast filter line
    beastBar.textContent = '';
    if (st.beast) {
      var name = (recipes.reduce(function (acc, r) {
        return acc || r.beasts.filter(function (b) { return pbNorm(b) === st.beast; })[0];
      }, '')) || st.beast;
      beastBar.appendChild(UI.el('span', 'br-beast-label', 'Recipes that use '));
      beastBar.appendChild(UI.el('b', null, name));
      var c = P.by[st.beast];
      if (c != null) beastBar.appendChild(UI.el('span', 'mech-item-price', ' ' + pbPrice(c, P.div)));
      beastBar.appendChild(UI.button('ghost', { label: 'Show all beasts', size: 'sm',
        onClick: function () { st.beast = ''; st.all = false; draw(); } }));
    }

    var rows = pool.filter(function (r) {
      if (st.kind !== 'all' && r.kinds.indexOf(st.kind) === -1) return false;
      return mechMatches(r.type + ' ' + r.recipe + ' ' + r.beasts.join(' ') + ' ' + r.any, st.q);
    });
    rows = rows.map(function (r) { return { r: r, cost: brCost(r, P) }; });
    if (st.sort === 'cost') {
      // fully priced recipes first, cheapest first; then the ones missing a price; no-beast ones last
      rows.sort(function (a, b) {
        var ka = a.r.beasts.length ? (a.cost.missing ? 1 : 0) : 2, kb = b.r.beasts.length ? (b.cost.missing ? 1 : 0) : 2;
        return ka - kb || a.cost.sum - b.cost.sum || a.r.i - b.r.i;
      });
    }
    list.textContent = '';
    var limit = st.all ? 0 : (ov ? BR_LIMIT_OV : BR_LIMIT);
    var lastType = null;
    rows.slice(0, limit || rows.length).forEach(function (x) {
      if (st.sort === 'sheet' && x.r.type !== lastType) {
        lastType = x.r.type;
        list.appendChild(UI.el('div', 'br-type', x.r.type));
      }
      list.appendChild(brRow(x.r, x.cost, P, st, draw));
    });
    if (!rows.length) list.appendChild(UI.el('div', 'mech-empty', 'No recipe matches.'));
    if (limit && rows.length > limit) {
      list.appendChild(UI.button('ghost', { label: 'Show all ' + rows.length, size: 'sm', cls: 'br-more',
        onClick: function () { st.all = true; draw(); } }));
    }
    foot.textContent = !isGui() ? 'Beast prices show in the app.'
      : P.has ? 'Beast prices: poe.ninja, through the app’s price backend. A total counts the beasts that have a price.'
        : 'No beast prices yet (offline, or the price backend has not answered).';
    if (ctx.onChange) ctx.onChange();
  }
  draw();
  pbBeastPrices(function () { if (root.isConnected) draw(); });
}

function brRow(r, cost, P, st, redraw) {
  var row = UI.el('div', 'br-row');
  row.dataset.recipe = String(r.i);
  var head = UI.el('div', 'br-head');
  head.appendChild(UI.el('span', 'br-recipe', st.sort === 'sheet' ? r.recipe || r.type : r.type + ': ' + r.recipe));
  if (r.beasts.length && cost.known) {
    var total = UI.el('span', 'br-total mech-item-price', pbPrice(cost.sum, P.div));
    total.title = cost.missing ? cost.missing + ' beast' + (cost.missing === 1 ? ' has' : 's have') + ' no price: the total leaves ' +
      (cost.missing === 1 ? 'it' : 'them') + ' out' : 'All ' + r.beasts.length + ' beasts priced';
    head.appendChild(total);
    if (cost.missing) head.appendChild(UI.chip('+' + cost.missing + ' unpriced', 'neutral', 'br-missing'));
  }
  row.appendChild(head);
  var beasts = UI.el('div', 'br-beasts');
  r.beasts.forEach(function (b) {
    var k = pbNorm(b), c = P.by[k];
    var btn = UI.el('button', 'br-beast-chip' + (st.beast === k ? ' is-on' : ''));
    btn.type = 'button';
    btn.dataset.beast = k;
    btn.title = 'Show every recipe that uses ' + b;
    btn.appendChild(UI.el('span', 'br-beast-name', b));
    if (c != null) btn.appendChild(UI.el('span', 'mech-item-price', pbPrice(c, P.div)));
    btn.addEventListener('click', function () { st.beast = st.beast === k ? '' : k; st.kind = 'all'; st.all = false; redraw(); });
    beasts.appendChild(btn);
  });
  if (r.any) beasts.appendChild(UI.el('span', 'br-any', r.any));
  row.appendChild(beasts);
  return row;
}

mechTool({ id: 'beastrecipes', title: 'Recipe browser', sheets: ['bestiary'], overlay: true, order: 20,
  available: function () { return !!pbTable('bestiary', /^Recipes/i); }, mount: brMount });
