/* js/app/28-atlas.js — Atlas tree: import someone's Atlas passive tree (the official
   pathofexile.com link, a PoB code that carries one in its notes, or a list of node names / ids),
   draw it, and keep it as a named strategy you can open again or link to a saved build.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Layout comes precomputed in data/atlasview.js (tools/make_atlasview.py, GGG's Atlas export).
// Node kinds: 0 small, 1 notable, 2 keystone, 3 mastery (a league area's round icon, never
// allocated), 4 gateway (wormhole), 5 start. Drawing reuses 23-tree.js's pure canvas helpers
// (treeColors, treeShape, treeResize, treeFit, treeZoomAt, treeList); the rest is the Atlas's own.
var ATLAS_KEY = 'pobtf-atlas';      // saved strategies: [{ id, name, url, nodes, notes, updated }]
var ATLAS_URL_BASE = 'https://www.pathofexile.com/fullscreen-atlas-skill-tree/';
var ATLAS_KIND_LABEL = ['Passive', 'Notable', 'Keystone', 'League area', 'Gateway', 'Start'];
var ATLAS_R = [27, 38, 54, 70, 44, 60];          // node radius in tree units
var ATLAS_MIN_PX = [1.6, 2.6, 3.6, 3, 3.2, 4];   // and never smaller than this on screen
var ATLAS_ICON_MIN_PX = 7;
var ATLAS_IDX = null;     // index over POE_ATLAS_VIEW, built once
var ATLAS = null;         // the view's state (built on first open)
var ATLAS_SPRITES = null; // { state, active, inactive, mastery }
var atlasViewBack = null;

// ---- data -----------------------------------------------------------------------------
function atlasIndex() {
  if (ATLAS_IDX || !window.POE_ATLAS_VIEW) return ATLAS_IDX;
  var D = window.POE_ATLAS_VIEW, byId = {}, byName = {}, lines = [], arcs = [], i;
  var at = D.icons ? D.icons.at : [], mat = D.icons && D.icons.mastery ? D.icons.mastery.at : {};
  D.nodes.forEach(function (r, k) {
    var n = byId[r[0]] = { id: r[0], x: r[1], y: r[2], kind: r[3], name: r[4], stats: r[5] || '', granted: r[6] || 0,
                           icon: at[2 * k] >= 0 ? [at[2 * k], at[2 * k + 1]] : null, micon: mat[r[0]] || null };
    if (atlasCounts(n) && n.name) (byName[n.name.toLowerCase()] = byName[n.name.toLowerCase()] || []).push(n.id);
  });
  for (i = 0; i < D.edges.length; i += 2) {
    if (byId[D.edges[i]] && byId[D.edges[i + 1]]) lines.push({ a: byId[D.edges[i]], b: byId[D.edges[i + 1]] });
  }
  for (i = 0; i < D.arcs.length; i += 5) { // the short way round, as the game draws it
    var p = byId[D.arcs[i]], q = byId[D.arcs[i + 1]];
    if (!p || !q) continue;
    var cx = D.arcs[i + 2], cy = D.arcs[i + 3];
    var t1 = Math.atan2(p.y - cy, p.x - cx), d = Math.atan2(q.y - cy, q.x - cx) - t1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    arcs.push({ a: p, b: q, cx: cx, cy: cy, r: D.arcs[i + 4], t1: t1, d: d });
  }
  ATLAS_IDX = { D: D, byId: byId, byName: byName, lines: lines, arcs: arcs,
                nodes: D.nodes.map(function (r) { return byId[r[0]]; }) };
  return ATLAS_IDX;
}

// nodes that take a point (masteries are decoration, the start is free)
function atlasCounts(n) { return !!n && n.kind !== 3 && n.kind !== 5; }

// what a node list allocates: points used / available, ids the data doesn't know
function atlasModel(ids) {
  var I = atlasIndex(), alloc = {}, missing = [], points = 0, granted = 0;
  (ids || []).forEach(function (id) {
    var n = I && I.byId[id];
    if (!n) { missing.push(id); return; }
    if (alloc[id]) return;
    alloc[id] = true;
    if (atlasCounts(n)) points++;
    granted += n.granted;
  });
  var base = I && I.D.totalPoints || 0;
  return { alloc: alloc, missing: missing, points: points, total: base ? base + granted : 0, granted: granted };
}

// ---- links and codes -------------------------------------------------------------------
// GGG's tree link: base64url of [version u32 BE][class u8][ascendancy u8], then for version 5+
// [node count u8][node ids u16 BE][cluster count u8 + ids][mastery count u8 + pairs]; version 4
// has a fullscreen byte and then node ids to the end. The Atlas uses class 0, ascendancy 0.
function atlasB64Bytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!s || !/^[A-Za-z0-9+\/]+$/.test(s) || s.length % 4 === 1) return null;
  while (s.length % 4) s += '=';
  var bin;
  try { bin = atob(s); } catch (e) { return null; }
  var b = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

// a code (the part after the last /) → { version, nodes } or an Error explaining why not
function atlasDecodeCode(code) {
  var b = atlasB64Bytes(code);
  if (!b || b.length < 7) return new Error('That link\'s code doesn\'t decode (it may be cut short: copy the whole link).');
  var ver = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  if (ver < 4 || ver > 6) return new Error('Unknown tree link version ' + ver + ' (the app reads versions 4 to 6).');
  if (b[4] !== 0 || b[5] !== 0) return new Error('That\'s a character passive tree code, not an Atlas tree.');
  var ids = [], i;
  if (ver === 4) {
    for (i = 7; i + 1 < b.length; i += 2) ids.push((b[i] << 8) | b[i + 1]);
  } else {
    var n = b[6];
    if (b.length < 7 + 2 * n) return new Error('That link\'s code is cut short (' + n + ' nodes promised). Copy the whole link.');
    for (i = 0; i < n; i++) ids.push((b[7 + 2 * i] << 8) | b[8 + 2 * i]);
  }
  var seen = {};
  ids = ids.filter(function (id) { if (!id || seen[id]) return false; seen[id] = true; return true; });
  return { version: ver, nodes: ids.sort(function (x, y) { return x - y; }) };
}

// node ids → the official link (version 6, as the site writes it)
function atlasEncodeUrl(ids) {
  var seen = {}, list = (ids || []).filter(function (id) {
    if (!(id > 0 && id < 65536) || seen[id]) return false;
    seen[id] = true;
    return true;
  }).sort(function (a, b) { return a - b; }).slice(0, 255);
  var bytes = [0, 0, 0, 6, 0, 0, list.length];
  list.forEach(function (id) { bytes.push((id >> 8) & 255, id & 255); });
  bytes.push(0, 0); // no cluster nodes, no mastery effects
  return ATLAS_URL_BASE + btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

var ATLAS_LINK_RE = /(?:https?:\/\/)?(?:www\.)?pathofexile\.com\/(?:fullscreen-)?atlas-skill-tree\/([^\s"'<>]+)/gi;

// every official Atlas link in a text → [{ url (normalised to the fullscreen page), code }]
function atlasFindLinks(text) {
  var out = [], m;
  ATLAS_LINK_RE.lastIndex = 0;
  while ((m = ATLAS_LINK_RE.exec(text))) {
    var path = m[1].split(/[?#]/)[0].replace(/&amp;/g, '&');
    try { path = decodeURIComponent(path); } catch (e) { /* keep as is */ }
    // the last path part (some links carry a version folder first); drop trailing ")" / "." etc.
    var code = (path.split('/').filter(Boolean).pop() || '').replace(/[^A-Za-z0-9_\-=].*$/, '');
    if (code) out.push({ url: ATLAS_URL_BASE + code, code: code });
  }
  return out;
}

