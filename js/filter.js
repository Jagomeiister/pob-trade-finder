/* filter.js — Path of Exile 1 loot filter engine: parse a .filter file, say
 * which block an item lands in, and rewrite the app's own managed section.
 * Browser (window.LootFilter) + Node. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.LootFilter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MARK_START = '#==== PoB Trade Finder: managed section start (the app rewrites everything up to the end marker) ====';
  var MARK_END = '#==== PoB Trade Finder: managed section end ====';

  var RARITY_RANK = { normal: 0, magic: 1, rare: 2, unique: 3 };

  // ---- lexing --------------------------------------------------------------

  // PlaySound is the legacy name of PlayAlertSound: an action, not an (unknown) condition
  var ACTION_RE = /^(Set[A-Z]\w*|PlayAlertSound\w*|PlaySound|CustomAlertSound\w*|MinimapIcon|PlayEffect|DisableDropSound\w*|EnableDropSound\w*)$/i;
  var OP_RE = /^\s*(==|!=|<=|>=|=|!|<|>)/;
  var NUM_RE = /^[+-]?\d+(\.\d+)?$/;
  var BLOCK_RE = /^(show|hide|minimal)(?=\s|#|$)/i;
  var VISIBILITY = { show: 'Show', hide: 'Hide', minimal: 'Minimal' };

  // Split a line into tokens. Quoted strings keep their spaces; '#' outside
  // quotes starts a trailing comment. Returns where each token ends so the
  // caller can slice the remainder (condition operators sit right after the key).
  function lex(str) {
    var tokens = [], i = 0, n = str.length, comment = null, codeEnd = n;
    while (i < n) {
      var c = str.charAt(i);
      if (/\s/.test(c)) { i++; continue; } // any whitespace (a no-break space too: it ends a token below)
      if (c === '#') { comment = str.slice(i + 1).trim(); codeEnd = i; break; }
      var start = i, val, quoted = false;
      if (c === '"') {
        quoted = true;
        var close = str.indexOf('"', i + 1);
        if (close === -1) close = n;           // unterminated: take the rest
        val = str.slice(i + 1, close);
        i = Math.min(close + 1, n);
      } else {
        while (i < n && !/[\s#"]/.test(str.charAt(i))) i++;
        val = str.slice(start, i);
      }
      tokens.push({ v: val, q: quoted, start: start, end: i });
    }
    return { tokens: tokens, comment: comment, code: str.slice(0, codeEnd) };
  }

  function toValue(t) {
    if (!t.q && NUM_RE.test(t.v)) return parseFloat(t.v);
    return t.v;
  }

  function parseCondition(key, rest, raw) {
    var op = '', m = OP_RE.exec(rest);
    if (m) { op = m[1]; rest = rest.slice(m[0].length); }
    return { key: key, op: op, values: lex(rest).tokens.map(toValue), raw: raw };
  }

  function parseAction(key, rest, raw) {
    return { key: key, args: lex(rest).tokens.map(toValue), raw: raw };
  }

  function parseTags(comment) {
    if (!comment) return null;
    var ty = /\$type->(\S+)/.exec(comment), ti = /\$tier->(\S+)/.exec(comment);
    if (!ty && !ti) return null;
    return { type: ty ? ty[1] : '', tier: ti ? ti[1] : '' };
  }

  // ---- text -> lines -------------------------------------------------------

  // Keep each line's own terminator so edits can splice the original text
  // and leave everything else byte-for-byte alone (mixed endings included).
  function scan(body) {
    var parts = body.split(/(\r\n|\n)/), lines = [], terms = [], offsets = [], off = 0;
    for (var i = 0; i < parts.length; i += 2) {
      lines.push(parts[i]);
      terms.push(parts[i + 1] || '');
      offsets.push(off);
      off += parts[i].length + (parts[i + 1] || '').length;
    }
    var nl = /\r?\n/.exec(body);
    var info = { lines: lines, terms: terms, offsets: offsets, eol: nl ? nl[0] : '\n',
                 managed: null, firstBlock: -1 };
    var s = -1;
    for (var j = 0; j < lines.length; j++) {
      var t = lines[j].trim();
      if (s === -1 && t === MARK_START) s = j;
      else if (s !== -1 && t === MARK_END) { info.managed = { startLine: s, endLine: j }; break; }
    }
    for (var k = 0; k < lines.length; k++) {
      if (info.managed && k >= info.managed.startLine && k <= info.managed.endLine) continue;
      if (BLOCK_RE.test(lines[k].trim())) { info.firstBlock = k; break; }
    }
    return info;
  }

  function stripBom(text) {
    text = text == null ? '' : String(text);
    var bom = text.charCodeAt(0) === 0xFEFF;
    return { bom: bom, body: bom ? text.slice(1) : text };
  }

  // ---- parse ---------------------------------------------------------------

  /* parse(text) -> { blocks, managed, eol, bom }
   * Line numbers are 0-based and inclusive. A block's endLine is its last
   * condition/action line, not the comments and blanks that trail it. */
  function parse(text) {
    var sb = stripBom(text), info = scan(sb.body);
    var blocks = [], cur = null, lastContent = -1;
    var ms = info.managed ? info.managed.startLine : -1, me = info.managed ? info.managed.endLine : -1;

    function close() {
      if (cur) { cur.endLine = lastContent; blocks.push(cur); cur = null; }
    }

    for (var i = 0; i < info.lines.length; i++) {
      if (i === ms || i === me) { close(); continue; }
      var raw = info.lines[i].trim();
      if (!raw || raw.charAt(0) === '#') continue;
      var lx = lex(raw);
      if (!lx.tokens.length) continue;
      var first = lx.tokens[0], key = first.v;
      if (!first.q && BLOCK_RE.test(raw) && VISIBILITY.hasOwnProperty(key.toLowerCase())) {
        close();
        cur = { index: blocks.length, visibility: VISIBILITY[key.toLowerCase()], continue: false,
                disabled: false, conditions: [], actions: [], tags: parseTags(lx.comment),
                comment: lx.comment || '', managed: ms !== -1 && i > ms && i < me,
                startLine: i, endLine: i };
        lastContent = i;
        continue;
      }
      if (!cur) continue;                       // stray line outside any block
      lastContent = i;
      var rest = lx.code.slice(first.end);
      if (key.toLowerCase() === 'continue') cur.continue = true;
      else if (ACTION_RE.test(key)) cur.actions.push(parseAction(key, rest, raw));
      else cur.conditions.push(parseCondition(key, rest, raw));
    }
    close();
    return { blocks: blocks, managed: info.managed, eol: info.eol, bom: sb.bom };
  }

  // ---- matching ------------------------------------------------------------

  function norm(s) {
    s = String(s == null ? '' : s);
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.toLowerCase().trim();
  }

  function isNum(v) { return typeof v === 'number' && !isNaN(v); }

  // condition key (lower case) -> item field
  var NUMERIC = {
    itemlevel: 'itemLevel', droplevel: 'dropLevel', arealevel: 'areaLevel', quality: 'quality',
    width: 'width', height: 'height', stacksize: 'stackSize', gemlevel: 'gemLevel', maptier: 'mapTier',
    linkedsockets: 'links', corruptedmods: 'corruptedMods', enchantmentpassivenum: 'enchantmentPassiveNum',
    memorystrands: 'memoryStrands', basearmour: 'baseArmour', baseevasion: 'baseEvasion',
    baseenergyshield: 'baseEnergyShield', baseward: 'baseWard', basedefencepercentile: 'baseDefencePercentile',
    hassearingexarchimplicit: 'searingExarchImplicits', haseaterofworldsimplicit: 'eaterOfWorldsImplicits'
  };
  var BOOLEAN = {
    corrupted: 'corrupted', identified: 'identified', mirrored: 'mirrored',
    fractureditem: 'fractured', synthesiseditem: 'synthesised', replica: 'replica',
    alternatequality: 'alternateQuality', transfiguredgem: 'transfiguredGem', zanamemory: 'zanaMemory',
    scourged: 'scourged', foulborn: 'foulborn', imbued: 'imbued', vestigial: 'vestigial',
    shapedmap: 'shapedMap', eldermap: 'elderMap', blightedmap: 'blightedMap',
    uberblightedmap: 'uberBlightedMap', hascruciblepassivetree: 'hasCruciblePassiveTree',
    anyenchantment: 'enchanted',
    // short spellings the game accepts too
    synthesised: 'synthesised', fractured: 'fractured', blighted: 'blightedMap', uberblighted: 'uberBlightedMap'
  };
  var INFLUENCE_FLAG = { shaperitem: 'shaper', elderitem: 'elder', crusaderitem: 'crusader',
                         hunteritem: 'hunter', redeemeritem: 'redeemer', warlorditem: 'warlord' };
  // Flags that are false on almost every item. When the caller didn't say,
  // assuming false beats flagging every item as uncertain (opts.strict turns it off).
  var DEFAULT_FALSE = { mirrored: 1, fractureditem: 1, synthesiseditem: 1, replica: 1, alternatequality: 1,
    transfiguredgem: 1, zanamemory: 1, scourged: 1, foulborn: 1, imbued: 1, vestigial: 1, shapedmap: 1,
    eldermap: 1, blightedmap: 1, uberblightedmap: 1, hascruciblepassivetree: 1,
    synthesised: 1, fractured: 1, blighted: 1, uberblighted: 1 };
  var MOD_LIST = { hasexplicitmod: 'explicitMods', hasimplicitmod: 'implicitMods',
                   hasenchantment: 'enchantments', enchantmentpassivenode: 'enchantmentPassiveNodes' };

  function cmpNum(op, v, vals) {
    var nums = [];
    for (var i = 0; i < vals.length; i++) { var n = Number(vals[i]); if (!isNaN(n)) nums.push(n); }
    if (!nums.length) return null;
    var k, hit = false;
    switch (op) {
      case '': case '=': case '==':
        for (k = 0; k < nums.length; k++) if (v === nums[k]) hit = true;
        return hit;
      case '!': case '!=':
        for (k = 0; k < nums.length; k++) if (v === nums[k]) hit = true;
        return !hit;
      case '<': return v < nums[0];
      case '<=': return v <= nums[0];
      case '>': return v > nums[0];
      case '>=': return v >= nums[0];
    }
    return null;
  }

  // '5RGB' / 'RGB' / 5 -> { n, letters: {R:1,G:1,B:1}, any }
  function socketSpec(v) {
    if (isNum(v)) return { n: v, letters: {}, any: false };
    var m = /^(\d*)([RGBWA]*)$/i.exec(String(v).trim());
    if (!m) return null;
    var letters = {}, any = false;
    m[2].toUpperCase().split('').forEach(function (c) { letters[c] = (letters[c] || 0) + 1; any = true; });
    return { n: m[1] === '' ? null : parseInt(m[1], 10), letters: letters, any: any };
  }

  function hasLetters(colours, letters) {
    var have = {}, c;
    colours.toUpperCase().split('').forEach(function (ch) { have[ch] = (have[ch] || 0) + 1; });
    for (c in letters) if ((have[c] || 0) < letters[c]) return false;
    return true;
  }

  // does one socket group (or all sockets) of `colours` satisfy the spec?
  function socketFits(op, spec, colours) {
    if (spec.n !== null) {
      var r = cmpNum(op === '!' || op === '!=' ? '' : op, colours.length, [spec.n]);
      if (!r) return false;
    }
    return !spec.any || hasLetters(colours, spec.letters);
  }

  function evalSockets(cond, it, group) {
    var op = cond.op || '', neg = op === '!' || op === '!=', hit = false, unknown = false, groups;
    if (group) {
      groups = it.linkedGroups;
      if (!groups && typeof it.links === 'number' && !(it.socketColours)) {
        // only the biggest link is known: enough for ">= n" style questions
        if (op === '>=' || op === '>') groups = [new Array(it.links + 1).join('X')];
      }
    } else {
      groups = typeof it.socketColours === 'string' ? [it.socketColours]
             : (typeof it.sockets === 'number' ? [new Array(it.sockets + 1).join('X')] : null);
    }
    if (!groups) return null;
    for (var i = 0; i < cond.values.length; i++) {
      var spec = socketSpec(cond.values[i]);
      if (!spec) return null;
      // colours asked for but only counts known -> can't say
      if (spec.any && groups.join('').indexOf('X') !== -1) { unknown = true; continue; }
      for (var g = 0; g < groups.length; g++) if (socketFits(neg ? '=' : op, spec, groups[g])) hit = true;
    }
    if (!hit && unknown) return null;
    return neg ? !hit : hit;
  }

  function strHit(op, cands, vals) {
    var exact = op === '==' || op === '!=', neg = op === '!' || op === '!=', hit = false;
    for (var i = 0; i < vals.length && !hit; i++) {
      var v = norm(vals[i]);
      for (var c = 0; c < cands.length; c++) {
        if (exact ? cands[c] === v : cands[c].indexOf(v) !== -1) { hit = true; break; }
      }
    }
    return neg ? !hit : hit;
  }

  function evalCondition(cond, it, opts) {
    var key = String(cond.key).toLowerCase(), op = cond.op || '', vals = cond.values || [];
    var strict = !!(opts && opts.strict), v, f;

    if (NUMERIC.hasOwnProperty(key)) {
      f = NUMERIC[key];
      v = it[f];
      if (!isNum(v) && !strict) {
        if (f === 'corruptedMods' && it.corrupted === false) v = 0;
        else if (f === 'enchantmentPassiveNum' && it.enchanted === false) v = 0;
        else if (f === 'memoryStrands' && it['class'] && !/memor/i.test(it['class'])) v = 0;
      }
      return isNum(v) ? cmpNum(op, v, vals) : null;
    }

    if (BOOLEAN.hasOwnProperty(key)) {
      v = it[BOOLEAN[key]];
      if (typeof v !== 'boolean' && !strict && DEFAULT_FALSE[key]) v = false;
      if (typeof v !== 'boolean') return null;
      var want = String(vals[0]).toLowerCase();
      if (want !== 'true' && want !== 'false') return null;
      var eq = v === (want === 'true');
      return op === '!' || op === '!=' ? !eq : eq;
    }

    if (INFLUENCE_FLAG.hasOwnProperty(key)) {
      if (!Array.isArray(it.influences)) return null;
      var has = it.influences.map(normInfluence).indexOf(INFLUENCE_FLAG[key]) !== -1;
      var w = String(vals[0]).toLowerCase() === 'true';
      return op === '!' || op === '!=' ? has !== w : has === w;
    }

    switch (key) {
      case 'rarity':
        if (typeof it.rarity !== 'string' || !(norm(it.rarity) in RARITY_RANK)) return null;
        v = RARITY_RANK[norm(it.rarity)];
        var ranks = [];
        vals.forEach(function (x) { if (norm(x) in RARITY_RANK) ranks.push(RARITY_RANK[norm(x)]); });
        return ranks.length ? cmpNum(op, v, ranks) : null;

      case 'class':
        return typeof it['class'] === 'string' ? strHit(op, [norm(it['class'])], vals) : null;

      case 'basetype':
        var b = it.base != null ? it.base : it.name;
        if (typeof b !== 'string') return null;
        var cands = [norm(b)];
        // a magic item whose base couldn't be told apart from its name ("Hale Vaal Regalia
        // of the Whale" as both): the base is somewhere inside the name
        if (op !== '==' && op !== '!=' && typeof it.name === 'string' && /^(normal|magic)$/i.test(it.rarity || '') &&
            norm(it.name) === norm(b)) {
          cands.push(norm(it.name));
        }
        return strHit(op, cands, vals);

      case 'hasinfluence':
        if (!Array.isArray(it.influences)) return null;
        var have = it.influences.map(normInfluence), wantI = vals.map(normInfluence), a;
        var wantReal = wantI.filter(function (x) { return x !== 'none'; });
        if (op === '==') {
          return have.length === wantReal.length && wantReal.every(function (x) { return have.indexOf(x) !== -1; });
        }
        var any = false;
        for (a = 0; a < wantI.length; a++) {
          if (wantI[a] === 'none' ? have.length === 0 : have.indexOf(wantI[a]) !== -1) any = true;
        }
        return op === '!' || op === '!=' ? !any : any;

      case 'sockets': return evalSockets(cond, it, false);
      case 'socketgroup': return evalSockets(cond, it, true);
    }

    if (MOD_LIST.hasOwnProperty(key)) {
      var list = it[MOD_LIST[key]];
      // "HasImplicitMod True": the item has any implicit at all
      if (key === 'hasimplicitmod' && vals.length === 1 && /^(true|false)$/i.test(String(vals[0]))) {
        if (!Array.isArray(list)) return null;
        var anyImp = (list.length > 0) === (String(vals[0]).toLowerCase() === 'true');
        return op === '!' || op === '!=' ? !anyImp : anyImp;
      }
      if (!Array.isArray(list) && !strict) {
        if (key === 'hasexplicitmod' && /^normal$/i.test(it.rarity || '')) list = [];
        else if ((key === 'hasenchantment' || key === 'enchantmentpassivenode') && it.enchanted === false) list = [];
      }
      if (!Array.isArray(list)) return null;
      var count = null, names = vals;
      if (isNum(vals[0])) { count = vals[0]; names = vals.slice(1); }
      var nl = list.map(norm), n = 0;
      if (count === null) return strHit(op, nl, names);
      var exactM = op === '==';
      nl.forEach(function (m) {
        for (var j = 0; j < names.length; j++) {
          var nn = norm(names[j]);
          if (exactM ? m === nn : m.indexOf(nn) !== -1) { n++; break; }
        }
      });
      return cmpNum(op, n, [count]);
    }

    return null;                                // a key we don't know
  }

  function normInfluence(s) { return norm(s).replace(/[^a-z]/g, ''); }

  // Fill in what follows from what the caller gave (sockets, links, groups).
  var SOCKETABLE_RE = /armour|helmet|glove|boot|shield|bow|claw|dagger|wand|sceptre|sword|axe|mace|stave|fishing/i;

  function prep(item, opts) {
    var it = {}, k;
    for (k in item) if (Object.prototype.hasOwnProperty.call(item, k)) it[k] = item[k];
    // currency, gems, maps, jewellery... can't have sockets; don't call that "unknown"
    if (!(opts && opts.strict) && typeof it['class'] === 'string' && !SOCKETABLE_RE.test(it['class']) &&
        it.sockets === undefined && it.socketColours === undefined && it.linkedGroups === undefined && it.links === undefined) {
      it.sockets = 0;
    }
    if (Array.isArray(it.linkedGroups)) {
      if (typeof it.socketColours !== 'string') it.socketColours = it.linkedGroups.join('');
      if (!isNum(it.links)) {
        it.links = it.linkedGroups.reduce(function (m, g) { return Math.max(m, g.length); }, 0);
      }
    }
    if (typeof it.socketColours === 'string' && !isNum(it.sockets)) it.sockets = it.socketColours.length;
    if (it.sockets === 0) {
      if (!isNum(it.links)) it.links = 0;
      if (typeof it.socketColours !== 'string') it.socketColours = '';
      if (!Array.isArray(it.linkedGroups)) it.linkedGroups = [];
    }
    return it;
  }

  // A block matches when none of its conditions fails AND at least one actually passes
  // (a block with no conditions at all matches everything). A block whose conditions are
  // all unknown is only `possible`: it can't take the item.
  function evalBlock(block, it, opts) {
    var unknown = [], passed = 0;
    for (var i = 0; i < block.conditions.length; i++) {
      var r = evalCondition(block.conditions[i], it, opts);
      if (r === false) return { ok: false, possible: false, unknown: unknown };
      if (r === null) unknown.push(block.conditions[i].key);
      else passed++;
    }
    if (block.conditions.length && !passed) return { ok: false, possible: true, unknown: unknown };
    return { ok: true, possible: false, unknown: unknown };
  }

  // Actions that survive the Continue chain: later blocks override earlier ones per key.
  function mergeActions(chain) {
    var out = [], pos = {};
    chain.forEach(function (b) {
      b.actions.forEach(function (a) {
        var k = a.key.toLowerCase();
        if (pos.hasOwnProperty(k)) out[pos[k]] = a;
        else { pos[k] = out.length; out.push(a); }
      });
    });
    return out;
  }

  /* matchItem(parsed, item[, opts]) -> { block, index, certain, unknown, trail, possible, actions, visibility }
   * First block with no failing condition and at least one passing one wins (see
   * evalBlock); Continue blocks that match go to `trail` and matching goes on.
   * `possible` lists the blocks passed over because every condition was unknown
   * ({ block, index, unknown }). `certain` is false when the winner only got there
   * because some condition needed a field the item doesn't have (`unknown` lists those
   * keys), or when a non-Continue block before it was only `possible`.
   * opts.strict: no assumed defaults for missing flags. */
  function matchItem(parsed, item, opts) {
    var it = prep(item || {}, opts), trail = [], possible = [], blocks = parsed.blocks || [];
    var doubt = false;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], r = evalBlock(b, it, opts);
      if (r.possible) {
        possible.push({ block: b, index: i, unknown: r.unknown });
        if (!b.continue) doubt = true;
        continue;
      }
      if (!r.ok) continue;
      if (b.continue) { trail.push({ block: b, index: i, certain: !r.unknown.length, unknown: r.unknown }); continue; }
      return { block: b, index: i, certain: !r.unknown.length && !doubt, unknown: r.unknown, trail: trail,
               possible: possible, visibility: b.visibility,
               actions: mergeActions(trail.map(function (t) { return t.block; }).concat([b])) };
    }
    return { block: null, index: -1, certain: !doubt, unknown: [], trail: trail, possible: possible, visibility: 'Show',
             actions: mergeActions(trail.map(function (t) { return t.block; })) };
  }

  // ---- writing blocks ------------------------------------------------------

  var TEXT_KEYS = { 'class': 1, basetype: 1, hasexplicitmod: 1, hasimplicitmod: 1, hasenchantment: 1,
                    enchantmentpassivenode: 1 };
  var OP_ONLY_RE = /^\s*(==|!=|<=|>=|=|!|<|>)\s*(.*)$/;

  function quote(s) { return '"' + String(s).replace(/"/g, '') + '"'; }

  function bareOrQuoted(s) {
    s = String(s);
    return /^[^\s"#]+$/.test(s) ? s : quote(s);
  }

  function fmtScalar(textKey, v) {
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    v = String(v);
    if (/^(true|false)$/i.test(v)) return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
    if (textKey && !NUM_RE.test(v)) return quote(v);
    return bareOrQuoted(v);
  }

  // One condition line, or '' when there is nothing to say.
  function fmtCondition(key, val) {
    var textKey = !!TEXT_KEYS[String(key).toLowerCase()], op = '', toks = [], m;
    if (val === undefined || val === null) return '';
    if (Array.isArray(val)) {
      var arr = val.slice();
      if (typeof arr[0] === 'string' && (m = OP_ONLY_RE.exec(arr[0]))) {
        op = m[1];
        if (m[2] !== '') arr[0] = m[2]; else arr.shift();
      }
      toks = arr.map(function (x) { return fmtScalar(textKey, x); });
    } else if (typeof val === 'string' && (m = OP_ONLY_RE.exec(val))) {
      op = m[1];
      var rest = m[2];
      if (rest.indexOf('"') !== -1) toks = [rest];                       // already hand-quoted
      else if (textKey) toks = [fmtScalar(true, rest)];
      else toks = rest.split(/\s+/).filter(Boolean).map(function (x) { return fmtScalar(false, x); });
    } else if (typeof val === 'string' && !textKey && val.indexOf('"') === -1) {
      toks = val.split(/\s+/).filter(Boolean).map(function (x) { return fmtScalar(false, x); });
    } else {
      toks = [fmtScalar(textKey, val)];
    }
    if (!toks.length) return '';
    var head = key;
    // HasExplicitMod >=2 "A" "B": the count rides on the operator, as filters write it
    if (op && textKey && /^\d+$/.test(toks[0])) { head += ' ' + op + toks[0]; toks.shift(); }
    else if (op) head += ' ' + op;
    return toks.length ? head + ' ' + toks.join(' ') : head;
  }

  function fmtAction(a) {
    if (a.args && a.args.length) {
      var custom = /^CustomAlertSound/i.test(a.key);
      return a.key + ' ' + a.args.map(function (x, i) {
        if (typeof x === 'number') return String(x);
        return custom && i === 0 ? quote(x) : bareOrQuoted(x);
      }).join(' ');
    }
    return a.raw ? a.raw : a.key;
  }

  function styleActions(rule) {
    var out = [];
    function rgb(key, c) { if (c && c.length >= 3) out.push({ key: key, args: c.slice(0, 4) }); }
    rgb('SetTextColor', rule.textColor);
    rgb('SetBorderColor', rule.borderColor);
    rgb('SetBackgroundColor', rule.backgroundColor);
    if (isNum(rule.fontSize)) out.push({ key: 'SetFontSize', args: [rule.fontSize] });
    if (rule.sound && rule.sound.length) {
      var id = rule.sound[0], rest = rule.sound.slice(1).filter(function (x) { return x !== 'positional'; });
      var positional = rule.sound.indexOf('positional') !== -1;
      if (typeof id === 'string' && /[.\\\/]/.test(id)) out.push({ key: 'CustomAlertSound', args: [id].concat(rest) });
      else out.push({ key: positional ? 'PlayAlertSoundPositional' : 'PlayAlertSound', args: [id].concat(rest) });
    }
    if (rule.minimapIcon && rule.minimapIcon.length) out.push({ key: 'MinimapIcon', args: rule.minimapIcon.slice(0, 3) });
    if (rule.effect && rule.effect.length) out.push({ key: 'PlayEffect', args: rule.effect.slice(0, 2) });
    if (rule.disableDropSound) out.push({ key: 'DisableDropSound', args: ['True'] });
    return out;
  }

  /* ruleBlock(rule) -> array of lines (no line endings) for one Show/Hide block.
   * Explicit rule.actions win over the style shortcuts for the same key. */
  function ruleBlock(rule) {
    rule = rule || {};
    var vis = VISIBILITY[String(rule.visibility || 'Show').toLowerCase()] || 'Show';
    var comment = rule.comment ? String(rule.comment).replace(/[\r\n]+/g, ' ').trim() : '';
    var lines = [vis + (comment ? ' # ' + comment : '')];
    var conds = rule.conditions;
    if (Array.isArray(conds)) {
      conds.forEach(function (c) {
        if (c && c.key) {
          var ln = fmtCondition(c.key, (c.op ? [c.op].concat(c.values || []) : (c.values || [])));
          if (ln) lines.push('\t' + ln);
        }
      });
    } else if (conds) {
      Object.keys(conds).forEach(function (k) {
        var ln = fmtCondition(k, conds[k]);
        if (ln) lines.push('\t' + ln);
      });
    }
    var acts = (rule.actions || []).slice(), have = {};
    acts.forEach(function (a) { have[a.key.toLowerCase()] = true; });
    styleActions(rule).forEach(function (a) {
      var k = a.key.toLowerCase();
      // a custom sound shortcut shadows the stock one too
      if (have[k] || (k === 'customalertsound' && have.playalertsound) || (k === 'playalertsound' && have.customalertsound)) return;
      acts.push(a);
    });
    acts.forEach(function (a) { lines.push('\t' + fmtAction(a)); });
    if (rule.continue) lines.push('\tContinue');
    return lines;
  }

  /* actionsOf(block) -> a copy of the block's actions (Continue isn't an action). */
  function actionsOf(block) {
    return (block && block.actions ? block.actions : []).map(function (a) {
      return { key: a.key, args: a.args.slice(), raw: a.raw };
    });
  }

  // ---- the managed section -------------------------------------------------

  var DEFAULT_HEADER = 'Rules written by PoB Trade Finder. Edit your filter outside these markers; this part is rewritten.';

  /* buildManaged(rules, header[, eol]) -> section text ending in a line break,
   * or '' when there are no rules (so applyManaged(text, buildManaged([])) removes it). */
  function buildManaged(rules, header, eol) {
    eol = eol || '\n';
    var blocks = [];
    (rules || []).forEach(function (r) {
      var b = ruleBlock(r);
      if (b.length) blocks.push(b);
    });
    if (!blocks.length) return '';
    var lines = [MARK_START];
    String(header == null ? DEFAULT_HEADER : header).split(/\r?\n/).forEach(function (h) {
      if (h.trim()) lines.push('# ' + h.trim());
    });
    blocks.forEach(function (b) { lines.push(''); Array.prototype.push.apply(lines, b); });
    lines.push(MARK_END);
    return lines.join(eol) + eol;
  }

  function isBlank(s) { return s.trim() === ''; }

  /* applyManaged(text, sectionText) -> new file text.
   * Existing section is replaced; otherwise the section goes in just above the
   * first block's own header comments, followed by one blank line that belongs
   * to it. Empty sectionText removes the section and that blank line again, so
   * add-then-remove gives the original bytes back. */
  function applyManaged(text, sectionText) {
    var sb = stripBom(text), body = sb.body, info = scan(body), eol = info.eol;
    var sec = sectionText ? String(sectionText).replace(/\r\n|\n/g, eol) : '';
    if (sec && sec.slice(-eol.length) !== eol) sec += eol;
    var out, m = info.managed;
    if (m) {
      var a = info.offsets[m.startLine];
      var b = info.offsets[m.endLine] + info.lines[m.endLine].length + info.terms[m.endLine].length;
      if (!sec) {
        var nx = m.endLine + 1;
        if (nx < info.lines.length && info.terms[nx] && isBlank(info.lines[nx])) {
          b += info.lines[nx].length + info.terms[nx].length;
        }
      }
      out = body.slice(0, a) + sec + body.slice(b);
    } else {
      if (!sec) return (sb.bom ? '﻿' : '') + body;
      if (info.firstBlock === -1) {
        out = body + (body && !/\n$/.test(body) ? eol : '') + sec;
      } else {
        // step over blank lines above the first block, then over the comment
        // run stuck to it (that's its section header), and insert above that
        var j = info.firstBlock - 1;
        while (j >= 0 && isBlank(info.lines[j])) j--;
        while (j >= 0 && info.lines[j].trim().charAt(0) === '#') j--;
        var p = info.offsets[j + 1];
        out = body.slice(0, p) + sec + eol + body.slice(p);
      }
    }
    return (sb.bom ? '﻿' : '') + out;
  }

  // ---- app items -----------------------------------------------------------

  function mapRarity(r) {
    r = String(r || '').toUpperCase();
    if (r === 'MAGIC') return 'Magic';
    if (r === 'RARE') return 'Rare';
    if (r === 'UNIQUE' || r === 'RELIC') return 'Unique';
    return 'Normal';                            // normal, gems, currency, cards: all "Normal" to a filter
  }

  /* fromAppItem(it) -> the item shape matchItem wants, from js/pob.js's
   * parseGameItem / parseItemText output. Fields the app doesn't know stay unset. */
  // item flags / numbers copied as they are when the app knows them (unset = unknown)
  var APP_FLAGS = ['mirrored', 'fractured', 'synthesised', 'replica', 'foulborn', 'imbued', 'zanaMemory',
                   'transfiguredGem', 'scourged', 'vestigial', 'blightedMap', 'uberBlightedMap',
                   'alternateQuality', 'shapedMap', 'elderMap', 'hasCruciblePassiveTree'];
  var APP_NUMBERS = ['memoryStrands', 'searingExarchImplicits', 'eaterOfWorldsImplicits', 'corruptedMods',
                     'width', 'height', 'dropLevel', 'baseArmour', 'baseEvasion', 'baseEnergyShield', 'baseWard'];
  // the Searing Exarch / Eater of Worlds "influence" lines are eldritch implicits to a filter
  var ELDRITCH = { searingexarch: 1, eaterofworlds: 1 };

  function fromAppItem(it) {
    var o = {};
    if (!it) return o;
    var cls = it.itemClass || it['class'];
    if (cls === 'DivinationCard') cls = 'Divination Cards';     // how some copies spell the class
    if (cls) o['class'] = cls;
    if (it.base || it.name) o.base = it.base || it.name;
    if (it.name) o.name = it.name;
    o.rarity = mapRarity(it.rarity);
    if (it.itemLevel > 0) o.itemLevel = it.itemLevel;
    if (isNum(it.quality)) o.quality = it.quality;
    if (it.stackSize > 0) o.stackSize = it.stackSize;
    if (it.gemLevel > 0) o.gemLevel = it.gemLevel;
    if (it.mapTier > 0) o.mapTier = it.mapTier;
    if (typeof it.corrupted === 'boolean') o.corrupted = it.corrupted;
    if (Array.isArray(it.influences)) {
      o.influences = it.influences.filter(function (x) { return !ELDRITCH[normInfluence(x)]; });
    }
    APP_FLAGS.forEach(function (k) { if (typeof it[k] === 'boolean') o[k] = it[k]; });
    APP_NUMBERS.forEach(function (k) { if (isNum(it[k])) o[k] = it[k]; });

    var mods = Array.isArray(it.mods) ? it.mods : [];
    var game = it.itemClass !== undefined;      // a pasted game item carries the whole item text
    if (typeof it.identified === 'boolean') o.identified = it.identified;
    else if (game) o.identified = !mods.some(function (m) { return /^unidentified$/i.test(m.line || ''); });
    if (typeof it.enchanted === 'boolean') o.enchanted = it.enchanted;
    else if (game) o.enchanted = mods.some(function (m) { return m.kind === 'implicit' && m.crafted; });
    // affix names for HasExplicitMod: one per mod (a hybrid mod's two lines share a header)
    var names = [], seenSeq = {};
    mods.forEach(function (m) {
      var nm = m.affix || m.affixName;
      if (m.kind !== 'explicit' || !nm) return;
      if (m.affixSeq != null) {
        if (seenSeq[m.affixSeq]) return;
        seenSeq[m.affixSeq] = 1;
      }
      names.push(nm);
    });
    if (Array.isArray(it.explicitMods)) o.explicitMods = it.explicitMods.slice();
    else if (names.length) o.explicitMods = names;
    // an identified magic/rare advanced copy names every affix it has, so "none named" is known
    else if (game && it.advanced && o.identified === true && /^(Magic|Rare)$/.test(o.rarity)) o.explicitMods = [];
    // implicits for HasImplicitMod (enchants are implicit + crafted in the app's model)
    if (Array.isArray(it.implicitMods)) o.implicitMods = it.implicitMods.slice();
    else if (game) {
      o.implicitMods = mods.filter(function (m) { return m.kind === 'implicit' && !m.crafted && !m.enchant; })
                           .map(function (m) { return m.line; });
    }

    if (typeof it.sockets === 'string') {
      var groups = it.sockets.trim().split(/\s+/).filter(Boolean)
        .map(function (g) { return g.replace(/[^A-Za-z]/g, '').toUpperCase(); })
        .filter(Boolean);
      o.linkedGroups = groups;
      o.socketColours = groups.join('');
      o.sockets = o.socketColours.length;
      o.links = groups.reduce(function (m, g) { return Math.max(m, g.length); }, 0);
    }
    return o;
  }

  /* tierBlocks(parsed, type) -> NeverSink blocks tagged `$type->type`, file order,
   * as { index, tier, visibility, comment, block } for a "move to tier" picker. */
  function tierBlocks(parsed, type) {
    var want = norm(type), out = [];
    (parsed.blocks || []).forEach(function (b) {
      if (b.managed || !b.tags || norm(b.tags.type) !== want) return;
      out.push({ index: b.index, tier: b.tags.tier, visibility: b.visibility, comment: b.comment, block: b });
    });
    return out;
  }

  return {
    MARK_START: MARK_START,
    MARK_END: MARK_END,
    parse: parse,
    matchItem: matchItem,
    testCondition: function (cond, item, opts) { return evalCondition(cond, prep(item || {}, opts), opts); },
    ruleBlock: ruleBlock,
    actionsOf: actionsOf,
    buildManaged: buildManaged,
    applyManaged: applyManaged,
    fromAppItem: fromAppItem,
    tierBlocks: tierBlocks
  };
});
