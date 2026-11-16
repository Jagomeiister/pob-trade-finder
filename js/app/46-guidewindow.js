/* js/app/46-guidewindow.js — build guides: a guide link on each saved build (04-library.js: the
   build card and the library's ⋯ dialog) and a short list of guides you're reading (pobtf-guides,
   on the Builds page). "Open guide" shows the real page in the app's guide window (gui.py
   guide_open: a plain browser window, no bridge, allowed sites only; it can stay on top of the
   game). The app never reads the page.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// The allowed sites come from gui.py (GUIDE_HOSTS, through guide_hosts()). This copy is only for
// the browser version (no bridge) and is kept equal to gui.py's by test/test_guide_window.py.
var GUIDE_HOSTS_FALLBACK = ['mobalytics.gg', 'maxroll.gg', 'www.icy-veins.com', 'www.poe-vault.com', 'poe.ninja', 'pobb.in', 'www.pathofexile.com'];
var GUIDE_PATHS_FALLBACK = { 'www.pathofexile.com': '/forum/' };
var GUIDES_KEY = 'pobtf-guides';     // [{ url, title, added }]
var GUIDES_MAX = 50;
var GUIDE_TITLE_MAX = 80;
var guideHostList = null;            // { hosts, paths } once gui.py answered
var guideWin = { open: false, top: null };

async function guideLoadHosts() {
  if (guideHostList) return guideHostList;
  if (isGui() && window.pywebview.api.guide_hosts) {
    try {
      var r = await window.pywebview.api.guide_hosts();
      if (r && r.ok && Array.isArray(r.hosts) && r.hosts.length) {
        guideHostList = { hosts: r.hosts, paths: r.paths || {} };
        return guideHostList;
      }
    } catch (e) { /* the copy below */ }
  }
  return { hosts: GUIDE_HOSTS_FALLBACK, paths: GUIDE_PATHS_FALLBACK };
}
function guideSites(h) {
  return (h || guideHostList || { hosts: GUIDE_HOSTS_FALLBACK }).hosts
    .map(function (x) { return x.replace(/^www\./, ''); }).join(', ');
}