// a list of node names or ids (one per line, or comma separated) → ids, or an Error
function atlasParseNames(text) {
  var I = atlasIndex();
  var toks = String(text).split(/[\n\r,;]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  var ids = [], unknown = [], ambiguous = [];
  toks.forEach(function (t) {
    if (/^\d+$/.test(t)) {
      if (atlasCounts(I.byId[+t])) ids.push(+t); else unknown.push(t);
      return;
    }
    var hit = I.byName[t.toLowerCase()] || [];
    if (hit.length === 1) ids.push(hit[0]);
    else if (hit.length > 1) ambiguous.push(t + ' (' + hit.length + ' nodes)');
    else unknown.push(t);
  });
  if (!ids.length) return null; // not a name list at all
  if (unknown.length || ambiguous.length) {
    return new Error((unknown.length ? 'Not Atlas nodes: ' + unknown.slice(0, 5).join(', ') + (unknown.length > 5 ? '…' : '') + '. ' : '') +
      (ambiguous.length ? 'Several nodes share these names, use their ids instead: ' + ambiguous.slice(0, 5).join(', ') + '. ' : '') +
      'Nothing was imported.');
  }
  return { nodes: ids, source: 'names' };
}

// a pasted text → Promise of { nodes, url, source, links } (links: every Atlas link found), or a
// rejected Error saying what the text is and why it can't be read. Never guesses.
async function atlasParseInput(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Paste an Atlas tree link first.');
  if (!atlasIndex()) throw new Error('The Atlas data (data/atlasview.js) didn\'t load.');
  var links = atlasFindLinks(text);
  if (links.length) return atlasFromLinks(links, 'link');
  if (/pathofexile\.com\/(?:fullscreen-)?passive-skill-tree\//i.test(text)) {
    throw new Error('That\'s a character passive tree link, not an Atlas tree. Atlas links contain "atlas-skill-tree".');
  }
  if (/poeplanner\.com/i.test(text)) {
    throw new Error('poeplanner links can\'t be read offline. Paste the official pathofexile.com Atlas link instead, ' +
      'or the node names (one per line).');
  }
  if (/^https?:\/\//i.test(text) && /pobb\.in|pastebin\.com/i.test(text)) { // a PoB build link: its notes may carry one
    if (!isGui() || !window.pywebview.api.fetch_pob_link) throw new Error('PoB build links are read in the desktop app. Paste the PoB code instead.');
    var res = await window.pywebview.api.fetch_pob_link(text);
    if (!res || !res.ok) throw new Error('Couldn\'t fetch that build (' + ((res && res.error) || 'no answer') + ').');
    return atlasFromPob(res.code);
  }
  if (/^https?:\/\//i.test(text)) {
    throw new Error('That link isn\'t an Atlas tree. The app reads pathofexile.com Atlas links, PoB codes or links whose notes carry one, and node names.');
  }
  if (/^[A-Za-z0-9_\-+\/=]+$/.test(text)) { // one code: an Atlas tree code, or a PoB export code
    var dec = atlasDecodeCode(text);
    if (!(dec instanceof Error)) return { nodes: dec.nodes, url: ATLAS_URL_BASE + text, source: 'code', links: [] };
    var b = atlasB64Bytes(text);
    if (b && b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0) throw dec; // a tree code, but not a readable Atlas one
    if (text.length > 100) return atlasFromPob(text);
  }
  var names = atlasParseNames(text);
  if (names instanceof Error) throw names;
  if (names) return { nodes: names.nodes, url: atlasEncodeUrl(names.nodes), source: 'names', links: [] };
  throw new Error('That isn\'t an Atlas tree. Paste the pathofexile.com Atlas link (".../atlas-skill-tree/..."), ' +
    'a PoB code whose notes carry one, or node names / ids, one per line.');
}

function atlasFromLinks(links, source) {
  var first = atlasDecodeCode(links[0].code);
  if (first instanceof Error) throw first;
  return { nodes: first.nodes, url: links[0].url, source: source, links: links };
}

async function atlasFromPob(code) {
  var xml;
  try { xml = await PoB.decodePobCode(code); } catch (e) { xml = ''; }
  if (!xml || xml.indexOf('<PathOfBuilding') === -1) {
    throw new Error('That isn\'t an Atlas tree code or a PoB build code.');
  }
  var links = atlasFindLinks(xml);
  if (!links.length) {
    throw new Error('That PoB build has no Atlas tree in it. Path of Building has no Atlas tree of its own; ' +
      'a build carries one only when its author pasted the pathofexile.com Atlas link into the notes.');
  }
  return atlasFromLinks(links, 'pob');
}

// ---- saved strategies --------------------------------------------------------------------
function atlasLoad() {
  try {
    var v = JSON.parse(localStorage.getItem(ATLAS_KEY));
    return Array.isArray(v) ? v.filter(function (s) { return s && s.id && Array.isArray(s.nodes); }) : [];
  } catch (e) { return []; }
}
function atlasStore(list) { persist(ATLAS_KEY, JSON.stringify(list)); }
function atlasGet(id) { return atlasLoad().filter(function (s) { return s.id === id; })[0] || null; }
function atlasNewId() { return 'at' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// for the build library (04-library.js): every strategy, a name, open one
function atlasList() {
  return atlasLoad().map(function (s) { return { id: s.id, name: s.name, points: atlasModel(s.nodes).points }; });
}
function atlasName(id) { var s = id && atlasGet(id); return s ? s.name : null; }
function atlasOpen(id) {
  var s = atlasGet(id);
  if (!s) return false;
  openAtlasView();
  atlasShow({ nodes: s.nodes, url: s.url, source: 'saved', links: [] }, s);
  return true;
}

// saved builds that point at a strategy (04-library.js entries carry atlas: id)
function atlasUsedBy(id) {
  var lib = typeof loadBuildLib === 'function' ? loadBuildLib() : [];
  return lib.filter(function (b) { return b && b.atlas === id; }).map(function (b) { return String(b.name || 'Build'); });
}

// ---- drawing ---------------------------------------------------------------------------
function atlasRadius(n, s) { return Math.max(ATLAS_MIN_PX[n.kind], ATLAS_R[n.kind] * s); }

function atlasSprites() {
  if (ATLAS_SPRITES) return ATLAS_SPRITES.state === 'ready' ? ATLAS_SPRITES : null;
  var I = atlasIndex(), ic = I && I.D.icons, api = isGui() && window.pywebview.api;
  if (!ic || !api || !api.cache_art) { ATLAS_SPRITES = { state: 'failed' }; return null; }
  var S = ATLAS_SPRITES = { state: 'loading' };
  var urls = [ic.active, ic.inactive].concat(ic.mastery ? [ic.mastery.sheet] : []);
  function cached() { return urls.every(function (u) { return ART[u]; }); }
  (cached() ? Promise.resolve() : api.cache_art(JSON.stringify(urls)).then(function (r) {
    if (r && r.ok) Object.keys(r.art || {}).forEach(function (u) { ART[u] = r.art[u]; });
  })).then(function () {
    if (!cached()) throw new Error('atlas icon sheets not cached');
    return Promise.all(urls.map(function (u) {
      return new Promise(function (ok, fail) {
        var img = new Image();
        img.onload = function () { ok(img); };
        img.onerror = fail;
        img.src = ART[u];
      });
    }));
  }).then(function (imgs) {
    S.active = atlasCutIcons(I, imgs[0]);
    S.inactive = atlasCutIcons(I, imgs[1]);
    S.mastery = imgs[2] || null; // transparent PNG: drawn as is
    S.state = 'ready';
    atlasRedraw();
  }).catch(function () { S.state = 'failed'; });
  return null;
}

// each icon cut to its node's shape once, so a frame only copies sub-rects
function atlasCutIcons(I, img) {
  var ic = I.D.icons, c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  var g = c.getContext('2d');
  g.beginPath();
  I.nodes.forEach(function (n) {
    var sz = ic.size[n.kind];
    if (!n.icon || !sz) return;
    treeShape(g, n.kind === 2 ? 2 : 0, n.icon[0] + sz[0] / 2, n.icon[1] + sz[1] / 2, Math.min(sz[0], sz[1]) / 2);
  });
  g.fill();
  g.globalCompositeOperation = 'source-in';
  g.drawImage(img, 0, 0);
  return c;
}

function atlasDraw() {
  var A = ATLAS, cv = A && A.main;
  if (!cv || !cv.w) return;
  var C = treeColors(), ctx = cv.ctx, s = cv.s, w = cv.w, h = cv.h, I = A.I;
  var ox = w / 2 - cv.cx * s, oy = h / 2 - cv.cy * s;
  var alloc = A.M.alloc;
  ctx.setTransform(cv.dpr, 0, 0, cv.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  // links: dim ones, then the allocated path on top
  [false, true].forEach(function (on) {
    ctx.beginPath();
    var any = false;
    I.lines.concat(I.arcs).forEach(function (e) {
      if (!!(alloc[e.a.id] && alloc[e.b.id]) !== on) return;
      any = true;
      ctx.moveTo(e.a.x * s + ox, e.a.y * s + oy);
      if (e.r) ctx.arc(e.cx * s + ox, e.cy * s + oy, e.r * s, e.t1, e.t1 + e.d, e.d < 0);
      else ctx.lineTo(e.b.x * s + ox, e.b.y * s + oy);
    });
    if (!any) return;
    ctx.globalAlpha = on ? 1 : 0.8;
    ctx.strokeStyle = on ? C.alloc : C.line;
    ctx.lineWidth = on ? Math.max(2, 12 * s) : Math.max(1, 6 * s);
    ctx.stroke();
  });

  var onScreen = [];
  var sprites = ATLAS_R[2] * s >= ATLAS_ICON_MIN_PX ? atlasSprites() : null;
  var ic = I.D.icons;
  cv.iconsDrawn = 0;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // league areas (masteries) first: they sit under their cluster
  I.nodes.forEach(function (n) {
    var x = n.x * s + ox, y = n.y * s + oy, r = atlasRadius(n, s);
    if (x < -r - 60 || y < -r - 60 || x > w + r + 60 || y > h + r + 60) return;
    onScreen.push(n);
    if (n.kind !== 3) return;
    if (sprites && sprites.mastery && n.micon && r >= ATLAS_ICON_MIN_PX) {
      var ms = ic.mastery.size;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(sprites.mastery, n.micon[0], n.micon[1], ms[0], ms[1], x - r, y - r, 2 * r, 2 * r);
      cv.iconsDrawn++;
      return;
    }
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.strokeStyle = C.dim;
    ctx.stroke();
  });
  onScreen.forEach(function (n) {
    if (n.kind === 3) return;
    var x = n.x * s + ox, y = n.y * s + oy, r = atlasRadius(n, s), on = !!alloc[n.id];
    var col = on ? C.alloc : C.dim, sz = ic && ic.size[n.kind];
    if (sprites && n.icon && sz && r >= ATLAS_ICON_MIN_PX) {
      ctx.globalAlpha = on ? 1 : 0.8;
      ctx.drawImage(on ? sprites.active : sprites.inactive, n.icon[0], n.icon[1], sz[0], sz[1], x - r, y - r, 2 * r, 2 * r);
      cv.iconsDrawn++;
      ctx.globalAlpha = on ? 1 : 0.7;
      ctx.beginPath();
      treeShape(ctx, n.kind === 2 ? 2 : 0, x, y, r);
      ctx.lineWidth = Math.max(1.5, r * (n.kind === 0 ? 0.13 : 0.16));
      ctx.strokeStyle = col;
      ctx.stroke();
      return;
    }
    ctx.globalAlpha = on ? 1 : n.kind === 0 ? 0.5 : 0.85;
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.beginPath();
    treeShape(ctx, n.kind === 2 ? 2 : 0, x, y, r);
    if (n.kind === 4 || n.kind === 5) { // gateways and the start: rings
      ctx.lineWidth = Math.max(1.5, r * 0.25);
      ctx.stroke();
    } else {
      ctx.fill();
      if (n.kind !== 0 && r > 4) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.45, 0, 2 * Math.PI);
        ctx.fillStyle = C.bg;
        ctx.globalAlpha = 0.55;
        ctx.fill();
      }
    }
  });

  // rings: hovered / just-centred node, search hits
  ctx.globalAlpha = 1;
  onScreen.forEach(function (n) {
    var ring = A.flash === n.id ? C.text : A.hover === n ? C.text : A.hits && A.hits[n.id] ? C.hit : null;
    if (!ring) return;
    ctx.beginPath();
    ctx.arc(n.x * s + ox, n.y * s + oy, atlasRadius(n, s) + (A.flash === n.id ? 9 : 4), 0, 2 * Math.PI);
    ctx.lineWidth = A.flash === n.id ? 3 : 2;
    ctx.strokeStyle = ring;
    ctx.stroke();
  });

  // labels (12px), the most important first when they collide
  ctx.font = '600 12px ' + C.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  var nHits = A.hitCount || 0, cands = [];
  onScreen.forEach(function (n) {
    var on = !!alloc[n.id], hit = A.hits && A.hits[n.id] && nHits <= 40, show;
    if (hit) show = true;
    else if (n.kind === 3) show = s >= 0.045 && s < 0.3;
    else if (n.kind === 4) show = s >= 0.08;
    else if (n.kind !== 1 && n.kind !== 2) show = false;
    else show = on ? (n.kind === 2 ? s >= 0.04 : s >= 0.12) : s >= 0.3;
    if (show) cands.push({ n: n, on: on, pri: (A.hover === n ? 100 : 0) + (hit ? 50 : 0) + (n.kind === 2 ? 20 : 0) + (on ? 10 : 0) - (n.kind === 3 ? 5 : 0) });
  });
  cands.sort(function (a, b) { return b.pri - a.pri; });
  var placed = [];
  cands.forEach(function (c) {
    var n = c.n, label = n.name || ATLAS_KIND_LABEL[n.kind];
    var half = ctx.measureText(label).width / 2 + 3;
    var x = Math.max(half, Math.min(w - half, n.x * s + ox)), y = n.y * s + oy;
    var ly = n.kind === 3 ? y - 7 : y + atlasRadius(n, s) + 3;
    var box = [x - half, ly - 1, x + half, ly + 15];
    if (placed.some(function (p) { return box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]; })) return;
    placed.push(box);
    ctx.strokeStyle = C.bg;
    ctx.strokeText(label, x, ly);
    ctx.fillStyle = c.on ? C.text : C.text2;
    ctx.fillText(label, x, ly);
  });
}

