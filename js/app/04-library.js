/* js/app/04-library.js — saved builds on the start screen.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- saved builds library --------------------------------------------------
function loadBuildLib() {
  try { return JSON.parse(localStorage.getItem('pobtf-builds')) || []; }
  catch (e) { return []; }
}
function saveBuildLib(lib) {
  try { persist('pobtf-builds', JSON.stringify(lib.slice(0, 20))); }
  catch (e) { /* storage full/unavailable */ }
}
// saved builds as one-click cards on the start screen
function refreshBuildSelect() {
  var list = document.getElementById('saved-list');
  var lib = loadBuildLib();
  list.textContent = '';
  document.getElementById('saved-section').classList.toggle('hidden', !lib.length);
  lib.forEach(function (b, i) {
    var parts = String(b.name || 'Build').split(' · ');
    var row = UI.el('div', 'saved-build');
    var open = UI.el('button', 'saved-open');
    open.type = 'button';
    open.appendChild(UI.el('span', 'saved-name', parts[0]));
    open.appendChild(UI.el('span', 'saved-meta', parts.slice(1).join(' · ')));
    var tr = b.track;
    if (tr && tr.on) {
      var league = document.getElementById('league').value;
      var meta = UI.el('span', 'saved-track');
      meta.appendChild(document.createTextNode(tr.last
        ? '📈 ' + fmtEq(tr.last.total, league) + ' on ' + fmtShortDate(tr.last.ts / 1000) + ' '
        : '📈 Tracking daily, first check pending'));
      if (tr.last && tr.last.change != null) meta.appendChild(pctChip(tr.last.change, true));
      open.appendChild(meta);
    }
    open.addEventListener('click', function () {
      document.getElementById('pob-input').value = b.code;
      onDecode();
    });
    row.appendChild(open);
    var form = trackForm(b, i);
    form.hidden = true;
    var trackBtn = UI.iconButton('📈', 'Daily price tracking for ' + parts[0], { size: 'sm', onClick: function () {
      form.hidden = !form.hidden;
      trackBtn.setAttribute('aria-expanded', form.hidden ? 'false' : 'true');
    } });
    trackBtn.setAttribute('aria-expanded', 'false');
    row.appendChild(trackBtn);
    row.appendChild(UI.iconButton('🗑', 'Delete saved build ' + parts[0], { size: 'sm', onClick: function () {
      UI.confirmDanger('Delete saved build?', '"' + b.name + '" will be removed from your library.', 'Delete build')
        .then(function (ok) {
          if (!ok) return;
          var cur = loadBuildLib();
          cur.splice(i, 1);
          saveBuildLib(cur);
          refreshBuildSelect();
          UI.toast('Saved build deleted.', 'success');
        });
    } }));
    var cell = UI.el('div', 'saved-item'); // card + its tracking form share a grid cell
    cell.appendChild(row);
    cell.appendChild(form);
    list.appendChild(cell);
  });
}
