"""68 market — the Market tab laid out like poe.ninja:
- a category rail (Overview, Watchlist, the exchange feed split into General categories, then the
  poe.ninja snapshot: Equipment & gems, Atlas, Other) with item counts, arrow keys, a select when narrow
- Overview keeps movers, chart, watchlist, converter and the chaos/divine gaps
- a category table: chaos, divine, 7-day sparkline and change, volume or listings, star; sorting,
  search, hide thin, filters (links, gem level/quality/corrupted)
- a detail drawer for both kinds of row; Esc closes it and focus returns to the row
- the chosen category is remembered; a failed snapshot load says so and offers Retry
"""
TAG = "68 market"

READY_JS = ("document.body && document.body.classList.contains('gui') && "
            "document.getElementById('league').options.length > 0")

# shared by both page loads: fixtures + small helpers (window.__mk)
SETUP = r"""
const H = window.__e2e;
const hour = Math.floor(Date.now() / 3600000) * 3600;
const item = (name, cat, start, end, vol) => {
  const s = [];
  for (let k = 0; k < 29; k++) s.push([hour - (28 - k) * 6 * 3600, +(start + (end - start) * k / 28).toPrecision(4), vol]);
  return { name, cat, img: '', s };
};
const FS = 'Fragments, Scarabs & Mapping';
const cx = {
  divine: item('Divine Orb', 'Currency', 180, 200, 400000), exalted: item('Exalted Orb', 'Currency', 15, 12, 60000),
  mirror: item('Mirror of Kalandra', 'Currency', 70000, 80000, 1000),
  'scarab-a': item('Ambush Scarab', FS, 4, 5, 30000), 'scarab-b': item('Divination Scarab of Curation', FS, 100, 80, 9000),
  'scarab-c': item('Bestiary Scarab', FS, 1, 1, 800), frag: item('Sacrifice at Dusk', FS, 2, 2, 7000),
  ess: item('Deafening Essence of Greed', 'Essences', 3, 4, 6000), card: item('The Doctor', 'Cards', 900, 1000, 8000),
  ducat: item("Merrick's Ducat", 'Ducats', 10, 11, 6000),
  // a category this app has never heard of: one item a name rule places, one that lands in Other
  oilx: item('Golden Oil', 'Season Twelve Stuff', 50, 60, 9000), odd: item('Brand New Thing', 'Season Twelve Stuff', 7, 7, 9000),
};
const counts = { UniqueWeapon: 5, SkillGem: 6, Beast: 2, Map: 0 };
const at = Date.now() - 600000;
const NJ = {
  UniqueWeapon: { ok: true, type: 'UniqueWeapon', at, divine: 200, counts, lines: [
    { n: 'Starforge', b: 'Infernal Sword', c: 600, d: 3, lc: 40, i: '/gen/image/e2e/Starforge.png', sp: [-10, [0, -2, -4, -6, -8, -9, -10]] },
    { n: 'Starforge', b: 'Infernal Sword', c: 4000, d: 20, l: 6, lc: 12, sp: [25, [0, 5, 10, null, 15, 20, 25]] },
    { n: 'Starforge', b: 'Infernal Sword', c: 900, d: 4.5, l: 5, lc: 3 },
    { n: 'Paradoxica', b: 'Vaal Rapier', v: 'Veiled', c: 150, d: 0.75, lc: 25, i: '/gen/image/e2e/Paradoxica.png', sp: [0, [0, 1, 0, 1, 0, 1, 0]] },
    { n: "Ahn's Might", b: 'Midnight Blade', c: 2, lc: 200 }] },
  SkillGem: { ok: true, type: 'SkillGem', at, divine: 200, counts, lines: [
    { n: 'Enlighten Support', c: 30000, d: 150, gl: 4, cr: 1, lc: 8, sp: [3, [0, 1, 2, 3]] },
    { n: 'Enlighten Support', c: 8000, d: 40, gl: 3, lc: 30 },
    { n: 'Vaal Grace', c: 50, gl: 21, gq: 23, cr: 1, lc: 15 }, { n: 'Vaal Grace', c: 5, gl: 20, gq: 20, lc: 90 },
    { n: 'Grace', c: 1, gl: 1, lc: 300 }, { n: 'Grace', c: 12, gl: 21, gq: 20, cr: 1, lc: 22 }] },
  Beast: { ok: true, type: 'Beast', at, divine: 200, counts, lines: [
    { n: 'Black Mórrigan', c: 300, d: 1.5, lc: 12 }, { n: 'Vivid Vulture', c: 60, lc: 20 }] },
};
const page = document.getElementById('market-page');
const M = window.__mk = {
  NJ, page,
  rail: id => page.querySelector('.mk-rail-item[data-cat="' + id + '"]'),
  go: async (id, sel) => {
    M.rail(id).click();
    await H.waitFor(() => page.querySelector(sel || '.mk-table tbody tr .mk-name, .mk-table .data-empty'), 5000, 'category ' + id);
    await H.sleep(20);
  },
  names: () => [...page.querySelectorAll('.mk-table tbody tr .mk-name')].map(e => e.textContent),
  row: name => [...page.querySelectorAll('.mk-table tbody tr')].find(tr => (tr.querySelector('.mk-name') || {}).textContent === name),
  cells: tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()),
  sortBy: async key => {
    const b = page.querySelector('.mk-table .th-sort[data-sort="' + key + '"]');
    b.focus(); b.click(); await H.sleep(20);
  },
  set: async (mk, value) => {
    const el = page.querySelector('.mk-table [data-mk="' + mk + '"]');
    el.focus();
    if (el.type === 'checkbox') { el.checked = value; el.dispatchEvent(new Event('change')); }
    else { el.value = value; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input')); }
    await H.sleep(20);
  },
  drawer: () => page.querySelector('.mk-drawer'),
  esc: () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
};
window.__stubOverrides.cx_overview = { ok: true, hour, items: cx };
window.__stubOverrides.cx_history = { ok: true, hour, step: 1, series: { 'scarab-a': cx['scarab-a'].s }, names: {} };
"""