function atlasRedraw() { if (ATLAS && ATLAS.main) atlasDraw(); }

function atlasHit(cv, mx, my) {
  var wx = (mx - cv.w / 2) / cv.s + cv.cx, wy = (my - cv.h / 2) / cv.s + cv.cy, best = null, bd = Infinity;
  ATLAS.I.nodes.forEach(function (n) {
    var lim = Math.max(ATLAS_R[n.kind] * (n.kind === 3 ? 0.8 : 1.15), 7 / cv.s);
    var d = (n.x - wx) * (n.x - wx) + (n.y - wy) * (n.y - wy);
    if (d < lim * lim && d < bd) { bd = d; best = n; }
  });
  return best;
}

function atlasTip(n, mx, my) {
  var A = ATLAS, tip = A.tip;
  if (!n) { tip.hidden = true; return; }
  tip.textContent = '';
  tip.appendChild(UI.el('div', 'tv-tip-name', n.name || ATLAS_KIND_LABEL[n.kind]));
  var meta = UI.el('div', 'tv-tip-meta', ATLAS_KIND_LABEL[n.kind] + ' · ' + n.id);
  if (A.M.alloc[n.id] && atlasCounts(n)) meta.appendChild(UI.chip('Allocated', 'accent'));
  tip.appendChild(meta);
  String(n.stats || '').split('\n').forEach(function (l) { if (l) tip.appendChild(UI.el('div', 'tv-tip-stat', l)); });
  if (n.kind === 3) tip.appendChild(UI.el('div', 'tv-tip-opt', 'The league mechanic this part of the Atlas is about.'));
  if (n.kind === 4) tip.appendChild(UI.el('div', 'tv-tip-opt', 'A gateway: linked to the gateway of the same name on the other side of the Atlas.'));
  tip.hidden = false;
  var stage = A.stage, sw = stage.clientWidth, sh = stage.clientHeight;
  var px = mx + 16, py = my + 16, tw = tip.offsetWidth, th = tip.offsetHeight;
  if (px + tw > sw - 4) px = Math.max(4, px - tw - 32);
  if (py + th > sh - 4) py = Math.max(4, sh - th - 4);
  tip.style.left = px + 'px';
  tip.style.top = py + 'px';
}

