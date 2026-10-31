// Design-token guard — run: node test/test_contrast.js
// Every text colour must reach WCAG AA (4.5:1) on the page and panel surfaces in every
// theme × accent × contrast combination, and colours may only be defined in css/tokens.css.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

// ---- parse tokens.css into blocks of {attrs, vars} -------------------------
const src = fs.readFileSync(path.join(ROOT, 'css', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = [];
src.replace(/([^{}]+)\{([^}]*)\}/g, function (_, sel, body) {
  const attrs = {};
  sel.replace(/\[data-([a-z]+)="([^"]+)"\]/g, function (m, k, v) { attrs[k] = v; return m; });
  const vars = {};
  body.split(';').forEach(function (decl) {
    const m = decl.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) vars[m[1]] = m[2];
  });
  blocks.push({ attrs, vars, n: Object.keys(attrs).length, order: blocks.length });
  return '';
});

// cascade for one <html> state: fewer attributes first (lower specificity), then source order
function resolve(state) {
  const vars = {};
  blocks.filter(function (b) {
    return Object.keys(b.attrs).every(function (k) { return state[k] === b.attrs[k]; });
  }).sort(function (a, b) { return a.n - b.n || a.order - b.order; })
    .forEach(function (b) { Object.assign(vars, b.vars); });
  return function get(name) {
    let v = vars[name];
    for (let i = 0; v && i < 10 && /^var\(/.test(v); i++) v = vars[v.slice(4, -1).trim()];
    return v;
  };
}

function rgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
  return [0, 2, 4].map(function (i) { return parseInt(full.slice(i, i + 2), 16); });
}
function lum(c) {
  const l = c.map(function (x) {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function mix(fg, bg, pct) { return fg.map(function (c, i) { return Math.round(c * pct + bg[i] * (1 - pct)); }); }

const TEXT = ['--text', '--text-2', '--text-3', '--accent', '--unique', '--rare', '--magic', '--normal',
  '--crafted', '--fractured', '--veiled', '--exarch', '--eater', '--gem', '--divine', '--price',
  '--success', '--warn', '--danger', '--info'];
const SURFACES = ['--bg', '--s1', '--s2'];
// chips/badges paint their own colour at --chip-tint over the panel (components.css .badge)
const CHIP = ['--accent', '--magic', '--crafted', '--exarch', '--eater', '--gem', '--divine',
  '--success', '--warn', '--danger', '--info', '--text-2', '--unique'];

const STATES = [];
['dark', 'light'].forEach(function (theme) {
  ['gold', 'crimson', 'teal', 'violet', 'green'].forEach(function (accent) {
    ['normal', 'high'].forEach(function (contrast) {
      const s = {};
      if (theme === 'light') s.theme = 'light';
      if (accent !== 'gold') s.accent = accent;
      if (contrast === 'high') s.contrast = 'high';
      STATES.push({ label: theme + '/' + accent + '/' + contrast, state: s });
    });
  });
});

STATES.forEach(function (st) {
  const get = resolve(st.state);
  const bad = [];
  let missing = [];
  TEXT.concat(SURFACES, ['--on-accent']).forEach(function (t) {
    if (!/^#[0-9a-f]{3,6}$/i.test(get(t) || '')) missing.push(t);
  });
  if (missing.length) { check(st.label + ': tokens are hex colours', false, missing.join(', ')); return; }
  TEXT.forEach(function (t) {
    SURFACES.forEach(function (s) {
      const r = ratio(rgb(get(t)), rgb(get(s)));
      if (r < 4.5) bad.push(t + ' on ' + s + ' ' + r.toFixed(2));
    });
  });
  CHIP.forEach(function (t) {
    ['--s1', '--s2'].forEach(function (s) {
      const fg = rgb(get(t)), bg = mix(fg, rgb(get(s)), parseFloat(get('--chip-tint')) / 100);
      const r = ratio(fg, bg);
      if (r < 4.5) bad.push(t + ' chip on ' + s + ' ' + r.toFixed(2));
    });
  });
  const oa = ratio(rgb(get('--on-accent')), rgb(get('--accent')));
  if (oa < 4.5) bad.push('--on-accent on --accent ' + oa.toFixed(2));
  const oh = ratio(rgb(get('--on-accent')), rgb(get('--accent-hover')));
  if (oh < 4.5) bad.push('--on-accent on --accent-hover ' + oh.toFixed(2));
  check(st.label + ': all text pairs reach AA', !bad.length, bad.slice(0, 6).join('; '));
});

// ---- colours live only in tokens.css; no focus-killing; no tiny text ---------
const cssDir = path.join(ROOT, 'css');
fs.readdirSync(cssDir).filter(function (f) { return /\.css$/.test(f) && f !== 'tokens.css'; }).forEach(function (f) {
  const lines = fs.readFileSync(path.join(cssDir, f), 'utf8').split(/\r?\n/);
  const hex = [], outline = [], small = [];
  lines.forEach(function (line, i) {
    const code = line.replace(/\/\*.*?\*\//g, '');
    if (/#[0-9a-f]{3,8}\b/i.test(code.replace(/url\([^)]*\)/g, ''))) hex.push(i + 1);
    if (/outline\s*:\s*(none|0)\b/.test(code)) outline.push(i + 1);
    const fs_ = code.match(/font-size\s*:\s*([\d.]+)px/);
    if (fs_ && parseFloat(fs_[1]) < 12 && !/allow-small/.test(line)) small.push(i + 1);
  });
  check(f + ': no colour literals outside tokens.css', !hex.length, 'lines ' + hex.join(', '));
  check(f + ': no outline:none (keeps keyboard focus visible)', !outline.length, 'lines ' + outline.join(', '));
  check(f + ': no font-size below 12px', !small.length, 'lines ' + small.join(', '));
});
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('index.html: no inline <style> block (CSS lives in css/)', !/<style[\s>]/i.test(html));
check('index.html: no colour literals', !/#[0-9a-f]{6}\b/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, '')));
['tokens', 'base', 'components', 'layout'].forEach(function (n) {
  check('index.html loads css/' + n + '.css', html.indexOf("'css/" + n + ".css'") >= 0);
});
// ---- shared components (js/ui.js) replace hand-built buttons and alerts --------
const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
check('no legacy button classes (use UI.button)', !/copy-btn|trade-btn/.test(app + html));
check('no alert() popups (use UI.toast)', !/[^.\w]alert\(/.test(app));
check('index.html loads js/ui.js before app.js',
  html.indexOf("'js/ui.js'") >= 0 && html.indexOf("'js/ui.js'") < html.indexOf("'js/app.js'"));
const UI = require('../js/ui.js');
['button', 'iconButton', 'select', 'input', 'field', 'chip', 'sectionHeader', 'panel', 'table', 'disclosure',
 'menu', 'popover', 'dialog', 'confirmDanger', 'toast', 'emptyState'].forEach(function (k) {
  check('UI.' + k + ' exported', typeof UI[k] === 'function');
});
let threw = false;
try { UI.iconButton('✕'); } catch (e) { threw = true; }
check('UI.iconButton refuses a missing aria label', threw);

const ship = fs.readFileSync(path.join(ROOT, 'tools', 'build_release.py'), 'utf8');
check('release ships every css file', fs.readdirSync(cssDir).filter(function (f) { return /\.css$/.test(f); })
  .every(function (f) { return ship.indexOf('"css/' + f + '"') >= 0; }));
check("release ships js/ui.js", ship.indexOf('"js/ui.js"') >= 0);

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