MAIN = SETUP + r"""
const out = {};
await H.loadBuild();
await loadMarket();
await H.waitFor(() => market && market.items['scarab-a'], 5000, 'the fixture market');
document.getElementById('market-tile').click();
await H.waitFor(() => page.querySelector('.mk-watch-list .mk-watch-row'), 5000, 'overview');
await H.sleep(60);

// ---- rail
out.current0 = (page.querySelector('.mk-rail-item[aria-current="page"]') || {}).dataset.cat;
out.groups = [...page.querySelectorAll('.mk-rail-label')].map(e => e.textContent);
const railCounts = () => Object.fromEntries([...page.querySelectorAll('.mk-rail-item')]
  .map(b => [b.dataset.cat, b.querySelector('.mk-rail-n').textContent]));
out.counts0 = railCounts();
out.railOrder = [...page.querySelectorAll('.mk-rail-item')].map(b => b.dataset.cat);
out.prefetch = H.calls('ninja_category').map(c => c.args);
M.rail('overview').focus();
document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
out.arrowDown = document.activeElement.dataset.cat;
document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
out.end = document.activeElement.dataset.cat;
out.railIsButtons = [...page.querySelectorAll('.mk-rail-item')].every(b => b.tagName === 'BUTTON');

// ---- overview: everything it had
out.overview = { movers: page.querySelectorAll('.mk-main .mk-movers .mk-mover').length,
  chart: !!page.querySelector('.mk-main .mk-chart svg'), chartTitle: H.text('.mk-title', page),
  watch: page.querySelectorAll('.mk-watch-list .mk-watch-row').length, conv: H.text('.mk-conv-out', page),
  flips: !!page.querySelector('.mk-main .mk-flips'), table: !!page.querySelector('.mk-table'),
  ranges: page.querySelectorAll('.mk-chart .segmented .seg').length };

// ---- an exchange category
await M.go('cx:scarabs');
out.scarabs = M.names();
out.scarabHead = [...page.querySelectorAll('.mk-table thead th')].map(th => th.textContent.trim());
out.scarabSorted = page.querySelector('.mk-table th[aria-sort]').textContent.trim() + ':' + page.querySelector('.mk-table th[aria-sort]').getAttribute('aria-sort');
out.scarabRow = M.cells(M.row('Divination Scarab of Curation'));
out.scarabSpark = !!M.row('Ambush Scarab').querySelector('.spark svg');
out.scarabThin = M.row('Bestiary Scarab').textContent.includes('thin');
out.noIcon = M.row('Ambush Scarab').querySelector('.mk-noic').textContent;
await M.sortBy('c');
out.byValue = M.names();
await M.sortBy('c');
out.byValueUp = M.names();
await M.sortBy('name');
out.byName = M.names();
out.sortFocus = document.activeElement.dataset.sort || null;
await M.sortBy('n');
await M.set('q', 'curation');
out.search = M.names();
out.searchFocusKept = document.activeElement === page.querySelector('.mk-table [data-mk="q"]');
await M.set('q', '');
await M.set('thin', true);
out.hideThin = M.names();
await M.set('thin', false);
out.watchN0 = railCounts().watch;
M.row('Ambush Scarab').querySelector('.mk-star').click();
await H.sleep(30);
out.starOn = M.row('Ambush Scarab').querySelector('.mk-star').textContent.trim();
out.watchN1 = railCounts().watch;
// drawer: an exchange item keeps the chart, range buttons, alert form and star
const scarabBtn = M.row('Ambush Scarab').querySelector('.mk-item');
out.rowIsButton = scarabBtn.tagName === 'BUTTON';
scarabBtn.focus();
scarabBtn.click();
await H.waitFor(() => M.drawer() && !M.drawer().hidden && M.drawer().querySelector('.pc svg'), 5000, 'exchange drawer');
const d1 = M.drawer();
out.cxDrawer = { title: H.text('.mk-title', d1), price: H.text('.mk-price', d1), ranges: d1.querySelectorAll('.segmented .seg').length,
  alertForm: !!d1.querySelector('.mk-alert'), star: !!H.button(d1, '★ Watching'), bell: !!H.button(d1, '🔔 Alert'),
  focus: document.activeElement.classList.contains('mk-drawer-close'), rowSel: M.row('Ambush Scarab').classList.contains('sel'),
  beside: M.drawer().getBoundingClientRect().left > page.querySelector('.mk-table').getBoundingClientRect().right - 2 };
const h0 = H.calls('cx_history').length;
[...d1.querySelectorAll('.segmented .seg')].find(b => b.textContent === '1 day').click();
await H.waitFor(() => H.calls('cx_history').length > h0 && M.drawer().querySelector('.pc svg'), 5000, '1-day chart');
out.cxRange = H.calls('cx_history').slice(-1)[0].args[2];
M.esc();
await H.sleep(30);
out.cxEsc = { hidden: M.drawer().hidden, focusKey: document.activeElement.dataset.key || null,
  rowSel: M.row('Ambush Scarab').classList.contains('sel') };
// a click anywhere on the row opens it too; the close button shuts it
M.row('Bestiary Scarab').querySelector('td.num').click();
await H.sleep(30);
out.rowClick = !M.drawer().hidden && H.text('.mk-title', M.drawer());
M.drawer().querySelector('.mk-drawer-close').click();
await H.sleep(20);
out.closeBtn = { hidden: M.drawer().hidden, focusKey: document.activeElement.dataset.key || null };
// the starred scarab is on the Watchlist entry
await M.go('watch');
out.watchlist = M.names();
// other general categories: nothing dropped
await M.go('cx:other');
out.other = M.names().sort();
await M.go('cx:oils');
out.oils = M.names();

// ---- a snapshot category: unique weapons
window.__stubOverrides.ninja_category = NJ.UniqueWeapon;
await M.go('nj:UniqueWeapon', '.mk-table tbody tr .mk-name');
out.njCall = H.calls('ninja_category').slice(-1)[0].args;
out.weapons = M.names();
out.weaponHead = [...page.querySelectorAll('.mk-table thead th')].map(th => th.textContent.trim());
out.weaponRows = [...page.querySelectorAll('.mk-table tbody tr')].map(M.cells);
out.weaponSubs = [...page.querySelectorAll('.mk-table tbody tr .mk-sub')].map(e => e.textContent.trim());
out.weaponFilters = [...page.querySelectorAll('.mk-toolbar .field-label')].map(e => e.textContent);
out.noStar = !page.querySelector('.mk-table .mk-star');
out.countsAfter = railCounts();
await H.waitFor(() => !page.querySelector('.mk-table tbody img'), 5000, 'blocked icons to fall back');
out.iconFallback = [...page.querySelectorAll('.mk-table tbody tr')].map(tr => (tr.querySelector('.mk-noic') || {}).textContent || null);
out.sparks = [...page.querySelectorAll('.mk-table tbody tr')].map(tr => !!tr.querySelector('.spark svg'));
await M.set('f:l', '6');
out.links6 = M.weaponRows = [...page.querySelectorAll('.mk-table tbody tr')].map(M.cells).map(c => c[1]);
await M.set('f:l', '0');
out.linksNone = M.names().length;
await M.set('f:l', '');
await M.set('thin', true);
out.confident = [...page.querySelectorAll('.mk-table tbody tr')].map(M.cells).map(c => c[1]);
await M.set('thin', false);
await M.sortBy('name');
out.wByName = M.names();
await M.sortBy('name');
out.wByNameDown = M.names();
await M.sortBy('n');
out.wByListings = [...page.querySelectorAll('.mk-table tbody tr')].map(M.cells).map(c => c[5]);
await M.sortBy('c');
// drawer: sparkline enlarged, listings, a poe.ninja link
const wBtn = page.querySelector('.mk-table tbody tr .mk-item');
wBtn.focus();
wBtn.click();
await H.waitFor(() => !M.drawer().hidden, 3000, 'snapshot drawer');
const d2 = M.drawer();
const n0 = H.calls('open_url').length;
H.button(d2, 'poe.ninja ↗').click();
await H.sleep(30);
out.njDrawer = { title: H.text('.mk-title', d2), price: H.text('.mk-price', d2), sub: H.text('.mk-sub', d2),
  spark: !!d2.querySelector('.mk-drawer-spark .spark svg'), stats: [...d2.querySelectorAll('.mk-stat')].map(e => e.textContent),
  noChart: !d2.querySelector('.pc'), url: (H.calls('open_url')[n0] || { args: [] }).args[0],
  league: document.getElementById('league').value };
M.esc();
await H.sleep(30);
out.njEsc = { hidden: M.drawer().hidden, focusKey: document.activeElement.dataset.key || null };

// ---- gems: level / quality / corrupted
window.__stubOverrides.ninja_category = NJ.SkillGem;
await M.go('nj:SkillGem', '.mk-table tbody tr .mk-name');
out.gemFilters = [...page.querySelectorAll('.mk-toolbar .field-label')].map(e => e.textContent);
out.gems = [...page.querySelectorAll('.mk-table tbody tr')].map(M.cells).map(c => c[0] + ' | ' + c[1]);
out.gemLevels = [...page.querySelector('[data-mk="f:gl"]').options].map(o => o.value);
out.corruptedChips = page.querySelectorAll('.mk-table tbody .badge.tone-danger').length;
await M.set('f:gl', '21');
out.gl21 = M.names();
await M.set('f:gq', '23');
out.gl21q23 = M.names();
await M.set('f:gl', '');
await M.set('f:gq', '');
await M.set('f:cr', '0');
out.clean = [...page.querySelectorAll('.mk-table tbody tr')].map(M.cells).map(c => c[1]);
await M.set('f:cr', '1');
out.corrupted = M.names().length;
await M.set('f:cr', '');
out.savedCat = localStorage.getItem('pobtf-market-cat');
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-market-cat' && c.args[1] === 'nj:SkillGem');
return out;
"""