function atlasWire(cv) {
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
    var A = ATLAS, p = pos(e);
    if (down && down.id === e.pointerId) {
      if (!down.moved && Math.abs(p[0] - down.x) + Math.abs(p[1] - down.y) > 4) {
        down.moved = true;
        try { el.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
        el.classList.add('dragging');
      }
      if (down.moved) {
        cv.cx = down.cx - (p[0] - down.x) / cv.s;
        cv.cy = down.cy - (p[1] - down.y) / cv.s;
        atlasTip(null);
        atlasDraw();
        return;
      }
    }
    var n = atlasHit(cv, p[0], p[1]);
    if (A.hover !== n) { A.hover = n; atlasDraw(); }
    atlasTip(n, p[0], p[1]);
  });
  function up(e) {
    if (!down || down.id !== e.pointerId) return;
    down = null;
    el.classList.remove('dragging');
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', function () { down = null; el.classList.remove('dragging'); });
  el.addEventListener('pointerleave', function () {
    if (ATLAS.hover) { ATLAS.hover = null; atlasDraw(); }
    atlasTip(null);
  });
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = pos(e);
    treeZoomAt(cv, p[0], p[1], Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    atlasTip(null);
    atlasDraw();
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
    if (handled) { e.preventDefault(); atlasDraw(); }
  });
}