// The same rules as gui.guide_url_check (which decides in the app): https, an allowed host exactly
// (no look-alikes, no user@host, no other port), no spaces, backslashes or dot segments.
function guideCheckUrl(url, h) {
  h = h || guideHostList || { hosts: GUIDE_HOSTS_FALLBACK, paths: GUIDE_PATHS_FALLBACK };
  var nope = { ok: false, error: 'Only https:// links to build-guide sites open here: ' + guideSites(h) + '.' };
  if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'Paste the link of a written build guide.' };
  url = url.trim();
  if (url.length > 2048) return { ok: false, error: 'That link is too long.' };
  if (/[\u0000- \u007f\\]/.test(url)) return { ok: false, error: 'That link has spaces or characters a web address can\'t have.' };
  var m = /^([a-z][a-z0-9+.-]*):\/\/([^\/?#]*)/i.exec(url);
  if (!m || m[1].toLowerCase() !== 'https' || m[2].indexOf('@') !== -1) return nope;
  var host = m[2].toLowerCase().replace(/:443$/, '');
  if (h.hosts.indexOf(host) === -1) return nope;
  var rest = url.slice(m[0].length).split(/[?#]/)[0];
  if (rest.split('/').some(function (s) { return /^(\.|%2e){1,2}$/i.test(s); })) return nope;
  try { if (new URL(url).hostname !== host) return nope; } catch (e) { return nope; }
  var need = (h.paths || {})[host];
  if (need && (rest || '/').indexOf(need) !== 0) return { ok: false, error: 'On ' + host + ' only forum guides (' + need + '…) open here.' };
  return { ok: true, url: url };
}

// "mobalytics.gg/…/3-28-bleed-slams-slayer" → "3 28 bleed slams slayer"
function guideTitleFromUrl(url) {
  var host = '', last = '';
  try {
    var u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    last = u.pathname.split('/').filter(Boolean).pop() || '';
    last = decodeURIComponent(last);
  } catch (e) { /* host only */ }
  last = last.replace(/\.(html?|php)$/i, '').replace(/[-_+]+/g, ' ').trim();
  var t = last && !/^\d+$/.test(last) ? last.charAt(0).toUpperCase() + last.slice(1) : host || 'Build guide';
  return t.slice(0, GUIDE_TITLE_MAX);
}
function guideHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// Add / change a link: { heading, url, title, confirmLabel } → { url, title } or null.
// A link that fails the check keeps the dialog's button off and says why.
async function guideDialog(opts) {
  var h = await guideLoadHosts();
  var url = opts.url || '', title = opts.title || '';
  for (;;) {
    var body = UI.el('div', 'lib-save guide-form');
    var u = UI.input({ type: 'url', value: url, placeholder: 'https://mobalytics.gg/poe/…', ariaLabel: 'Guide link',
      cls: 'lib-name-input guide-url-input' });
    u.maxLength = 2048;
    body.appendChild(UI.field('Link', u));
    var err = UI.el('p', 'guide-error');
    err.setAttribute('role', 'alert');
    body.appendChild(err);
    var t = UI.input({ value: title, placeholder: 'From the link', ariaLabel: 'Guide name', cls: 'lib-name-input guide-title-input' });
    t.maxLength = GUIDE_TITLE_MAX;
    body.appendChild(UI.field('Name', t));
    body.appendChild(UI.el('p', 'finder-sub guide-sites', 'Written guides from ' + guideSites(h) + '.'));
    body.appendChild(UI.el('p', 'finder-sub guide-note',
      'The page opens as your own visit to that site, in a separate window; the app does not read it.'));
    var pending = UI.dialog({ title: opts.heading, body: body, confirmLabel: opts.confirmLabel || 'Save link' });
    var dlg = body.closest('dialog');
    var okBtn = dlg ? dlg.querySelector('.ui-dialog-actions .btn-primary') : null;
    var live = function () {
      var c = guideCheckUrl(u.value, h);
      var bad = !!u.value.trim() && !c.ok;
      err.textContent = bad ? c.error : '';
      err.hidden = !bad;
      if (okBtn) okBtn.disabled = !c.ok;
    };
    u.addEventListener('input', live);
    u.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && okBtn && !okBtn.disabled) { e.preventDefault(); okBtn.click(); }
    });
    live();
    setTimeout(function () { u.focus(); if (!u.value) return; u.select(); }, 30);
    var ok = await pending;
    if (!ok) return null;
    url = u.value;
    title = t.value;
    var c = guideCheckUrl(url, h);
    if (c.ok) return { url: c.url, title: (title.replace(/\s+/g, ' ').trim() || guideTitleFromUrl(c.url)).slice(0, GUIDE_TITLE_MAX) };
  }
}

// ---- the guide window ---------------------------------------------------------
function guideTop() {
  if (guideWin.top !== null) return guideWin.top;
  try { return !!(JSON.parse(localStorage.getItem('pobtf-guide-win') || '{}') || {}).top; } catch (e) { return false; }
}
async function guideOpen(url, title) {
  var c = guideCheckUrl(url, await guideLoadHosts());
  if (!c.ok) { UI.toast(c.error, 'danger'); return false; }
  if (!isGui() || !window.pywebview.api.guide_open) {
    window.open(c.url, '_blank', 'noopener');
    return true;
  }
  var r = null;
  try { r = await window.pywebview.api.guide_open(c.url, title || ''); } catch (e) { r = null; }
  if (!r || !r.ok) { UI.toast('Guide not opened: ' + ((r && r.error) || 'no answer'), 'danger'); return false; }
  if (r.external) UI.toast('The guide window isn\'t available here: opened in your browser.', 'info');
  guideWin.open = !r.external;
  if (typeof r.onTop === 'boolean') guideWin.top = r.onTop;
  guideRefresh();
  return true;
}
async function guideToggleTop() {
  if (!isGui() || !window.pywebview.api.guide_on_top) return;
  var want = !guideTop();
  var r = null;
  try { r = await window.pywebview.api.guide_on_top(want); } catch (e) { r = null; }
  if (!r || !r.ok) { UI.toast('Not changed: ' + ((r && r.error) || 'no answer'), 'danger'); return; }
  guideWin.top = !!r.onTop;
  if (typeof r.open === 'boolean') guideWin.open = r.open;
  UI.toast(guideWin.top ? 'The guide window stays on top of other windows (the game too).' : 'The guide window is a normal window again.', 'info');
  guideRefresh();
}
async function guideCloseWindow() {
  if (!isGui() || !window.pywebview.api.guide_close) return;
  try { await window.pywebview.api.guide_close(); } catch (e) { /* closed anyway or gone */ }
  guideWin.open = false;
  guideRefresh();
}
// menu items shared by the build card and the Guides list
function guideWindowItems() {
  return [
    { label: (guideTop() ? '☑ ' : '☐ ') + 'Keep guide window on top', hidden: !isGui(), onClick: guideToggleTop,
      title: 'Keep the guide window above other windows, e.g. beside the game' },
    { label: 'Close guide window', hidden: !isGui() || !guideWin.open, onClick: guideCloseWindow }
  ];
}
function guideRefresh() {
  if (typeof libShowCurrent === 'function') libShowCurrent();
  guidesRender();
}

