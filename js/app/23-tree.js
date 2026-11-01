/* js/app/23-tree.js — Skill tree: a mini Path of Building. Draws the build's passive tree
   (pan, zoom, search, hover), shows where its jewels sit and which mastery effects it picks,
   and, compared with your character, which points are still to take and in what order.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Layout comes precomputed in data/treeview.js (tools/make_treeview.py, PoB's orbit maths),
// so this file only draws. Node kinds: 0 small, 1 notable, 2 keystone, 3 mastery,
// 4 jewel socket, 5 class start, 6 ascendancy start.
var TREE_KIND_LABEL = ['Passive', 'Notable', 'Keystone', 'Mastery', 'Jewel socket', 'Class start', 'Ascendancy start'];
var TREE_R = [26, 40, 56, 34, 38, 80, 30];            // node radius in tree units
var TREE_MIN_PX = [1.6, 2.6, 3.6, 2.2, 3.2, 5, 2.4];  // and never smaller than this on screen
var TREE_MAX_SCALE = 2.5;
var TREE_IDX = null;  // index over POE_TREE_VIEW, built once
var TREEVIEW = null;  // the current build's view: { b, I, M, cmp, mode, q, hits, main, inset, … }

function treeIndex() {
  if (TREE_IDX || !window.POE_TREE_VIEW) return TREE_IDX;
  var D = window.POE_TREE_VIEW, byId = {}, adj = {}, mlink = {}, lines = [], arcs = [], i;
  var at = D.icons ? D.icons.at : [];
  D.nodes.forEach(function (r, k) {
    byId[r[0]] = { id: r[0], x: r[1], y: r[2], kind: r[3], name: r[4], stats: r[5] || '',
                   asc: r.length > 6 ? r[6] : -1, flags: r[7] || 0,
                   icon: at[2 * k] >= 0 ? [at[2 * k], at[2 * k + 1]] : null }; // x, y in the icon sheets
  });
  function link(a, b) { (adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a); }
  for (i = 0; i < D.edges.length; i += 2) {
    var a = byId[D.edges[i]], b = byId[D.edges[i + 1]];
    if (!a || !b) continue;
    lines.push({ a: a, b: b });
    link(a.id, b.id);
  }
  // same group + orbit: an arc around the group centre, the short way round (as PoB draws it)
  for (i = 0; i < D.arcs.length; i += 5) {
    var p = byId[D.arcs[i]], q = byId[D.arcs[i + 1]];
    if (!p || !q) continue;
    var cx = D.arcs[i + 2], cy = D.arcs[i + 3];
    var t1 = Math.atan2(p.y - cy, p.x - cx), d = Math.atan2(q.y - cy, q.x - cx) - t1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    arcs.push({ a: p, b: q, cx: cx, cy: cy, r: D.arcs[i + 4], t1: t1, d: d });
    link(p.id, q.id);
  }
  // a mastery is reached from its notables but is never a way through
  for (i = 0; i < D.masteryLinks.length; i += 2) {
    (mlink[D.masteryLinks[i + 1]] = mlink[D.masteryLinks[i + 1]] || []).push(D.masteryLinks[i]);
  }
  var ascBounds = D.ascendancies.map(function () { return null; });
  D.nodes.forEach(function (r) {
    var k = r.length > 6 ? r[6] : -1;
    if (k < 0) return;
    var bb = ascBounds[k] || (ascBounds[k] = [Infinity, Infinity, -Infinity, -Infinity]);
    bb[0] = Math.min(bb[0], r[1]); bb[1] = Math.min(bb[1], r[2]);
    bb[2] = Math.max(bb[2], r[1]); bb[3] = Math.max(bb[3], r[2]);
  });
  TREE_IDX = { D: D, byId: byId, adj: adj, mlink: mlink, lines: lines, arcs: arcs, ascBounds: ascBounds };
  return TREE_IDX;
}

// what the build allocates, in tree terms
function treeModel(b, I) {
  var t = b.tree || { nodes: [], masteries: [], sockets: [] };
  var alloc = {}, cluster = 0, missing = [];
  (t.nodes || []).forEach(function (id) {
    if (id >= 65536) { cluster++; return; } // cluster jewel passives: generated, not in the tree data
    if (!I.byId[id]) { missing.push(id); return; }
    alloc[id] = true;
  });
  var cls = I.D.classes.filter(function (c) { return c.name === b.className; })[0] || null;
  var ascIdx = -1;
  I.D.ascendancies.forEach(function (a, i) { if (ascIdx < 0 && (a.id === b.ascendClass || a.name === b.ascendClass)) ascIdx = i; });
  var points = cluster, ascPts = {};
  Object.keys(alloc).forEach(function (id) {
    var n = I.byId[id];
    if (n.kind === 5) return;
    if (n.asc >= 0) { ascPts[n.asc] = (ascPts[n.asc] || 0) + (n.kind === 6 ? 0 : 1); return; }
    points++;
  });
  var mastery = {};
  (t.masteries || []).forEach(function (m) { mastery[m[0]] = m[1]; });
  var sockets = {};
  (t.sockets || []).forEach(function (s) {
    var it = s.itemId && s.itemId !== '0' && b.items[s.itemId];
    if (it) sockets[s.nodeId] = it;
  });
  // insets: the build's ascendancy first, then any other one it allocates in (bloodlines)
  var insets = ascIdx >= 0 ? [ascIdx] : [];
  Object.keys(ascPts).forEach(function (k) { if (insets.indexOf(+k) === -1) insets.push(+k); });
  return { alloc: alloc, cluster: cluster, missing: missing, cls: cls, ascIdx: ascIdx, points: points,
           ascPts: ascPts, mastery: mastery, sockets: sockets, insets: insets };
}

// character-window mastery_effects → {mastery node: effect id}. The shape has changed over the
// years (plain effect ids, packed numbers), so keep only pairs the tree says are valid.
function treeCharMasteries(I, raw) {
  var out = {};
  if (!raw) return out;
  var pairs = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return [k, raw[k]]; });
  pairs.forEach(function (p) {
    if (!p || p.length < 2) return;
    var node = +p[0], v = +p[1];
    var ok = I.D.masteries[node];
    if (ok) {
      [v, Math.floor(v / 65536), v % 65536].some(function (e) {
        if (ok.indexOf(e) === -1) return false;
        out[node] = e;
        return true;
      });
    } else if (I.D.masteries[v] && I.D.masteries[v].indexOf(node) !== -1) {
      out[v] = node; // {effect: node}
    }
  });
  return out;
}

// build vs character: still to take (in an order you can take them), to refund, in common.
// ch = get_character_passives answer { hashes, hashesEx, masteries, jewels }
function treeCompare(I, M, ch) {
  var have = {};
  (ch.hashes || []).forEach(function (id) { if (I.byId[id]) have[id] = true; });
  function counts(n) { return n && n.kind !== 5 && n.kind !== 6; } // starts cost nothing
  var take = {}, refund = [], both = 0;
  Object.keys(M.alloc).forEach(function (id) {
    if (!counts(I.byId[id])) return;
    if (have[id]) both++; else take[id] = true;
  });
  Object.keys(have).forEach(function (id) { if (counts(I.byId[id]) && !M.alloc[id]) refund.push(+id); });
  // walk out from everything you have (plus the build's starts): step 1 = can take it now
  var dist = {}, q = [], order = [];
  Object.keys(have).concat(Object.keys(M.alloc).filter(function (id) { return !counts(I.byId[id]); }))
    .forEach(function (id) { if (dist[id] === undefined) { dist[id] = 0; q.push(+id); } });
  for (var h = 0; h < q.length; h++) {
    var id = q[h];
    if (I.byId[id] && I.byId[id].kind === 3) continue; // masteries are dead ends
    (I.adj[id] || []).concat(I.mlink[id] || []).forEach(function (nb) {
      if (dist[nb] !== undefined || !take[nb]) return;
      dist[nb] = dist[id] + 1;
      order.push(nb);
      q.push(nb);
    });
  }
  Object.keys(take).forEach(function (id) { if (dist[id] === undefined) order.push(+id); }); // not connected
  var steps = {}, refundSet = {};
  order.forEach(function (id) { steps[id] = dist[id] || 0; });
  refund.sort(function (a, b) { return a - b; }).forEach(function (id) { refundSet[id] = true; });
  var chm = treeCharMasteries(I, ch.masteries);
  var masteryChanges = [];
  Object.keys(M.mastery).forEach(function (node) {
    if (have[node] && chm[node] && chm[node] !== M.mastery[node]) {
      masteryChanges.push({ node: +node, from: chm[node], to: M.mastery[node] });
    }
  });
  var jewels = {};
  (ch.jewels || []).forEach(function (j) {
    var node = I.D.jewelSlots[j.x];
    if (node) jewels[node] = j;
  });
  return { take: order.map(function (id) { return { id: id, step: steps[id] }; }), steps: steps, refund: refund,
           refundSet: refundSet, both: both, masteryChanges: masteryChanges, jewels: jewels, have: have,
           clusterYou: (ch.hashesEx || []).length };
}

// ---- drawing --------------------------------------------------------------------------
function treeStatus(id) {
  var T = TREEVIEW;
  if (T.mode === 'compare' && T.cmp) {
    if (T.cmp.steps[id] !== undefined) return 'take';
    if (T.cmp.refundSet[id]) return 'refund';
  }
  return T.M.alloc[id] ? 'alloc' : null;
}

function treeEdgeCat(a, b) {
  var sa = treeStatus(a), sb = treeStatus(b);
  if (!sa || !sb) return 'dim';
  if (sa === 'refund' || sb === 'refund') return sa !== 'take' && sb !== 'take' ? 'refund' : 'dim';
  return sa === 'take' || sb === 'take' ? 'take' : 'alloc';
}

function treeColors() {
  var cs = getComputedStyle(document.documentElement);
  function v(n) { return cs.getPropertyValue(n).trim(); }
  return { bg: v('--bg'), s1: v('--s1'), line: v('--border-strong'), dim: v('--text-3'),
           alloc: v('--accent'), take: v('--success'), refund: v('--danger'), hit: v('--info'),
           text: v('--text'), text2: v('--text-2'), unique: v('--unique'), rare: v('--rare'),
           magic: v('--magic'), normal: v('--normal'),
           font: getComputedStyle(document.body).fontFamily || 'sans-serif' };
}

function treeRarityColor(C, it) {
  var r = String(it && it.rarity || '').toLowerCase();
  return r === 'unique' || r === 'relic' ? C.unique : r === 'rare' ? C.rare : r === 'magic' ? C.magic : C.normal;
}

// one canvas (the whole tree, or one ascendancy inset) with its own pan/zoom
function treeCanvas(canvas, nodes, bounds, opts) {
  var set = {};
  nodes.forEach(function (n) { set[n.id] = true; });
  var I = treeIndex();
  return {
    el: canvas, ctx: canvas.getContext('2d'), nodes: nodes, opts: opts || {},
    lines: I.lines.filter(function (l) { return set[l.a.id] && set[l.b.id]; }),
    arcs: I.arcs.filter(function (l) { return set[l.a.id] && set[l.b.id]; }),
    bounds: bounds, w: 0, h: 0, dpr: 1, s: 0.05, cx: 0, cy: 0, fitted: false, minS: 0.01
  };
}

function treeResize(cv) {
  var w = cv.el.clientWidth, h = cv.el.clientHeight;
  if (!w || !h) return false;
  var dpr = window.devicePixelRatio || 1;
  if (w !== cv.w || h !== cv.h || dpr !== cv.dpr) {
    cv.w = w; cv.h = h; cv.dpr = dpr;
    cv.el.width = Math.round(w * dpr);
    cv.el.height = Math.round(h * dpr);
  }
  if (!cv.fitted) treeFit(cv);
  return true;
}

function treeFit(cv) {
  if (!cv.w) return;
  var b = cv.bounds, pad = cv.opts.inset ? 70 : 120;
  var bw = Math.max(1, b[2] - b[0] + 2 * pad), bh = Math.max(1, b[3] - b[1] + 2 * pad);
  cv.s = Math.min(cv.w / bw, cv.h / bh);
  cv.minS = cv.s * 0.6;
  cv.cx = (b[0] + b[2]) / 2;
  cv.cy = (b[1] + b[3]) / 2;
  cv.fitted = true;
}

function treeZoomAt(cv, mx, my, f) {
  var wx = (mx - cv.w / 2) / cv.s + cv.cx, wy = (my - cv.h / 2) / cv.s + cv.cy;
  cv.s = Math.max(cv.minS, Math.min(TREE_MAX_SCALE, cv.s * f));
  cv.cx = wx - (mx - cv.w / 2) / cv.s;
  cv.cy = wy - (my - cv.h / 2) / cv.s;
}

function treeNodeRadius(n, s) { return Math.max(TREE_MIN_PX[n.kind], TREE_R[n.kind] * s); }

// a node's outline: a hexagon for keystones, a circle for the rest
function treeShape(ctx, kind, x, y, r) {
  if (kind === 2) {
    for (var k = 0; k < 6; k++) {
      var a = Math.PI / 6 + k * Math.PI / 3;
      if (k) ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); else ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.closePath();
  } else {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
}

// ---- passive icons ----------------------------------------------------------------------
// GGG's icon sprite sheets (data/treeview.js icons: one sheet in colour for allocated nodes, one
// greyed for the rest), loaded once through the art cache (08-cards.js). Each sheet is copied
// once to a canvas with every icon already cut to its node's shape, so a frame only copies
// sub-rects: no clipping, no image decoding. Without the bridge (browser) the tree keeps its
// plain dots. The backdrop under them (tile, group circles, start art) is loaded the same way:
// see treeBgLoad below.
var TREE_ICON_MIN_PX = 7; // a node shows its icon once its radius on screen is at least this
var TREE_SPRITES = null;  // { state: 'loading' | 'ready' | 'failed', active, inactive: canvases }

function treeSprites() {
  if (TREE_SPRITES) return TREE_SPRITES.state === 'ready' ? TREE_SPRITES : null;
  var I = treeIndex(), ic = I && I.D.icons, api = isGui() && window.pywebview.api;
  if (!ic || !api || !api.cache_art) { TREE_SPRITES = { state: 'failed' }; return null; }
  var S = TREE_SPRITES = { state: 'loading' }, urls = [ic.active, ic.inactive];
  function cached() { return urls.every(function (u) { return ART[u]; }); }
  (cached() ? Promise.resolve() : api.cache_art(JSON.stringify(urls)).then(function (r) {
    if (r && r.ok) Object.keys(r.art || {}).forEach(function (u) { ART[u] = r.art[u]; });
  })).then(function () {
    if (!cached()) throw new Error('icon sheets not cached');
    return Promise.all(urls.map(function (u) {
      return new Promise(function (ok, fail) {
        var img = new Image();
        img.onload = function () { ok(img); };
        img.onerror = fail;
        img.src = ART[u];
      });
    }));
  }).then(function (imgs) {
    S.active = treeCutIcons(I, imgs[0]);
    S.inactive = treeCutIcons(I, imgs[1]);
    S.state = 'ready';
    treeRedraw();
  }).catch(function () { S.state = 'failed'; });
  return null;
}

function treeCutIcons(I, img) {
  var ic = I.D.icons, c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  var g = c.getContext('2d');
  g.beginPath();
  I.D.nodes.forEach(function (r) {
    var n = I.byId[r[0]], sz = ic.size[n.kind];
    if (!n.icon || !sz) return;
    treeShape(g, n.kind, n.icon[0] + sz[0] / 2, n.icon[1] + sz[1] / 2, Math.min(sz[0], sz[1]) / 2);
  });
  g.fill();
  g.globalCompositeOperation = 'source-in'; // keep the sheet only inside the shapes
  g.drawImage(img, 0, 0);
  return c;
}

// ---- the in-game backdrop -----------------------------------------------------------------
// data/treeview.js / data/atlasview.js background: GGG's dark tile, the circles behind each
// group (a half image mirrored for its bottom), the start art and, on the Atlas, the painting.
// Loaded once through the art cache like the icons; every piece is copied to canvases once,
// with halved copies (mips) so a zoomed-out frame scales a small canvas, not a 2048 px one.
// Until it is ready (or without the bridge) the trees keep their plain background.
function treeBgLoad(bg, onReady) {
  var api = isGui() && window.pywebview.api;
  if (!bg || !api || !api.cache_art) return { state: 'failed' };
  var S = { state: 'loading' };
  var urls = [bg.tile && bg.tile.url, bg.sheet && bg.sheet.url, bg.painting && bg.painting.url].filter(Boolean);
  var need = urls.filter(function (u) { return !ART[u]; });
  (need.length ? api.cache_art(JSON.stringify(need)).then(function (r) {
    if (r && r.ok) Object.keys(r.art || {}).forEach(function (u) { ART[u] = r.art[u]; });
  }) : Promise.resolve()).then(function () {
    return Promise.all(urls.map(function (u) {
      if (!ART[u]) return null;
      return new Promise(function (ok) {
        var img = new Image();
        img.onload = function () { ok(img); };
        img.onerror = function () { ok(null); };
        img.src = ART[u];
      });
    }));
  }).then(function (imgs) {
    var got = {};
    urls.forEach(function (u, i) { got[u] = imgs[i]; });
    var tile = bg.tile && got[bg.tile.url], sheet = bg.sheet && got[bg.sheet.url];
    var paint = bg.painting && got[bg.painting.url];
    if (tile) {
      var r = bg.tile.rect;
      S.tile = treeMips(treeBgCut(tile, r[0], r[1], r[2], r[3], false));
      S.tileSize = r[2] / bg.tile.zoom; // tree units per tile
    }
    if (sheet) { // each piece cut the way it is used: whole, or as a mirrored half
      var halves = {}, wholes = {}, i;
      for (i = 2; i < bg.groups.length; i += 3) (bg.groups[i] & 1 ? halves : wholes)[bg.groups[i] >> 1] = true;
      for (i = 1; i < (bg.starts || []).length; i += 2) wholes[bg.starts[i]] = true;
      if (bg.startInactive !== undefined) wholes[bg.startInactive] = true;
      S.art = bg.art.map(function (a, k) {
        return { half: halves[k] ? treeMips(treeBgCut(sheet, a[1], a[2], a[3], a[4], true)) : null,
                 full: wholes[k] ? treeMips(treeBgCut(sheet, a[1], a[2], a[3], a[4], false)) : null,
                 w: a[3] / bg.sheet.zoom, h: a[4] / bg.sheet.zoom };
      });
    }
    if (paint) S.painting = treeMips(treeBgCut(paint, 0, 0, paint.naturalWidth, paint.naturalHeight, false));
    if (!S.tile && !S.art && !S.painting) throw new Error('background art not cached');
    S.state = 'ready';
    onReady();
  }).catch(function () { S.state = 'failed'; });
  return S;
}

// a sprite cut from its sheet; half: the top half with its mirror image below (PoB's DrawAsset)
function treeBgCut(img, x, y, w, h, half) {
  var c = document.createElement('canvas');
  c.width = w;
  c.height = half ? 2 * h : h;
  var g = c.getContext('2d');
  g.drawImage(img, x, y, w, h, 0, 0, w, h);
  if (half) {
    g.translate(0, 2 * h);
    g.scale(1, -1);
    g.drawImage(img, x, y, w, h, 0, 0, w, h);
  }
  return c;
}

// the canvas and its halved copies, down to about 32 px
function treeMips(c) {
  var out = [c];
  while (c.width > 32 && c.height > 32) {
    var n = document.createElement('canvas');
    n.width = Math.ceil(c.width / 2);
    n.height = Math.ceil(c.height / 2);
    var g = n.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, n.width, n.height);
    out.push(n);
    c = n;
  }
  return out;
}

// the smallest copy at least px wide (device pixels)
function treeMip(mips, px) {
  for (var i = mips.length - 1; i > 0; i--) if (mips[i].width >= px) return mips[i];
  return mips[0];
}

// how much the backdrop is dimmed under the theme's page colour: a little on dark themes, more on
// light ones (where the nodes and labels are dark), so nodes and the allocated path stay readable
function treeBgDim(ctx, bg) {
  ctx.fillStyle = bg;
  var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(ctx.fillStyle);
  var lum = m ? (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255 : 0;
  return lum > 0.5 ? 0.72 : 0.3;
}

// draws the backdrop over the plain fill; B = a ready treeBgLoad() state, bg = the data,
// opts: { starts: function (node id, art index) → art index to draw or -1 }. Returns what it drew.
function treeBgDraw(cv, B, bg, C, ox, oy, opts) {
  var ctx = cv.ctx, s = cv.s, w = cv.w, h = cv.h, dpr = cv.dpr, done = { tile: false, painting: false, groups: 0, starts: 0 };
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  if (B.tile) { // a pattern per mip level, kept on the canvas (patterns belong to a context)
    var tpx = B.tileSize * s, mip = treeMip(B.tile, tpx * dpr), lvl = B.tile.indexOf(mip);
    cv.bgPats = cv.bgPats && cv.bgPats.src === B ? cv.bgPats : { src: B };
    var pat = cv.bgPats[lvl] || (cv.bgPats[lvl] = ctx.createPattern(mip, 'repeat'));
    if (pat && pat.setTransform) {
      var k = tpx / mip.width;
      pat.setTransform(new DOMMatrix([k, 0, 0, k, ox, oy]));
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
      done.tile = true;
    }
  }
  if (B.painting && bg.painting) {
    var p = bg.painting.rect, pw = (p[2] - p[0]) * s, ph = (p[3] - p[1]) * s;
    ctx.drawImage(treeMip(B.painting, pw * dpr), p[0] * s + ox, p[1] * s + oy, pw, ph);
    done.painting = true;
  }
  if (B.art) {
    var one = function (a, half, x, y) {
      var A = B.art[a];
      if (!A || !(half ? A.half : A.full)) return false;
      var gw = A.w * s, gh = (half ? 2 * A.h : A.h) * s, sx = x * s + ox, sy = y * s + oy;
      if (gw < 1.5 || sx + gw / 2 < 0 || sy + gh / 2 < 0 || sx - gw / 2 > w || sy - gh / 2 > h) return false;
      ctx.drawImage(treeMip(half ? A.half : A.full, gw * dpr), sx - gw / 2, sy - gh / 2, gw, gh);
      return true;
    };
    var g = bg.groups, i;
    for (i = 0; i < g.length; i += 3) if (one(g[i + 2] >> 1, g[i + 2] & 1, g[i], g[i + 1])) done.groups++;
    var st = bg.starts || [], I = opts && opts.nodes;
    for (i = 0; i < st.length; i += 2) {
      var a = opts && opts.starts ? opts.starts(st[i], st[i + 1]) : st[i + 1], n = I && I[st[i]];
      if (a >= 0 && n && one(a, false, n.x, n.y)) done.starts++;
    }
  }
  ctx.globalAlpha = treeBgDim(ctx, C.bg);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  return done;
}

var TREE_BG = null; // treeBgLoad() state for the passive tree

function treeDraw(cv) {
  var T = TREEVIEW;
  if (!cv || !T || !cv.w) return;
  var C = treeColors(), ctx = cv.ctx, s = cv.s, w = cv.w, h = cv.h;
  var ox = w / 2 - cv.cx * s, oy = h / 2 - cv.cy * s; // screen = tree * s + offset
  ctx.setTransform(cv.dpr, 0, 0, cv.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = cv.opts.inset ? C.s1 : C.bg;
  ctx.fillRect(0, 0, w, h);
  cv.bgDrawn = null;
  var bgD = !cv.opts.inset && T.I.D.background;
  if (bgD && !TREE_BG) TREE_BG = treeBgLoad(bgD, treeRedraw);
  if (bgD && TREE_BG.state === 'ready') {
    var cls = T.M.cls;
    cv.bgDrawn = treeBgDraw(cv, TREE_BG, bgD, C, ox, oy, { nodes: T.I.byId, starts: function (id, a) {
      return cls && cls.start === id ? a : bgD.startInactive !== undefined ? bgD.startInactive : -1;
    } });
  }

  // links: one path per colour
  var cats = { dim: [], alloc: [], take: [], refund: [] };
  cv.lines.forEach(function (l) { cats[treeEdgeCat(l.a.id, l.b.id)].push(l); });
  cv.arcs.forEach(function (l) { cats[treeEdgeCat(l.a.id, l.b.id)].push(l); });
  ['dim', 'alloc', 'take', 'refund'].forEach(function (cat) {
    var list = cats[cat];
    if (!list.length) return;
    ctx.beginPath();
    list.forEach(function (e) {
      ctx.moveTo(e.a.x * s + ox, e.a.y * s + oy);
      if (e.r) ctx.arc(e.cx * s + ox, e.cy * s + oy, e.r * s, e.t1, e.t1 + e.d, e.d < 0);
      else ctx.lineTo(e.b.x * s + ox, e.b.y * s + oy);
    });
    ctx.globalAlpha = cat === 'dim' ? 0.8 : 1;
    ctx.strokeStyle = cat === 'dim' ? C.line : C[cat];
    ctx.lineWidth = cat === 'dim' ? Math.max(1, 6 * s) : Math.max(2, 12 * s);
    ctx.stroke();
  });

  // nodes: zoomed in far enough, small nodes, notables and keystones show their icon
  var onScreen = [];
  var sprites = TREE_R[2] * s >= TREE_ICON_MIN_PX ? treeSprites() : null;
  var iconSize = sprites && T.I.D.icons.size;
  cv.iconsDrawn = 0;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  cv.nodes.forEach(function (n) {
    var x = n.x * s + ox, y = n.y * s + oy, r = treeNodeRadius(n, s);
    if (x < -r - 60 || y < -r - 60 || x > w + r + 60 || y > h + r + 60) return;
    onScreen.push(n);
    var st = treeStatus(n.id), col = st ? C[st] : C.dim;
    if (sprites && n.icon && r >= TREE_ICON_MIN_PX) {
      var sz = iconSize[n.kind];
      ctx.globalAlpha = st ? 1 : 0.8;
      ctx.drawImage(st ? sprites.active : sprites.inactive, n.icon[0], n.icon[1], sz[0], sz[1], x - r, y - r, 2 * r, 2 * r);
      cv.iconsDrawn++;
      // the frame keeps the status colours (allocated / still to take / to refund)
      ctx.globalAlpha = st ? 1 : 0.7;
      ctx.beginPath();
      treeShape(ctx, n.kind, x, y, r);
      ctx.lineWidth = Math.max(1.5, r * (n.kind === 0 ? 0.13 : 0.16));
      ctx.strokeStyle = col;
      ctx.stroke();
      return;
    }
    ctx.globalAlpha = st ? 1 : n.kind === 0 ? 0.5 : 0.85;
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.beginPath();
    treeShape(ctx, n.kind, x, y, r);
    if (n.kind === 3 || n.kind === 4 || n.kind === 5 || n.kind === 6) { // rings
      if (n.kind === 3 && st) { ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.lineWidth = n.kind === 4 ? Math.max(1.5, r * 0.32) : n.kind === 5 ? Math.max(1.5, 10 * s) : Math.max(1, r * 0.22);
      ctx.stroke();
    } else {
      ctx.fill();
      if (n.kind !== 0 && r > 4) { // notables and keystones: a darker core
        ctx.beginPath();
        ctx.arc(x, y, r * 0.45, 0, 2 * Math.PI);
        ctx.fillStyle = cv.opts.inset ? C.s1 : C.bg;
        ctx.globalAlpha = 0.55;
        ctx.fill();
      }
    }
    var jewel = n.kind === 4 && T.M.sockets[n.id];
    if (jewel) { // a jewel sits here: a dot in its rarity colour
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, r * 0.5), 0, 2 * Math.PI);
      ctx.fillStyle = treeRarityColor(C, jewel);
      ctx.fill();
    }
  });

  // rings: search hits, next steps, the hovered / just-centred node
  ctx.globalAlpha = 1;
  onScreen.forEach(function (n) {
    var ring = null, width = 2;
    if (T.flash === n.id) { ring = C.text; width = 3; }
    else if (T.hover && T.hover.n === n && T.hover.cv === cv) ring = C.text;
    else if (T.hits && T.hits[n.id]) ring = C.hit;
    else if (T.mode === 'compare' && T.cmp && T.cmp.steps[n.id] === 1) ring = C.take;
    else if (T.mode === 'compare' && T.cmp && T.cmp.refundSet[n.id]) ring = C.refund;
    if (!ring) return;
    var x = n.x * s + ox, y = n.y * s + oy, r = treeNodeRadius(n, s);
    ctx.beginPath();
    ctx.arc(x, y, r + (T.flash === n.id ? 9 : 4), 0, 2 * Math.PI);
    ctx.lineWidth = width;
    ctx.strokeStyle = ring;
    ctx.stroke();
  });

  // labels (12px: the app's smallest text size)
  ctx.font = '600 12px ' + C.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  var nHits = T.hitCount || 0, cands = [];
  onScreen.forEach(function (n) {
    var st = treeStatus(n.id), hit = T.hits && T.hits[n.id] && nHits <= 40, show;
    if (n.kind === 5) show = !cv.opts.inset;
    else if (n.kind !== 1 && n.kind !== 2 && n.kind !== 4) show = false;
    else if (hit) show = true;
    else if (cv.opts.inset) show = n.kind !== 4 && (!!st || s > 0.3);
    else show = st ? (n.kind === 2 ? s >= 0.05 : s >= 0.14) : s >= 0.32;
    // who wins when labels collide: the hovered node, hits, class starts, keystones, allocated
    if (show) cands.push({ n: n, st: st, pri: (T.hover && T.hover.n === n ? 100 : 0) + (hit ? 50 : 0) +
      (n.kind === 5 ? 30 : 0) + (n.kind === 2 ? 20 : 0) + (st ? 10 : 0) });
  });
  cands.sort(function (a, b) { return b.pri - a.pri; });
  var placed = [];
  cands.forEach(function (c) {
    var n = c.n, st = c.st;
    var label = n.kind === 4 && T.M.sockets[n.id] ? T.M.sockets[n.id].name || n.name : n.name;
    var half = ctx.measureText(label).width / 2 + 3;
    var x = Math.max(half, Math.min(w - half, n.x * s + ox)), y = n.y * s + oy; // keep labels inside
    var ly = n.kind === 5 ? y - 6 : y + treeNodeRadius(n, s) + 3;
    var box = [x - half, ly - 1, x + half, ly + 15];
    if (placed.some(function (p) { return box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]; })) return;
    placed.push(box);
    ctx.strokeStyle = cv.opts.inset ? C.s1 : C.bg;
    ctx.strokeText(label, x, ly);
    ctx.fillStyle = n.kind === 5 ? (T.M.cls && T.M.cls.start === n.id ? C.alloc : C.text2) : st ? C.text : C.text2;
    ctx.fillText(label, x, ly);
  });
}

function treeRedraw() {
  if (!TREEVIEW) return;
  treeDraw(TREEVIEW.main);
  if (TREEVIEW.inset) treeDraw(TREEVIEW.inset);
}

function treeHit(cv, mx, my) {
  var wx = (mx - cv.w / 2) / cv.s + cv.cx, wy = (my - cv.h / 2) / cv.s + cv.cy, best = null, bd = Infinity;
  cv.nodes.forEach(function (n) {
    var lim = Math.max(TREE_R[n.kind] * 1.15, 7 / cv.s);
    var d = (n.x - wx) * (n.x - wx) + (n.y - wy) * (n.y - wy);
    if (d < lim * lim && d < bd) { bd = d; best = n; }
  });
  return best;
}

// ---- tooltip --------------------------------------------------------------------------
function treeTip(n, cv, mx, my) {
  var T = TREEVIEW, I = T.I, tip = T.tip;
  if (!n) { tip.hidden = true; return; }
  tip.textContent = '';
  tip.appendChild(UI.el('div', 'tv-tip-name', n.kind === 5 ? n.name + ' (class start)' : n.name));
  var st = treeStatus(n.id);
  var kind = TREE_KIND_LABEL[n.kind] + (n.asc >= 0 ? ' · ' + I.D.ascendancies[n.asc].name : '');
  var meta = UI.el('div', 'tv-tip-meta', kind);
  if (st === 'take') meta.appendChild(UI.chip(T.cmp.steps[n.id] ? 'Still to take · step ' + T.cmp.steps[n.id] : 'Still to take', 'success'));
  else if (st === 'refund') meta.appendChild(UI.chip('To refund', 'danger'));
  else if (st === 'alloc') meta.appendChild(UI.chip('Allocated', 'accent'));
  tip.appendChild(meta);
  function lines(text, cls) {
    String(text || '').split('\n').forEach(function (l) { if (l) tip.appendChild(UI.el('div', cls || 'tv-tip-stat', l)); });
  }
  lines(n.stats);
  if (n.kind === 3) {
    var chosen = T.M.mastery[n.id];
    if (chosen && I.D.masteryEffects[chosen]) {
      tip.appendChild(UI.el('div', 'tv-tip-sub', 'Chosen effect'));
      lines(I.D.masteryEffects[chosen]);
    } else {
      tip.appendChild(UI.el('div', 'tv-tip-sub', 'Effects to choose from'));
      (I.D.masteries[n.id] || []).forEach(function (e) { lines('• ' + (I.D.masteryEffects[e] || '').replace(/\n/g, ' · '), 'tv-tip-opt'); });
    }
  }
  if (n.kind === 4) {
    var it = T.M.sockets[n.id];
    if (it) {
      var rar = String(it.rarity || 'normal').toLowerCase();
      tip.appendChild(UI.el('div', 'tv-tip-jewel tv-r-' + (rar === 'relic' ? 'unique' : rar), it.name || it.base));
      if (it.name && it.base && it.base !== it.name) tip.appendChild(UI.el('div', 'tv-tip-meta', it.base));
      (it.mods || []).slice(0, 10).forEach(function (m) { tip.appendChild(UI.el('div', 'tv-tip-stat', m.line)); });
    } else if (st) {
      tip.appendChild(UI.el('div', 'tv-tip-meta', 'Empty socket in this build'));
    }
    var mine = T.mode === 'compare' && T.cmp && T.cmp.jewels[n.id];
    if (mine) tip.appendChild(UI.el('div', 'tv-tip-sub', 'You: ' + (mine.name ? mine.name + ' · ' : '') + mine.base));
  }
  tip.hidden = false;
  // place next to the cursor, inside the stage
  var stage = T.stage, sw = stage.clientWidth, sh = stage.clientHeight;
  var r = cv.el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  var z = parseFloat(getComputedStyle(document.body).zoom) || 1; // Text size zooms <body>
  var px = (r.left - sr.left) / z + mx + 16, py = (r.top - sr.top) / z + my + 16;
  var tw = tip.offsetWidth, th = tip.offsetHeight;
  if (px + tw > sw - 4) px = Math.max(4, px - tw - 32);
  if (py + th > sh - 4) py = Math.max(4, sh - th - 4);
  tip.style.left = px + 'px';
  tip.style.top = py + 'px';
}

// ---- interaction ----------------------------------------------------------------------
function treeWire(cv) {
  var el = cv.el, down = null;
  function pos(e) {
    var r = el.getBoundingClientRect(), z = r.width ? el.clientWidth / r.width : 1;
    return [(e.clientX - r.left) * z, (e.clientY - r.top) * z];
  }
  el.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var p = pos(e);
    down = { x: p[0], y: p[1], cx: cv.cx, cy: cv.cy, moved: false, id: e.pointerId };
  });
  el.addEventListener('pointermove', function (e) {
    var T = TREEVIEW, p = pos(e);
    if (down && down.id === e.pointerId && !cv.opts.inset) {
      if (!down.moved && Math.abs(p[0] - down.x) + Math.abs(p[1] - down.y) > 4) {
        down.moved = true;
        try { el.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
        el.classList.add('dragging');
      }
      if (down.moved) {
        cv.cx = down.cx - (p[0] - down.x) / cv.s;
        cv.cy = down.cy - (p[1] - down.y) / cv.s;
        treeTip(null);
        treeDraw(cv);
        return;
      }
    }
    var n = treeHit(cv, p[0], p[1]);
    var prev = T.hover;
    T.hover = n ? { n: n, cv: cv } : null;
    if ((prev && prev.n) !== n || (prev && prev.cv) !== cv) {
      if (prev && prev.cv !== cv) treeDraw(prev.cv);
      treeDraw(cv);
    }
    treeTip(n, cv, p[0], p[1]);
  });
  function up(e) {
    if (!down || down.id !== e.pointerId) return;
    var moved = down.moved;
    down = null;
    el.classList.remove('dragging');
    if (moved) return;
    var p = pos(e), n = treeHit(cv, p[0], p[1]);
    if (n && cv.opts.inset) treeFocusNode(n.id); // same as the side lists: flash it
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', function () { down = null; el.classList.remove('dragging'); });
  el.addEventListener('pointerleave', function () {
    var T = TREEVIEW;
    if (T.hover && T.hover.cv === cv) { T.hover = null; treeDraw(cv); }
    treeTip(null);
  });
  if (cv.opts.inset) return;
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = pos(e);
    treeZoomAt(cv, p[0], p[1], Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    treeTip(null);
    treeDraw(cv);
  }, { passive: false });
  el.addEventListener('keydown', function (e) {
    var step = 80 / cv.s, handled = true;
    if (e.key === '+' || e.key === '=') treeZoomAt(cv, cv.w / 2, cv.h / 2, 1.25);
    else if (e.key === '-' || e.key === '_') treeZoomAt(cv, cv.w / 2, cv.h / 2, 0.8);
    else if (e.key === '0' || e.key === 'f') treeFit(cv);
    else if (e.key === 'ArrowLeft') cv.cx -= step;
    else if (e.key === 'ArrowRight') cv.cx += step;
    else if (e.key === 'ArrowUp') cv.cy -= step;
    else if (e.key === 'ArrowDown') cv.cy += step;
    else handled = false;
    if (handled) { e.preventDefault(); treeDraw(cv); }
  });
}

// centre a node (main tree) or show its ascendancy in the inset, and ring it for a moment
var treeFlashTimer = null;
function treeFocusNode(id) {
  var T = TREEVIEW, n = T && T.I.byId[id];
  if (!n) return;
  if (n.asc >= 0) {
    if (T.insetAsc !== n.asc && T.M.insets.indexOf(n.asc) !== -1) treeSetInset(n.asc);
  } else {
    var cv = T.main;
    cv.cx = n.x;
    cv.cy = n.y;
    cv.s = Math.max(cv.s, Math.min(0.35, TREE_MAX_SCALE));
  }
  T.flash = id;
  treeRedraw();
  clearTimeout(treeFlashTimer);
  treeFlashTimer = setTimeout(function () { if (TREEVIEW === T) { T.flash = null; treeRedraw(); } }, 1600);
}

// the inset canvas keeps its listeners; only what it shows changes
function treeSetInset(k) {
  var T = TREEVIEW, I = T.I;
  T.insetAsc = k;
  var nodes = I.D.nodes.filter(function (r) { return (r.length > 6 ? r[6] : -1) === k; })
    .map(function (r) { return I.byId[r[0]]; });
  var fresh = treeCanvas(T.insetEl, nodes, I.ascBounds[k], { inset: true });
  ['nodes', 'lines', 'arcs', 'bounds'].forEach(function (f) { T.inset[f] = fresh[f]; });
  T.inset.fitted = false;
  T.insetTitle.textContent = I.D.ascendancies[k].name + (I.D.ascendancies[k].bloodline ? ' (bloodline)' : '');
  if (treeResize(T.inset)) treeDraw(T.inset);
}

// ---- search ---------------------------------------------------------------------------
function treeSearch(q) {
  var T = TREEVIEW, I = T.I;
  T.q = q;
  T.hits = null;
  T.hitList = [];
  T.hitPos = -1;
  q = q.trim().toLowerCase();
  if (q.length >= 2) {
    T.hits = {};
    T.I.D.nodes.forEach(function (r) {
      var n = I.byId[r[0]];
      if (n.asc >= 0 && T.M.insets.indexOf(n.asc) === -1) return; // other classes' ascendancies
      if ((n.flags & 1) && !T.M.alloc[n.id]) return;               // hidden cluster sockets
      var text = (n.name + '\n' + n.stats).toLowerCase();
      if (n.kind === 3) text += '\n' + (I.D.masteries[n.id] || []).map(function (e) { return I.D.masteryEffects[e] || ''; }).join('\n').toLowerCase();
      if (n.kind === 4 && T.M.sockets[n.id]) text += '\n' + (T.M.sockets[n.id].name || '').toLowerCase();
      if (text.indexOf(q) === -1) return;
      T.hits[n.id] = true;
      T.hitList.push(n.id);
    });
    // allocated first, then by name
    T.hitList.sort(function (a, b) {
      return (T.M.alloc[b] ? 1 : 0) - (T.M.alloc[a] ? 1 : 0) || I.byId[a].name.localeCompare(I.byId[b].name);
    });
  }
  T.hitCount = T.hitList.length;
  var alloc = T.hitList.filter(function (id) { return T.M.alloc[id]; }).length;
  T.countEl.textContent = !T.hits ? '' : T.hitCount ? T.hitCount + ' match' + (T.hitCount > 1 ? 'es' : '') +
    (alloc ? ' · ' + alloc + ' allocated' : '') : 'No matches';
  treeRedraw();
}

// ---- side panel -----------------------------------------------------------------------
function treeItem(id, label, sub) {
  var b = UI.el('button', 'tv-item');
  b.type = 'button';
  b.appendChild(UI.el('span', 'tv-item-name', label));
  if (sub) b.appendChild(UI.el('span', 'tv-item-sub', sub));
  b.addEventListener('click', function () { treeFocusNode(id); });
  return b;
}

function treeList(parent, title, ids, fmt, limit) {
  var box = UI.el('section', 'tv-panel');
  box.appendChild(UI.el('h3', 'tv-h', title + (ids.length ? ' (' + ids.length + ')' : '')));
  var list = UI.el('div', 'tv-list');
  box.appendChild(list);
  function fill(n) {
    list.textContent = '';
    ids.slice(0, n).forEach(function (id, i) { list.appendChild(fmt(id, i)); });
    if (ids.length > n) {
      list.appendChild(UI.button('ghost', { size: 'sm', label: 'Show all ' + ids.length, onClick: function () { fill(ids.length); } }));
    }
  }
  fill(limit || ids.length);
  if (!ids.length) list.appendChild(UI.el('div', 'finder-sub', 'None'));
  parent.appendChild(box);
  return box;
}

function treeFirstStat(n) { return String(n.stats || '').split('\n')[0]; }

function renderTreeSide() {
  var T = TREEVIEW, I = T.I, M = T.M, side = T.side, D = I.D;
  side.textContent = '';
  // summary
  var sum = UI.el('section', 'tv-panel');
  sum.appendChild(UI.el('h3', 'tv-h', (T.b.className || 'Unknown class') + (M.ascIdx >= 0 ? ' · ' + D.ascendancies[M.ascIdx].name : '')));
  var pts = UI.el('div', 'tv-stat');
  pts.appendChild(UI.el('b', 'tv-points', String(M.points)));
  pts.appendChild(document.createTextNode(' passive points' + (M.cluster ? ' (incl. ' + M.cluster + ' in cluster jewels)' : '')));
  sum.appendChild(pts);
  M.insets.forEach(function (k) {
    var a = UI.el('div', 'tv-stat');
    a.appendChild(UI.el('b', 'tv-asc-points', String(M.ascPts[k] || 0)));
    a.appendChild(document.createTextNode(' ' + (D.ascendancies[k].bloodline ? 'bloodline' : 'ascendancy') + ' points · ' + D.ascendancies[k].name));
    sum.appendChild(a);
  });
  if (M.missing.length) {
    sum.appendChild(UI.el('div', 'finder-sub tv-warn', M.missing.length + ' allocated node' + (M.missing.length > 1 ? 's aren\'t' : ' isn\'t') +
      ' in the app\'s tree data (tree ' + (T.b.tree.version || '?') + ') and ' + (M.missing.length > 1 ? 'aren\'t' : 'isn\'t') + ' drawn.'));
  }
  side.appendChild(sum);

  // your character: what's still to take, in order
  var cmpBox = UI.el('section', 'tv-panel tv-compare');
  cmpBox.appendChild(UI.el('h3', 'tv-h', 'Your character'));
  if (!isGui()) {
    cmpBox.appendChild(UI.el('div', 'finder-sub', 'In the desktop app this compares the build with your character\'s passives ' +
      'and lists the points still to take, in the order you can take them.'));
  } else {
    var name = T.charShown = treeCharName();
    var row = UI.el('div', 'tv-row');
    row.appendChild(UI.button(T.cmp ? 'secondary' : 'primary', { size: 'sm', cls: 'tv-compare-btn',
      label: T.cmp ? '↻ Re-read ' + T.cmp.name : name ? 'Compare with ' + name : 'Compare with my character',
      title: 'Reads your character\'s passives from its public profile (one request)',
      onClick: function () { treeRunCompare(this); } }));
    if (T.cmp) {
      row.appendChild(UI.segmented([['compare', 'Compare'], ['build', 'Build only']], T.mode, { ariaLabel: 'Colour the tree by',
        onChange: function (v) { T.mode = v; renderTreeLegend(); treeRedraw(); } }));
    }
    cmpBox.appendChild(row);
    T.cmpStatus = UI.el('div', 'finder-sub tv-cmp-status', T.cmpMsg || (name ? '' :
      'Pick your account and character under ⚖ Compare with character… first.'));
    cmpBox.appendChild(T.cmpStatus);
    if (T.cmp) {
      var c = T.cmp;
      var chips = UI.el('div', 'tv-chips');
      chips.appendChild(UI.chip(c.take.length + ' still to take', 'success', 'tv-take-count'));
      chips.appendChild(UI.chip(c.refund.length + ' to refund', 'danger', 'tv-refund-count'));
      chips.appendChild(UI.chip(c.both + ' in common', 'accent', 'tv-both-count'));
      cmpBox.appendChild(chips);
      if (M.cluster || c.clusterYou) {
        cmpBox.appendChild(UI.el('div', 'finder-sub', 'Cluster jewel passives: build ' + M.cluster + ', you ' + c.clusterYou +
          ' (they depend on the jewels, so they aren\'t compared one by one).'));
      }
    }
  }
  side.appendChild(cmpBox);
  if (T.cmp) {
    var c2 = T.cmp;
    treeList(side, 'Next points to take', c2.take.map(function (t) { return t.id; }), function (id) {
      var n = I.byId[id], step = c2.steps[id];
      var b = treeItem(id, n.name, n.kind === 3 && M.mastery[id] ? (D.masteryEffects[M.mastery[id]] || '').split('\n')[0] : treeFirstStat(n));
      b.insertBefore(UI.el('span', 'tv-step' + (step === 1 ? ' now' : ''), step ? String(step) : '?'), b.firstChild);
      b.title = step === 1 ? 'You can take this now' : step ? 'Step ' + step + ': after the ones before it' : 'Not connected to your tree yet';
      return b;
    }, 30).classList.add('tv-take-list');
    if (c2.refund.length) {
      treeList(side, 'To refund', c2.refund, function (id) { return treeItem(id, I.byId[id].name, treeFirstStat(I.byId[id])); }, 15)
        .classList.add('tv-refund-list');
    }
    if (c2.masteryChanges.length) {
      treeList(side, 'Mastery effects to change', c2.masteryChanges.map(function (m) { return m.node; }), function (id, i) {
        var m = c2.masteryChanges[i];
        return treeItem(id, I.byId[id].name, (D.masteryEffects[m.from] || '?').split('\n')[0] + ' → ' + (D.masteryEffects[m.to] || '?').split('\n')[0]);
      });
    }
  }

  // what the build takes
  var allocIds = Object.keys(M.alloc).map(Number);
  function byName(a, b) { return I.byId[a].name.localeCompare(I.byId[b].name); }
  treeList(side, 'Keystones', allocIds.filter(function (id) { return I.byId[id].kind === 2; }).sort(byName),
    function (id) { return treeItem(id, I.byId[id].name); }).classList.add('tv-keystones');
  treeList(side, 'Notables', allocIds.filter(function (id) { return I.byId[id].kind === 1 && I.byId[id].asc < 0; }).sort(byName),
    function (id) { return treeItem(id, I.byId[id].name, treeFirstStat(I.byId[id])); }, 12).classList.add('tv-notables');
  var ascN = allocIds.filter(function (id) { return I.byId[id].asc >= 0 && I.byId[id].kind === 1; }).sort(byName);
  if (ascN.length) {
    treeList(side, 'Ascendancy notables', ascN, function (id) {
      return treeItem(id, I.byId[id].name, D.ascendancies[I.byId[id].asc].name);
    });
  }
  treeList(side, 'Jewel sockets', allocIds.filter(function (id) { return I.byId[id].kind === 4; }).sort(function (a, b) {
    return (M.sockets[a] ? 0 : 1) - (M.sockets[b] ? 0 : 1) || a - b;
  }), function (id) {
    var it = M.sockets[id], n = I.byId[id];
    var b = treeItem(id, it ? it.name || it.base : 'Empty', n.name + (it && it.name && it.base ? ' · ' + it.base : ''));
    var rar = String(it && it.rarity || '').toLowerCase();
    if (it) b.firstChild.classList.add('tv-r-' + (rar === 'relic' ? 'unique' : rar || 'normal'));
    return b;
  }).classList.add('tv-sockets');
  treeList(side, 'Masteries', Object.keys(M.mastery).map(Number).filter(function (id) { return I.byId[id]; }).sort(byName),
    function (id) { return treeItem(id, I.byId[id].name, (D.masteryEffects[M.mastery[id]] || '').replace(/\n/g, ' · ')); })
    .classList.add('tv-masteries');
}

function renderTreeLegend() {
  var T = TREEVIEW, box = T.legend;
  box.textContent = '';
  box.appendChild(UI.chip('Allocated', 'accent'));
  if (T.mode === 'compare' && T.cmp) {
    box.lastChild.textContent = 'You have it';
    box.appendChild(UI.chip('Still to take', 'success'));
    box.appendChild(UI.chip('To refund', 'danger'));
  }
  if (T.hits) box.appendChild(UI.chip('Search match', 'info'));
}

function treeCharName() {
  if (typeof charName_ !== 'undefined' && charName_) return charName_;
  var sel = document.getElementById('char-select');
  if (sel && sel.value) return sel.value;
  try {
    var g = JSON.parse(localStorage.getItem('pobtf-chargear'));
    if (g && g.name) return g.name;
  } catch (e) { /* none saved */ }
  return '';
}