var atlasFlashTimer = null;
function atlasFocusNode(id) {
  var A = ATLAS, n = A && A.I.byId[id];
  if (!n) return;
  A.main.cx = n.x;
  A.main.cy = n.y;
  A.main.s = Math.max(A.main.s, 0.3);
  A.flash = id;
  atlasDraw();
  clearTimeout(atlasFlashTimer);
  atlasFlashTimer = setTimeout(function () { if (ATLAS === A) { A.flash = null; atlasDraw(); } }, 1600);
}

function atlasSearch(q) {
  var A = ATLAS, I = A.I;
  A.hits = null;
  A.hitList = [];
  A.hitPos = -1;
  q = String(q || '').trim().toLowerCase();
  if (q.length >= 2) {
    A.hits = {};
    I.nodes.forEach(function (n) {
      if ((n.name + '\n' + n.stats).toLowerCase().indexOf(q) === -1) return;
      A.hits[n.id] = true;
      A.hitList.push(n.id);
    });
    A.hitList.sort(function (a, b) {
      return (A.M.alloc[b] ? 1 : 0) - (A.M.alloc[a] ? 1 : 0) || I.byId[a].name.localeCompare(I.byId[b].name);
    });
  }
  A.hitCount = A.hitList.length;
  var on = A.hitList.filter(function (id) { return A.M.alloc[id]; }).length;
  A.countEl.textContent = !A.hits ? '' : A.hitCount ? A.hitCount + ' match' + (A.hitCount > 1 ? 'es' : '') +
    (on ? ' · ' + on + ' allocated' : '') : 'No matches';
  atlasLegend();
  atlasDraw();
}

function atlasLegend() {
  var A = ATLAS;
  A.legend.textContent = '';
  A.legend.appendChild(UI.chip('Allocated', 'accent'));
  if (A.hits) A.legend.appendChild(UI.chip('Search match', 'info'));
}

// ---- side panel ------------------------------------------------------------------------
function atlasItem(id, label, sub) {
  var b = UI.el('button', 'tv-item');
  b.type = 'button';
  b.appendChild(UI.el('span', 'tv-item-name', label));
  if (sub) b.appendChild(UI.el('span', 'tv-item-sub', sub));
  b.addEventListener('click', function () { atlasFocusNode(id); });
  return b;
}

function atlasSetStatus(text, tone) {
  var el = ATLAS && ATLAS.statusEl;
  if (!el) return;
  el.textContent = text || '';
  el.className = 'finder-sub atlas-status' + (tone ? ' atlas-status-' + tone : '');
}

