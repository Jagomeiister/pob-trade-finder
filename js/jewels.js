/* Jewel finder: what does THIS build want from a jewel?
 *
 * 1. profile(): tally features across the allocated passive tree (small 1,
 *    notable/keystone/mastery 3) and the main skill's gem tags (strong signal).
 * 2. scoreMod(): a jewel mod's value = its EFFECT weight (damage, crit, life,
 *    ES, speed, …) × its weakest QUALIFIER (fire, spell, staff, minion, …).
 *    Qualifiers multiply because "+crit multi with Fire Skills" is worth
 *    nothing to a cold build however much it loves crit.
 * 3. weightedQuery()/countQuery(): trade queries over the chosen mods;
 *    timelessQuery(): seed search across a timeless jewel's conquerors.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Jewels = factory();
})(this, function () {
  'use strict';

  // qualifiers: conditions a mod only pays off under
  var QUALIFIERS = {
    fire: /\bfire damage|\bignit|\bburning|fire skills|\bwith fire\b/,
    cold: /\bcold damage|\bfreez|\bfrozen|\bchill|cold skills/,
    lightning: /\blightning damage|\bshock|lightning skills/,
    elemental: /\belemental damage|elemental skills/,
    chaos: /\bchaos damage|\bpoison|\bwither|chaos skills/,
    physical: /\bphysical damage|\bbleed|\bimpale/,
    dot: /damage over time|\bignit|\bpoison|\bbleed|damaging ailment/,
    area: /\barea damage|area of effect/,
    spell: /\bspells?\b|cast speed/,
    attack: /\battacks?\b|attack speed|\baccuracy/,
    melee: /\bmelee\b/,
    projectile: /\bprojectile/,
    minion: /\bminions?\b/,
    totem: /\btotems?\b/,
    trap: /\btraps?\b/,
    mine: /\bmines?\b/,
    brand: /\bbrands?\b/,
    staff: /\bstaff\b|\bstaves\b/,
    bow: /\bbows?\b/,
    wand: /\bwands?\b/,
    shield: /holding a shield|with a shield|(?:^|[^y] )shields?\b/,
    dualwield: /dual wield/,
    twohand: /two handed/,
    onehand: /one handed/,
    sword: /\bswords?\b/, axe: /\baxes?\b/, mace: /\bmaces?\b|\bsceptres?\b/,
    claw: /\bclaws?\b/, dagger: /\bdaggers?\b/
  };
  // effects: what a mod gives
  var EFFECTS = {
    crit: /critical strike/,
    life: /\blife\b/,
    es: /energy shield/,
    mana: /\bmana\b/,
    evasion: /\bevasion/,
    armour: /\barmour\b/,
    block: /\bblock\b/,
    suppress: /suppress/,
    speed: /attack speed|cast speed|\bspeed\b/,
    aura: /\baura|reservation/,
    curse: /\bcurse|\bhex/,
    resist: /resistance/,
    attribute: /\bstrength\b|\bdexterity\b|\bintelligence\b|all attributes/,
    damage: /\bdamage\b(?! taken)/
  };
  // main-skill gem tags that map onto features
  var GEM_TAG = { spell: 'spell', attack: 'attack', melee: 'melee', projectile: 'projectile', area: 'area',
                  fire: 'fire', cold: 'cold', lightning: 'lightning', chaos: 'chaos', physical: 'physical',
                  minion: 'minion', totem: 'totem', trap: 'trap', mine: 'mine', brand: 'brand',
                  bow: 'bow', critical: 'crit', critical_strike: 'crit' };
  var GEM_WEIGHT = 12, NODE_WEIGHT = { small: 1, notable: 3, keystone: 3, mastery: 3 };

  function features(text) {
    var t = String(text || '').toLowerCase(), q = [], e = [];
    Object.keys(QUALIFIERS).forEach(function (k) { if (QUALIFIERS[k].test(t)) q.push(k); });
    Object.keys(EFFECTS).forEach(function (k) { if (EFFECTS[k].test(t)) e.push(k); });
    // "% increased Fire Damage" names the element; plain resist lines don't make a build "fire"
    if (e.indexOf('resist') !== -1) q = q.filter(function (k) { return !/^(fire|cold|lightning|chaos)$/.test(k) || /damage/.test(t); });
    // "Block Spell Damage" / "Suppress Spell Damage" are defences, not damage
    if (e.indexOf('block') !== -1 || e.indexOf('suppress') !== -1) e = e.filter(function (k) { return k !== 'damage'; });
    // "…of Chill on you", "…Freeze Duration on you": defensive lines about the player
    var self = /\bon you\b|\byou are\b|\bagainst you\b/.test(t);
    return { q: q, e: e, self: self };
  }

  /* build: { tree: {nodes, masteries}, mainSkill: [gem names] }
     J: window.POE_JEWELS */
  function profile(build, J) {
    var tally = {}, why = {};
    function add(text, w, src) {
      var f = features(text);
      f.q.concat(f.e).forEach(function (k) {
        tally[k] = (tally[k] || 0) + w;
        if (src) (why[k] = why[k] || []).length < 4 && why[k].indexOf(src) === -1 && why[k].push(src);
      });
    }
    ((build.tree && build.tree.nodes) || []).forEach(function (id) {
      var n = J.tree[id];
      if (!n || !n[2]) return;
      var kind = n[0] & 2 ? 'keystone' : n[0] & 1 ? 'notable' : 'small';
      n[2].split('\n').forEach(function (line) { add(line, NODE_WEIGHT[kind], kind !== 'small' ? n[1] : null); });
    });
    ((build.tree && build.tree.masteries) || []).forEach(function (pair) {
      var s = J.masteries[pair[1]];
      if (s) s.split('\n').forEach(function (line) { add(line, NODE_WEIGHT.mastery, null); });
    });
    var gems = [], mainQ = {};
    (build.mainSkill || []).forEach(function (name, i) {
      var tags = J.gems[name] || J.gems[name + ' Support'];
      if (!tags) return;
      gems.push(name);
      var active = tags.indexOf('grants_active_skill') !== -1 || i === 0;
      // a minion gem's other tags (spell, duration…) describe casting it — the
      // minions do the damage, so only "minion" counts
      var minionGem = tags.indexOf('minion') !== -1;
      tags.forEach(function (tag) {
        var k = GEM_TAG[tag];
        if (!k || (minionGem && k !== 'minion')) return;
        tally[k] = (tally[k] || 0) + GEM_WEIGHT;
        // what the main ACTIVE skill is (cold, spell, area…) is fully relevant
        // however few passives mention it
        if (active && QUALIFIERS[k]) mainQ[k] = true;
        (why[k] = why[k] || []).indexOf(name) === -1 && why[k].length < 4 && why[k].push(name);
      });
    });
    var maxQ = 0;
    Object.keys(QUALIFIERS).forEach(function (k) { if ((tally[k] || 0) > maxQ) maxQ = tally[k]; });
    return { tally: tally, maxQ: maxQ || 1, why: why, gems: gems, mainQ: mainQ };
  }

  function qualWeight(P, k) {
    if (P.mainQ && P.mainQ[k]) return 1;
    if (k === 'elemental') return Math.max(qualWeight(P, 'fire'), qualWeight(P, 'cold'), qualWeight(P, 'lightning'),
                                           Math.min(1, (P.tally.elemental || 0) / P.maxQ));
    return Math.min(1, (P.tally[k] || 0) / P.maxQ);
  }

  function effectWeight(P, k, hasQualifier) {
    var t = P.tally, life = t.life || 0, es = t.es || 0;
    switch (k) {
      case 'damage': return hasQualifier ? 1 : 0.55; // unconditional "% increased Damage" is diluted
      case 'crit': return Math.min(1, (t.crit || 0) / (0.5 * P.maxQ));
      case 'life': return life + es ? life / (life + es) : 0.5;
      case 'es': return life + es ? es / (life + es) : 0.3;
      case 'speed': return 0.7;
      case 'resist': case 'attribute': return 0.25;
      default: return Math.min(1, (t[k] || 0) / P.maxQ);
    }
  }

  function scoreText(P, text) {
    var f = features(text);
    if (!f.e.length && !f.q.length) return 0.1;
    if (f.self && !f.e.some(function (k) { return k !== 'damage'; })) return 0.2; // ailment/curse avoidance etc.
    var eff = 0;
    f.e.forEach(function (k) { eff = Math.max(eff, effectWeight(P, k, f.q.length > 0)); });
    if (!f.e.length) eff = 0.4; // qualifier-only lines (e.g. "increased Freeze Duration on Enemies")
    var qual = 1;
    // elemental qualifiers are alternatives ("cold or lightning"), others must all hold
    f.q.forEach(function (k) { qual = Math.min(qual, qualWeight(P, k)); });
    return Math.round(eff * qual * 1000) / 1000;
  }

  /* kinds: bit mask of bases to consider (bits 0-2 regular, 3-6 abyss) */
  function rankMods(J, P, kinds) {
    return J.mods.filter(function (m) { return m[3] & kinds; }).map(function (m) {
      return { tail: m[0], text: m[1], max: m[2], mask: m[3], affix: m[4], tags: m[5], score: scoreText(P, m[1]) };
    }).sort(function (a, b) { return b.score - a.score || a.text.localeCompare(b.text); });
  }

  function baseFilters(opts) {
    var f = { type_filters: { filters: { category: { option: opts.abyss ? 'jewel.abyss' : 'jewel.base' },
                                         rarity: { option: 'nonunique' } } } };
    var trade = {};
    if (opts.saleType && opts.saleType !== 'any') trade.sale_type = { option: opts.saleType };
    if (opts.maxPrice) trade.price = { max: opts.maxPrice };
    if (Object.keys(trade).length) f.trade_filters = { filters: trade };
    return f;
  }

  /* selected: [{tail, max, score, required}] */
  function weightedQuery(selected, opts) {
    var stats = [], req = selected.filter(function (s) { return s.required; });
    if (req.length) stats.push({ type: 'and', filters: req.map(function (s) { return { id: 'explicit.' + s.tail }; }) });
    stats.push({ type: 'weight', value: opts.minScore ? { min: opts.minScore } : {},
      filters: selected.map(function (s) {
        return { id: 'explicit.' + s.tail, value: { weight: weightFor(s) } };
      }) });
    var q = { status: { option: opts.status || 'available' }, stats: stats, filters: baseFilters(opts) };
    if (opts.base) q.type = opts.base;
    var sort = {};
    if (opts.sort === 'price') sort.price = 'asc';
    else sort['statgroup.' + (stats.length - 1)] = 'desc';
    return { query: q, sort: sort };
  }
  // a max-rolled mod is worth (score × 100) points
  function weightFor(s) { return Math.round(s.score * 100 / Math.max(s.max, 0.01) * 100) / 100; }
  function maxScore(selected) {
    return selected.reduce(function (sum, s) { return sum + weightFor(s) * s.max; }, 0);
  }

  function countQuery(selected, opts) {
    var stats = [], req = selected.filter(function (s) { return s.required; });
    var pct = opts.minRoll || 0;
    function val(s) {
      if (!pct) return undefined;
      var v = s.max * pct;
      return { min: v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10 };
    }
    if (req.length) stats.push({ type: 'and', filters: req.map(function (s) { var f = { id: 'explicit.' + s.tail }; var v = val(s); if (v) f.value = v; return f; }) });
    var opt = selected.filter(function (s) { return !s.required; });
    if (opt.length) {
      stats.push({ type: 'count', value: { min: Math.min(opts.count || 2, opt.length) },
        filters: opt.map(function (s) { var f = { id: 'explicit.' + s.tail }; var v = val(s); if (v) f.value = v; return f; }) });
    }
    var q = { status: { option: opts.status || 'available' }, stats: stats, filters: baseFilters(opts) };
    if (opts.base) q.type = opts.base;
    return { query: q, sort: { price: 'asc' } };
  }

  var TIMELESS = {
    'Glorious Vanity': ['doryani', 'xibaqua', 'ahuana', 'zerphi'],
    'Lethal Pride': ['kaom', 'rakiata', 'akoya', 'kiloava'],
    'Brutal Restraint': ['asenath', 'nasima', 'balbala', 'deshret'],
    'Militant Faith': ['avarius', 'maxarius', 'dominus', 'venarius'],
    'Elegant Hubris': ['cadiro', 'victario', 'caspiro', 'chitus'],
    'Heroic Tragedy': ['vorana', 'uhtred', 'medved']
  };
  // the keystone each conqueror's version of the jewel grants (PoB unique data);
  // the fourth conqueror of each jewel is a legacy pre-3.11 variant
  var KEYSTONES = {
    doryani: 'Corrupted Soul', xibaqua: 'Divine Flesh', ahuana: 'Immortal Ambition', zerphi: 'Eternal Youth (legacy)',
    kaom: 'Strength of Blood', rakiata: 'Tempered by War', akoya: 'Chainbreaker', kiloava: 'Glancing Blows (legacy)',
    asenath: 'Dance with Death', nasima: 'Second Sight', balbala: 'The Traitor', deshret: 'Wind Dancer (legacy)',
    avarius: 'Power of Purpose', dominus: 'Inner Conviction', maxarius: 'Transcendence', venarius: 'The Agnostic (legacy)',
    cadiro: 'Supreme Decadence', victario: 'Supreme Grandstanding', caspiro: 'Supreme Ostentation', chitus: 'Supreme Ego (legacy)',
    vorana: 'Black Scythe Training', uhtred: 'Celestial Mathematics', medved: 'The Unbreaking Circle'
  };
  // PoB's TimelessData conquerorTypeId: 1 = Any, then these in order (per jewel type id)
  var POB_CONQUERORS = { 1: ['doryani', 'xibaqua', 'ahuana'], 2: ['kaom', 'rakiata', 'akoya'],
                         3: ['asenath', 'nasima', 'balbala'], 4: ['avarius', 'dominus', 'maxarius'],
                         5: ['cadiro', 'victario', 'caspiro'], 6: ['vorana', 'uhtred', 'medved'] };
  function pobConqueror(jewelTypeId, conquerorTypeId) {
    var list = POB_CONQUERORS[jewelTypeId];
    return list && conquerorTypeId > 1 ? list[conquerorTypeId - 2] || '' : '';
  }

  // trade 'query too complex' budget: 20 filters anonymously, 40 logged in (measured)
  var MAX_TIMELESS_FILTERS = 40, MAX_TIMELESS_FILTERS_ANON = 20;

  function parseSeeds(text) {
    var out = [];
    String(text || '').split(/[\s,;]+/).forEach(function (p) {
      var n = parseInt(p, 10);
      if (!isNaN(n) && n > 0 && out.indexOf(n) === -1) out.push(n);
    });
    return out;
  }

  /* conqueror: one of TIMELESS[jewel] or '' for any */
  function timelessQuery(jewel, seeds, conqueror, opts) {
    var cap = opts && opts.anonymous ? MAX_TIMELESS_FILTERS_ANON : MAX_TIMELESS_FILTERS;
    var conq = conqueror ? [conqueror] : TIMELESS[jewel] || [];
    var filters = [];
    seeds.forEach(function (s) {
      conq.forEach(function (c) {
        filters.push({ id: 'explicit.pseudo_timeless_jewel_' + c, value: { min: s, max: s } });
      });
    });
    var q = { status: { option: (opts && opts.status) || 'available' }, name: jewel, type: 'Timeless Jewel',
              stats: [{ type: 'count', value: { min: 1 }, filters: filters.slice(0, cap) }] };
    return { query: q, sort: { price: 'asc' }, truncated: filters.length > cap };
  }

  /* Fuzzy filter for the mod/outcome lists. Every query word must match one word of
     the text: as a prefix/substring (best), as a subsequence ("critcal" in
     "critical", "mlti" in "multiplier"), or within a small edit distance
     ("multipiler"). Returns a score (higher = better) or -1 for no match. */
  // optimal-string-alignment distance (adjacent swaps count as one edit), capped
  function editDistance(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    var older = null, prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (older && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], older[j - 2] + 1);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > cap) return cap + 1;
      older = prev; prev = cur;
    }
    return prev[b.length];
  }
  // shorthand players type -> the words the mods use
  var ALIASES = { es: 'energy shield', ms: 'movement speed', aoe: 'area', res: 'resistance',
                  ele: 'elemental', dot: 'over time', cdr: 'cooldown recovery', dmg: 'damage',
                  crit: 'critical', multi: 'multiplier', phys: 'physical', regen: 'regeneration',
                  hp: 'life', attr: 'attributes', ias: 'attack speed', cs: 'cast speed' };
  function isSubsequence(q, w) {
    var k = 0;
    for (var i = 0; i < w.length && k < q.length; i++) if (w[i] === q[k]) k++;
    return k === q.length;
  }
  function fuzzyScore(query, text) {
    var words = [];
    String(query || '').toLowerCase().split(/[^a-z0-9%+]+/).filter(Boolean).forEach(function (w) {
      (ALIASES[w] || w).split(' ').forEach(function (x) { words.push(x); });
    });
    if (!words.length) return 0;
    var tw = String(text || '').toLowerCase().split(/[^a-z0-9%+]+/).filter(Boolean);
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      var q = words[i], best = -1;
      for (var j = 0; j < tw.length; j++) {
        var w = tw[j], s = -1;
        if (w.indexOf(q) === 0) s = 10;
        else if (w.indexOf(q) > 0) s = 7;
        else if (q.length >= 3 && isSubsequence(q, w) && q[0] === w[0]) s = 5;
        else if (q.length >= 4) {
          var cap = q.length >= 7 ? 2 : 1;
          if (editDistance(q, w.slice(0, q.length + cap), cap) <= cap) s = 4;
        }
        if (s > best) best = s;
      }
      if (best < 0) return -1;
      total += best;
    }
    return total;
  }

  /* sockets in the tree: allocated jewel-socket nodes, which hold a jewel */
  function socketReport(build, J) {
    var filled = {};
    ((build.tree && build.tree.sockets) || []).forEach(function (s) { if (s.itemId && s.itemId !== '0') filled[s.nodeId] = s.itemId; });
    var out = [];
    ((build.tree && build.tree.nodes) || []).forEach(function (id) {
      var n = J.tree[id];
      if (n && n[0] & 4) out.push({ nodeId: id, name: n[1], itemId: filled[id] || null });
    });
    return out;
  }

  return { features: features, profile: profile, scoreText: scoreText, rankMods: rankMods,
           weightedQuery: weightedQuery, countQuery: countQuery, weightFor: weightFor, maxScore: maxScore,
           timelessQuery: timelessQuery, parseSeeds: parseSeeds, socketReport: socketReport, fuzzyScore: fuzzyScore,
           KEYSTONES: KEYSTONES, pobConqueror: pobConqueror,
           TIMELESS: TIMELESS, MAX_TIMELESS_FILTERS: MAX_TIMELESS_FILTERS,
           MAX_TIMELESS_FILTERS_ANON: MAX_TIMELESS_FILTERS_ANON, QUALIFIERS: QUALIFIERS, EFFECTS: EFFECTS };
});
