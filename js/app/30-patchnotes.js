/* js/app/30-patchnotes.js — Settings → Patch notes: what each release brought, newest first.
   The js/app/ files are one program split by feature: they load in order (index.html) and
   share their top-level names. */
'use strict';

// ==== patch notes =====================================================================
// data/patchnotes.js (tools/make_patchnotes.py, re-made by every release build) holds each
// release's notes as plain data (text runs: t text, b bold, i italic, c code, a link), drawn
// here with text nodes only, so a note can never inject markup.
var PATCH_SHOWN = 6;   // releases listed before "Show older"
var patchShowAll = false;

function patchInline(runs) {
  var frag = document.createDocumentFragment();
  (runs || []).forEach(function (r) {
    var kind = r[0], text = r[1] || '';
    if (kind === 'b') frag.appendChild(UI.el('b', null, text));
    else if (kind === 'i') frag.appendChild(UI.el('em', null, text));
    else if (kind === 'c') frag.appendChild(UI.el('code', null, text));
    else if (kind === 'a') {
      // links open in the system browser; gui.py open_url only opens its allowed prefixes
      var a = UI.el('a', null, text);
      a.href = r[2];
      a.addEventListener('click', function (e) { e.preventDefault(); openUrl(r[2]); });
      frag.appendChild(a);
    } else frag.appendChild(document.createTextNode(text));
  });
  return frag;
}
function patchList(items) {
  var ul = UI.el('ul', 'pn-list');
  items.forEach(function (it) {
    var li = UI.el('li');
    li.appendChild(patchInline(it.li));
    if (it.ul && it.ul.length) li.appendChild(patchList(it.ul));
    ul.appendChild(li);
  });
  return ul;
}
function patchRelease(n, installed) {
  var det = UI.el('details', 'pn-release');
  det.dataset.version = n.v;
  var sum = UI.el('summary', 'pn-head');
  sum.appendChild(UI.el('b', 'pn-version', n.v));
  if (n.title) sum.appendChild(UI.el('span', 'pn-title', n.title));
  if (n.date) sum.appendChild(UI.el('span', 'pn-date', n.date));
  if (installed) sum.appendChild(UI.chip('installed', 'success', 'pn-installed'));
  det.appendChild(sum);
  var body = UI.el('div', 'pn-body');
  (n.blocks || []).forEach(function (b) {
    if (b.p) { var p = UI.el('p'); p.appendChild(patchInline(b.p)); body.appendChild(p); }
    else if (b.h) { var h = UI.el('h4', 'pn-sub'); h.appendChild(patchInline(b.h)); body.appendChild(h); }
    else if (b.ul) body.appendChild(patchList(b.ul));
  });
  det.appendChild(body);
  return det;
}

function renderPatchNotes() {
  var box = document.getElementById('patch-notes');
  if (!box) return;
  var notes = window.POE_PATCH_NOTES || [];
  box.textContent = '';
  if (!notes.length) { box.appendChild(UI.el('p', 'settings-note', 'No patch notes in this copy of the app.')); return; }
  var installed = window.APP_VERSION ? 'v' + window.APP_VERSION : notes[0].v; // the newest notes ship with the app
  var list = patchShowAll ? notes : notes.slice(0, PATCH_SHOWN);
  list.forEach(function (n, i) {
    var det = patchRelease(n, n.v === installed);
    if (i === 0) det.open = true;
    box.appendChild(det);
  });
  if (!patchShowAll && notes.length > PATCH_SHOWN) {
    box.appendChild(UI.button('ghost', { size: 'sm', label: 'Show older releases (' + (notes.length - PATCH_SHOWN) + ')',
      onClick: function () { patchShowAll = true; renderPatchNotes(); } }));
  }
}

// after the update check (02-init.js): mark the installed version; say when a newer one is out
function markPatchNotes(res) {
  renderPatchNotes();
  var note = document.getElementById('patch-notes-update');
  if (!note || !res) return;
  var latest = String(res.latest || '').replace(/^v/i, '');
  note.hidden = !res.newer;
  note.textContent = res.newer ? 'v' + latest + ' is out: Settings → Updates → Update now. Its notes show here once it\'s installed.' : '';
}

document.addEventListener('DOMContentLoaded', renderPatchNotes);
// ==== end patch notes =================================================================