async function treeRunCompare(btn) {
  var T = TREEVIEW;
  var acct = ((document.getElementById('acct-input') || {}).value || '').trim();
  var name = treeCharName();
  if (!acct || !name) {
    T.cmpStatus.textContent = 'Pick your account and character under ⚖ Compare with character… first.';
    return;
  }
  if (btn) btn.disabled = true;
  T.cmpStatus.textContent = 'Reading ' + name + '\'s passives…';
  var r;
  if (typeof charPassives_ !== 'undefined' && charPassives_ && charPassives_.name === name) {
    r = charPassives_; // already read by ⚖ Compare with character (gear + tree jewels)
  } else {
    try { r = await window.pywebview.api.get_character_passives(acct, name); } catch (e) { r = { ok: false, error: String(e) }; }
  }
  if (TREEVIEW !== T) return; // another build was loaded meanwhile
  if (btn) btn.disabled = false;
  if (!r || !r.ok) {
    T.cmpMsg = '❌ Couldn\'t read the passives: ' + ((r && r.error) || 'no answer');
    T.cmpStatus.textContent = T.cmpMsg;
    return;
  }
  T.cmp = treeCompare(T.I, T.M, r);
  T.cmp.name = name;
  T.charRaw = r; // kept so switching tree stage compares again without asking the site
  T.cmpMsg = 'Compared with ' + name + '. Rings mark the points you can take now.';
  T.mode = 'compare';
  renderTreeSide();
  renderTreeLegend();
  treeRedraw();
}