function renderAtlasSide() {
  var A = ATLAS, I = A.I, M = A.M, side = A.side;
  var keepImport = A.importEl ? A.importEl.value : '';
  side.textContent = '';

  // import
  var imp = UI.el('section', 'tv-panel atlas-import');
  imp.appendChild(UI.el('h3', 'tv-h', 'Import an Atlas tree'));
  var ta = A.importEl = UI.el('textarea', 'atlas-input');
  ta.rows = 3;
  ta.value = keepImport;
  ta.placeholder = 'pathofexile.com Atlas link, a PoB code with one in its notes, or node names / ids (one per line)';
  ta.setAttribute('aria-label', 'Atlas tree to import');
  imp.appendChild(ta);
  var irow = UI.el('div', 'tv-row');
  irow.appendChild(UI.button('primary', { size: 'sm', label: 'Import', cls: 'atlas-import-btn', onClick: atlasImportClicked }));
  imp.appendChild(irow);
  A.statusEl = UI.el('div', 'finder-sub atlas-status');
  A.statusEl.setAttribute('role', 'status');
  imp.appendChild(A.statusEl);
  if (A.msg) atlasSetStatus(A.msg[0], A.msg[1]);
  if (A.links && A.links.length > 1) { // a PoB's notes or a paste with several trees: pick one
    var more = UI.el('div', 'tv-row atlas-more');
    more.appendChild(UI.el('span', 'finder-sub', A.links.length + ' Atlas links found:'));
    A.links.forEach(function (l, i) {
      more.appendChild(UI.button(l.url === A.url ? 'secondary' : 'ghost', { size: 'sm', label: 'Tree ' + (i + 1), onClick: function () {
        var dec = atlasDecodeCode(l.code);
        if (dec instanceof Error) { A.msg = [dec.message, 'error']; atlasSetStatus(dec.message, 'error'); return; }
        atlasShow({ nodes: dec.nodes, url: l.url, source: A.source, links: A.links }, null);
      } }));
    });
    imp.appendChild(more);
  }
  side.appendChild(imp);

  // the tree shown
  var saved = A.savedId ? atlasGet(A.savedId) : null;
  var cur = UI.el('section', 'tv-panel atlas-current');
  cur.appendChild(UI.el('h3', 'tv-h atlas-title', saved ? saved.name : A.url ? 'Imported tree (not saved)' : 'No tree yet'));
  var pts = UI.el('div', 'tv-stat');
  pts.appendChild(UI.el('b', 'atlas-points', String(M.points)));
  pts.appendChild(document.createTextNode(M.total ? ' / ' + M.total + ' Atlas points' : ' Atlas points'));
  if (M.granted) pts.title = 'Includes ' + M.granted + ' points granted by allocated nodes';
  cur.appendChild(pts);
  if (M.missing.length) {
    cur.appendChild(UI.el('div', 'finder-sub tv-warn', M.missing.length + ' node' + (M.missing.length > 1 ? 's aren\'t' : ' isn\'t') +
      ' in the app\'s Atlas data (' + I.D.version + ') and ' + (M.missing.length > 1 ? 'aren\'t' : 'isn\'t') + ' drawn: ' +
      'the tree is probably from another league.'));
  }
  if (saved) {
    var used = atlasUsedBy(saved.id);
    var ub = UI.el('div', 'finder-sub atlas-used-by', 'Used by: ' + (used.length ? used.map(function (n) { return n.split(' · ')[0]; }).join(', ') : 'no saved build yet'));
    ub.title = used.length ? used.join('\n') : 'Link this strategy to a saved build in your build library';
    cur.appendChild(ub);
  }
  if (A.url) {
    var nrow = UI.el('div', 'tv-row atlas-name-row');
    var name = A.nameEl = UI.input({ type: 'text', placeholder: 'Strategy name', ariaLabel: 'Strategy name', cls: 'atlas-name',
                                     value: saved ? saved.name : A.draftName || '' });
    name.addEventListener('input', function () { if (!A.savedId) A.draftName = name.value; });
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); atlasSaveClicked(); } });
    nrow.appendChild(name);
    nrow.appendChild(UI.button(saved ? 'secondary' : 'primary', { size: 'sm', label: saved ? 'Rename' : 'Save', cls: 'atlas-save',
      title: saved ? 'Give this strategy the name typed here' : 'Keep this tree under the name typed here', onClick: atlasSaveClicked }));
    cur.appendChild(nrow);
    var arow = UI.el('div', 'tv-row');
    arow.appendChild(UI.button('ghost', { size: 'sm', label: 'Copy link', title: 'The official pathofexile.com link for this tree',
      onClick: function () { atlasCopyLink(); } }));
    if (saved) {
      arow.appendChild(UI.button('ghost', { size: 'sm', label: 'Save as new', title: 'Keep a copy under another name',
        onClick: function () { atlasSaveNew(name.value.trim() && name.value.trim() !== saved.name ? name.value.trim() : saved.name + ' (copy)'); } }));
      arow.appendChild(UI.button('danger', { size: 'sm', label: 'Delete', cls: 'atlas-delete', onClick: atlasDeleteClicked }));
    }
    cur.appendChild(arow);
    var notes = A.notesEl = UI.el('textarea', 'atlas-notes');
    notes.rows = 4;
    notes.placeholder = 'Notes: the strategy, which scarabs, map device craft…';
    notes.setAttribute('aria-label', 'Notes');
    notes.value = saved ? saved.notes || '' : A.draftNotes || '';
    var t = null;
    function keepNotes() {
      clearTimeout(t);
      if (!A.savedId) { A.draftNotes = notes.value; return; }
      atlasUpdate(A.savedId, { notes: notes.value });
    }
    notes.addEventListener('input', function () { clearTimeout(t); if (!A.savedId) { A.draftNotes = notes.value; return; } t = setTimeout(keepNotes, 400); });
    notes.addEventListener('change', keepNotes);
    cur.appendChild(notes);
  }
  side.appendChild(cur);

  // every saved strategy
  var list = atlasLoad().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  var lib = UI.el('section', 'tv-panel atlas-saved');
  lib.appendChild(UI.el('h3', 'tv-h', 'Saved strategies' + (list.length ? ' (' + list.length + ')' : '')));
  var box = UI.el('div', 'tv-list');
  if (!list.length) box.appendChild(UI.el('div', 'finder-sub', 'None yet. Import a tree, name it, Save.'));
  list.forEach(function (s) {
    var b = UI.el('button', 'tv-item atlas-saved-item');
    b.type = 'button';
    b.appendChild(UI.el('span', 'tv-item-name', s.name));
    var users = atlasUsedBy(s.id).length;
    b.appendChild(UI.el('span', 'tv-item-sub', atlasModel(s.nodes).points + ' points' + (users ? ' · ' + users + ' build' + (users > 1 ? 's' : '') : '')));
    if (s.id === A.savedId) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', function () { atlasOpen(s.id); });
    box.appendChild(b);
  });
  lib.appendChild(box);
  side.appendChild(lib);

  // what the tree takes
  var ids = Object.keys(M.alloc).map(Number);
  function byName(a, b) { return I.byId[a].name.localeCompare(I.byId[b].name); }
  if (ids.length) {
    treeList(side, 'Keystones', ids.filter(function (id) { return I.byId[id].kind === 2; }).sort(byName),
      function (id) { return atlasItem(id, I.byId[id].name, String(I.byId[id].stats).split('\n')[0]); }).classList.add('atlas-keystones');
    treeList(side, 'Notables', ids.filter(function (id) { return I.byId[id].kind === 1; }).sort(byName),
      function (id) { return atlasItem(id, I.byId[id].name, String(I.byId[id].stats).split('\n')[0]); }, 12).classList.add('atlas-notables');
  }
}

