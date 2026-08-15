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
      var crafted = false, fractured = false, tagRange = null;
      var raw = line;
      var tagMatch;
      while ((tagMatch = line.match(/^\{([^}]*)\}/))) {
        var tag = tagMatch[1];
        if (tag === 'crafted') crafted = true;
        else if (tag === 'fractured') fractured = true;
        else if (tag.indexOf('range:') === 0) tagRange = parseFloat(tag.slice(6));
        // {tags:...}, {custom}, {variant:...} are ignored
        line = line.slice(tagMatch[0].length);
      }
      line = line.trim();
      if (!line) continue;
      var isRanged = RANGE_PATTERN.test(line);
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
      item.mods.push({ line: line, raw: raw, kind: kind, crafted: crafted,
                       fractured: fractured, ranged: isRanged, bounds: bounds });
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

  /* Parse a full PoB XML document string.
   * Returns { className, ascendClass, items: {id: item}, slots: [{slot, itemId}],
   *           jewels: [itemId...], flasks: [{slot,itemId}] } */
  function parseBuild(xml) {
    var out = { className: '', ascendClass: '', items: {}, slots: [], jewels: [], flasks: [] };

    var bm = xml.match(/<Build\b([^>]*)>/);
    if (bm) {
      out.className = attr(bm[1], 'className') || '';
      out.ascendClass = attr(bm[1], 'ascendClassName') || '';
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
      var set = {
        id: setId,
        title: attr(sm2[1], 'title') || ('Gear set ' + (out.itemSets.length + 1)),
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

    // Skill gems — active skill set, enabled gems only, deduped by name/level/quality
    out.gems = [];
    var skillsBlock = xml.match(/<Skills\b([^>]*)>([\s\S]*?)<\/Skills>/);
    if (skillsBlock) {
      var activeGemSet = attr(skillsBlock[1], 'activeSkillSet') || '1';
      var scope = skillsBlock[2];
      var setRe2 = /<SkillSet\b([^>]*)>([\s\S]*?)<\/SkillSet>/g, ss;
      var found = null, firstSet = null;
      while ((ss = setRe2.exec(scope))) {
        if (firstSet === null) firstSet = ss[2];
        if (attr(ss[1], 'id') === activeGemSet) { found = ss[2]; break; }
      }
      // old builds have <Skill> directly under <Skills> with no SkillSet wrapper
      var gemScope = found !== null ? found : (firstSet !== null ? firstSet : scope);
      out.gemGroups = [];
      var skillRe = /<Skill\b([^>]*)>([\s\S]*?)<\/Skill>/g, sk;
      while ((sk = skillRe.exec(gemScope))) {
        if (attr(sk[1], 'enabled') === 'false') continue;
        if (attr(sk[1], 'source')) continue; // item-granted skill, not a real gem
        var group = {
          slot: attr(sk[1], 'slot') || '',
          label: attr(sk[1], 'label') || '',
          gems: []
        };
        var gemRe = /<Gem\b([^>]*)\/?>/g, gm;
        while ((gm = gemRe.exec(sk[2]))) {
          if (attr(gm[1], 'enabled') === 'false') continue;
          var gname = attr(gm[1], 'nameSpec');
          if (!gname) continue;
          // real gems always carry a gemId; item-granted skills don't (and not
          // every PoB version marks the parent Skill with a source attribute)
          if (!attr(gm[1], 'gemId') && !attr(gm[1], 'variantId')) continue;
          group.gems.push({
            name: gname,
            level: parseInt(attr(gm[1], 'level') || '1', 10),
            quality: parseInt(attr(gm[1], 'quality') || '0', 10),
            count: parseInt(attr(gm[1], 'count') || '1', 10)
          });
        }
        if (group.gems.length) {
          // group title: user label, else the first (main) gem's name
          group.title = group.label || (group.gems[0].name + (group.gems.length > 1 ? ' setup' : ''));
          out.gemGroups.push(group);
          group.gems.forEach(function (g) { out.gems.push(g); });
        }
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

  /* Parse the in-game Ctrl+C item text into the same item model parseItemText
   * produces, so the whole matcher/search pipeline applies. */
  function parseGameItem(text) {
    if (!looksLikeGameItem(text)) return null;
    var sections = text.replace(/\r/g, '').split(/\n--------\n/);
    var headLines = sections[0].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var item = { rarity: 'RARE', name: '', base: '', sockets: '', maxLinks: 0,
                 corrupted: false, itemLevel: 0, influences: [], mods: [], slotGuess: null };
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

    for (var s = 1; s < sections.length; s++) {
      var lines = sections[s].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      lines.forEach(function (line) {
        var m;
        if ((m = line.match(/^Item Level:\s*(\d+)/))) { item.itemLevel = parseInt(m[1], 10); return; }
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
          return;
        }
        for (var p = 0; p < GAME_META_PREFIXES.length; p++) {
          if (line.indexOf(GAME_META_PREFIXES[p]) === 0) return;
        }
        // mod line — kind comes from the parenthesised suffix
        var kind = 'explicit', crafted = false, fractured = false;
        var suffix = line.match(/\s\((implicit|crafted|fractured|enchant|scourge|crucible)\)$/);
        if (suffix) {
          line = line.slice(0, -suffix[0].length);
          if (suffix[1] === 'implicit' || suffix[1] === 'enchant') kind = 'implicit';
          if (suffix[1] === 'enchant') crafted = true;   // matcher tries enchant section first
          if (suffix[1] === 'crafted') crafted = true;
          if (suffix[1] === 'fractured') fractured = true;
        }
        item.mods.push({ line: line, raw: line, kind: kind, crafted: crafted,
                         fractured: fractured, ranged: false });
      });
    }
    return item;
  }

  return {
    decodePobCode: decodePobCode,
    parseBuild: parseBuild,
    parseItemText: parseItemText,
    parseGameItem: parseGameItem,
    looksLikeGameItem: looksLikeGameItem,
    resolveRanges: resolveRanges
  };
});
