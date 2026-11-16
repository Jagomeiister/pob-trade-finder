/* pob.js — decode + parse Path of Building export codes.
 * Works in browser (window.PoB) and Node (module.exports) so the same
 * logic is unit-testable outside the browser. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PoB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- decoding -----------------------------------------------------------

  function base64UrlToBytes(code) {
    var b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    var bin;
    if (typeof atob === 'function') {
      bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  // Browser path: DecompressionStream handles zlib ("deflate") data.
  async function decodePobCode(code) {
    var bytes = base64UrlToBytes(code);
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('deflate');
      var stream = new Blob([bytes]).stream().pipeThrough(ds);
      var buf = await new Response(stream).arrayBuffer();
      return new TextDecoder('utf-8').decode(buf);
    }
    // Node path
    var zlib = require('zlib');
    return zlib.inflateSync(Buffer.from(bytes)).toString('utf8');
  }

  // ---- XML extraction (regex-based so it runs identically in Node) --------

  function unescapeXml(s) {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&amp;/g, '&');
  }

  function attr(attrStr, name) {
    var m = attrStr.match(new RegExp('\\b' + name + '="([^"]*)"'));
    return m ? unescapeXml(m[1]) : null;
  }

  // Metadata line prefixes inside an <Item> block that are never mods.
  var META_PREFIXES = [
    'Rarity:', 'Unique ID:', 'Item Level:', 'Quality:', 'Sockets:', 'LevelReq:',
    'Radius:', 'Limited to:', 'Variant:', 'Selected Variant', 'Has Alt Variant',
    'Alt Variant', 'League:', 'Crafted:', 'Prefix:', 'Suffix:', 'Catalyst',
    'Armour:', 'ArmourBase', 'Evasion:', 'EvasionBase', 'Energy Shield:',
    'EnergyShieldBase', 'Ward:', 'WardBase', 'Talisman Tier', 'Source:',
    'Cluster Jewel', 'Requires ', 'Implicits:', 'Upgrade:', 'Mirrored',
    'Split', 'Note:', 'Influence1:', 'Influence2:'
  ];
  var INFLUENCE_LINES = [
    'Shaper Item', 'Elder Item', 'Crusader Item', 'Redeemer Item',
    'Hunter Item', 'Warlord Item', 'Searing Exarch Item', 'Eater of Worlds Item',
    'Synthesised Item', 'Fractured Item', 'Corrupted'
  ];

  function isMetaLine(line) {
    for (var i = 0; i < META_PREFIXES.length; i++)
      if (line.indexOf(META_PREFIXES[i]) === 0) return true;
    return INFLUENCE_LINES.indexOf(line) !== -1;
  }

  // Resolve "(20-30)" roll ranges to a concrete number using range factor.
  function resolveRanges(line, rangeFactor) {
    var f = (typeof rangeFactor === 'number') ? rangeFactor : 0.5;
    return line.replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, function (_, a, b) {
      var v = parseFloat(a) + f * (parseFloat(b) - parseFloat(a));
      return String(Math.round(v * 100) / 100);
    });
  }

  /* Parse the raw text block of one <Item>. Returns:
   * { rarity, name, base, sockets, maxLinks, corrupted, mods: [
   *     { line, raw, kind: 'implicit'|'explicit', crafted, fractured } ] } */
  var RANGE_PATTERN = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/;

  function parseItemText(text, modRanges) {
    modRanges = modRanges || {};
    var rangedSeen = 0;
    var lines = text.split('\n').map(function (l) { return l.trim(); })
                    .filter(function (l) { return l.length > 0 && l.charAt(0) !== '<'; });
    if (!lines.length) return null;

    var item = { rarity: 'RARE', name: '', base: '', sockets: '', maxLinks: 0,
                 corrupted: false, itemLevel: 0, influences: [], mods: [] };
    var i = 0;
    var m = lines[0].match(/^Rarity:\s*(\w+)/i);
    if (m) { item.rarity = m[1].toUpperCase(); i = 1; }

    // Name / base lines (skip {variant:...} decorated alternates for simplicity)
    var nameLines = [];
    while (i < lines.length && !isMetaLine(lines[i]) && nameLines.length < 2) {
      var nl = lines[i];
      while (/^\{[^}]*\}/.test(nl)) nl = nl.replace(/^\{[^}]*\}/, '');
      nameLines.push(nl.trim());
      i++;
    }
    if (nameLines.length === 2) { item.name = nameLines[0]; item.base = nameLines[1]; }
    else if (nameLines.length === 1) { item.name = nameLines[0]; item.base = nameLines[0]; }

    var implicitCount = 0;
    var pastImplicitMarker = false;
    var implicitsSeen = 0;
    var bodyStart = i;

    // Variant uniques (Impossible Escape, Watcher's Eye-style rolls, legacy versions)
    // list EVERY variant's lines tagged {variant:1,2}; keep only the selected one(s)
    var selVariant = null, selAlt = null, hasAlt = false;
    lines.forEach(function (l) {
      var sv = l.match(/^Selected Variant:\s*(\d+)/i);
      if (sv) selVariant = parseInt(sv[1], 10);
      var sa = l.match(/^Selected Alt Variant:\s*(\d+)/i);
      if (sa) selAlt = parseInt(sa[1], 10);
      if (/^Has Alt Variant:\s*true/i.test(l)) hasAlt = true;
    });
    if (!hasAlt) selAlt = null;

    for (; i < lines.length; i++) {
      var line = lines[i];
      var sm = line.match(/^Sockets:\s*(.+)$/i);
      if (sm) {
        item.sockets = sm[1].trim();
        var groups = item.sockets.split(/\s+/);
        for (var g = 0; g < groups.length; g++) {
          var linked = groups[g].split('-').length;
          if (linked > item.maxLinks) item.maxLinks = linked;
        }
        continue;
      }
      if (line === 'Corrupted') { item.corrupted = true; continue; }
      var ilm = line.match(/^Item Level:\s*(\d+)/i);
      if (ilm) { item.itemLevel = parseInt(ilm[1], 10); continue; }
      var infl = line.match(/^(Shaper|Elder|Crusader|Redeemer|Hunter|Warlord|Searing Exarch|Eater of Worlds) Item$/);
      if (infl) { item.influences.push(infl[1]); continue; }
      var im = line.match(/^Implicits:\s*(\d+)/i);
      if (im) { implicitCount = parseInt(im[1], 10); pastImplicitMarker = true; continue; }
      if (isMetaLine(line)) continue;
      if (!pastImplicitMarker) continue; // pre-implicit metadata we don't recognise

      // Mod line: peel off {tag} prefixes
      var crafted = false, fractured = false, tagRange = null, variants = null;
      var raw = line;
      var tagMatch;
      while ((tagMatch = line.match(/^\{([^}]*)\}/))) {
        var tag = tagMatch[1];
        if (tag === 'crafted') crafted = true;
        else if (tag === 'fractured') fractured = true;
        else if (tag.indexOf('range:') === 0) tagRange = parseFloat(tag.slice(6));
        else if (tag.indexOf('variant:') === 0) variants = tag.slice(8).split(',').map(Number);
        // {tags:...}, {custom} are ignored
        line = line.slice(tagMatch[0].length);
      }
      line = line.trim();
      if (!line) continue;
      var isRanged = RANGE_PATTERN.test(line);
      if (variants && selVariant !== null && variants.indexOf(selVariant) === -1 &&
          !(selAlt !== null && variants.indexOf(selAlt) !== -1)) {
        // another variant's line: skip it, but keep the implicit/roll counters in
        // step — PoB counts every listed line for both
        if (implicitsSeen < implicitCount) implicitsSeen++;
        if (isRanged) rangedSeen++;
        continue;
      }
      var bounds = null;
      if (isRanged) {
        // capture the roll bounds (avg-space for multi-range "Adds (a-b) to (c-d)")
        var lows = [], highs = [], pm;
        var pairRe = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g;
        while ((pm = pairRe.exec(line))) {
          lows.push(parseFloat(pm[1]));
          highs.push(parseFloat(pm[2]));
        }
        if (lows.length) {
          var avg = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
          bounds = [avg(lows), avg(highs)];
        }
        // Nth ranged mod on the item — <ModRange id="N"> gives its real roll
        rangedSeen++;
        var rf = 0.5;
        if (tagRange !== null) rf = tagRange;
        else if (modRanges[String(rangedSeen)] !== undefined) rf = modRanges[String(rangedSeen)];
        line = resolveRanges(line, rf);
      }

      var kind = (implicitsSeen < implicitCount) ? 'implicit' : 'explicit';
      if (implicitsSeen < implicitCount) implicitsSeen++;
      // variant: the line came from the selected {variant:N} — it's what tells
      // this copy of the unique apart from the others (keystone, conqueror…)
      item.mods.push({ line: line, raw: raw, kind: kind, crafted: crafted,
                       fractured: fractured, ranged: isRanged, bounds: bounds, variant: !!variants });
    }

    // Defensive fallback: no "Implicits: N" marker at all (hand-edited or
    // non-standard export) — treat every non-metadata line as an explicit mod
    // rather than silently dropping the whole item.
    if (!pastImplicitMarker && !item.mods.length) {
      for (var j = bodyStart; j < lines.length; j++) {
        var fl = lines[j];
        if (isMetaLine(fl) || fl === 'Corrupted' || /^Sockets:/i.test(fl)) continue;
        var fCrafted = false, fFractured = false, fRange = 0.5, fRaw = fl, ftm;
        while ((ftm = fl.match(/^\{([^}]*)\}/))) {
          if (ftm[1] === 'crafted') fCrafted = true;
          else if (ftm[1] === 'fractured') fFractured = true;
          else if (ftm[1].indexOf('range:') === 0) fRange = parseFloat(ftm[1].slice(6));
          fl = fl.slice(ftm[0].length);
        }
        fl = fl.trim();
        if (!fl) continue;
        var fRanged = RANGE_PATTERN.test(fl);
        item.mods.push({ line: resolveRanges(fl, fRange), raw: fRaw, kind: 'explicit',
                         crafted: fCrafted, fractured: fFractured, ranged: fRanged });
      }
    }
    return item;
  }

  /* The skill sets inside <Skills>: [{id, title, body}] and the active one's index. Old builds
   * have <Skill> directly under <Skills> with no SkillSet wrapper: one set, the whole block. */
  function findSkillSets(skillsAttrs, scope) {
    var activeId = attr(skillsAttrs, 'activeSkillSet') || '1';
    var sets = [], active = 0;
    var re = /<SkillSet\b([^>]*)>([\s\S]*?)<\/SkillSet>/g, m;
    while ((m = re.exec(scope))) {
      if (attr(m[1], 'id') === activeId) active = sets.length;
      sets.push({ id: attr(m[1], 'id'), title: attr(m[1], 'title') || '', body: m[2] });
    }
    if (!sets.length) sets.push({ id: '1', title: '', body: scope });
    return { sets: sets, active: active };
  }

  /* One skill set's link groups (enabled groups with real gems), its gems in order, and its main
   * skill: <Build mainSocketGroup="N"> is the 1-based position among ALL <Skill> entries of the
   * set (disabled and item-granted ones count); 0 = none. */
  function parseSkillScope(scope, mainIdx) {
    var res = { gemGroups: [], gems: [], mainSkill: [] };
    var skillRe = /<Skill\b([^>]*)>([\s\S]*?)<\/Skill>/g, sk, n = 0;
    while ((sk = skillRe.exec(scope))) {
      n++;
      var gemRe = /<Gem\b([^>]*)\/?>/g, gm;
      if (n === mainIdx) {
        while ((gm = gemRe.exec(sk[2]))) {
          if (attr(gm[1], 'enabled') !== 'false' && attr(gm[1], 'nameSpec')) res.mainSkill.push(attr(gm[1], 'nameSpec'));
        }
        gemRe.lastIndex = 0;
      }
      if (attr(sk[1], 'enabled') === 'false') continue;
      if (attr(sk[1], 'source')) continue; // item-granted skill, not a real gem
      var group = {
        slot: attr(sk[1], 'slot') || '',
        label: attr(sk[1], 'label') || '',
        gems: [],
        offGems: [] // unticked in PoB: swap-in options, not part of the setup
      };
      while ((gm = gemRe.exec(sk[2]))) {
        var off = attr(gm[1], 'enabled') === 'false';
        var gname = attr(gm[1], 'nameSpec');
        if (!gname) continue;
        // real gems always carry a gemId; item-granted skills don't (and not
        // every PoB version marks the parent Skill with a source attribute)
        if (!attr(gm[1], 'gemId') && !attr(gm[1], 'variantId')) continue;
        var gemObj = {
          name: gname,
          level: parseInt(attr(gm[1], 'level') || '1', 10),
          quality: parseInt(attr(gm[1], 'quality') || '0', 10),
          count: parseInt(attr(gm[1], 'count') || '1', 10)
        };
        if (off) { gemObj.enabled = false; group.offGems.push(gemObj); } else group.gems.push(gemObj);
      }
      if (group.gems.length) {
        // group title: user label, else the first (main) gem's name
        group.title = group.label || (group.gems[0].name + (group.gems.length > 1 ? ' setup' : ''));
        res.gemGroups.push(group);
        group.gems.forEach(function (g) { res.gems.push(g); });
      }
    }
    return res;
  }

  /* Parse a full PoB XML document string.
   * Returns { className, ascendClass, items: {id: item}, slots: [{slot, itemId}],
   *           jewels: [itemId...], flasks: [{slot,itemId}] } */
  function parseBuild(xml) {
    var out = { className: '', ascendClass: '', items: {}, slots: [], jewels: [], flasks: [] };

    var bm = xml.match(/<Build\b([^>]*)>/);
    if (bm) {
      out.className = attr(bm[1], 'className') || '';
      out.ascendClass = attr(bm[1], 'ascendClassName') || '';
      out.level = parseInt(attr(bm[1], 'level') || '0', 10) || null;
    }

    var itemRe = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/g, im;
    while ((im = itemRe.exec(xml))) {
      var id = attr(im[1], 'id');
      var inner = im[2];
      // <ModRange id="N" range="0.35"/> children give each ranged mod's actual
      // roll position — collect them, then strip all child tags from the text.
      var modRanges = {};
      var mrRe = /<ModRange\b([^>]*)\/?>/g, mr;
      while ((mr = mrRe.exec(inner))) {
        var mrId = attr(mr[1], 'id');
        var mrVal = parseFloat(attr(mr[1], 'range'));
        if (mrId && !isNaN(mrVal)) modRanges[mrId] = mrVal;
      }
      inner = inner.replace(/<[^>]*>/g, '');
      var parsed = parseItemText(unescapeXml(inner), modRanges);
      if (id && parsed) out.items[id] = parsed;
    }

    // Item sets — guide PoBs often ship several (Leveling / Budget / Endgame…)
    var activeSet = '1';
    var itemsTag = xml.match(/<Items\b([^>]*)>/);
    if (itemsTag) activeSet = attr(itemsTag[1], 'activeItemSet') || '1';

    out.itemSets = [];
    out.activeSetIndex = 0;
    var setRe = /<ItemSet\b([^>]*)>([\s\S]*?)<\/ItemSet>/g, sm2;
    while ((sm2 = setRe.exec(xml))) {
      var setId = attr(sm2[1], 'id');
      var setTitle = attr(sm2[1], 'title');
      var set = {
        id: setId,
        title: setTitle || ('Gear set ' + (out.itemSets.length + 1)),
        untitled: !setTitle,
        slots: [], flasks: []
      };
      var slotRe = /<Slot\b([^>]*)\/?>/g, slm;
      while ((slm = slotRe.exec(sm2[2]))) {
        var sName = attr(slm[1], 'name');
        var sItem = attr(slm[1], 'itemId');
        if (!sName || !sItem || sItem === '0') continue;
        if (/Swap/i.test(sName)) continue;
        if (/^Flask/i.test(sName)) set.flasks.push({ slot: sName, itemId: sItem });
        else set.slots.push({ slot: sName, itemId: sItem });
      }
      if (setId === activeSet) out.activeSetIndex = out.itemSets.length;
      out.itemSets.push(set);
    }
    // Back-compat: slots/flasks mirror the active set
    var act = out.itemSets[out.activeSetIndex];
    if (act) { out.slots = act.slots; out.flasks = act.flasks; }

    // Skill sets — guide PoBs ship one gem setup per stage (Leveling / Endgame…). Every set is
    // parsed; gemGroups / gems / mainSkill mirror the active one (what every caller reads)
    out.skillSets = [];
    out.activeSkillSet = 0;
    out.gems = [];
    out.mainSkill = [];
    var skillsBlock = xml.match(/<Skills\b([^>]*)>([\s\S]*?)<\/Skills>/);
    if (skillsBlock) {
      var mainIdx = bm ? parseInt(attr(bm[1], 'mainSocketGroup') || '0', 10) : 0;
      var found = findSkillSets(skillsBlock[1], skillsBlock[2]);
      found.sets.forEach(function (s, i) {
        var parsed = parseSkillScope(s.body, mainIdx);
        out.skillSets.push({ id: s.id, title: s.title || ('Skill set ' + (i + 1)), untitled: !s.title,
                             gemGroups: parsed.gemGroups, gems: parsed.gems, mainSkill: parsed.mainSkill });
      });
      out.activeSkillSet = found.active;
      // the other sets have no main group of their own: the one holding the active set's main gem,
      // else the same position (what PoB shows when you switch to that set)
      var mainGem = (out.skillSets[found.active] || { mainSkill: [] }).mainSkill[0];
      out.skillSets.forEach(function (s, i) {
        if (i === found.active || !mainGem) return;
        var g = s.gemGroups.find(function (gr) { return gr.gems.some(function (x) { return x.name === mainGem; }); });
        if (g) s.mainSkill = g.gems.map(function (x) { return x.name; });
      });
      var act2 = out.skillSets[found.active];
      if (act2) { out.gemGroups = act2.gemGroups; out.gems = act2.gems; out.mainSkill = act2.mainSkill; }
    }

    // PoB's own "Find Timeless Jewel" settings, if the build author filled them in:
    // searchList lines are "<legion passive id>, <weight1>, <weight2>, <minimum>"
    out.timelessSearch = null;
    var td = xml.match(/<TimelessData\b([^>]*)\/?>/);
    if (td) {
      var parseList = function (s) {
        return (s || '').split(/\r?\n/).map(function (line) {
          var f = line.split(/[,\s]+/).filter(Boolean);
          return f.length ? { id: f[0], weight1: parseFloat(f[1]) || 0, weight2: parseFloat(f[2]) || 0,
                              minimum: parseFloat(f[3]) || 0 } : null;
        }).filter(Boolean);
      };
      out.timelessSearch = {
        jewelTypeId: parseInt(attr(td[1], 'jewelTypeId') || '0', 10) || null,
        conquerorTypeId: parseInt(attr(td[1], 'conquerorTypeId') || '0', 10) || null,
        socketId: parseInt(attr(td[1], 'jewelSocketId') || '0', 10) || null,
        searchList: parseList(attr(td[1], 'searchList')),
        searchListFallback: parseList(attr(td[1], 'searchListFallback'))
      };
    }

    // Passive trees: every spec (PoB's tree "stages", e.g. Level 30 / 60 / Endgame) with its
    // allocated nodes, chosen masteries and jewel sockets; out.tree is the active one
    out.tree = { nodes: [], masteries: [], sockets: [], version: '', title: '' };
    out.treeSpecs = [];
    out.treeActive = 0;
    var treeTag = xml.match(/<Tree\b([^>]*)>([\s\S]*?)<\/Tree>/);
    if (treeTag) {
      var activeSpec = parseInt(attr(treeTag[1], 'activeSpec') || '1', 10);
      // lazy attributes: a self-closing <Spec .../> must not swallow the next spec
      var specRe = /<Spec\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Spec>)/g, sp;
      while ((sp = specRe.exec(treeTag[2]))) {
        var spec = { nodes: [], masteries: [], sockets: [], version: attr(sp[1], 'treeVersion') || '',
                     title: attr(sp[1], 'title') || '' };
        spec.nodes = (attr(sp[1], 'nodes') || '').split(',').filter(Boolean).map(Number);
        var me = attr(sp[1], 'masteryEffects') || '', mm, meRe = /\{(\d+),(\d+)\}/g;
        while ((mm = meRe.exec(me))) spec.masteries.push([+mm[1], +mm[2]]);
        var sRe = /<Socket\b([^>]*)\/?>/g, so;
        while ((so = sRe.exec(sp[2] || ''))) {
          spec.sockets.push({ nodeId: +attr(so[1], 'nodeId'), itemId: attr(so[1], 'itemId') || '0' });
        }
        out.treeSpecs.push(spec);
      }
      if (out.treeSpecs.length) {
        out.treeActive = Math.min(Math.max(activeSpec, 1), out.treeSpecs.length) - 1;
        out.tree = out.treeSpecs[out.treeActive];
      }
    }

    // Jewels socketed in the tree (Sockets under active Spec)
    var sockRe = /<Socket\b([^>]*)\/?>/g, skm;
    var seen = {};
    while ((skm = sockRe.exec(xml))) {
      var jid = attr(skm[1], 'itemId');
      if (jid && jid !== '0' && !seen[jid] && out.items[jid]) {
        seen[jid] = true;
        out.jewels.push(jid);
      }
    }
    return out;
  }

  // ---- stages: one gear set + skill set + tree spec per build stage ------------

  // a set's name for matching: lower case, punctuation and runs of spaces folded; PoB's
  // default names ("Default", no title, our "Gear set 2"-style fallbacks) all become ''
  function stageKey(title, untitled) {
    if (untitled) return '';
    var k = String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return k === 'default' ? '' : k;
  }
  function wordsIn(a, b) { return (' ' + a + ' ').indexOf(' ' + b + ' ') !== -1; }

  /* A build's stages: [{ title, itemSet, skillSet, treeSpec, active, match }] where each of the
   * three is an index into build.itemSets / skillSets / treeSpecs, or null when that list has
   * nothing for the stage (the caller then keeps PoB's active entry). active: the stage made of
   * PoB's active sets (or the closest). match: 'name' | 'position' | 'single'.
   * - Sets are matched across the lists by name (case, spaces and punctuation ignored; whole
   *   words of one name inside the other also match when that is the only candidate).
   * - A list whose names don't all match but that is as long as the first list with several
   *   entries is paired by position instead.
   * - A list with one entry (or none) is the same for every stage; only lists with several
   *   entries make stages. Order: the first such list's (item sets first), then names only found
   *   in the later lists. */
  function buildStages(b) {
    b = b || {};
    var kinds = [
      { k: 'itemSet', active: b.activeSetIndex || 0,
        list: (b.itemSets || []).map(function (s) { return { title: s.title || '', key: stageKey(s.title, s.untitled) }; }) },
      { k: 'skillSet', active: b.activeSkillSet || 0,
        list: (b.skillSets || []).map(function (s) { return { title: s.title || '', key: stageKey(s.title, s.untitled) }; }) },
      { k: 'treeSpec', active: b.treeActive || 0,
        list: (b.treeSpecs || []).map(function (s) { return { title: s.title || '', key: stageKey(s.title, !s.title) }; }) }
    ];
    function blank(match) { return { title: '', itemSet: null, skillSet: null, treeSpec: null, active: false, match: match, keys: [], titles: [] }; }
    var multi = kinds.filter(function (x) { return x.list.length > 1; });
    var stages = [];
    if (!multi.length) {
      stages.push(blank('single'));
    } else {
      var base = multi[0];
      base.list.forEach(function (e, i) {
        var st = blank('name');
        st[base.k] = i;
        st.keys.push(e.key);
        st.titles.push(e);
        stages.push(st);
      });
      multi.slice(1).forEach(function (x) {
        var assigned = x.list.map(function () { return -1; });
        var taken = {};
        function free(si) { return stages[si][x.k] === null && !taken[si]; }
        // exact names first
        x.list.forEach(function (e, j) {
          for (var si = 0; si < stages.length; si++) {
            if (free(si) && stages[si].keys.indexOf(e.key) !== -1) { assigned[j] = si; taken[si] = true; return; }
          }
        });
        // then one name's words inside the other's ("Endgame" ~ "Endgame mapping"), if unambiguous
        x.list.forEach(function (e, j) {
          if (assigned[j] !== -1 || !e.key) return;
          var hits = [];
          stages.forEach(function (st, si) {
            if (free(si) && st.keys.some(function (k) { return k && (wordsIn(k, e.key) || wordsIn(e.key, k)); })) hits.push(si);
          });
          if (hits.length === 1) { assigned[j] = hits[0]; taken[hits[0]] = true; }
        });
        var all = assigned.every(function (a) { return a !== -1; });
        if (!all && x.list.length === base.list.length) {
          x.list.forEach(function (e, j) {
            stages[j][x.k] = j;
            stages[j].match = 'position';
            stages[j].keys.push(e.key);
            stages[j].titles.push(e);
          });
          return;
        }
        x.list.forEach(function (e, j) {
          var st = assigned[j] !== -1 ? stages[assigned[j]] : null;
          if (!st) { st = blank('name'); stages.push(st); }
          st[x.k] = j;
          st.keys.push(e.key);
          st.titles.push(e);
        });
      });
    }
    // lists with one entry: the same for every stage
    kinds.forEach(function (x) {
      if (x.list.length !== 1) return;
      stages.forEach(function (st) { st[x.k] = 0; });
    });
    var best = -1, bestAt = 0;
    stages.forEach(function (st, i) {
      var named = st.titles.filter(function (t) { return t.key; })[0] || st.titles[0];
      st.title = named && named.title ? named.title : 'Stage ' + (i + 1);
      var score = 0;
      multi.forEach(function (x) { if (st[x.k] === x.active) score++; });
      if (score > best) { best = score; bestAt = i; }
      delete st.keys;
      delete st.titles;
    });
    stages[bestAt].active = true;
    return stages;
  }

  // ---- game clipboard format (Ctrl+C on an item in the client) --------------

  var GAME_ITEM_CLASS_SLOT = {
    'Helmets': 'Helmet', 'Body Armours': 'Body Armour', 'Gloves': 'Gloves', 'Boots': 'Boots',
    'Amulets': 'Amulet', 'Rings': 'Ring 1', 'Belts': 'Belt', 'Quivers': 'Weapon 2',
    'Shields': 'Weapon 2', 'Wands': 'Weapon 1', 'Daggers': 'Weapon 1', 'Rune Daggers': 'Weapon 1',
    'Claws': 'Weapon 1', 'Sceptres': 'Weapon 1', 'One Hand Swords': 'Weapon 1',
    'Thrusting One Hand Swords': 'Weapon 1', 'One Hand Axes': 'Weapon 1', 'One Hand Maces': 'Weapon 1',
    'Two Hand Swords': 'Weapon 1', 'Two Hand Axes': 'Weapon 1', 'Two Hand Maces': 'Weapon 1',
    'Bows': 'Weapon 1', 'Staves': 'Weapon 1', 'Warstaves': 'Weapon 1', 'Fishing Rods': 'Weapon 1',
    'Jewels': 'Jewel', 'Abyss Jewels': 'Jewel', 'Life Flasks': 'Flask 1', 'Mana Flasks': 'Flask 1',
    'Hybrid Flasks': 'Flask 1', 'Utility Flasks': 'Flask 1', 'Tinctures': 'Flask 1'
  };

  var GAME_META_PREFIXES = [
    'Item Class:', 'Rarity:', 'Requirements', 'Level:', 'Str:', 'Dex:', 'Int:',
    'Strength:', 'Dexterity:', 'Intelligence:', 'Sockets:', 'Item Level:', 'Quality:',
    'Armour:', 'Evasion Rating:', 'Energy Shield:', 'Ward:', 'Chance to Block:',
    'Physical Damage:', 'Elemental Damage:', 'Chaos Damage:', 'Critical Strike Chance:',
    'Attacks per Second:', 'Weapon Range:', 'Map Tier:', 'Stack Size:', 'Radius:',
    'Limited to:', 'Talisman Tier:', 'Quality (', 'Note:', 'Price:'
  ];

  function looksLikeGameItem(text) {
    return /^Item Class:/m.test(text) && /^--------$/m.test(text);
  }

  // ---- base type of a pasted item --------------------------------------------

  // Name tables the page loads (data/basetypes.js, baseicons.js, filtericons.js,
  // gemtypes.js). Read when needed; in Node a test sets global.window and requires them.
  function gameTables() {
    var w = typeof window !== 'undefined' && window ? window : null;
    if (!w) return { bases: [], gems: null };
    var bases = [w.POE_BASE_TYPES, w.POE_BASE_ICONS, w.POE_FILTER_ICONS].filter(function (t) {
      return t && typeof t === 'object';
    });
    return { bases: bases, gems: w.POE_GEM_TYPES && typeof w.POE_GEM_TYPES === 'object' ? w.POE_GEM_TYPES : null };
  }

  function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  function knownBase(tables, s) {
    for (var i = 0; i < tables.length; i++) if (has(tables[i], s)) return true;
    return false;
  }

  // "Hale Vaal Regalia of the Whale" -> "Vaal Regalia": the longest known base made of
  // whole words that starts after at most two prefix words and ends where an "of …"
  // suffix starts (or at the end). Case-sensitive, so "of the Wolf" is never "The Wolf".
  function baseInName(name, tables) {
    if (!tables.length || !name) return null;
    var words = name.split(/\s+/), best = null;
    for (var s = 0; s <= 2 && s < words.length; s++) {
      if (words[s] === 'of') break;
      for (var e = words.length; e > s; e--) {
        if (e < words.length && words[e] !== 'of') continue;
        var cand = words.slice(s, e).join(' ');
        if ((!best || cand.length > best.length) && knownBase(tables, cand)) best = cand;
      }
    }
    return best;
  }

  // Take the advanced-copy affix names off a magic name: "Hale " in front, " of the Whale" behind.
  function peelAffixes(name, prefixes, suffixes) {
    var out = name, i;
    for (i = 0; i < prefixes.length; i++) {
      var p = prefixes[i] + ' ';
      if (prefixes[i] && out.indexOf(p) === 0 && out.length > p.length) { out = out.slice(p.length); break; }
    }
    for (i = 0; i < suffixes.length; i++) {
      var sx = ' ' + suffixes[i];
      if (suffixes[i] && out.length > sx.length && out.slice(-sx.length) === sx) { out = out.slice(0, -sx.length); break; }
    }
    return out;
  }

  // Words the game puts in front of the base type that aren't part of it.
  var BASE_PREFIX_RE = /^(Superior|Synthesised|Vestigial) (?=\S)/;
  // On maps "Blighted Strand Map" is still a Strand Map; "Blighted Incubator" is a real base.
  var MAP_BLIGHT_RE = /^(Blighted|Blight-ravaged) (?=\S)/;

  // Eldritch implicit tiers as the filter's HasSearingExarchImplicit / HasEaterOfWorldsImplicit count them.
  var ELDRITCH_TIER = { lesser: 1, greater: 2, grand: 3, exceptional: 4, exquisite: 5, perfect: 6 };

  /* modHeader(line) -> what an advanced-copy header says about the mod lines under it:
   * { Fractured Prefix Modifier "Hale" (Tier: 7) — Life }
   * { Searing Exarch Implicit Modifier (Grand) — Mana } */
  function modHeader(line) {
    var h = { implicit: /Implicit Modifier/i.test(line), crafted: /Crafted/i.test(line),
              fractured: /Fractured/i.test(line), enchant: /Enchant/i.test(line),
              tier: (line.match(/\(Tier: (\d+)\)/) || [])[1],
              affixType: '', affix: '', eldritch: '', eldritchTier: 0,
              foulborn: /Foulborn/i.test(line) };
    var m = /\b(Prefix|Suffix|Implicit|Unique)\s+Modifier\b(?:\s*"([^"]*)")?/i.exec(line);
    if (m) {
      h.affixType = m[1].toLowerCase();
      if (m[2] && (h.affixType === 'prefix' || h.affixType === 'suffix')) h.affix = m[2];
    }
    if (/Searing Exarch/i.test(line)) h.eldritch = 'Searing Exarch';
    else if (/Eater of Worlds/i.test(line)) h.eldritch = 'Eater of Worlds';
    if (h.eldritch) {
      var t = /\((Lesser|Greater|Grand|Exceptional|Exquisite|Perfect)\)/i.exec(line);
      if (t) h.eldritchTier = ELDRITCH_TIER[t[1].toLowerCase()];
    }
    return h;
  }

  var UNUSABLE_RE = /^You cannot use this item/;

  /* Parse the in-game Ctrl+C item text into the same item model parseItemText
   * produces, so the whole matcher/search pipeline applies.
   * Besides the PoB fields it fills what a loot filter asks about. Each is known from a
   * full copy (false/0 when its marker is absent) and left unset when the copy can't say:
   *   identified, mirrored, fractured, synthesised, vestigial, replica, foulborn, imbued,
   *   zanaMemory, transfiguredGem, scourged, blightedMap, uberBlightedMap, memoryStrands,
   *   mapTier, searingExarchImplicits / eaterOfWorldsImplicits (eldritch tier 1-6),
   *   eldritch (["Searing Exarch", …]: also still in influences, which the trade search reads),
   *   unusable, advanced (the copy had "{ … Modifier … }" headers).
   * Each advanced-copy mod also gets affix (its prefix/suffix name), affixType, affixSeq
   * (one number per header) and enchant / eldritch / mutated where they apply. */
  function parseGameItem(text) {
    if (!looksLikeGameItem(text)) return null;
    var sections = text.replace(/\r/g, '').split(/\n--------\n/);
    var trimmed = function (sec) { return sec.split('\n').map(function (l) { return l.trim(); }).filter(Boolean); };
    var headLines = trimmed(sections[0]);
    var item = { rarity: 'RARE', name: '', base: '', sockets: '', maxLinks: 0,
                 corrupted: false, itemLevel: 0, influences: [], mods: [], slotGuess: null,
                 itemClass: '', stackSize: 0, gemLevel: 0, quality: 0, eldritch: [] };
    // an item you can't use gets "You cannot use this item. Its stats will be ignored"
    // under Rarity, which pushes its name and base into the next section
    if (headLines.some(function (l) { return UNUSABLE_RE.test(l); })) {
      item.unusable = true;
      headLines = headLines.filter(function (l) { return !UNUSABLE_RE.test(l); });
      var named = headLines.some(function (l) { return !/^(Item Class|Rarity):/.test(l); });
      if (!named && sections.length >= 2) {
        headLines = headLines.concat(trimmed(sections[1]));
        sections.splice(1, 1);
      }
    }
    var itemClass = '';
    var nameLines = [];
    headLines.forEach(function (l) {
      var m;
      if ((m = l.match(/^Item Class:\s*(.+)$/))) itemClass = m[1].trim();
      else if ((m = l.match(/^Rarity:\s*(\w+)/))) item.rarity = m[1].toUpperCase();
      else nameLines.push(l);
    });
    if (nameLines.length >= 2) { item.name = nameLines[0]; item.base = nameLines[1]; }
    else if (nameLines.length === 1) { item.name = nameLines[0]; item.base = nameLines[0]; }
    item.slotGuess = GAME_ITEM_CLASS_SLOT[itemClass] || null;
    item.itemClass = itemClass;
    var isGem = /Gems?$/.test(itemClass);
    var isMap = itemClass === 'Maps';

    var prefixNames = [], suffixNames = [], headerSeq = 0, monsterLevel = 0;
    var eldritchTier = { 'Searing Exarch': 0, 'Eater of Worlds': 0 }, eldritchHeader = {};
    var seen = { unidentified: false, mirrored: false, fractured: false, synthesised: false, transfigured: false,
                 zana: false, scourged: false, mutated: false, blighted: false, uber: false };

    for (var s = 1; s < sections.length; s++) {
      var lines = trimmed(sections[s]);
      // advanced copy (the default since 3.29): a "{ … Modifier … }" header precedes each
      // mod and says what kind it is; rolls carry their range, "+42(38-45) to …"
      var header = null;
      lines.forEach(function (line) {
        var m;
        if (/^\{.*\}$/.test(line)) {
          header = modHeader(line);
          header.seq = ++headerSeq;
          item.advanced = true;
          if (header.affix) (header.affixType === 'prefix' ? prefixNames : suffixNames).push(header.affix);
          if (header.eldritch) {
            eldritchHeader[header.eldritch] = true;
            if (header.eldritchTier > eldritchTier[header.eldritch]) eldritchTier[header.eldritch] = header.eldritchTier;
          }
          if (header.foulborn) seen.mutated = true;
          if (/Scourge/i.test(line)) seen.scourged = true;
          return;
        }
        if (/^\(.*\)$/.test(line)) return; // reminder text
        line = line.replace(/(\d+(?:\.\d+)?)\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, '$1');
        if ((m = line.match(/^Item Level:\s*(\d+)/))) { item.itemLevel = parseInt(m[1], 10); return; }
        // "1,234/5000"; some locales group thousands with a (no-break) space
        if ((m = line.match(/^Stack Size:\s*(\d[\d,.\s ]*?)\s*(?:\/|$)/))) { item.stackSize = parseInt(m[1].replace(/[^\d]/g, ''), 10); return; }
        // the gem's own level comes first; "Requirements: Level: 72" later is the character's
        if (isGem && (m = line.match(/^Level:\s*(\d+)/))) { if (!item.gemLevel) item.gemLevel = parseInt(m[1], 10); return; }
        if ((m = line.match(/^Quality(?: \([^)]*\))?:\s*\+?(\d+)%/))) { item.quality = parseInt(m[1], 10); return; }
        if ((m = line.match(/^Sockets:\s*(.+)$/))) {
          item.sockets = m[1].trim();
          m[1].trim().split(/\s+/).forEach(function (g) {
            var linked = g.split('-').length;
            if (linked > item.maxLinks) item.maxLinks = linked;
          });
          return;
        }
        if (line === 'Corrupted') { item.corrupted = true; return; }
        if ((m = line.match(/^(Shaper|Elder|Crusader|Redeemer|Hunter|Warlord|Searing Exarch|Eater of Worlds) Item$/))) {
          item.influences.push(m[1]);
          if (m[1] === 'Searing Exarch' || m[1] === 'Eater of Worlds') item.eldritch.push(m[1]);
          return;
        }
        // item markers and numbers a loot filter asks about (none of them is a mod)
        if ((m = line.match(/^Map Tier:\s*(\d+)/))) { item.mapTier = parseInt(m[1], 10); return; }
        if ((m = line.match(/^Monster Level:\s*(\d+)/))) { monsterLevel = parseInt(m[1], 10); return; }
        if ((m = line.match(/^Memory Strands:\s*(\d+)/))) { item.memoryStrands = parseInt(m[1], 10); return; }
        if (line === 'Mirrored') { seen.mirrored = true; return; }
        if (line === 'Fractured Item') { seen.fractured = true; return; }
        if (line === 'Synthesised Item') { seen.synthesised = true; return; }
        if (line === 'Transfigured') { seen.transfigured = true; return; }
        if (line === 'Scourged') { seen.scourged = true; return; }
        if (line === 'Unidentified') seen.unidentified = true;   // stays in mods too: older readers look for it there
        if (/originator's memories/i.test(line)) seen.zana = true;
        if (isMap && /blight-ravaged map/i.test(line)) seen.uber = true;
        else if (isMap && /blighted map/i.test(line)) seen.blighted = true;
        for (var p = 0; p < GAME_META_PREFIXES.length; p++) {
          if (line.indexOf(GAME_META_PREFIXES[p]) === 0) return;
        }
        // mod line — kind comes from the parenthesised suffix
        var kind = 'explicit', crafted = false, fractured = false, enchant = false, mutated = false;
        var suffix = line.match(/\s\((implicit|crafted|fractured|enchant|scourge|crucible|mutated)\)$/);
        if (suffix) {
          line = line.slice(0, -suffix[0].length);
          if (suffix[1] === 'implicit' || suffix[1] === 'enchant') kind = 'implicit';
          if (suffix[1] === 'enchant') { crafted = true; enchant = true; }  // matcher tries enchant section first
          if (suffix[1] === 'crafted') crafted = true;
          if (suffix[1] === 'fractured') fractured = true;
          if (suffix[1] === 'scourge') seen.scourged = true;
          if (suffix[1] === 'mutated') { mutated = true; seen.mutated = true; }
        }
        if (header) {
          if (header.implicit || header.enchant) kind = 'implicit';
          if (header.crafted || header.enchant) crafted = true;
          if (header.enchant) enchant = true;
          if (header.fractured) fractured = true;
          if (header.foulborn) mutated = true;
        }
        if (fractured) seen.fractured = true;
        var mod = { line: line, raw: line, kind: kind, crafted: crafted, fractured: fractured, ranged: false };
        if (header && header.tier) mod.tier = parseInt(header.tier, 10);
        if (header && header.affixType) mod.affixType = header.affixType;
        if (header && header.affix) { mod.affix = header.affix; mod.affixSeq = header.seq; }
        if (header && header.eldritch) mod.eldritch = header.eldritch;
        if (enchant) mod.enchant = true;
        if (mutated) mod.mutated = true;
        item.mods.push(mod);
      });
    }

    // ---- the real base type ----
    // a magic item's single name line is "<prefix> <base> <suffix>": take the advanced-copy
    // affix names off, else find the longest known base inside it; then drop the words the
    // game puts in front of a base (Superior on quality, Synthesised, Vestigial; Blighted on maps)
    function stripFront(b) {
      var pm;
      while ((pm = BASE_PREFIX_RE.exec(b))) {
        if (pm[1] === 'Synthesised') seen.synthesised = true;
        if (pm[1] === 'Vestigial') item.vestigial = true;
        b = b.slice(pm[0].length);
      }
      while (isMap && (pm = MAP_BLIGHT_RE.exec(b))) {
        if (pm[1] === 'Blight-ravaged') seen.uber = true; else seen.blighted = true;
        b = b.slice(pm[0].length);
      }
      return b;
    }
    var base = item.base;
    if (base && item.rarity === 'MAGIC' && nameLines.length === 1) {
      var tables = gameTables().bases;
      var peeled = stripFront(peelAffixes(base, prefixNames, suffixNames));
      base = knownBase(tables, peeled) ? peeled : (baseInName(peeled, tables) || peeled);
    }
    if (base) item.base = stripFront(base) || base;
    if (isMap) {
      var shown = item.name + ' ' + nameLines.join(' ');
      if (/(^|\s)Blight-ravaged\s/.test(shown)) seen.uber = true;
      if (/(^|\s)Blighted\s/.test(shown)) seen.blighted = true;
    }

    // ---- flags (known from a full copy) ----
    var unique = item.rarity === 'UNIQUE';
    item.identified = !seen.unidentified;
    item.mirrored = seen.mirrored;
    item.fractured = seen.fractured;
    item.synthesised = seen.synthesised;
    if (item.vestigial !== true) item.vestigial = false;
    item.zanaMemory = seen.zana;
    item.scourged = seen.scourged;
    item.uberBlightedMap = isMap && seen.uber;
    item.blightedMap = isMap && (seen.blighted || seen.uber);
    if (typeof item.memoryStrands !== 'number') item.memoryStrands = 0;
    // an unidentified unique shows only its base, so its name can't say Replica / Foulborn
    var nameKnown = !(unique && seen.unidentified);
    if (!unique) item.replica = false;
    else if (nameKnown) item.replica = /^Replica /.test(item.name);
    if (seen.mutated || (unique && nameKnown && /^Foulborn /.test(item.name))) item.foulborn = true;
    else if (nameKnown) item.foulborn = false;
    if (typeof item.foulborn === 'boolean') item.imbued = item.foulborn;
    if (!isGem) item.transfiguredGem = false;
    else if (seen.transfigured) item.transfiguredGem = true;
    else {
      var gems = gameTables().gems;
      if (gems) item.transfiguredGem = has(gems, item.name);
    }
    // a map's tier: its "Map Tier:" line, else its monster level (tier 1 = level 68)
    if (isMap && !item.mapTier && monsterLevel >= 68) item.mapTier = monsterLevel - 67;
    // eldritch implicit tier: from the advanced header; an eldritch item copied without
    // headers has some tier we can't see (left unset); no "… Item" line means none
    ['Searing Exarch', 'Eater of Worlds'].forEach(function (e) {
      var f = e === 'Searing Exarch' ? 'searingExarchImplicits' : 'eaterOfWorldsImplicits';
      if (eldritchTier[e] > 0) item[f] = eldritchTier[e];
      else if (item.eldritch.indexOf(e) === -1 && !eldritchHeader[e]) item[f] = 0;
    });
    return item;
  }

  return {
    decodePobCode: decodePobCode,
    parseBuild: parseBuild,
    buildStages: buildStages,
    parseItemText: parseItemText,
    parseGameItem: parseGameItem,
    looksLikeGameItem: looksLikeGameItem,
    resolveRanges: resolveRanges
  };
});
