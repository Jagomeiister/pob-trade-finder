"""70 guides — build-guide links (js/app/46-guidewindow.js): a guide link on a saved build (the build
card and the library's ⋯ dialog), checked against gui.py's allowed sites (bad links keep the dialog's
button off), opened through the guide_open bridge, saved with the build and back after a restart;
removing asks first. The Guides list on the Builds page: add, open, rename, Keep on top, delete."""
import json
import urllib.parse

TAG = "70 guides"
URL = "https://mobalytics.gg/poe/profile/phazeplays/builds/3-28-phazeplays-bleed-slams-slayer-revamped-ground-slam-of-earthshaking"
URL2 = "https://www.icy-veins.com/poe/righteous-fire-chieftain-build"

APP = r"""
const H = window.__e2e;
const out = {};
const lib = () => JSON.parse(localStorage.getItem('pobtf-builds') || '[]');
const dlg = () => document.querySelector('dialog[open]');
const type = (inp, v) => { inp.value = v; inp.dispatchEvent(new Event('input')); };
await H.loadBuild();
await H.sleep(60);
// not saved yet: the card offers to add a guide (saving the build first)
const card = document.getElementById('build-guide');
out.addShown = !!(card && H.button(card, '📖 Add guide link'));
H.button(card, '📖 Add guide link').click();
await H.waitFor(() => dlg(), 3000, 'save dialog');
dlg().querySelector('.lib-name-input').value = 'Slam Slayer';
H.button(dlg(), 'Save').click();
await H.waitFor(() => dlg() && dlg().querySelector('.guide-url-input'), 3000, 'guide dialog');
let d = dlg();
const ok = () => H.button(d, 'Add link');
const err = () => d.querySelector('.guide-error');
out.note = H.text('.guide-note', d);
out.emptyOff = ok().disabled;
const bad = {};
for (const u of ['https://mobalytics.gg.evil.com/x', 'https://evilmobalytics.gg/x', 'http://mobalytics.gg/x',
                 'https://mobalytics.gg@evil.com/', 'https://www.youtube.com/watch?v=1']) {
  type(d.querySelector('.guide-url-input'), u);
  bad[u] = [ok().disabled, !err().hidden, err().textContent];
}
out.bad = bad;
type(d.querySelector('.guide-url-input'), '  ' + URL + '  ');
out.goodOn = [!ok().disabled, err().hidden];
ok().click();
await H.sleep(60);
out.saved = lib().map(b => [b.name, b.guide]);
out.persisted = (H.calls('storage_set').filter(c => c.args[0] === 'pobtf-builds').slice(-1)[0] || { args: [] }).args[1] || null;
// the card: 📖 Guide: <name>, a click opens it through the bridge
const link = document.querySelector('#build-guide .guide-link');
out.linkText = link && link.textContent;
const n0 = H.calls('guide_open').length;
link.click();
await H.sleep(40);
out.openArgs = (H.calls('guide_open')[n0] || { args: [] }).args;
out.noOpenUrl = H.calls('open_url').every(c => c.args[0] !== URL);
// a failure says why
window.__stubOverrides.guide_open = { ok: false, error: 'WebView2 missing (e2e)' };
link.click();
await H.sleep(60);
out.failToast = [...document.querySelectorAll('.toast')].some(t => /Guide not opened: WebView2 missing \(e2e\)/.test(t.textContent));
delete window.__stubOverrides.guide_open;
// Keep on top from the card's ⋯ menu
document.querySelector('#build-guide .menu-trigger').click();
await H.sleep(30);
const items = () => [...document.querySelectorAll('.menu .menu-item')];
out.menu = items().map(b => b.textContent);
items().find(b => /Keep guide window on top/.test(b.textContent)).click();
await H.sleep(60);
out.topCalls = H.calls('guide_on_top').map(c => c.args[0]);
return out;
"""