// ---- actions ---------------------------------------------------------------------------
async function atlasImportClicked() {
  var A = ATLAS, text = A.importEl.value;
  atlasSetStatus('Reading…');
  var r;
  try { r = await atlasParseInput(text); } catch (e) {
    A.msg = ['❌ ' + (e && e.message || String(e)), 'error'];
    atlasSetStatus(A.msg[0], A.msg[1]);
    return;
  }
  A.importEl.value = '';
  atlasShow(r, null);
}

// show a tree: r = { nodes, url, source, links }, saved = the strategy it is (or null: unsaved)
function atlasShow(r, saved) {
  var A = ATLAS || atlasBuildView();
  if (!A) return;
  A.ids = r.nodes.slice();
  A.url = r.url || atlasEncodeUrl(r.nodes);
  A.source = r.source;
  A.links = r.links || [];
  A.savedId = saved ? saved.id : null;
  if (!saved) { A.draftName = ''; A.draftNotes = ''; }
  A.M = atlasModel(A.ids);
  var how = { link: 'the Atlas link', code: 'the tree code', pob: 'the PoB build\'s notes', names: 'the node list', saved: '' }[r.source];
  A.msg = saved ? null : ['Imported ' + A.M.points + ' points from ' + (how || 'the paste') + '.' +
    (A.links.length > 1 ? ' Showing tree ' + (A.links.map(function (l) { return l.url; }).indexOf(A.url) + 1) + ' of ' + A.links.length + '.' : ''), 'ok'];
  renderAtlasSide();
  atlasSearch(A.searchEl.value);
  if (A.main.w) { treeFit(A.main); atlasDraw(); }
}

function atlasUpdate(id, fields) {
  var list = atlasLoad(), s = list.filter(function (x) { return x.id === id; })[0];
  if (!s) return null;
  Object.keys(fields).forEach(function (k) { s[k] = fields[k]; });
  s.updated = Date.now();
  atlasStore(list);
  return s;
}

function atlasSaveNew(name) {
  var A = ATLAS, list = atlasLoad();
  var s = { id: atlasNewId(), name: name || 'Atlas strategy ' + (list.length + 1), url: A.url, nodes: A.ids.slice(),
            notes: A.notesEl ? A.notesEl.value : A.draftNotes || '', updated: Date.now() };
  list.push(s);
  atlasStore(list);
  A.savedId = s.id;
  A.msg = ['Saved as "' + s.name + '".', 'ok'];
  renderAtlasSide();
  return s;
}

function atlasSaveClicked() {
  var A = ATLAS, name = (A.nameEl && A.nameEl.value || '').trim();
  if (!A.savedId) { atlasSaveNew(name); return; }
  if (!name) { A.msg = ['Type a name first.', 'error']; atlasSetStatus(A.msg[0], A.msg[1]); return; }
  atlasUpdate(A.savedId, { name: name });
  A.msg = ['Renamed to "' + name + '".', 'ok'];
  renderAtlasSide();
}

async function atlasDeleteClicked() {
  var A = ATLAS, s = A.savedId && atlasGet(A.savedId);
  if (!s) return;
  var used = atlasUsedBy(s.id);
  var sure = await UI.confirmDanger('Delete "' + s.name + '"?', 'The Atlas strategy is removed from your saved ones' +
    (used.length ? '. ' + used.length + ' saved build' + (used.length > 1 ? 's link' : ' links') + ' to it: they keep their gear, only the link goes.' : '.'),
    'Delete');
  if (!sure || ATLAS !== A) return;
  atlasStore(atlasLoad().filter(function (x) { return x.id !== s.id; }));
  A.savedId = null;
  A.draftName = s.name;
  A.draftNotes = s.notes || '';
  A.msg = ['Deleted "' + s.name + '". The tree stays on screen until you open another; Save keeps it again.', 'ok'];
  renderAtlasSide();
}

function atlasCopyLink() {
  var A = ATLAS, url = A.url && /atlas-skill-tree\//.test(A.url) ? A.url : atlasEncodeUrl(A.ids);
  var done = function () { A.msg = ['Link copied.', 'ok']; atlasSetStatus(A.msg[0], A.msg[1]); };
  try { navigator.clipboard.writeText(url).then(done, function () { atlasSetStatus(url); }); } catch (e) { atlasSetStatus(url); }
}