// ---- a guide on a saved build (entries in pobtf-builds: guide: { url, title }) ----------
function guideOfEntry(e) {
  return e && e.guide && typeof e.guide.url === 'string' && e.guide.url ? e.guide : null;
}
function guideSetForBuild(code, g) {
  var lib = loadBuildLib(), i = libIndexOf(code);
  if (i === -1) return false;
  if (g) lib[i].guide = { url: g.url, title: g.title };
  else delete lib[i].guide;
  saveBuildLib(lib);
  refreshBuildSelect();
  libShowCurrent();
  return true;
}
async function guideEditForBuild(code) {
  var i = libIndexOf(code);
  if (i === -1) return false;
  var e = loadBuildLib()[i], cur = guideOfEntry(e);
  var g = await guideDialog({ heading: (cur ? 'Change guide link: ' : 'Add guide link: ') + (e.name || 'build'),
    url: cur ? cur.url : '', title: cur ? cur.title : '', confirmLabel: cur ? 'Save link' : 'Add link' });
  if (!g) return false;
  guideSetForBuild(code, g);
  UI.toast('Guide linked to "' + (e.name || 'this build') + '": 📖 opens it.', 'success');
  return true;
}
async function guideRemoveForBuild(code) {
  var i = libIndexOf(code);
  if (i === -1) return false;
  var e = loadBuildLib()[i], cur = guideOfEntry(e);
  if (!cur) return false;
  var sure = await UI.confirmDanger('Remove guide link?', '"' + cur.title + '" will no longer be linked to "' +
    (e.name || 'this build') + '". The build stays saved.', 'Remove link');
  if (!sure) return false;
  guideSetForBuild(code, null);
  UI.toast('Guide link removed.', 'success');
  return true;
}

// the loaded build's card (called from libShowCurrent): 📖 Guide: name ⋯, or + Add guide link
function guideRenderBuildCard(e) {
  var line = document.getElementById('build-guide');
  if (!line) {
    var after = document.getElementById('build-atlas');
    if (!after || !after.parentNode) return;
    line = UI.el('div', 'build-guide');
    line.id = 'build-guide';
    after.parentNode.insertBefore(line, after.nextSibling);
  }
  line.textContent = '';
  line.classList.toggle('hidden', typeof build === 'undefined' || !build);
  if (typeof build === 'undefined' || !build) return;
  var g = guideOfEntry(e);
  if (!g) {
    line.appendChild(UI.button('ghost', { size: 'sm', cls: 'guide-add', label: '📖 Add guide link',
      title: 'Link the written guide you follow (Mobalytics, Maxroll, Icy Veins…) to this build',
      onClick: async function () {
        if (libIndexOf(libCurrentCode()) === -1 && !(await libSaveCurrent())) return; // saved builds hold the link
        guideEditForBuild(libCurrentCode());
      } }));
    return;
  }
  var open = UI.el('button', 'guide-link', '📖 Guide: ' + g.title);
  open.type = 'button';
  open.title = 'Open guide: ' + guideHost(g.url) + ' (in the guide window)';
  open.addEventListener('click', function () { guideOpen(g.url, g.title); });
  line.appendChild(open);
  line.appendChild(UI.menu(function () {
    var code = libCurrentCode();
    return [
      { label: 'Open guide', onClick: function () { guideOpen(g.url, g.title); } },
      { label: 'Change…', onClick: function () { guideEditForBuild(code); } },
      { label: 'Remove…', danger: true, onClick: function () { guideRemoveForBuild(code); } }
    ].concat(guideWindowItems());
  }, { size: 'sm', variant: 'ghost', ariaLabel: 'Guide link: open, change, remove, keep on top' }));
}

