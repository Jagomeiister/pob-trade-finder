/* filter-edit.js — edit a Path of Exile 1 loot filter in place: move a base
 * between tiers, hide an item, restyle a block, shift a stack/quality
 * threshold, and replay recorded edits onto a new version of the filter.
 * Every edit takes the filter TEXT and returns { ok, text, reason?, code?,
 * change, changes } without touching the input; only the lines that must
 * change are rewritten (indent, per-line EOL, trailing comments, the Show
 * line's tag comment and the BOM stay), and the output is re-parsed to check
 * it says what was intended. Browser (window.FilterEdit, needs
 * window.LootFilter) + Node. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./filter.js'));
  else root.FilterEdit = factory(root.LootFilter);
})(typeof self !== 'undefined' ? self : this, function (LF) {
  'use strict';

  // same split as filter.js's parser, so our line map matches its blocks
  // same list as filter.js (a line both read differently would make blockMap refuse the block)
  var ACTION_RE = /^(Set[A-Z]\w*|PlayAlertSound\w*|PlaySound|CustomAlertSound\w*|MinimapIcon|PlayEffect|DisableDropSound\w*|EnableDropSound\w*)$/i;
  var OP_TOKEN_RE = /^(==|!=|<=|>=|=|!|<|>)/;
  var NUM_RE = /^[+-]?\d+(\.\d+)?$/;

  var COLOURS = ['Red', 'Green', 'Blue', 'Brown', 'White', 'Yellow', 'Cyan', 'Grey', 'Orange', 'Pink', 'Purple'];
  var SHAPES = ['Circle', 'Diamond', 'Hexagon', 'Square', 'Star', 'Triangle', 'Cross', 'Moon', 'Raindrop', 'Kite',
                'Pentagon', 'UpsideDownHouse'];
  var SOUND = { playalertsound: 1, playalertsoundpositional: 1, customalertsound: 1, customalertsoundoptional: 1 };
  var THRESHOLD_FIELD = { stacksize: 'stackSize', quality: 'quality', memorystrands: 'memoryStrands' };
  var THRESHOLD_MIN = { stacksize: 1, quality: 0, memorystrands: 0 };
  var DEFAULT_VOLUME = 300;

  function norm(s) {
    s = String(s == null ? '' : s);
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.toLowerCase().trim();
  }

  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  // numbers and numeric strings compare alike ("1.50" == 1.5), the way parse() reads them
  function canon(v) {
    var s = String(v);
    return NUM_RE.test(s) ? String(parseFloat(s)) : s;
  }

  // ---- tiers ---------------------------------------------------------------

  function titleCase(s) {
    return s.split(/[_\-\s]+/).filter(Boolean).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  /* tierLabel(slug) -> "T1", "T2 Top", "Hidden" (exhide), "Rest" (restex), else Title Case. */
  function tierLabel(slug) {
    var s = lower(slug).trim(), m;
    if (!s) return '';
    if (s === 'exhide') return 'Hidden';
    if (s === 'restex') return 'Rest';
    if ((m = /^t(\d+)(.*)$/.exec(s))) return 'T' + m[1] + (m[2] ? ' ' + titleCase(m[2]) : '');
    return titleCase(s);
  }

  /* isExceptionTier(slug) -> true for exactly ex, ex<digits>, exhide, exshow, 2x, 2x<digits>,
   * or any slug starting "exotic" (bases can leave them, never be moved into them).
   * "exalted", "extra" or "2xstack" are ordinary tiers. */
  function isExceptionTier(slug) {
    var s = lower(slug).trim();
    return /^(ex\d*|exhide|exshow|2x\d*)$/.test(s) || /^exotic/.test(s);
  }

  /* tierGroup(parsed, block) -> the blocks sharing block.tags.type, file order, as
   * [{ block, index, tier, label, visibility, exception }]; [] for an untagged block. */
  function tierGroup(parsed, block) {
    if (!block || !block.tags || !block.tags.type) return [];
    return LF.tierBlocks(parsed, block.tags.type).map(function (t) {
      return { block: t.block, index: t.index, tier: t.tier, label: tierLabel(t.tier),
               visibility: t.visibility, exception: isExceptionTier(t.tier) };
    });
  }

  function findTier(parsed, type, tier) {
    var bs = parsed.blocks;
    for (var i = 0; i < bs.length; i++) {
      var t = bs[i].tags;
      if (!bs[i].managed && t && t.type === type && t.tier === tier) return bs[i];
    }
    return null;
  }

  function blockName(b) {
    if (b && b.tags && b.tags.tier) return tierLabel(b.tags.tier);
    return 'block ' + (b ? b.index + 1 : '?');
  }

  // ---- text <-> lines ------------------------------------------------------

  var cache = { text: null, parsed: null };

  function parse(text) {
    text = text == null ? '' : String(text);
    if (cache.text !== text) { cache.parsed = LF.parse(text); cache.text = text; }
    return cache.parsed;
  }

  // Every line keeps its own terminator; edits replace, drop or insert whole
  // lines and leave the rest byte-for-byte alone.
  function load(text) {
    text = text == null ? '' : String(text);
    var bom = text.charCodeAt(0) === 0xFEFF, body = bom ? text.slice(1) : text;
    var parts = body.split(/(\r\n|\n)/), lines = [], terms = [];
    for (var i = 0; i < parts.length; i += 2) { lines.push(parts[i]); terms.push(parts[i + 1] || ''); }
    var nl = /\r?\n/.exec(body);
    return { bom: bom, lines: lines, terms: terms, eol: nl ? nl[0] : '\n', after: {} };
  }

  function dump(doc) {
    var out = [], n = doc.lines.length;
    for (var i = 0; i < n; i++) {
      var ins = doc.after[i], term = doc.terms[i];
      if (doc.lines[i] !== null) out.push([doc.lines[i], ins && !term ? doc.eol : term]);
      if (ins) {
        for (var k = 0; k < ins.length; k++) {
          // new lines take the line ending of the line they follow
          out.push([ins[k], term || (k < ins.length - 1 ? doc.eol : '')]);
        }
      }
    }
    // a deleted unterminated last line must not leave a new trailing newline
    if (n && doc.terms[n - 1] === '' && out.length) out[out.length - 1][1] = '';
    var s = doc.bom ? '﻿' : '';
    for (var j = 0; j < out.length; j++) s += out[j][0] + out[j][1];
    return s;
  }

  // Tokens with their positions in the line. Like filter.js's lexer, but any
  // whitespace separates tokens.
  function lexLine(str) {
    var tokens = [], i = 0, n = str.length, hash = -1;
    while (i < n) {
      var c = str.charAt(i);
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') { hash = i; break; }
      var start = i, val, quoted = false;
      if (c === '"') {
        quoted = true;
        var close = str.indexOf('"', i + 1);
        if (close === -1) close = n;
        val = str.slice(i + 1, close);
        i = Math.min(close + 1, n);
      } else {
        while (i < n && !/[\s#"]/.test(str.charAt(i))) i++;
        val = str.slice(start, i);
      }
      tokens.push({ v: val, q: quoted, start: start, end: i });
    }
    return { tokens: tokens, hash: hash };
  }

  function indentOf(str) { return /^\s*/.exec(str)[0]; }

  // Which line holds which condition/action of a block (same walk as parse()).
  function blockMap(doc, block) {
    var map = { head: block.startLine, conds: [], acts: [], cont: -1 };
    for (var i = block.startLine + 1; i <= block.endLine; i++) {
      var t = (doc.lines[i] || '').trim();
      if (!t || t.charAt(0) === '#') continue;
      var lx = lexLine(t);
      if (!lx.tokens.length) continue;
      var key = lx.tokens[0].v;
      if (lower(key) === 'continue') map.cont = i;
      else if (ACTION_RE.test(key)) map.acts.push({ line: i, key: key });
      else map.conds.push({ line: i, key: key });
    }
    if (map.conds.length !== block.conditions.length || map.acts.length !== block.actions.length) return null;
    return map;
  }

  // The value tokens of a condition line (after the key and any operator).
  function valueTokens(line) {
    var toks = lexLine(line).tokens, out = [], opEnd = toks.length ? toks[0].end : 0, prevEnd = opEnd;
    for (var i = 1; i < toks.length; i++) {
      var t = toks[i], start = t.start, v = t.v;
      if (i === 1 && !t.q) {
        var m = OP_TOKEN_RE.exec(v);
        if (m && m[0] === v) { opEnd = prevEnd = t.end; continue; }    // a separate "==" token
        if (m) { start += m[0].length; v = v.slice(m[0].length); opEnd = prevEnd = start; }  // "==Foo"
      }
      out.push({ v: v, q: t.q, start: start, end: t.end, prevEnd: prevEnd });
      prevEnd = t.end;
    }
    return { tokens: out, opEnd: opEnd };
  }

  function quote(s) { return '"' + String(s).replace(/"/g, '') + '"'; }

  function fmtArg(key, x, i) {
    if (typeof x === 'number') return String(x);
    if (typeof x === 'boolean') return x ? 'True' : 'False';
    x = String(x);
    if (/^CustomAlertSound/i.test(key) && i === 0) return quote(x);
    return /^[^\s"#]+$/.test(x) ? x : quote(x);
  }

  function fmtAction(key, args) {
    return args.length ? key + ' ' + args.map(function (x, i) { return fmtArg(key, x, i); }).join(' ') : key;
  }

  // ---- work sets: line edits + the blocks they are meant to produce -------

  function modelOf(b) {
    return {
      visibility: b.visibility, cont: b.continue,
      conds: b.conditions.map(function (c) { return { key: c.key, op: c.op, values: c.values.map(canon) }; }),
      acts: b.actions.map(function (a) { return { key: a.key, args: a.args.map(canon) }; })
    };
  }

  function cleanModel(m) {
    return JSON.stringify({ visibility: m.visibility, cont: m.cont,
      conds: m.conds.filter(Boolean), acts: m.acts.filter(Boolean) });
  }

  function work(text) {
    text = text == null ? '' : String(text);
    var doc = load(text);
    return { text: text, parsed: parse(text), doc: doc, orig: doc.lines.slice(), models: {}, maps: {}, changes: [] };
  }

  function wModel(w, i) {
    if (!w.models[i]) w.models[i] = modelOf(w.parsed.blocks[i]);
    return w.models[i];
  }

  function wMap(w, i) {
    if (!w.maps.hasOwnProperty(i)) w.maps[i] = blockMap(w.doc, w.parsed.blocks[i]);
    return w.maps[i];
  }

  function refuse(text, code, reason) {
    return { ok: false, text: text, code: code, reason: reason, change: null, changes: [] };
  }

  // Write the edits out and check the result parses to exactly the intended blocks.
  function finish(w, extra) {
    var out = dump(w.doc), np = LF.parse(out), old = w.parsed.blocks;
    if (np.blocks.length !== old.length || np.bom !== w.parsed.bom) {
      return refuse(w.text, 'invalid', 'The edit would change the filter\'s block layout, so it was not made');
    }
    for (var i = 0; i < old.length; i++) {
      var want = w.models[i] ? cleanModel(w.models[i]) : cleanModel(modelOf(old[i]));
      if (want !== cleanModel(modelOf(np.blocks[i]))) {
        return refuse(w.text, 'invalid', 'The edited ' + blockName(old[i]) + ' did not re-parse as intended, so it was not changed');
      }
    }
    var r = { ok: true, text: out, change: w.changes[0] || null, changes: w.changes };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  function tagged(b) { return !!(b && b.tags && b.tags.type && b.tags.tier); }

  function record(w, c) { w.changes.push(c); }

  // ---- BaseType ------------------------------------------------------------

  function positiveBaseType(c) { return lower(c.key) === 'basetype' && (c.op === '' || c.op === '=' || c.op === '=='); }

  // does one BaseType value catch the base? (non-== matches by substring, like the game)
  function tokenCatches(op, v, base) {
    v = norm(v);
    return op === '==' ? v === base : v !== '' && base.indexOf(v) !== -1;
  }

  function hasBaseTypeLine(b) { return b.conditions.some(positiveBaseType); }

  /* tierBases(block) -> the base names its BaseType line(s) list, deduped, in order. */
  function tierBases(block) {
    var out = [], seen = {};
    (block && block.conditions || []).forEach(function (c) {
      if (!positiveBaseType(c)) return;
      c.values.forEach(function (v) {
        var s = String(v), k = norm(s);
        if (!seen[k]) { seen[k] = 1; out.push(s); }
      });
    });
    return out;
  }

  function namesBase(b, base) {
    var nb = norm(base);
    return b.conditions.some(function (c) {
      return positiveBaseType(c) && c.values.some(function (v) { return norm(v) === nb; });
    });
  }

  // Can the block drop this base so it no longer catches it?
  // -> { ok } or { ok:false, code: 'not-named'|'only'|'substring', token }
  function giveUp(b, base) {
    var nb = norm(base), named = false;
    var conds = b.conditions.filter(positiveBaseType);
    for (var i = 0; i < conds.length; i++) {
      var c = conds[i], rest = c.values.filter(function (v) { return norm(v) !== nb; });
      if (rest.length < c.values.length) {
        named = true;
        if (!rest.length) return { ok: false, code: 'only' };
      }
      for (var k = 0; k < rest.length; k++) {
        if (tokenCatches(c.op, rest[k], nb)) return { ok: false, code: 'substring', token: String(rest[k]) };
      }
    }
    return named ? { ok: true } : { ok: false, code: 'not-named' };
  }

  function giveUpReason(b, base, g) {
    var name = blockName(b);
    if (g.code === 'only') return '"' + base + '" is the only base ' + name + ' names';
    if (g.code === 'substring') return name + ' would still catch "' + base + '" through "' + g.token + '"';
    return name + ' catches "' + base + '" without naming it';
  }

  // the parsed conditions with the base taken out of the BaseType line(s)
  function condsWithout(b, base) {
    var nb = norm(base), out = [];
    b.conditions.forEach(function (c) {
      if (!positiveBaseType(c)) { out.push(c); return; }
      var vals = c.values.filter(function (v) { return norm(v) !== nb; });
      if (vals.length) out.push({ key: c.key, op: c.op, values: vals, raw: c.raw });
    });
    return out;
  }

  function condsWith(b, base) {
    var done = false;
    return b.conditions.map(function (c) {
      if (done || !positiveBaseType(c)) return c;
      done = true;
      if (c.values.some(function (v) { return norm(v) === norm(base); })) return c;
      return { key: c.key, op: c.op, values: c.values.concat([base]), raw: c.raw };
    });
  }

  // strip every exact occurrence from the block's BaseType line(s); an emptied line goes
  function wStrip(w, i, base) {
    var b = w.parsed.blocks[i], map = wMap(w, i), m = wModel(w, i), nb = norm(base), hit = false;
    if (!map) return false;
    b.conditions.forEach(function (c, ci) {
      if (!positiveBaseType(c)) return;
      var ln = map.conds[ci].line, str = w.doc.lines[ln], vt = valueTokens(str).tokens, drop = [];
      vt.forEach(function (t) { if (norm(t.v) === nb) drop.push(t); });
      if (!drop.length) return;
      hit = true;
      if (drop.length === vt.length) {
        w.doc.lines[ln] = null;
        m.conds[ci] = null;
        return;
      }
      for (var k = drop.length - 1; k >= 0; k--) str = str.slice(0, drop[k].prevEnd) + str.slice(drop[k].end);
      w.doc.lines[ln] = str;
      m.conds[ci].values = m.conds[ci].values.filter(function (v) { return norm(v) !== nb; });
    });
    return hit;
  }

  // append the quoted base to the first BaseType line, before any trailing comment
  function wAdd(w, i, base) {
    var b = w.parsed.blocks[i], map = wMap(w, i), m = wModel(w, i);
    if (!map) return false;
    for (var ci = 0; ci < b.conditions.length; ci++) {
      if (!positiveBaseType(b.conditions[ci])) continue;
      if (!m.conds[ci]) return false;
      if (m.conds[ci].values.some(function (v) { return norm(v) === norm(base); })) return false;
      var ln = map.conds[ci].line, str = w.doc.lines[ln], vt = valueTokens(str);
      var at = vt.tokens.length ? vt.tokens[vt.tokens.length - 1].end : vt.opEnd;
      w.doc.lines[ln] = str.slice(0, at) + ' ' + quote(base) + str.slice(at);
      m.conds[ci].values.push(canon(String(base).replace(/"/g, '')));
      return true;
    }
    return false;
  }

  // ---- switch tier ---------------------------------------------------------

  function blockFits(b, item, skipBaseType) {
    for (var i = 0; i < b.conditions.length; i++) {
      var c = b.conditions[i];
      if (skipBaseType && lower(c.key) === 'basetype') continue;
      if (LF.testCondition(c, item) === false) return c;
    }
    return null;
  }

  // Why the base can't go from `from` to `to` (null when it can).
  function moveRefusal(parsed, item, base, from, to) {
    var label = blockName(to);
    if (to.tags && isExceptionTier(to.tags.tier)) return { code: 'exception', reason: label + ' is an exception tier' };
    if (!hasBaseTypeLine(to)) return { code: 'no-basetype', reason: label + ' has no BaseType line' };
    if (item) {
      var bad = blockFits(to, item, true);
      if (bad) return { code: 'conditions', reason: 'This item fails ' + label + '\'s condition ' + bad.raw };
    }
    var g = giveUp(from, base), inDest = namesBase(to, base);
    if (!g.ok && to.index > from.index) {
      return { code: 'source-keeps', reason: giveUpReason(from, base, g) + ', and ' + label + ' comes after it' };
    }
    if (!g.ok && inDest) return { code: 'already', reason: '"' + base + '" is already in ' + label };
    return null;
  }

  function itemBase(item) { return item ? (item.base != null ? item.base : item.name) : null; }

  /* moveTargets(text, item, fromIndex) -> [{ index, tier, label, ok, reason, code }]
   * for every other tier of the source block's $type-> group, file order. */
  function moveTargets(text, item, fromIndex) {
    var p = parse(text), from = p.blocks[fromIndex], base = itemBase(item);
    if (!from || base == null) return [];
    return tierGroup(p, from).filter(function (t) { return t.index !== fromIndex; }).map(function (t) {
      var r = moveRefusal(p, item, base, from, t.block);
      return { index: t.index, tier: t.tier, label: t.label, ok: !r, reason: r ? r.reason : '', code: r ? r.code : '' };
    });
  }

  /* moveBases(text, item, bases, fromIndex, toIndex) -> result: several bases in
   * one write (the audit's "move the N above"). item may be null (no condition check). */
  function moveBases(text, item, bases, fromIndex, toIndex) {
    var w = work(text), p = w.parsed, from = p.blocks[fromIndex], to = p.blocks[toIndex];
    if (!from || !to) return refuse(w.text, 'no-block', 'No such block');
    if (fromIndex === toIndex) return refuse(w.text, 'same', 'That is the tier it is in');
    if (!bases || !bases.length) return refuse(w.text, 'no-base', 'No base to move');
    if (!wMap(w, fromIndex) || !wMap(w, toIndex)) return refuse(w.text, 'invalid', 'Could not map the block\'s lines');
    var left = tierBases(from).length;
    for (var i = 0; i < bases.length; i++) {
      var base = bases[i], r = moveRefusal(p, item, base, from, to);
      if (r) return refuse(w.text, r.code, r.reason);
      var g = giveUp(from, base);
      if (g.ok && --left < 1) return refuse(w.text, 'only', blockName(from) + ' must keep at least one base');
      var stripped = g.ok && wStrip(w, fromIndex, base);
      var added = wAdd(w, toIndex, base);
      if (stripped && tagged(from) && tagged(to)) {
        record(w, { kind: 'move-basetype', base: base, fromType: from.tags.type, fromTier: from.tags.tier,
                    toType: to.tags.type, toTier: to.tags.tier });
      } else {
        if (stripped && tagged(from)) record(w, { kind: 'remove-basetype', base: base, type: from.tags.type, tier: from.tags.tier });
        if (added && tagged(to)) record(w, { kind: 'add-basetype', base: base, type: to.tags.type, tier: to.tags.tier });
      }
    }
    var res = finish(w);
    if (res.ok && item) {
      var m = LF.matchItem(LF.parse(res.text), item);
      res.landsOn = m.index;
    }
    return res;
  }

  /* moveBase(text, item, base, fromIndex, toIndex) -> result. Adds the base to the
   * destination's BaseType line and strips it from the source; when the source
   * can't give it up but the destination comes first, only adds. */
  function moveBase(text, item, base, fromIndex, toIndex) {
    return moveBases(text, item, [base], fromIndex, toIndex);
  }

  // ---- hide ----------------------------------------------------------------

  function withConds(parsed, mods) {
    var blocks = parsed.blocks.map(function (b, i) {
      if (!mods.hasOwnProperty(i)) return b;
      return { index: b.index, visibility: b.visibility, continue: b.continue, conditions: mods[i],
               actions: b.actions, tags: b.tags, comment: b.comment, managed: b.managed };
    });
    return { blocks: blocks };
  }

  function step(op, b, base) {
    return { op: op, index: b.index, base: base, type: b.tags ? b.tags.type : '', tier: b.tags ? b.tags.tier : '',
             label: blockName(b) };
  }

  // Hide blocks to try, nearest first: same $type-> path, then each ancestor path,
  // then any Hide block whose other conditions fit the item.
  function hideCandidates(parsed, item, winner) {
    var hides = parsed.blocks.filter(function (b) { return !b.managed && b.visibility === 'Hide' && hasBaseTypeLine(b); });
    var at = winner ? winner.index : 0, out = [], seen = {};
    function near(a, b) { return Math.abs(a.index - at) - Math.abs(b.index - at) || a.index - b.index; }
    function take(list) { list.sort(near).forEach(function (b) { if (!seen[b.index]) { seen[b.index] = 1; out.push(b); } }); }
    if (winner && winner.tags && winner.tags.type) {
      var path = winner.tags.type.split('->');
      for (var n = path.length; n > 0; n--) {
        var want = norm(path.slice(0, n).join('->'));
        take(hides.filter(function (b) { return b.tags && norm(b.tags.type) === want; }));
      }
    }
    // a Hide block that names the item's class beats one that only lists bases (Gold)
    var fits = hides.filter(function (b) { return !blockFits(b, item, true); });
    take(fits.filter(function (b) {
      return b.conditions.some(function (c) { return lower(c.key) === 'class' && LF.testCondition(c, item) === true; });
    }));
    take(fits);
    return out;
  }

  /* hidePlan(text, item) -> { kind: 'flip'|'strip-add'|'strip'|'none', steps, target, reason }
   * steps: [{ op: 'flip'|'strip'|'add', index, base, type, tier, label }]. */
  function hidePlan(text, item) {
    var p = parse(text), base = itemBase(item);
    function none(reason) { return { kind: 'none', steps: [], target: -1, reason: reason }; }
    if (base == null || base === '') return none('The item has no base type');
    var m = LF.matchItem(p, item), win = m.block;
    if (win && win.visibility === 'Hide') return none('It is already hidden by ' + blockName(win));

    // (a) the tier names only this base: flip it
    if (win) {
      var listed = tierBases(win);
      if (listed.length === 1 && norm(listed[0]) === norm(base)) {
        return { kind: 'flip', steps: [step('flip', win, base)], target: win.index,
                 reason: 'Set ' + blockName(win) + ' to Hide (it only holds "' + base + '")' };
      }
    }

    // (b) strip it from every Show block that catches the item and can give it up
    var mods = {}, strips = [];
    p.blocks.forEach(function (b) {
      if (b.continue || b.visibility === 'Hide' || b.managed) return;
      if (!namesBase(b, base) || !giveUp(b, base).ok || blockFits(b, item, false)) return;
      mods[b.index] = condsWithout(b, base);
      strips.push(b);
    });
    var after = LF.matchItem(withConds(p, mods), item);
    function before(t) {
      return strips.filter(function (b) { return b.index < t; }).map(function (b) { return step('strip', b, base); });
    }
    // (c) stripping alone lands it on a Hide block
    if (strips.length && after.block && after.visibility === 'Hide') {
      return { kind: 'strip', steps: before(after.index), target: after.index,
               reason: 'Take "' + base + '" out of ' + strips.map(blockName).join(', ') + '; ' + blockName(after.block) + ' then hides it' };
    }
    var cands = hideCandidates(p, item, win);
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], mm = {};
      for (var k in mods) if (mods.hasOwnProperty(k)) mm[k] = mods[k];
      mm[c.index] = condsWith(c, base);
      var r = LF.matchItem(withConds(p, mm), item);
      if (r.index === c.index) {
        var steps = before(c.index).concat([step('add', c, base)]);
        return { kind: 'strip-add', steps: steps, target: c.index,
                 reason: 'Move "' + base + '" to ' + blockName(c) + (c.tags && c.tags.type ? ' (' + c.tags.type + ')' : '') };
      }
    }
    return none('No hidden tier is available');
  }

  /* applyHide(text, item) -> result; plan as hidePlan, `plan` attached. */
  function applyHide(text, item) {
    var plan = hidePlan(text, item), w = work(text), p = w.parsed, base = itemBase(item);
    if (plan.kind === 'none') return refuse(w.text, 'none', plan.reason);
    var stripped = [], addTo = null;
    for (var i = 0; i < plan.steps.length; i++) {
      var s = plan.steps[i], b = p.blocks[s.index];
      if (!wMap(w, s.index)) return refuse(w.text, 'invalid', 'Could not map the block\'s lines');
      if (s.op === 'flip') {
        wSetVisibility(w, s.index, 'Hide');
        if (tagged(b)) record(w, { kind: 'set-visibility', type: b.tags.type, tier: b.tags.tier, visibility: 'Hide' });
      } else if (s.op === 'strip') {
        if (wStrip(w, s.index, base)) stripped.push(b);
      } else if (wAdd(w, s.index, base)) addTo = b;
    }
    var tg = stripped.filter(tagged);
    if (addTo && tg.length === 1 && stripped.length === 1 && tagged(addTo)) {
      record(w, { kind: 'move-basetype', base: base, fromType: tg[0].tags.type, fromTier: tg[0].tags.tier,
                  toType: addTo.tags.type, toTier: addTo.tags.tier });
    } else {
      tg.forEach(function (b) { record(w, { kind: 'remove-basetype', base: base, type: b.tags.type, tier: b.tags.tier }); });
      if (addTo && tagged(addTo)) record(w, { kind: 'add-basetype', base: base, type: addTo.tags.type, tier: addTo.tags.tier });
    }
    var res = finish(w, { plan: plan });
    if (res.ok && LF.matchItem(LF.parse(res.text), item).visibility !== 'Hide') {
      return refuse(w.text, 'invalid', 'The edit would not hide the item, so it was not made');
    }
    return res;
  }

  // ---- block edits ---------------------------------------------------------

  function wSetVisibility(w, i, vis) {
    var ln = w.parsed.blocks[i].startLine, str = w.doc.lines[ln], t = lexLine(str).tokens[0];
    w.doc.lines[ln] = str.slice(0, t.start) + vis + str.slice(t.end);
    wModel(w, i).visibility = vis;
  }

  function isInt(x, lo, hi) { return typeof x === 'number' && x % 1 === 0 && x >= lo && x <= hi; }

  function oneOf(x, list) {
    for (var i = 0; i < list.length; i++) if (lower(x) === lower(list[i])) return list[i];
    return null;
  }

  function volumeOf(b) {
    for (var i = 0; i < b.actions.length; i++) {
      var a = b.actions[i];
      if (SOUND[lower(a.key)] && typeof a.args[1] === 'number') return a.args[1];
    }
    return DEFAULT_VOLUME;
  }

  // -> the args to write, or a string saying what's wrong
  function checkArgs(key, args, block) {
    var k = lower(key);
    if (typeof args === 'string') args = lexLine(args).tokens.map(function (t) { return t.q || !NUM_RE.test(t.v) ? t.v : parseFloat(t.v); });
    if (!Array.isArray(args)) return key + ' needs a list of values';
    args = args.slice();
    if (/^set(text|border|background)colou?r$/.test(k)) {
      if ((args.length !== 3 && args.length !== 4) || !args.every(function (x) { return isInt(x, 0, 255); })) {
        return key + ' needs 3 or 4 numbers from 0 to 255';
      }
      return args;
    }
    if (k === 'setfontsize') return args.length === 1 && isInt(args[0], 1, 45) ? args : 'SetFontSize needs one number from 1 to 45';
    if (k === 'minimapicon') {
      if (args.length === 1 && args[0] === -1) return args;
      var col = oneOf(args[1], COLOURS), shp = oneOf(args[2], SHAPES);
      if (args.length !== 3 || !isInt(args[0], 0, 2) || !col || !shp) return 'MinimapIcon needs a size (0-2), a colour and a shape';
      return [args[0], col, shp];
    }
    if (k === 'playeffect') {
      var ec = oneOf(args[0], COLOURS.concat(['None']));
      if (!ec || args.length > 2 || (args.length === 2 && lower(args[1]) !== 'temp')) return 'PlayEffect needs a colour, optionally Temp';
      return args.length === 2 ? [ec, 'Temp'] : [ec];
    }
    if (k === 'playalertsound' || k === 'playalertsoundpositional') {
      var id = args[0];
      if (!(isInt(id, 1, 16) || (typeof id === 'string' && /^Sh\w+$/.test(id)))) return key + ' needs a sound 1-16';
      var vol = args.length > 1 ? args[1] : volumeOf(block);
      if (!isInt(vol, 0, 300)) return 'Volume must be 0-300';
      return [id, vol];
    }
    if (k === 'customalertsound' || k === 'customalertsoundoptional') {
      var file = args[0];
      if (typeof file !== 'string' || !file.replace(/"/g, '').trim()) return key + ' needs a sound file';
      var v2 = args.length > 1 ? args[1] : volumeOf(block);
      if (!isInt(v2, 0, 300)) return 'Volume must be 0-300';
      return [file.replace(/"/g, ''), v2];
    }
    return args;
  }

  function wSetAction(w, i, key, args) {
    var b = w.parsed.blocks[i], map = wMap(w, i), m = wModel(w, i), k = lower(key), changed = false;
    var sound = !!SOUND[k], same;
    if (sound && args) same = function (x) { return !!SOUND[lower(x)]; };
    else if (sound) {
      // clearing the stock sound clears its positional form; custom likewise
      same = function (x) { x = lower(x); return x === k || x === k + 'positional' || x === k + 'optional'; };
    } else same = function (x) { return lower(x) === k; };
    var hits = [];
    map.acts.forEach(function (a, ai) { if (m.acts[ai] && same(a.key)) hits.push(ai); });
    if (args) {
      var text = fmtAction(key, args), want = { key: key, args: args.map(canon) };
      if (hits.length) {
        var a0 = map.acts[hits[0]], str = w.doc.lines[a0.line], toks = lexLine(str).tokens;
        var nu = indentOf(str) + text + str.slice(toks[toks.length - 1].end);
        if (nu !== str) { w.doc.lines[a0.line] = nu; changed = true; }
        m.acts[hits[0]] = want;
        hits.shift();
      } else {
        // after the last action line, else the last condition line (so before Continue)
        var anchor = map.acts.length ? map.acts[map.acts.length - 1].line
                   : (map.conds.length ? map.conds[map.conds.length - 1].line : b.startLine);
        var ind = anchor === b.startLine ? '\t' : indentOf(w.orig[anchor]);
        (w.doc.after[anchor] = w.doc.after[anchor] || []).push(ind + text);
        m.acts.push(want);
        changed = true;
      }
    }
    hits.forEach(function (ai) { w.doc.lines[map.acts[ai].line] = null; m.acts[ai] = null; changed = true; });
    return changed;
  }

  /* editBlock(text, index, edits) -> result.
   * edits = { visibility?: 'Show'|'Hide', actions?: { Key: [args] | null } } */
  function editBlock(text, index, edits) {
    var w = work(text), b = w.parsed.blocks[index];
    edits = edits || {};
    if (!b) return refuse(w.text, 'no-block', 'No such block');
    if (!wMap(w, index)) return refuse(w.text, 'invalid', 'Could not map the block\'s lines');
    var tg = tagged(b);
    if (edits.visibility != null) {
      var vis = oneOf(edits.visibility, ['Show', 'Hide']);
      if (!vis) return refuse(w.text, 'bad-value', 'Visibility must be Show or Hide');
      if (vis !== b.visibility) {
        wSetVisibility(w, index, vis);
        if (tg) record(w, { kind: 'set-visibility', type: b.tags.type, tier: b.tags.tier, visibility: vis });
      }
    }
    var acts = edits.actions || {}, keys = Object.keys(acts);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], args = acts[key];
      if (!ACTION_RE.test(key)) return refuse(w.text, 'bad-key', key + ' is not an action');
      if (args != null) {
        args = checkArgs(key, args, b);
        if (typeof args === 'string') return refuse(w.text, 'bad-value', args);
      }
      if (wSetAction(w, index, key, args || null) && tg) {
        record(w, { kind: 'set-action', type: b.tags.type, tier: b.tags.tier, action: key, values: args ? args.slice() : null });
      }
    }
    return finish(w);
  }

  /* actionTarget(parsed, matchResult, actionKey) -> index of the block to edit for
   * that action: the last block in the Continue chain that sets it, else the winner. */
  function actionTarget(parsed, match, actionKey) {
    if (!match) return -1;
    var k = lower(actionKey), chain = (match.trail || []).map(function (t) { return t.block; });
    if (match.block) chain.push(match.block);
    function sets(b) {
      return b.actions.some(function (a) { var x = lower(a.key); return x === k || (SOUND[k] && SOUND[x]); });
    }
    for (var i = chain.length - 1; i >= 0; i--) if (sets(chain[i])) return chain[i].index;
    if (match.block) return match.index;
    return chain.length ? chain[chain.length - 1].index : -1;
  }

  // ---- thresholds ----------------------------------------------------------

  // first non-Continue block whose conditions all come out true (unknown = no)
  function strictFirst(parsed, item) {
    var bs = parsed.blocks;
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].continue) continue;
      var ok = true;
      for (var c = 0; c < bs[i].conditions.length && ok; c++) {
        if (LF.testCondition(bs[i].conditions[c], item) !== true) ok = false;
      }
      if (ok) return bs[i];
    }
    return null;
  }

  /* thresholdSegments(text, item, key) -> [{ from, to, index, block }] for
   * StackSize | Quality | MemoryStrands: which block the item lands on across the
   * value range (to: null = and up). [] when no matching block tests that key. */
  function thresholdSegments(text, item, key) {
    var k = lower(key), field = THRESHOLD_FIELD[k];
    if (!field || !item) return [];
    var p = parse(text), pts = {}, any = false;
    p.blocks.forEach(function (b) {
      var mine = b.conditions.filter(function (c) { return lower(c.key) === k; });
      if (!mine.length) return;
      for (var i = 0; i < b.conditions.length; i++) {
        var c = b.conditions[i];
        if (lower(c.key) !== k && LF.testCondition(c, item) !== true) return;
      }
      mine.forEach(function (c) {
        c.values.forEach(function (v) {
          if (typeof v !== 'number') return;
          any = true;
          pts[v - 1] = pts[v] = pts[v + 1] = 1;
        });
      });
    });
    if (!any) return [];
    var min = THRESHOLD_MIN[k];
    pts[min] = 1;
    var vals = Object.keys(pts).map(Number).filter(function (v) { return v >= min && v % 1 === 0; })
                     .sort(function (a, b) { return a - b; });
    var segs = [];
    vals.forEach(function (v, i) {
      var it = {}, f;
      for (f in item) if (Object.prototype.hasOwnProperty.call(item, f)) it[f] = item[f];
      it[field] = v;
      var b = strictFirst(p, it), idx = b ? b.index : -1, last = segs[segs.length - 1];
      var to = i < vals.length - 1 ? vals[i + 1] - 1 : null;
      if (last && last.index === idx) last.to = to;
      else segs.push({ from: v, to: to, index: idx, block: b });
    });
    return segs;
  }

  function wSetNumber(w, i, ci, oldValue, newValue) {
    var ln = wMap(w, i).conds[ci].line, str = w.doc.lines[ln], vt = valueTokens(str).tokens, hit = false;
    for (var t = vt.length - 1; t >= 0; t--) {
      if (vt[t].q || !NUM_RE.test(vt[t].v) || parseFloat(vt[t].v) !== oldValue) continue;
      str = str.slice(0, vt[t].start) + String(newValue) + str.slice(vt[t].end);
      hit = true;
    }
    if (!hit) return false;
    w.doc.lines[ln] = str;
    var m = wModel(w, i).conds[ci];
    m.values = m.values.map(function (v) { return v === canon(oldValue) ? canon(newValue) : v; });
    return true;
  }

  /* setThreshold(text, type, key, oldValue, newValue) -> result. Rewrites the
   * `key oldValue` conditions of blocks tagged $type->type only; refuses to
   * cross a neighbouring boundary of that group. */
  function setThreshold(text, type, key, oldValue, newValue) {
    var w = work(text), k = lower(key), p = w.parsed;
    if (!THRESHOLD_FIELD[k]) return refuse(w.text, 'bad-key', key + ' is not a threshold');
    oldValue = Number(oldValue); newValue = Number(newValue);
    if (!isInt(newValue, THRESHOLD_MIN[k], 1e9)) return refuse(w.text, 'bad-value', key + ' must be a whole number from ' + THRESHOLD_MIN[k]);
    if (newValue === oldValue) return refuse(w.text, 'unchanged', 'The boundary is already ' + oldValue);
    var group = LF.tierBlocks(p, type), all = {}, hits = [];
    group.forEach(function (t) {
      t.block.conditions.forEach(function (c, ci) {
        if (lower(c.key) !== k) return;
        c.values.forEach(function (v) { if (typeof v === 'number') all[v] = 1; });
        if (c.values.indexOf(oldValue) !== -1) hits.push({ b: t.block, ci: ci, op: c.op });
      });
    });
    if (!hits.length) return refuse(w.text, 'not-found', 'No ' + key + ' ' + oldValue + ' condition in ' + type);
    var lo = -Infinity, hi = Infinity;
    Object.keys(all).map(Number).forEach(function (v) {
      if (v < oldValue && v > lo) lo = v;
      if (v > oldValue && v < hi) hi = v;
    });
    if (newValue <= lo || newValue >= hi) {
      return refuse(w.text, 'crosses', key + ' ' + newValue + ' would cross the neighbouring boundary ' + (newValue <= lo ? lo : hi));
    }
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!wMap(w, h.b.index)) return refuse(w.text, 'invalid', 'Could not map the block\'s lines');
      if (wSetNumber(w, h.b.index, h.ci, oldValue, newValue) && tagged(h.b)) {
        record(w, { kind: 'set-threshold', type: h.b.tags.type, tier: h.b.tags.tier, condition: h.b.conditions[h.ci].key,
                    op: h.op, value: newValue });
      }
    }
    return finish(w);
  }

  // ---- recorded edits ------------------------------------------------------

  function copy(c) { var o = {}; for (var k in c) if (c.hasOwnProperty(k)) o[k] = Array.isArray(c[k]) ? c[k].slice() : c[k]; return o; }

  function sameTier(t1, r1, t2, r2) { return t1 === t2 && r1 === r2; }

  /* compactChanges(list) -> a shorter list with the same effect: latest per
   * key wins; chained moves merge and a move back to its origin cancels; a
   * removal after a move becomes a removal at the move's origin; add and remove
   * of one base in one tier cancel. Order follows each entry's latest edit. */
  function compactChanges(list) {
    var out = [];
    function drop(pred) {
      for (var i = out.length - 1; i >= 0; i--) if (pred(out[i])) { var e = out[i]; out.splice(i, 1); return e; }
      return null;
    }
    (list || []).forEach(function (c0) {
      if (!c0 || !c0.kind) return;
      var c = copy(c0), nb = norm(c.base);
      function base(e) { return norm(e.base) === nb; }
      switch (c.kind) {
        case 'set-visibility':
          drop(function (e) { return e.kind === c.kind && sameTier(e.type, e.tier, c.type, c.tier); });
          out.push(c); return;
        case 'set-threshold':
          drop(function (e) { return e.kind === c.kind && sameTier(e.type, e.tier, c.type, c.tier) && lower(e.condition) === lower(c.condition); });
          out.push(c); return;
        case 'set-action':
          var k = lower(c.action);
          while (drop(function (e) {
            if (e.kind !== c.kind || !sameTier(e.type, e.tier, c.type, c.tier)) return false;
            var x = lower(e.action);
            // setting one sound replaces every other sound line of the block
            return x === k || (c.values && SOUND[k] && SOUND[x]);
          })) { /* drop all */ }
          out.push(c); return;
        case 'move-basetype':
          var prev = drop(function (e) { return e.kind === 'move-basetype' && base(e) && sameTier(e.toType, e.toTier, c.fromType, c.fromTier); });
          if (prev) { c.fromType = prev.fromType; c.fromTier = prev.fromTier; c.base = prev.base; }
          else {
            var add = drop(function (e) { return e.kind === 'add-basetype' && base(e) && sameTier(e.type, e.tier, c.fromType, c.fromTier); });
            if (add) { out.push({ kind: 'add-basetype', base: add.base, type: c.toType, tier: c.toTier }); return; }
          }
          if (sameTier(c.fromType, c.fromTier, c.toType, c.toTier)) return;      // back where it started
          out.push(c); return;
        case 'remove-basetype':
          var mv = drop(function (e) { return e.kind === 'move-basetype' && base(e) && sameTier(e.toType, e.toTier, c.type, c.tier); });
          if (mv) { c.type = mv.fromType; c.tier = mv.fromTier; }
          if (drop(function (e) { return e.kind === 'add-basetype' && base(e) && sameTier(e.type, e.tier, c.type, c.tier); })) return;
          drop(function (e) { return e.kind === c.kind && base(e) && sameTier(e.type, e.tier, c.type, c.tier); });
          out.push(c); return;
        case 'add-basetype':
          if (drop(function (e) { return e.kind === 'remove-basetype' && base(e) && sameTier(e.type, e.tier, c.type, c.tier); })) return;
          drop(function (e) { return e.kind === c.kind && base(e) && sameTier(e.type, e.tier, c.type, c.tier); });
          out.push(c); return;
        default:
          out.push(c);
      }
    });
    return out;
  }

  function skip(text, reason) { return { ok: false, text: text, reason: reason }; }

  function replayOne(text, c) {
    var p = parse(text), b, r;
    switch (c.kind) {
      case 'set-visibility':
      case 'set-action':
        b = findTier(p, c.type, c.tier);
        if (!b) return skip(text, 'Tier ' + c.type + ' ' + c.tier + ' is gone');
        var ed = {};
        if (c.kind === 'set-visibility') ed.visibility = c.visibility;
        else { ed.actions = {}; ed.actions[c.action] = c.values; }
        r = editBlock(text, b.index, ed);
        return r.ok ? r : skip(text, r.reason);

      case 'set-threshold':
        b = findTier(p, c.type, c.tier);
        if (!b) return skip(text, 'Tier ' + c.type + ' ' + c.tier + ' is gone');
        var w = work(text), done = false, found = false;
        if (!wMap(w, b.index)) return skip(text, 'Could not map the block\'s lines');
        b.conditions.forEach(function (cd, ci) {
          if (lower(cd.key) !== lower(c.condition) || (c.op != null && cd.op !== c.op)) return;
          cd.values.forEach(function (v) {
            if (typeof v !== 'number') return;
            found = true;
            if (v !== c.value && wSetNumber(w, b.index, ci, v, c.value)) done = true;
          });
        });
        if (!found) return skip(text, blockName(b) + ' has no ' + c.condition + ' condition');
        if (!done) return { ok: true, text: text };
        r = finish(w);
        return r.ok ? r : skip(text, r.reason);

      case 'add-basetype':
        b = findTier(p, c.type, c.tier);
        if (!b) return skip(text, 'Tier ' + c.type + ' ' + c.tier + ' is gone');
        if (!hasBaseTypeLine(b)) return skip(text, blockName(b) + ' has no BaseType line');
        if (namesBase(b, c.base)) return { ok: true, text: text };
        var wa = work(text);
        if (!wMap(wa, b.index) || !wAdd(wa, b.index, c.base)) return skip(text, 'Could not add "' + c.base + '"');
        r = finish(wa);
        return r.ok ? r : skip(text, r.reason);

      case 'remove-basetype':
        b = findTier(p, c.type, c.tier);
        if (!b || !namesBase(b, c.base)) {
          // fall back to the block of the same $type-> path that names it now
          var alt = LF.tierBlocks(p, c.type).filter(function (t) { return namesBase(t.block, c.base); })[0];
          if (!alt) return skip(text, b ? '"' + c.base + '" is gone' : 'Tier ' + c.type + ' ' + c.tier + ' is gone');
          b = alt.block;
        }
        var g = giveUp(b, c.base);
        if (!g.ok) return skip(text, giveUpReason(b, c.base, g));
        var wr = work(text);
        if (!wMap(wr, b.index) || !wStrip(wr, b.index, c.base)) return skip(text, 'Could not remove "' + c.base + '"');
        r = finish(wr);
        return r.ok ? r : skip(text, r.reason);

      case 'move-basetype':
        var to = findTier(p, c.toType, c.toTier);
        if (!to) return skip(text, 'Tier ' + c.toType + ' ' + c.toTier + ' is gone');
        if (!hasBaseTypeLine(to)) return skip(text, blockName(to) + ' has no BaseType line');
        // the base where it sits now: its old tier if that still names it, else
        // the first tier of its group(s) that does
        var types = c.fromType === c.toType ? [c.fromType] : [c.fromType, c.toType], srcs = [];
        var old = findTier(p, c.fromType, c.fromTier), inDest = namesBase(to, c.base);
        if (old && old.index !== to.index && namesBase(old, c.base)) srcs.push(old);
        else if (inDest) return { ok: true, text: text };                      // already moved
        types.forEach(function (t) {
          LF.tierBlocks(p, t).forEach(function (x) {
            if (!srcs.length && x.index !== to.index && namesBase(x.block, c.base)) srcs.push(x.block);
          });
        });
        if (!srcs.length && !inDest) return skip(text, '"' + c.base + '" is gone');
        var wm = work(text);
        for (var i = 0; i < srcs.length; i++) {
          var gu = giveUp(srcs[i], c.base);
          if (gu.ok) {
            if (!wMap(wm, srcs[i].index) || !wStrip(wm, srcs[i].index, c.base)) return skip(text, 'Could not remove "' + c.base + '"');
          } else if (srcs[i].index < to.index) return skip(text, giveUpReason(srcs[i], c.base, gu));
        }
        if (!inDest && (!wMap(wm, to.index) || !wAdd(wm, to.index, c.base))) return skip(text, 'Could not add "' + c.base + '"');
        if (dump(wm.doc) === text) return { ok: true, text: text };
        r = finish(wm);
        return r.ok ? r : skip(text, r.reason);
    }
    return skip(text, 'Unknown edit ' + c.kind);
  }

  /* replayChanges(text, list) -> { text, applied: [change], skipped: [{ change, reason }] }
   * Re-applies recorded edits (compacted first) to a new version of the filter. */
  function replayChanges(text, list) {
    var cur = text == null ? '' : String(text), applied = [], skipped = [];
    compactChanges(list).forEach(function (c) {
      var r = replayOne(cur, c);
      if (r.ok) { cur = r.text; applied.push(c); } else skipped.push({ change: c, reason: r.reason });
    });
    return { text: cur, applied: applied, skipped: skipped };
  }

  // ---- economy audit -------------------------------------------------------

  /* auditSplit(bases, prices, threshold) -> { above, below, unpriced, moveAbove, moveBelow }
   * above/below: names at/over and under the threshold (chaos), dearest first.
   * moveAbove/moveBelow: what can actually leave without emptying the tier. */
  function auditSplit(bases, prices, threshold) {
    var lc = {}, k;
    prices = prices || {};
    for (k in prices) if (prices.hasOwnProperty(k)) lc[norm(k)] = prices[k];
    function price(b) {
      var v = prices.hasOwnProperty(b) ? prices[b] : lc[norm(b)];
      return typeof v === 'number' && !isNaN(v) ? v : null;
    }
    var above = [], below = [], unpriced = [];
    (bases || []).forEach(function (b) {
      var v = price(b);
      if (v === null) unpriced.push(b);
      else (v >= threshold ? above : below).push(b);
    });
    function dear(a, b) { return price(b) - price(a); }
    above.sort(dear); below.sort(dear);
    var moveAbove = above.slice(), moveBelow = below.slice();
    // the tier keeps at least one base: hold back the one nearest the threshold
    if (moveAbove.length && moveAbove.length === bases.length) moveAbove.pop();
    if (moveBelow.length && moveBelow.length === bases.length) moveBelow.shift();
    return { above: above, below: below, unpriced: unpriced, moveAbove: moveAbove, moveBelow: moveBelow };
  }

  return {
    tierLabel: tierLabel,
    isExceptionTier: isExceptionTier,
    tierGroup: tierGroup,
    moveTargets: moveTargets,
    moveBase: moveBase,
    moveBases: moveBases,
    hidePlan: hidePlan,
    applyHide: applyHide,
    editBlock: editBlock,
    actionTarget: actionTarget,
    thresholdSegments: thresholdSegments,
    setThreshold: setThreshold,
    compactChanges: compactChanges,
    replayChanges: replayChanges,
    tierBases: tierBases,
    auditSplit: auditSplit
  };
});
