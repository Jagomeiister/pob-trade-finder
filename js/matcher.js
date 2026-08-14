/* matcher.js — match PoB item mod lines to official trade-site stat IDs.
 * Uses the bundled GGG /api/trade/data/stats payload. Browser + Node. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Matcher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalize(text) {
    return text
      .toLowerCase()
      .replace(/\d+(\.\d+)?/g, '#')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Exact key keeps digits — matches fixed-text stats like cluster notables
  // ("1 Added Passive Skill is X") and value-in-id enchants
  // ("Added Small Passive Skills grant: 12% increased Cold Damage").
  function exactKey(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function extractNumbers(line) {
    var nums = [];
    var re = /-?\d+(\.\d+)?/g, m;
    while ((m = re.exec(line))) nums.push(parseFloat(m[0]));
    return nums;
  }

  /* Build lookups:
   *   norm:  normalizedText -> { sectionId: [entries...] }
   *   exact: exactText      -> { sectionId: [entries...] }
   *   byId:  statId -> entry */
  function buildStatIndex(statsJson) {
    var index = { norm: {}, exact: {}, byId: {} };
    var sections = statsJson.result || [];
    for (var s = 0; s < sections.length; s++) {
      var secId = sections[s].id;
      var entries = sections[s].entries || [];
      for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        if (!entry.text) continue;
        var nk = normalize(entry.text);
        var ek = exactKey(entry.text);
        if (!index.norm[nk]) index.norm[nk] = {};
        if (!index.norm[nk][secId]) index.norm[nk][secId] = [];
        index.norm[nk][secId].push(entry);
        if (ek !== nk) { // only worth indexing when the text has literal digits
          if (!index.exact[ek]) index.exact[ek] = {};
          if (!index.exact[ek][secId]) index.exact[ek][secId] = [];
          index.exact[ek][secId].push(entry);
        }
        // multi-line stats (2000+ in the DB, e.g. flask suffixes): items show the
        // lines separately, so index every line to the parent stat as well
        if (entry.text.indexOf('\n') !== -1) {
          entry.text.split('\n').forEach(function (lineText) {
            var lk = normalize(lineText);
            if (!lk || lk === nk) return;
            if (!index.norm[lk]) index.norm[lk] = {};
            if (!index.norm[lk][secId]) index.norm[lk][secId] = [];
            index.norm[lk][secId].push(entry);
          });
        }
        index.byId[entry.id] = entry;
      }
    }
    return index;
  }

  // Pseudo-total substitutions (mod normalized text -> pseudo stat id)
  var PSEUDO_MAP = {
    '+#% to fire resistance': 'pseudo.pseudo_total_fire_resistance',
    '+#% to cold resistance': 'pseudo.pseudo_total_cold_resistance',
    '+#% to lightning resistance': 'pseudo.pseudo_total_lightning_resistance',
    '+#% to chaos resistance': 'pseudo.pseudo_total_chaos_resistance',
    '+#% to all elemental resistances': 'pseudo.pseudo_total_all_elemental_resistances',
    '+# to maximum life': 'pseudo.pseudo_total_life',
    '+# to maximum mana': 'pseudo.pseudo_total_mana',
    '+# to maximum energy shield': 'pseudo.pseudo_total_energy_shield',
    '+# to strength': 'pseudo.pseudo_total_strength',
    '+# to dexterity': 'pseudo.pseudo_total_dexterity',
    '+# to intelligence': 'pseudo.pseudo_total_intelligence',
    '+# to all attributes': 'pseudo.pseudo_total_all_attributes'
  };
  var DUAL_RES_RE = /^\+#% to (fire|cold|lightning) and (fire|cold|lightning) resistances$/;

  function findPseudo(index, normLine, values) {
    var id = PSEUDO_MAP[normLine];
    if (id && index.byId[id]) return { entry: index.byId[id], values: values, multiplier: 1 };
    if (DUAL_RES_RE.test(normLine) && index.byId['pseudo.pseudo_total_elemental_resistance']) {
      return { entry: index.byId['pseudo.pseudo_total_elemental_resistance'], values: values, multiplier: 2 };
    }
    return null;
  }

  function lookupById(index, id) {
    return index.byId[id] || null;
  }

  // Slots where a "(Local)" twin, when it exists, is the right pick
  function prefersLocal(slotName) {
    return /^(Weapon|Helmet|Body Armour|Gloves|Boots)/i.test(slotName || '') ||
           /Shield/i.test(slotName || '');
  }

  function pickFromSections(bySection, order) {
    if (!bySection) return null;
    for (var i = 0; i < order.length; i++) {
      var sec = order[i];
      if (bySection[sec] && bySection[sec].length) return { entry: bySection[sec][0], section: sec };
    }
    return null;
  }

  /* Match one parsed mod ({line, kind, crafted, fractured}) for a given slot.
   * Returns { entry, section, values, avg, local, fixedText, pseudo } or null. */
  function matchMod(index, mod, slotName) {
    var norm = normalize(mod.line);
    var values = extractNumbers(mod.line);

    var order;
    if (mod.kind === 'implicit' && mod.crafted) order = ['enchant', 'implicit', 'crafted', 'explicit'];
    else if (mod.kind === 'implicit') order = ['implicit', 'explicit', 'enchant'];
    else if (mod.crafted) order = ['crafted', 'explicit', 'implicit', 'enchant'];
    else if (mod.fractured) order = ['explicit', 'fractured', 'implicit', 'enchant'];
    else order = ['explicit', 'implicit', 'enchant', 'crafted', 'veiled'];

    var picked = null, usedLocal = false;

    // 1) Exact text (digits kept) — fixed-value stats, notables, value-in-id enchants
    picked = pickFromSections(index.exact[exactKey(mod.line)], order);

    // 2) "(Local)" twin on weapon/armour slots
    if (!picked && prefersLocal(slotName) && mod.kind !== 'implicit') {
      picked = pickFromSections(index.norm[norm + ' (local)'], order);
      if (picked) usedLocal = true;
    }

    // 3) Plain normalized
    if (!picked) picked = pickFromSections(index.norm[norm], order);

    // 4) tolerant fallbacks — PoB item text drifts from GGG stat templates:
    //    plural ("Gain 3 Charges" vs "Gain # Charge"), sign ("-1%" shown for a
    //    negative roll of a "+#%" template), and short in-game aliases.
    if (!picked) {
      var candidates = [];
      var depl = norm.replace(/(# \w+?)s\b/g, '$1');
      if (depl !== norm) candidates.push(depl);
      var plur = norm.replace(/(# \w+)\b(?!s)/g, '$1s');
      if (plur !== norm) candidates.push(plur);
      var signAlt = norm.replace(/-#/g, '+#');
      if (signAlt !== norm) candidates.push(signAlt);
      // aliases: short in-game phrasing -> full trade phrasing
      [norm, signAlt].forEach(function (base) {
        var aliased = base.replace(/chance to block(?! (attack|spell|projectile))/g, 'chance to block attack damage');
        if (aliased !== base) candidates.push(aliased);
      });
      // small cluster jewels phrase the socket count in the singular
      if (norm === '# added passive skill is a jewel socket') {
        candidates.push('# added passive skills are jewel sockets');
      }
      for (var c = 0; c < candidates.length && !picked; c++) {
        picked = pickFromSections(index.norm[candidates[c]], order);
      }
    }

    // 5) increased <-> reduced flip with negated value
    var flipped = false;
    if (!picked) {
      var alt = null;
      if (norm.indexOf('reduced') !== -1) alt = norm.replace(/reduced/g, 'increased');
      else if (norm.indexOf('increased') !== -1) alt = norm.replace(/increased/g, 'reduced');
      if (alt) {
        picked = pickFromSections(index.norm[alt], order);
        if (picked) flipped = true;
      }
    }
    if (!picked) return null;

    var vals = values.slice();
    if (flipped) vals = vals.map(function (v) { return -v; });
    var avg = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;

    return {
      entry: picked.entry,
      section: picked.section,
      values: vals,
      avg: avg,
      local: usedLocal,
      // true when the trade stat has no '#' or embeds its value in the id —
      // such filters must be sent without a value clause
      fixedText: picked.entry.text.indexOf('#') === -1 || picked.entry.id.indexOf('|') !== -1,
      pseudo: findPseudo(index, norm, vals)
    };
  }

  // Direct lookup of a mod line in one specific stat section (e.g. 'fractured')
  function findInSection(index, line, section) {
    var e = index.exact[exactKey(line)];
    if (e && e[section] && e[section].length) return e[section][0];
    var n = index.norm[normalize(line)];
    if (n && n[section] && n[section].length) return n[section][0];
    return null;
  }

  return {
    normalize: normalize,
    extractNumbers: extractNumbers,
    buildStatIndex: buildStatIndex,
    matchMod: matchMod,
    lookupById: lookupById,
    findInSection: findInSection
  };
});