// ---- the view ---------------------------------------------------------------------------
function atlasBuildView() {
  var view = document.getElementById('view-atlas');
  if (!view) return null;
  view.textContent = '';
  var I = atlasIndex();
  if (!I) {
    view.appendChild(UI.el('p', 'finder-sub', 'The Atlas data (data/atlasview.js) didn\'t load.'));
    return null;
  }
  var A = ATLAS = { I: I, ids: [], url: '', source: '', links: [], savedId: null, M: atlasModel([]), hits: null,
                    hitList: [], hitPos: -1, hitCount: 0, hover: null, flash: null, msg: null, draftName: '', draftNotes: '' };
  var page = UI.el('div', 'finder tv atlas-page');
  var head = UI.el('div', 'trades-bar');
  head.appendChild(UI.button('ghost', { size: 'sm', label: '← Back', onClick: atlasClose, title: 'Back to where you were (Esc)' }));
  head.appendChild(UI.el('span', 'ov-title', 'Atlas tree'));
  head.appendChild(UI.el('span', 'finder-sub', 'Atlas data ' + I.D.version));
  page.appendChild(head);

  var bar = UI.el('div', 'tv-bar');
  var q = A.searchEl = UI.input({ type: 'search', placeholder: 'Search nodes (name or stat)', width: '240px', ariaLabel: 'Search the Atlas tree' });
  q.classList.add('atlas-search');
  q.addEventListener('input', function () { atlasSearch(q.value); });
  q.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !A.hitList.length) return;
    e.preventDefault();
    A.hitPos = (A.hitPos + 1) % A.hitList.length;
    atlasFocusNode(A.hitList[A.hitPos]);
  });
  bar.appendChild(q);
  A.countEl = UI.el('span', 'finder-sub tv-count');
  A.countEl.setAttribute('aria-live', 'polite');
  bar.appendChild(A.countEl);
  var zoom = UI.el('div', 'tv-zoom');
  zoom.appendChild(UI.iconButton('−', 'Zoom out', { size: 'sm', onClick: function () { treeZoomAt(A.main, A.main.w / 2, A.main.h / 2, 0.8); atlasDraw(); } }));
  zoom.appendChild(UI.iconButton('+', 'Zoom in', { size: 'sm', onClick: function () { treeZoomAt(A.main, A.main.w / 2, A.main.h / 2, 1.25); atlasDraw(); } }));
  zoom.appendChild(UI.button('ghost', { size: 'sm', label: 'Fit', title: 'Show the whole Atlas', onClick: function () { treeFit(A.main); atlasDraw(); } }));
  bar.appendChild(zoom);
  A.legend = UI.el('div', 'tv-legend');
  bar.appendChild(A.legend);
  page.appendChild(bar);

  var main = UI.el('div', 'tv-main');
  var stage = A.stage = UI.el('div', 'tv-stage atlas-stage');
  var canvas = UI.el('canvas', 'tv-canvas atlas-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Atlas passive tree. Drag to move, wheel or + and − to zoom, arrow keys to pan, 0 to fit.');
  stage.appendChild(canvas);
  A.main = { el: canvas, ctx: canvas.getContext('2d'), opts: {}, bounds: I.D.bounds, w: 0, h: 0, dpr: 1,
             s: 0.05, cx: 0, cy: 0, fitted: false, minS: 0.01 };
  atlasWire(A.main);
  A.tip = UI.el('div', 'tv-tip');
  A.tip.hidden = true;
  A.tip.setAttribute('role', 'tooltip');
  stage.appendChild(A.tip);
  main.appendChild(stage);
  A.side = UI.el('div', 'tv-side atlas-side');
  main.appendChild(A.side);
  page.appendChild(main);
  page.appendChild(UI.el('p', 'sheet-foot', 'Atlas tree data: Grinding Gear Games\' Atlas tree export (' + I.D.version + '). ' +
    'Links are read in the app; nothing is sent to pathofexile.com.'));
  view.appendChild(page);
  atlasLegend();
  renderAtlasSide();
  if (window.ResizeObserver) {
    new ResizeObserver(function () { if (ATLAS === A && treeResize(A.main)) atlasDraw(); }).observe(stage);
  }
  // the most recently changed strategy, if there is one
  var last = atlasLoad().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); })[0];
  if (last) atlasShow({ nodes: last.nodes, url: last.url, source: 'saved', links: [] }, last);
  return A;
}

function openAtlasView() {
  var cur = document.body.dataset.view;
  if (cur && cur !== 'atlas') atlasViewBack = cur;
  if (cur !== 'atlas') setView('atlas');
  window.scrollTo(0, 0);
}
function atlasClose() { setView(build ? (atlasViewBack || 'gear') : ''); }

// setView('atlas'): build once, then size and draw (a hidden canvas has no size)
function showAtlasView() {
  var A = ATLAS || atlasBuildView();
  if (!A) return;
  if (A.savedId) renderAtlasSide(); // "Used by" may have changed in the build library
  if (A.side && !A.side.childNodes.length) renderAtlasSide();
  function draw() {
    if (ATLAS !== A) return true;
    if (!treeResize(A.main)) return false;
    atlasDraw();
    return true;
  }
  if (!draw()) requestAnimationFrame(draw);
}

document.addEventListener('DOMContentLoaded', function () {
  new MutationObserver(function () { if (document.body.dataset.view === 'atlas') atlasRedraw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-surface', 'data-contrast'] });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (document.body.dataset.view !== 'atlas' || document.body.classList.contains('over-game')) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.value) return; // Esc in a filled field
    atlasClose();
  });
});
// ==== end Atlas tree ==================================================================
