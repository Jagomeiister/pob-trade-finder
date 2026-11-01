/* js/app/04-library.js — saved builds: the library on the start screen (shown at launch), saving
   from the build card or the "save this build?" offer after an import, rename, search, and a
   linked Atlas strategy per build (js/app/28-atlas.js).
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- saved builds library --------------------------------------------------
// Entries: { name, code, ts (saved), opened (last loaded), cls, asc, level, skill, atlas (an Atlas
// strategy id) }. The stored order is kept (price tracking refers to entries by position:
// 13-builds-tracking.js); the start screen sorts its own view by last opened.
var BUILD_LIB_MAX = 100;
function loadBuildLib() {
  try { return JSON.parse(localStorage.getItem('pobtf-builds')) || []; }
  catch (e) { return []; }
}
function saveBuildLib(lib) {
  try { persist('pobtf-builds', JSON.stringify(lib.slice(0, BUILD_LIB_MAX))); }
  catch (e) { /* storage full/unavailable */ }
}
function libCurrentCode() { return document.getElementById('pob-input').value.trim(); }
function libIndexOf(code) {
  var c = String(code || '').trim();
  return c ? loadBuildLib().findIndex(function (b) { return String(b.code || '').trim() === c; }) : -1;
}
// a name for the loaded build: "Main Skill · Ascendancy"
function libDefaultName() {
  if (!build) return 'Build';
  var skill = (build.mainSkill || [])[0] || '';
  var who = build.ascendClass || build.className || 'Build';
  return skill ? skill + ' · ' + who : who;
}
function libMeta() {
  return { cls: build.className || '', asc: build.ascendClass || '', level: build.level || null,
           skill: (build.mainSkill || [])[0] || '', items: Object.keys(build.items || {}).length };
}

// ☆ Save on the build card (and the offer after an import): asks for a name; the same build saved
// again keeps its entry (and its tracking and Atlas link)
async function libSaveCurrent() {
  if (!build) return false;
  var code = libCurrentCode();
  var at = libIndexOf(code);
  var lib = loadBuildLib();
  var input = UI.input({ value: at === -1 ? libDefaultName() : lib[at].name, ariaLabel: 'Build name', cls: 'lib-name-input' });
  input.maxLength = 80;
  var body = UI.el('div', 'lib-save');
  body.appendChild(UI.field('Name', input));
  if (at !== -1) body.appendChild(UI.el('p', 'finder-sub', 'This build is already saved: this renames it.'));
  setTimeout(function () { input.focus(); input.select(); }, 30);
  var ok = await UI.dialog({ title: at === -1 ? 'Save this build' : 'Saved build', body: body,
    confirmLabel: at === -1 ? 'Save' : 'Rename' });
  if (!ok) return false;
  var name = input.value.trim() || libDefaultName();
  lib = loadBuildLib();
  at = libIndexOf(code);
  if (at === -1) {
    if (lib.length >= BUILD_LIB_MAX) { UI.toast('The library is full (' + BUILD_LIB_MAX + ' builds): delete one first.', 'warn'); return false; }
    lib.unshift(Object.assign({ name: name, code: code, ts: Date.now(), opened: Date.now() }, libMeta()));
  } else {
    lib[at] = Object.assign(lib[at], { name: name }, libMeta());
  }
  saveBuildLib(lib);
  refreshBuildSelect();
  libShowCurrent();
  UI.toast('Saved as "' + name + '": it\'s in your builds on the start screen.', 'success');
  return true;
}

// after a build loads: mark it opened, or offer to save it (once per build per session)
var libOffered = {};
function libAfterLoad() {
  var code = libCurrentCode(), at = libIndexOf(code);
  if (at !== -1) {
    var lib = loadBuildLib();
    lib[at] = Object.assign(lib[at], { opened: Date.now() }, libMeta());
    saveBuildLib(lib);
    refreshBuildSelect();
  } else if (code && !libOffered[code]) {
    libOffered[code] = true;
    UI.toast('Save this build to your library?', 'info', { action: { label: '☆ Save', onClick: libSaveCurrent } });
  }
  libShowCurrent();
}