RELOADED = r"""
const H = window.__e2e;
const out = {};
const lib = () => JSON.parse(localStorage.getItem('pobtf-builds') || '[]');
const dlg = () => document.querySelector('dialog[open]');
await H.waitFor(() => document.querySelector('#saved-list .saved-build'), 5000, 'library');
out.guide = lib()[0] && lib()[0].guide;
const row = document.querySelector('#saved-list .saved-build');
out.sub = H.text('.saved-when', row);
const n0 = H.calls('guide_open').length;
row.querySelector('.saved-guide').click();
await H.sleep(40);
out.openArgs = (H.calls('guide_open')[n0] || { args: [] }).args;
// ⋯ → Guide → Remove: asks first; Cancel keeps it
const edit = () => { row.querySelector('button[aria-label^="Rename, Atlas strategy, delete"]').click(); };
edit();
await H.waitFor(() => dlg(), 3000, 'edit dialog');
out.section = [H.text('.guide-edit-name', dlg()), !!H.button(dlg(), '📖 Open guide'), !!H.button(dlg(), 'Change')];
H.button(dlg(), 'Remove').click();
await H.waitFor(() => dlg() && /Remove guide link/.test(dlg().textContent), 3000, 'confirm');
out.asked = H.text('.ui-dialog-title', dlg());
H.button(dlg(), 'Cancel').click();
await H.sleep(40);
out.keptAfterCancel = !!(lib()[0] && lib()[0].guide);
document.querySelectorAll('dialog').forEach(x => x.remove());
const row2 = () => document.querySelector('#saved-list .saved-build');
row2().querySelector('button[aria-label^="Rename, Atlas strategy, delete"]').click();
await H.waitFor(() => dlg(), 3000, 'edit dialog 2');
H.button(dlg(), 'Remove').click();
await H.waitFor(() => dlg() && /Remove guide link/.test(dlg().textContent), 3000, 'confirm 2');
H.button(dlg(), 'Remove link').click();
await H.sleep(60);
out.removed = lib()[0] && !lib()[0].guide;
out.noButton = !row2().querySelector('.saved-guide');
document.querySelectorAll('dialog').forEach(x => x.remove());
return out;
"""