NARROW = r"""
const H = window.__e2e, M = window.__mk, page = M.page;
const sel = page.querySelector('.mk-rail-select');
const out = { listHidden: !H.visible(page.querySelector('.mk-rail-list')), selectShown: H.visible(sel), value: sel.value,
  groups: [...sel.querySelectorAll('optgroup')].map(g => g.label),
  option: [...sel.options].find(o => o.value === 'cx:scarabs').textContent };
sel.value = 'cx:scarabs';
sel.dispatchEvent(new Event('change'));
await H.waitFor(() => M.names().includes('Ambush Scarab'), 3000, 'scarabs through the select');
out.names = M.names().length;
M.row('Ambush Scarab').querySelector('.mk-item').click();
await H.sleep(40);
out.below = M.drawer().getBoundingClientRect().top >= page.querySelector('.mk-table').getBoundingClientRect().bottom - 2;
out.noScroll = document.documentElement.scrollWidth <= window.innerWidth + 1;
// back to gems for the reload check
const s2 = page.querySelector('.mk-rail-select');
s2.value = 'nj:SkillGem';
s2.dispatchEvent(new Event('change'));
await H.waitFor(() => M.names().includes('Vaal Grace'), 3000, 'gems again');
return out;
"""

RELOAD = SETUP + r"""
const out = {};
window.__stubOverrides.ninja_category = NJ.SkillGem;
await H.loadBuild();
await H.marketReady();
document.getElementById('market-tile').click();
await H.waitFor(() => page.querySelector('.mk-table tbody tr .mk-name'), 5000, 'the remembered category');
out.current = page.querySelector('.mk-rail-item[aria-current="page"]').dataset.cat;
out.names = M.names().length;
out.noOverview = !page.querySelector('.mk-movers');

// ---- the bridge fails: say so, offer Retry, no empty table
window.__stubOverrides.ninja_category = { ok: false, error: 'backend down (e2e)' };
const c0 = H.calls('ninja_category').length;
M.rail('nj:Beast').click();
await H.waitFor(() => page.querySelector('.mk-error'), 5000, 'the error state');
const err = page.querySelector('.mk-error');
out.err = { text: err.textContent, role: err.getAttribute('role'), retry: !!H.button(err, 'Retry'),
  table: !!page.querySelector('.mk-table table'), calls: H.calls('ninja_category').length - c0 };
await H.sleep(150);
out.err.noLoop = H.calls('ninja_category').length - c0;
window.__stubOverrides.ninja_category = NJ.Beast;
H.button(err, 'Retry').click();
await H.waitFor(() => M.names().includes('Black Mórrigan'), 5000, 'beasts after Retry');
out.afterRetry = { names: M.names(), error: !!page.querySelector('.mk-error'), calls: H.calls('ninja_category').length - c0,
  div: M.cells(M.row('Black Mórrigan'))[2] };
// an alert's "View" jump lands on the Overview chart without forgetting the chosen category
selectMarketItem('exalted', true);
await H.sleep(40);
out.jump = { current: page.querySelector('.mk-rail-item[aria-current="page"]').dataset.cat, title: H.text('.mk-chart .mk-title', page),
  saved: localStorage.getItem('pobtf-market-cat') };
return out;
"""