// the build card: ★ Saved (as "name") and its Atlas strategy, if it has one
function libShowCurrent() {
  var btn = document.getElementById('save-build');
  var line = document.getElementById('build-atlas');
  var at = build ? libIndexOf(libCurrentCode()) : -1;
  var e = at === -1 ? null : loadBuildLib()[at];
  if (btn) {
    btn.textContent = e ? '★ Saved' : '☆ Save';
    btn.title = e ? 'Saved as "' + e.name + '": click to rename' : 'Keep this build in your library for one-click reload';
  }
  if (!line) return;
  line.textContent = '';
  var has = e && e.atlas && typeof atlasName === 'function' && atlasName(e.atlas);
  line.classList.toggle('hidden', !has);
  if (has) {
    var a = UI.el('button', 'lib-atlas-link', '🗺 Atlas: ' + atlasName(e.atlas));
    a.type = 'button';
    a.title = 'Open this build\'s Atlas strategy';
    a.addEventListener('click', function () { atlasOpen(e.atlas); });
    line.appendChild(a);
  }
}

// ---- the library on the start screen ----------------------------------------
var libQuery = '';
function libWhen(ts) {
  if (!ts) return '';
  var d = Math.round((Date.now() - ts) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : new Date(ts).toLocaleDateString();
}
// saved builds as one-click cards on the start screen
function refreshBuildSelect() {
  var list = document.getElementById('saved-list');
  var lib = loadBuildLib();
  list.textContent = '';
  document.getElementById('saved-section').classList.toggle('hidden', !lib.length);
  var count = document.getElementById('saved-count');
  if (count) count.textContent = lib.length ? String(lib.length) : '';
  var search = document.getElementById('saved-search');
  if (search) search.classList.toggle('hidden', lib.length < 7);
  var q = libQuery.toLowerCase().split(/\s+/).filter(Boolean);
  // newest opened first; the stored index goes with each card (tracking uses it)
  var rows = lib.map(function (b, i) { return { b: b, i: i }; })
    .filter(function (r) {
      if (!q.length) return true;
      var hay = [r.b.name, r.b.asc, r.b.cls, r.b.skill, r.b.atlas && typeof atlasName === 'function' ? atlasName(r.b.atlas) : '']
        .join(' ').toLowerCase();
      return q.every(function (w) { return hay.indexOf(w) !== -1; });
    })
    .sort(function (x, y) { return (y.b.opened || y.b.ts || 0) - (x.b.opened || x.b.ts || 0); });
  if (!rows.length && lib.length) list.appendChild(UI.el('div', 'finder-sub', 'No saved build matches "' + libQuery + '".'));
  rows.forEach(function (r) {
    var b = r.b, i = r.i;
    var parts = String(b.name || 'Build').split(' · ');
    var row = UI.el('div', 'saved-build');
    var open = UI.el('button', 'saved-open');
    open.type = 'button';
    open.appendChild(UI.el('span', 'saved-name', parts[0]));
    var meta = b.asc || b.cls
      ? [parts.length > 1 && parts[1] !== (b.asc || b.cls) ? parts.slice(1).join(' · ') : '', b.asc || b.cls,
         b.level ? 'level ' + b.level : ''].filter(Boolean).join(' · ')
      : parts.slice(1).join(' · ');
    open.appendChild(UI.el('span', 'saved-meta', meta));
    var when = b.opened || b.ts;
    var sub = [when ? 'opened ' + libWhen(when) : '',
               b.atlas && typeof atlasName === 'function' && atlasName(b.atlas) ? '🗺 ' + atlasName(b.atlas) : '']
      .filter(Boolean).join(' · ');
    if (sub) open.appendChild(UI.el('span', 'saved-meta saved-when', sub));
    var tr = b.track;
    if (tr && tr.on) {
      var league = document.getElementById('league').value;
      var tmeta = UI.el('span', 'saved-track');
      tmeta.appendChild(document.createTextNode(tr.last
        ? '📈 ' + fmtEq(tr.last.total, league) + ' on ' + fmtShortDate(tr.last.ts / 1000) + ' '
        : '📈 Daily reminder on, not priced yet'));
      if (tr.last && tr.last.change != null) tmeta.appendChild(pctChip(tr.last.change, true));
      open.appendChild(tmeta);
    }
    open.addEventListener('click', function () {
      document.getElementById('pob-input').value = b.code;
      onDecode();
    });
    row.appendChild(open);
    var form = trackForm(b, i);
    form.hidden = true;
    var trackBtn = UI.iconButton('📈', 'Re-price and price reminders for ' + parts[0], { size: 'sm', onClick: function () {
      form.hidden = !form.hidden;
      trackBtn.setAttribute('aria-expanded', form.hidden ? 'false' : 'true');
    } });
    trackBtn.setAttribute('aria-expanded', 'false');
    var more = UI.iconButton('⋯', 'Rename, Atlas strategy, delete: ' + parts[0], { size: 'sm', onClick: function () {
      libEdit(i);
    } });
    row.appendChild(trackBtn);
    row.appendChild(more);
    var cell = UI.el('div', 'saved-item'); // card + its tracking form share a grid cell
    cell.appendChild(row);
    cell.appendChild(form);
    list.appendChild(cell);
  });
}

// ⋯ on a saved build: name, its Atlas strategy (pick one, open it), delete
async function libEdit(i) {
  var lib = loadBuildLib(), b = lib[i];
  if (!b) return;
  var body = UI.el('div', 'lib-save');
  var name = UI.input({ value: b.name || '', ariaLabel: 'Build name', cls: 'lib-name-input' });
  name.maxLength = 80;
  body.appendChild(UI.field('Name', name));
  var atl = null;
  if (typeof atlasList === 'function') {
    var opts = [['', atlasList().length ? 'None' : 'None (import one in Tools → Atlas tree)']]
      .concat(atlasList().map(function (a) { return [a.id, a.name + (a.points ? ' · ' + a.points + ' points' : '')]; }));
    atl = UI.select(opts, b.atlas || '', { ariaLabel: 'Atlas strategy' });
    body.appendChild(UI.field('Atlas strategy', atl, { title: 'The Atlas tree you run with this build' }));
    if (b.atlas && typeof atlasOpen === 'function' && atlasName(b.atlas)) {
      body.appendChild(UI.button('ghost', { size: 'sm', label: '🗺 Open it', onClick: function () {
        var d = body.closest('dialog');
        if (d) d.close();
        atlasOpen(b.atlas);
      } }));
    }
  }
  var del = UI.button('danger', { size: 'sm', label: 'Delete this build…', onClick: async function () {
    var d = body.closest('dialog');
    if (d) d.close();
    var sure = await UI.confirmDanger('Delete saved build?', '"' + b.name + '" will be removed from your library.', 'Delete build');
    if (!sure) return;
    var cur = loadBuildLib();
    var k = cur.findIndex(function (x) { return x.code === b.code; });
    if (k !== -1) cur.splice(k, 1);
    saveBuildLib(cur);
    refreshBuildSelect();
    libShowCurrent();
    UI.toast('Saved build deleted.', 'success');
  } });
  body.appendChild(del);
  var ok = await UI.dialog({ title: b.name || 'Saved build', body: body, confirmLabel: 'Save changes' });
  if (!ok) return;
  lib = loadBuildLib();
  var j = lib.findIndex(function (x) { return x.code === b.code; });
  if (j === -1) return;
  lib[j].name = name.value.trim() || lib[j].name;
  if (atl) lib[j].atlas = atl.value || null;
  saveBuildLib(lib);
  refreshBuildSelect();
  libShowCurrent();
}