GUIDES = r"""
const H = window.__e2e;
const out = {};
const dlg = () => document.querySelector('dialog[open]');
const type = (inp, v) => { inp.value = v; inp.dispatchEvent(new Event('input')); };
const saved = () => JSON.parse(localStorage.getItem('pobtf-guides') || '[]');
const sec = await H.waitFor(() => document.getElementById('guides-section'), 5000, 'guides section');
out.visible = H.visible(sec);
out.empty = !document.getElementById('guides-empty').hidden;
const add = async (u, name) => {
  H.button(sec, '+ Add guide').click();
  await H.waitFor(() => dlg() && dlg().querySelector('.guide-url-input'), 3000, 'add dialog');
  type(dlg().querySelector('.guide-url-input'), u);
  if (name) dlg().querySelector('.guide-title-input').value = name;
  const b = H.button(dlg(), 'Add guide');
  const off = b.disabled;
  if (off) H.button(dlg(), 'Cancel').click(); else b.click();
  await H.sleep(60);
  return off;
};
out.badOff = await add('https://www.pathofexile.com/trade/search/Standard');
out.afterBad = saved().length;
await add(URL2, '');
await add(URL);
out.list = saved().map(g => [g.url, g.title, typeof g.added]);
out.rows = [...sec.querySelectorAll('.guide-item .guide-name')].map(e => e.textContent);
out.hosts = [...sec.querySelectorAll('.guide-item .guide-host')].map(e => e.textContent);
await add(URL);
out.dupe = [saved().length, [...document.querySelectorAll('.toast')].some(t => /already in your list/.test(t.textContent))];
// open
const n0 = H.calls('guide_open').length;
sec.querySelector('.guide-item .guide-open').click();
await H.sleep(40);
out.openArgs = (H.calls('guide_open')[n0] || { args: [] }).args;
// rename through ⋯
const menuItem = async (row, label) => {
  row.querySelector('.menu-trigger').click();
  await H.sleep(30);
  [...document.querySelectorAll('.menu .menu-item')].find(b => b.textContent === label).click();
  await H.sleep(30);
};
await menuItem(sec.querySelector('.guide-item'), 'Rename…');
await H.waitFor(() => dlg(), 3000, 'rename');
dlg().querySelector('.guide-title-input').value = 'Bleed Slams (Phaze)';
H.button(dlg(), 'Rename').click();
await H.sleep(40);
out.renamed = saved()[0].title;
// Keep on top toggle in the header
const topBtn = document.getElementById('guides-top');
topBtn.click();
await H.sleep(60);
out.top = [H.calls('guide_on_top').map(c => c.args[0]), topBtn.getAttribute('aria-pressed'), topBtn.textContent];
// delete asks first
await menuItem(sec.querySelector('.guide-item'), 'Delete…');
await H.waitFor(() => dlg() && /Delete guide/.test(dlg().textContent), 3000, 'confirm');
H.button(dlg(), 'Cancel').click();
await H.sleep(30);
out.keptAfterCancel = saved().length;
await menuItem(sec.querySelector('.guide-item'), 'Delete…');
await H.waitFor(() => dlg() && /Delete guide/.test(dlg().textContent), 3000, 'confirm 2');
H.button(dlg(), 'Delete guide').click();
await H.sleep(60);
out.afterDelete = saved().map(g => g.url);
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-guides');
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(APP, timeout=60, URL=URL)
    check(tag + " an unsaved build's card offers 'Add guide link' (saves the build first)", r["addShown"], r)
    check(tag + " the dialog says the page is your own visit and isn't read",
          "your own visit" in (r["note"] or "") and "does not read it" in (r["note"] or ""), r["note"])
    bad = r["bad"]
    check(tag + " look-alike, http, user@host and video links keep 'Add link' off and say why",
          r["emptyOff"] and all(v[0] and v[1] and "mobalytics.gg" in v[2] for v in bad.values()), bad)
    check(tag + " a good link (spaces trimmed) turns it on", r["goodOn"] == [True, True], r["goodOn"])
    sv = r["saved"]
    check(tag + " the link is saved on the build, named from the link",
          len(sv) == 1 and sv[0][0] == "Slam Slayer" and sv[0][1]["url"] == URL and
          sv[0][1]["title"].startswith("3 28 phazeplays bleed slams"), sv)
    check(tag + " ...and written to the bridge's storage", r["persisted"] and URL in r["persisted"], r["persisted"])
    check(tag + " the card shows 📖 Guide: <name>", (r["linkText"] or "").startswith("📖 Guide: 3 28 phazeplays"), r["linkText"])
    check(tag + " clicking it calls guide_open with the URL (not the system browser)",
          r["openArgs"][:1] == [URL] and r["noOpenUrl"], r["openArgs"])
    check(tag + " a failed open says why", r["failToast"])
    check(tag + " the card's ⋯: open, change, remove, keep on top", r["menu"][:3] == ["Open guide", "Change…", "Remove…"]
          and any("Keep guide window on top" in m for m in r["menu"]), r["menu"])
    check(tag + " Keep on top asks gui.py", r["topCalls"] == [True], r["topCalls"])

    s.fresh("?e2eStore=" + urllib.parse.quote(json.dumps({"pobtf-builds": r["persisted"]})))
    r = s.run(RELOADED, timeout=40)
    check(tag + " after a restart the build still has its guide", (r["guide"] or {}).get("url") == URL, r["guide"])
    check(tag + " the library card shows it and its 📖 button opens it",
          "📖 3 28 phazeplays" in (r["sub"] or "") and r["openArgs"][:1] == [URL], (r["sub"], r["openArgs"]))
    check(tag + " the ⋯ dialog has the guide with Open / Change / Remove", r["section"][1] and r["section"][2]
          and (r["section"][0] or "").startswith("3 28"), r["section"])
    check(tag + " Remove asks first; Cancel keeps the link", r["asked"] == "Remove guide link?" and r["keptAfterCancel"], r)
    check(tag + " confirming removes it (and the 📖 button)", r["removed"] and r["noButton"], r)

    s.fresh()
    r = s.run(GUIDES, timeout=60, URL=URL, URL2=URL2)
    check(tag + " the Builds page has a Guides list (empty at first)", r["visible"] and r["empty"], r)
    check(tag + " a link outside the allowed pages can't be added", r["badOff"] and r["afterBad"] == 0, r)
    check(tag + " guides added newest first, named from the link, with the site",
          [g[0] for g in r["list"]] == [URL, URL2] and r["list"][1][1] == "Righteous fire chieftain build"
          and all(g[2] == "number" for g in r["list"]) and r["hosts"] == ["mobalytics.gg", "icy-veins.com"], r["list"])
    check(tag + " the same guide twice: said, not added", r["dupe"] == [2, True], r["dupe"])
    check(tag + " a click opens it through guide_open", r["openArgs"][:1] == [URL], r["openArgs"])
    check(tag + " rename", r["renamed"] == "Bleed Slams (Phaze)", r["renamed"])
    check(tag + " Keep on top toggle", r["top"] == [[True], "true", "☑ Keep on top"], r["top"])
    check(tag + " delete asks first; Cancel keeps it, Delete removes it",
          r["keptAfterCancel"] == 2 and r["afterDelete"] == [URL2] and r["persisted"], r)