// the guide part of the library's ⋯ dialog (04-library.js libEdit); close() closes that dialog
function guideEditSection(b, close) {
  var box = UI.el('div', 'guide-edit');
  box.appendChild(UI.el('span', 'field-label', 'Guide'));
  var g = guideOfEntry(b);
  var row = UI.el('div', 'guide-edit-row');
  if (g) {
    var name = UI.el('span', 'guide-edit-name', g.title);
    name.title = g.url;
    row.appendChild(name);
    row.appendChild(UI.button('secondary', { size: 'sm', label: '📖 Open guide', onClick: function () { close(); guideOpen(g.url, g.title); } }));
    row.appendChild(UI.button('ghost', { size: 'sm', label: 'Change', onClick: function () { close(); guideEditForBuild(b.code); } }));
    row.appendChild(UI.button('ghost', { size: 'sm', label: 'Remove', onClick: function () { close(); guideRemoveForBuild(b.code); } }));
  } else {
    row.appendChild(UI.button('ghost', { size: 'sm', label: '📖 Add guide link', onClick: function () { close(); guideEditForBuild(b.code); } }));
  }
  box.appendChild(row);
  return box;
}

// ---- the Guides list on the Builds page (pobtf-guides) -----------------------------------
function guidesLoad() {
  try {
    var l = JSON.parse(localStorage.getItem(GUIDES_KEY));
    return Array.isArray(l) ? l.filter(function (g) { return g && typeof g.url === 'string' && g.url; }) : [];
  } catch (e) { return []; }
}
function guidesSave(list) { persist(GUIDES_KEY, JSON.stringify(list.slice(0, GUIDES_MAX))); }

async function guidesAdd() {
  var list = guidesLoad();
  if (list.length >= GUIDES_MAX) { UI.toast('The guide list is full (' + GUIDES_MAX + '): delete one first.', 'warn'); return false; }
  var g = await guideDialog({ heading: 'Add a guide', confirmLabel: 'Add guide' });
  if (!g) return false;
  list = guidesLoad();
  if (list.some(function (x) { return x.url === g.url; })) { UI.toast('That guide is already in your list.', 'info'); return false; }
  list.unshift({ url: g.url, title: g.title, added: Date.now() });
  guidesSave(list);
  guidesRender();
  UI.toast('Guide added: "' + g.title + '".', 'success');
  return true;
}
async function guidesRename(url) {
  var list = guidesLoad(), g = list.filter(function (x) { return x.url === url; })[0];
  if (!g) return;
  var input = UI.input({ value: g.title || '', ariaLabel: 'Guide name', cls: 'lib-name-input guide-title-input' });
  input.maxLength = GUIDE_TITLE_MAX;
  var body = UI.el('div', 'lib-save');
  body.appendChild(UI.field('Name', input));
  setTimeout(function () { input.focus(); input.select(); }, 30);
  if (!(await UI.dialog({ title: 'Rename guide', body: body, confirmLabel: 'Rename' }))) return;
  list = guidesLoad();
  var k = list.findIndex(function (x) { return x.url === url; });
  if (k === -1) return;
  list[k].title = (input.value.replace(/\s+/g, ' ').trim() || guideTitleFromUrl(url)).slice(0, GUIDE_TITLE_MAX);
  guidesSave(list);
  guidesRender();
}
async function guidesDelete(url) {
  var g = guidesLoad().filter(function (x) { return x.url === url; })[0];
  if (!g) return;
  var sure = await UI.confirmDanger('Delete guide?', '"' + g.title + '" will be removed from your guides.', 'Delete guide');
  if (!sure) return;
  guidesSave(guidesLoad().filter(function (x) { return x.url !== url; }));
  guidesRender();
  UI.toast('Guide deleted.', 'success');
}