def run(s, tag, check):
    s.fresh()
    # wide enough for the drawer to sit beside the table (it drops below under 1500px)
    s.b.send("Emulation.setDeviceMetricsOverride", {"width": 1700, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
    try:
        r = s.run(MAIN, timeout=90)
    finally:
        s.b.send("Emulation.clearDeviceMetricsOverride")
    check(tag + " opens on Overview; rail groups General / Equipment & gems / Atlas / Other", r["current0"] == "overview"
          and r["groups"] == ["General", "Equipment & gems", "Atlas", "Other"], (r["current0"], r["groups"]))
    c = r["counts0"]
    check(tag + " rail counts: exchange items split by feed category and by name (scarabs, oils)",
          (c.get("cx:currency"), c.get("cx:scarabs"), c.get("cx:fragments"), c.get("cx:essences"), c.get("cx:cards"),
           c.get("cx:oils"), c.get("cx:other"), c.get("watch")) == ("3", "3", "1", "1", "1", "1", "2", "3"), c)
    check(tag + " rail: empty exchange categories are left out, every snapshot category is listed",
          "cx:catalysts" not in c and "cx:tattoos" not in c and all(("nj:" + t) in c for t in (
              "UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueFlask", "UniqueJewel", "UniqueRelic",
              "UniqueTincture", "ForbiddenJewel", "ClusterJewel", "SkillGem", "Map", "UniqueMap", "Invitation",
              "Memory", "Beast")) and r["railOrder"][:2] == ["overview", "watch"], r["railOrder"])
    check(tag + " rail: snapshot counts unknown until the snapshot is read (asked once on open)",
          c.get("nj:UniqueWeapon") == "" and len(r["prefetch"]) == 1 and r["prefetch"][0][1] == "UniqueWeapon", r["prefetch"])
    check(tag + " rail: buttons, arrow keys and End move the focus", r["railIsButtons"] and r["arrowDown"] == "watch"
          and r["end"] == "nj:Beast", (r["arrowDown"], r["end"]))
    o = r["overview"]
    check(tag + " Overview keeps movers, chart with ranges, watchlist, converter and the gaps; no table",
          o["movers"] >= 2 and o["chart"] and o["chartTitle"] == "Divine Orb" and o["watch"] == 3 and o["ranges"] == 3
          and (o["conv"] or "").startswith("Worth") and o["flips"] and not o["table"], o)

    check(tag + " Scarabs: its 3 items, busiest first", r["scarabs"] == ["Ambush Scarab", "Divination Scarab of Curation",
          "Bestiary Scarab"] and r["scarabSorted"] == "Volume / h:descending", (r["scarabs"], r["scarabSorted"]))
    check(tag + " exchange columns: item, chaos, divine, 7-day line, 7-day change, volume, star",
          r["scarabHead"] == ["Item", "Chaos", "Divine", "Last 7 days", "7-day change", "Volume / h", "★"], r["scarabHead"])
    row = r["scarabRow"]
    check(tag + " exchange row: 80c = 0.4 div at 200c, change with the amount, volume", row[1] == "80c" and row[2] == "0.4 div"
          and "▼ 20.0%" in row[4] and "−20c" in row[4] and row[5].startswith("9000c"), row)
    check(tag + " exchange row: sparkline, thin chip, and a missing icon shows the initial",
          r["scarabSpark"] and r["scarabThin"] and r["noIcon"] == "A", (r["scarabSpark"], r["scarabThin"], r["noIcon"]))
    check(tag + " sort by value: high to low, then low to high", r["byValue"] == ["Divination Scarab of Curation",
          "Ambush Scarab", "Bestiary Scarab"] and r["byValueUp"] == r["byValue"][::-1], (r["byValue"], r["byValueUp"]))
    check(tag + " sort by name A to Z; the header keeps the focus", r["byName"] == sorted(r["scarabs"])
          and r["sortFocus"] == "name", (r["byName"], r["sortFocus"]))
    check(tag + " search narrows the table and keeps the caret in the box", r["search"] == ["Divination Scarab of Curation"]
          and r["searchFocusKept"], r["search"])
    check(tag + " Hide thin markets drops the thin one", r["hideThin"] == ["Ambush Scarab", "Divination Scarab of Curation"],
          r["hideThin"])
    check(tag + " star: the row and the Watchlist count follow", r["starOn"] == "★" and r["watchN0"] == "3"
          and r["watchN1"] == "4", (r["starOn"], r["watchN0"], r["watchN1"]))
    d = r["cxDrawer"]
    check(tag + " exchange drawer: price chart, 3 ranges, alert form, watch star; beside the table",
          r["rowIsButton"] and d["title"] == "Ambush Scarab" and d["price"].startswith("5c") and d["ranges"] == 3
          and d["alertForm"] and d["star"] and d["bell"] and d["beside"], d)
    check(tag + " drawer opens with focus on Close and marks its row", d["focus"] and d["rowSel"], d)
    check(tag + " drawer range button loads that history", r["cxRange"] == 1, r["cxRange"])
    check(tag + " Esc closes the drawer and focus returns to the row", r["cxEsc"] == {"hidden": True,
          "focusKey": "scarab-a", "rowSel": False}, r["cxEsc"])
    check(tag + " a click on the row opens it; Close returns focus to that row", r["rowClick"] == "Bestiary Scarab"
          and r["closeBtn"] == {"hidden": True, "focusKey": "scarab-c"}, (r["rowClick"], r["closeBtn"]))
    check(tag + " Watchlist entry lists the starred items", sorted(r["watchlist"]) == ["Ambush Scarab", "Divine Orb",
          "Exalted Orb", "Mirror of Kalandra"], r["watchlist"])
    check(tag + " unknown feed categories: placed by name (Golden Oil), the rest in Other, none dropped",
          r["other"] == ["Brand New Thing", "Merrick's Ducat"] and r["oils"] == ["Golden Oil"], (r["other"], r["oils"]))

    check(tag + " snapshot category asks the bridge for its type and league", r["njCall"][1] == "UniqueWeapon"
          and r["njCall"][0] == r["njDrawer"]["league"], r["njCall"])
    check(tag + " unique weapons: dearest first", [x[1] for x in r["weaponRows"]] == ["4000c", "900c", "600c", "150c", "2c"]
          and r["weapons"][0] == "Starforge", r["weaponRows"])
    check(tag + " snapshot columns: listings instead of volume, no star", r["weaponHead"] == ["Item", "Chaos", "Divine",
          "Last 7 days", "7-day change", "Listings"] and r["noStar"], r["weaponHead"])
    w = r["weaponRows"]
    check(tag + " divine column = chaos / divine rate (4000c = 20 div, 150c = 0.75 div, 2c = 0.01 div)",
          [x[2] for x in w] == ["20 div", "4.5 div", "3 div", "0.75 div", "0.01 div"], [x[2] for x in w])
    check(tag + " 7-day change from the snapshot's trend, with the amount; none = a dash", "▲ 25.0%" in w[0][4]
          and "+4 div" in w[0][4] and "▼ 10.0%" in w[2][4] and w[1][4] == "—", [x[4] for x in w])
    check(tag + " sub-line: base, variant, links", r["weaponSubs"][0] == "Infernal Sword · 6-link"
          and "Vaal Rapier · Veiled" in r["weaponSubs"], r["weaponSubs"])
    check(tag + " few listings are flagged", w[1][5].startswith("3") and "few" in w[1][5] and w[0][5] == "12", [x[5] for x in w])
    check(tag + " sparkline where there is a trend, words where there is none", r["sparks"] == [True, False, True, True, False]
          and "no trend yet" in w[1][3], r["sparks"])
    check(tag + " icons that fail to load fall back to the initial, never an empty cell",
          r["iconFallback"] == ["S", "S", "S", "P", "A"], r["iconFallback"])
    check(tag + " the snapshot's counts reach the rail", r["countsAfter"].get("nj:UniqueWeapon") == "5"
          and r["countsAfter"].get("nj:SkillGem") == "6" and r["countsAfter"].get("nj:Map") == "0", r["countsAfter"])
    check(tag + " uniques get a Links filter only", r["weaponFilters"] == ["Links"], r["weaponFilters"])
    check(tag + " links filter: 6-link, and under 5", r["links6"] == ["4000c"] and r["linksNone"] == 3,
          (r["links6"], r["linksNone"]))
    check(tag + " Hide low-confidence prices drops the 3-listing line", r["confident"] == ["4000c", "600c", "150c", "2c"],
          r["confident"])
    check(tag + " snapshot sort: name both ways, listings high to low", r["wByName"][0] == "Ahn's Might"
          and r["wByNameDown"][0] == "Starforge" and r["wByListings"][0] == "200", (r["wByName"], r["wByListings"]))
    n = r["njDrawer"]
    check(tag + " snapshot drawer: name, both prices, sub-line, enlarged sparkline, listings, no price chart",
          n["title"] == "Starforge" and n["price"] == "4000c · 20 div" and "6-link" in (n["sub"] or "") and n["spark"]
          and n["noChart"] and any(x.startswith("Listings") and x.endswith("12") for x in n["stats"]), n)
    check(tag + " snapshot drawer: the poe.ninja link opens the item's page for this league",
          (n["url"] or "").startswith("https://poe.ninja/poe1/economy/") and n["url"].endswith("/unique-weapons?name=Starforge"),
          n["url"])
    check(tag + " Esc closes the snapshot drawer and focus returns to the row", r["njEsc"] == {"hidden": True,
          "focusKey": "UniqueWeapon#1"}, r["njEsc"])

    check(tag + " gems get Level, Quality and Corrupted filters", r["gemFilters"] == ["Level", "Quality", "Corrupted"]
          and r["gemLevels"] == ["", "21", "20", "4", "3", "1"], (r["gemFilters"], r["gemLevels"]))
    check(tag + " gem rows: level, quality and a Corrupted chip in the sub-line",
          "Enlighten Support" in r["gems"][0] and "Level 4" in r["gems"][0] and "Corrupted" in r["gems"][0]
          and r["gems"][0].endswith("30.0Kc") and r["corruptedChips"] == 3, r["gems"])
    check(tag + " gem filters: level 21, then 21 + 23% quality", r["gl21"] == ["Vaal Grace", "Grace"]
          and r["gl21q23"] == ["Vaal Grace"], (r["gl21"], r["gl21q23"]))
    check(tag + " gem filters: not corrupted / corrupted", r["clean"] == ["8000c", "5c", "1c"] and r["corrupted"] == 3,
          (r["clean"], r["corrupted"]))
    check(tag + " the chosen category is saved (localStorage + bridge)", r["savedCat"] == "nj:SkillGem" and r["persisted"], r["savedCat"])

    # narrow window: the rail becomes a select, the drawer goes under the table
    s.b.send("Emulation.setDeviceMetricsOverride", {"width": 860, "height": 900, "deviceScaleFactor": 1, "mobile": False})
    try:
        r = s.run(NARROW, timeout=40)
    finally:
        s.b.send("Emulation.clearDeviceMetricsOverride")
    check(tag + " narrow: the rail is a select with the same groups and counts", r["listHidden"] and r["selectShown"]
          and r["value"] == "nj:SkillGem" and r["groups"] == ["General", "Equipment & gems", "Atlas", "Other"]
          and r["option"] == "Scarabs (3)", r)
    check(tag + " narrow: the select switches category; the drawer sits below the table; no sideways scroll",
          r["names"] == 3 and r["below"] and r["noScroll"], r)

    # a reload (same storage): the category comes back
    s.b.take_events()
    s.b.navigate(s.url, READY_JS, timeout=30)
    r = s.run(RELOAD, timeout=60)
    check(tag + " after a reload the Market opens on the remembered category", r["current"] == "nj:SkillGem"
          and r["names"] == 6 and r["noOverview"], r)
    e = r["err"]
    check(tag + " bridge failure: an error state with the reason and Retry, no table", "backend down (e2e)" in e["text"]
          and e["text"].startswith("Couldn't load beasts") and e["role"] == "alert" and e["retry"] and not e["table"], e)
    check(tag + " bridge failure: asked once, not in a loop", e["calls"] == 1 and e["noLoop"] == 1, e)
    a = r["afterRetry"]
    check(tag + " Retry asks again and fills the table", a["names"] == ["Black Mórrigan", "Vivid Vulture"] and not a["error"]
          and a["calls"] == 2 and a["div"] == "1.5 div", a)
    check(tag + " selectMarketItem jumps to the Overview chart, the remembered category stays", r["jump"] == {
          "current": "overview", "title": "Exalted Orb", "saved": "nj:Beast"}, r["jump"])