// ---- the view ---------------------------------------------------------------------------
function makeTreeView(b) {
  var wrap = UI.el('div', 'finder tv');
  var I = treeIndex();
  if (!I) {
    wrap.appendChild(UI.el('div', 'finder-sub', 'The tree data (data/treeview.js) didn\'t load.'));
    return wrap;
  }
  if (TREEVIEW && TREEVIEW.ro) TREEVIEW.ro.disconnect(); // the previous build's view
  if (TREE_SPRITES && TREE_SPRITES.state === 'failed') TREE_SPRITES = null; // icons: try again
  if (TREE_BG && TREE_BG.state === 'failed') TREE_BG = null;                 // and the backdrop
  var T = TREEVIEW = { b: b, I: I, M: treeModel(b, I), cmp: null, mode: 'build', q: '', hits: null, hitList: [],
                       hitCount: 0, hover: null, flash: null, insetAsc: -1, shown: false };

  var bar = UI.el('div', 'tv-bar');
  // PoB's tree stages (several specs, e.g. Level 30 / 60 / Endgame): pick one to see that tree
  var specs = b.treeSpecs || [];
  if (specs.length > 1) {
    var stageNo = b.treeStage !== undefined ? b.treeStage : (b.treeActive || 0);
    var stageSel = UI.select(specs.map(function (s, i) {
      return [String(i), (s.title || 'Tree ' + (i + 1)) + (i === (b.treeActive || 0) ? ' (active in PoB)' : '') +
        ' · ' + s.nodes.length + ' nodes'];
    }), String(stageNo), { ariaLabel: 'Tree stage', onChange: function () {
      var i = parseInt(this.value, 10);
      var root = b.treeRoot || b;
      var nb = Object.assign({}, root, { tree: specs[i], treeStage: i, treeRoot: root });
      var keep = T.charRaw, keepQ = q.value;
      var next = makeTreeView(nb);
      wrap.parentNode.replaceChild(next, wrap);
      var T2 = TREEVIEW;
      if (keep) { // compare the new stage with the character already read
        T2.cmp = treeCompare(T2.I, T2.M, keep);
        T2.cmp.name = T.cmp && T.cmp.name;
        T2.charRaw = keep;
        T2.cmpMsg = T.cmpMsg;
        T2.mode = 'compare';
        renderTreeSide();
      }
      if (keepQ) { next.querySelector('.tv-search').value = keepQ; treeSearch(keepQ); }
      renderTreeLegend();
      showTreeView();
    } });
    stageSel.classList.add('tv-stage-select');
    stageSel.title = 'Your PoB build has ' + specs.length + ' trees (stages). Pick one to see it, and to compare it with your character.';
    bar.appendChild(stageSel);
  }
  var q = UI.input({ type: 'search', placeholder: 'Search nodes (name or stat)', width: '240px', ariaLabel: 'Search the tree' });
  q.classList.add('tv-search');
  q.addEventListener('input', function () { treeSearch(q.value); renderTreeLegend(); });
  q.addEventListener('keydown', function (e) { // Enter: jump to the next match
    if (e.key !== 'Enter' || !T.hitList.length) return;
    e.preventDefault();
    T.hitPos = (T.hitPos + 1) % T.hitList.length;
    treeFocusNode(T.hitList[T.hitPos]);
  });
  bar.appendChild(q);
  T.countEl = UI.el('span', 'finder-sub tv-count');
  T.countEl.setAttribute('aria-live', 'polite');
  bar.appendChild(T.countEl);
  var zoom = UI.el('div', 'tv-zoom');
  zoom.appendChild(UI.iconButton('−', 'Zoom out', { size: 'sm', onClick: function () { treeZoomAt(T.main, T.main.w / 2, T.main.h / 2, 0.8); treeDraw(T.main); } }));
  zoom.appendChild(UI.iconButton('+', 'Zoom in', { size: 'sm', onClick: function () { treeZoomAt(T.main, T.main.w / 2, T.main.h / 2, 1.25); treeDraw(T.main); } }));
  zoom.appendChild(UI.button('ghost', { size: 'sm', label: 'Fit', title: 'Show the whole tree', onClick: function () { treeFit(T.main); treeDraw(T.main); } }));
  bar.appendChild(zoom);
  T.legend = UI.el('div', 'tv-legend');
  bar.appendChild(T.legend);
  wrap.appendChild(bar);

  var main = UI.el('div', 'tv-main');
  var stage = UI.el('div', 'tv-stage');
  T.stage = stage;
  var canvas = UI.el('canvas', 'tv-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Passive tree. Drag to move, wheel or + and − to zoom, arrow keys to pan, 0 to fit.');
  stage.appendChild(canvas);
  var mainNodes = I.D.nodes.filter(function (r) {
    var n = I.byId[r[0]];
    return n.asc < 0 && (!(n.flags & 1) || T.M.alloc[n.id]); // cluster sockets only where used
  }).map(function (r) { return I.byId[r[0]]; });
  T.main = treeCanvas(canvas, mainNodes, I.D.bounds, {});
  treeWire(T.main);

  if (T.M.insets.length) {
    var inset = UI.el('div', 'tv-inset');
    var head = UI.el('div', 'tv-inset-head');
    T.insetTitle = UI.el('span', 'tv-inset-title');
    head.appendChild(T.insetTitle);
    if (T.M.insets.length > 1) { // the build's ascendancy + a bloodline: pick which one to show
      T.insetTitle.hidden = true;
      head.appendChild(UI.select(T.M.insets.map(function (k) { return [String(k), I.D.ascendancies[k].name]; }),
        String(T.M.insets[0]), { ariaLabel: 'Ascendancy shown', onChange: function () { treeSetInset(parseInt(this.value, 10)); } }));
    }
    var fold = UI.iconButton('▾', 'Hide the ascendancy', { size: 'sm', cls: 'tv-inset-fold', onClick: function () {
      var folded = inset.classList.toggle('folded');
      fold.textContent = folded ? '▸' : '▾';
      fold.setAttribute('aria-label', folded ? 'Show the ascendancy' : 'Hide the ascendancy');
      fold.title = fold.getAttribute('aria-label');
      if (!folded && treeResize(T.inset)) treeDraw(T.inset);
    } });
    head.appendChild(fold);
    inset.appendChild(head);
    T.insetEl = UI.el('canvas', 'tv-inset-canvas');
    T.insetEl.setAttribute('role', 'img');
    T.insetEl.setAttribute('aria-label', 'Ascendancy tree');
    inset.appendChild(T.insetEl);
    stage.appendChild(inset);
    T.inset = treeCanvas(T.insetEl, [], [0, 0, 1, 1], { inset: true });
    treeWire(T.inset);
    treeSetInset(T.M.insets[0]);
  }
  T.tip = UI.el('div', 'tv-tip');
  T.tip.hidden = true;
  T.tip.setAttribute('role', 'tooltip');
  stage.appendChild(T.tip);
  main.appendChild(stage);
  T.side = UI.el('div', 'tv-side');
  main.appendChild(T.side);
  wrap.appendChild(main);
  renderTreeSide();
  renderTreeLegend();
  if (window.ResizeObserver) {
    T.ro = new ResizeObserver(function () {
      if (TREEVIEW !== T) return;
      if (treeResize(T.main)) treeDraw(T.main);
      if (T.inset && treeResize(T.inset)) treeDraw(T.inset);
    });
    T.ro.observe(stage);
  }
  return wrap;
}

// setView('tree'): the canvas has no size while its view is hidden, so size and draw now
function showTreeView() {
  var T = TREEVIEW;
  if (!T) return;
  if (!T.cmp && T.charShown !== treeCharName()) renderTreeSide(); // a character was picked meanwhile
  function draw() {
    if (TREEVIEW !== T) return true;
    if (T.inset && treeResize(T.inset)) treeDraw(T.inset);
    if (!treeResize(T.main)) return false;
    treeDraw(T.main);
    return true;
  }
  if (!draw()) requestAnimationFrame(draw); // layout not settled yet
}

document.addEventListener('DOMContentLoaded', function () {
  // themes and accents change the tokens the canvas reads: redraw
  new MutationObserver(function () { if (document.body.dataset.view === 'tree') treeRedraw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-surface', 'data-contrast'] });
});