function guidesRender() {
  var sec = document.getElementById('guides-section');
  if (!sec) return;
  var list = guidesLoad();
  document.getElementById('guides-count').textContent = list.length ? String(list.length) : '';
  var top = document.getElementById('guides-top');
  if (top) {
    top.setAttribute('aria-pressed', guideTop() ? 'true' : 'false');
    top.textContent = (guideTop() ? '☑' : '☐') + ' Keep on top';
  }
  var host = document.getElementById('guides-list');
  host.textContent = '';
  document.getElementById('guides-empty').hidden = list.length > 0;
  list.forEach(function (g) {
    var row = UI.el('div', 'guide-item');
    var open = UI.el('button', 'guide-open');
    open.type = 'button';
    open.title = 'Open guide: ' + g.url;
    open.appendChild(UI.el('span', 'guide-name', g.title || guideTitleFromUrl(g.url)));
    open.appendChild(UI.el('span', 'guide-host', guideHost(g.url)));
    open.addEventListener('click', function () { guideOpen(g.url, g.title); });
    row.appendChild(open);
    row.appendChild(UI.menu(function () {
      return [
        { label: 'Open guide', onClick: function () { guideOpen(g.url, g.title); } },
        { label: 'Rename…', onClick: function () { guidesRename(g.url); } },
        { label: 'Delete…', danger: true, onClick: function () { guidesDelete(g.url); } }
      ];
    }, { size: 'sm', variant: 'ghost', ariaLabel: 'Open, rename, delete: ' + (g.title || g.url) }));
    host.appendChild(row);
  });
}

function guidesBuildSection() {
  var after = document.getElementById('saved-section');
  if (!after || document.getElementById('guides-section')) return;
  var sec = UI.el('section', 'guides-section');
  sec.id = 'guides-section';
  sec.setAttribute('aria-labelledby', 'guides-title');
  var head = UI.el('div', 'saved-head');
  var h2 = UI.el('h2', 'landing-h2', 'Guides ');
  h2.id = 'guides-title';
  var count = UI.el('span', 'saved-count');
  count.id = 'guides-count';
  h2.appendChild(count);
  head.appendChild(h2);
  var acts = UI.el('span', 'guides-actions');
  var topBtn = UI.button('ghost', { size: 'sm', cls: 'gui-only', label: '☐ Keep on top',
    title: 'Keep the guide window above other windows, e.g. beside the game', onClick: guideToggleTop });
  topBtn.id = 'guides-top';
  acts.appendChild(topBtn);
  acts.appendChild(UI.button('secondary', { size: 'sm', label: '+ Add guide', cls: 'guides-add', onClick: guidesAdd }));
  head.appendChild(acts);
  sec.appendChild(head);
  var empty = UI.el('p', 'finder-sub', 'Keep the written build guides you\'re reading here (Mobalytics, Maxroll, Icy Veins, ' +
    'PoE Vault, forum guides). A guide for one build goes on that build: ⋯ on its card.');
  empty.id = 'guides-empty';
  sec.appendChild(empty);
  var list = UI.el('div', 'guides-list');
  list.id = 'guides-list';
  sec.appendChild(list);
  after.parentNode.insertBefore(sec, after.nextSibling);
}

document.addEventListener('DOMContentLoaded', function () {
  if (IN_GAME_PAGE || (typeof TRADES !== 'undefined' && TRADES)) return; // the main window's Builds page only
  guidesBuildSection();
  guidesRender();
  guideLoadHosts();
});
