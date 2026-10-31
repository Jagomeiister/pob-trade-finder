// Shared UI components — one factory per pattern so every button, field, chip, table and
// popup looks and behaves the same (docs/UI-PLAN.md §4). Styles: css/components.css.
(function (root) {
  'use strict';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // opts: a string of extra classes, or { label, title, onClick, size: 'sm'|'md'|'lg', cls, ariaLabel }
  function normOpts(opts) {
    if (typeof opts === 'string') return { cls: opts };
    return opts || {};
  }

  var VARIANTS = { primary: 1, secondary: 1, ghost: 1, danger: 1 };

  // Button. variant: primary (one per area — the main action), secondary, ghost, danger
  function button(variant, opts) {
    opts = normOpts(opts);
    if (!VARIANTS[variant]) throw new Error('UI.button: unknown variant ' + variant);
    var b = el('button', 'btn btn-' + variant + (opts.size && opts.size !== 'md' ? ' btn-' + opts.size : '') +
      (opts.cls ? ' ' + opts.cls : ''), opts.label);
    b.type = 'button';
    if (opts.title) b.title = opts.title;
    if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  // Icon-only button: an accessible name is mandatory
  function iconButton(glyph, ariaLabel, opts) {
    if (!ariaLabel) throw new Error('UI.iconButton: aria label required for ' + glyph);
    opts = normOpts(opts);
    var b = button(opts.variant || 'ghost', { cls: 'btn-icon' + (opts.cls ? ' ' + opts.cls : ''), size: opts.size,
      onClick: opts.onClick, title: opts.title || ariaLabel, ariaLabel: ariaLabel, label: glyph });
    return b;
  }

  // options: ['a', 'b'] or [['value', 'Label'], ...]
  function select(options, value, opts) {
    opts = normOpts(opts);
    var s = el('select', opts.cls || '');
    options.forEach(function (o) {
      var pair = Array.isArray(o) ? o : [o, o];
      var opt = el('option', null, pair[1]);
      opt.value = pair[0];
      s.appendChild(opt);
    });
    if (value !== undefined && value !== null) s.value = value;
    if (opts.title) s.title = opts.title;
    if (opts.ariaLabel) s.setAttribute('aria-label', opts.ariaLabel);
    if (opts.onChange) s.addEventListener('change', opts.onChange);
    return s;
  }

  // opts: { type, placeholder, cls, width, min, max, step, value, ariaLabel }
  function input(opts) {
    opts = normOpts(opts);
    var i = el('input', opts.cls || '');
    i.type = opts.type || 'text';
    ['placeholder', 'min', 'max', 'step', 'value'].forEach(function (k) {
      if (opts[k] !== undefined && opts[k] !== null) i[k] = opts[k];
    });
    if (opts.width) i.style.width = opts.width;
    if (opts.ariaLabel) i.setAttribute('aria-label', opts.ariaLabel);
    return i;
  }

  // Inline labelled control ("Match: [select]"). Returns the <label>; the control is inside it.
  function field(label, control, opts) {
    opts = normOpts(opts);
    var w = el('label', 'field' + (opts.cls ? ' ' + opts.cls : ''));
    w.appendChild(el('span', 'field-label', label));
    w.appendChild(control);
    if (opts.title) w.title = opts.title;
    if (opts.parent) opts.parent.appendChild(w);
    return w;
  }

  var TONES = { neutral: 1, accent: 1, success: 1, warn: 1, danger: 1, info: 1, magic: 1, crafted: 1,
                exarch: 1, eater: 1, gem: 1, divine: 1, unique: 1 };

  // Chip/badge: soft tinted pill with words, never colour alone
  function chip(text, tone, cls) {
    if (tone && !TONES[tone]) throw new Error('UI.chip: unknown tone ' + tone);
    return el('span', 'badge' + (tone && tone !== 'neutral' ? ' tone-' + tone : '') + (cls ? ' ' + cls : ''), text);
  }

  // Section header: title + optional right-aligned actions
  function sectionHeader(title, actions) {
    var h = el('div', 'section-header');
    h.appendChild(el('span', 'section-title', title));
    if (actions && actions.length) {
      var a = el('span', 'section-actions');
      actions.forEach(function (x) { if (x) a.appendChild(x); });
      h.appendChild(a);
    }
    return h;
  }

  // Panel: { title, actions, cls } → { el, head, body }
  function panel(opts) {
    opts = normOpts(opts);
    var p = el('section', 'panel' + (opts.cls ? ' ' + opts.cls : ''));
    var head = null;
    if (opts.title) { head = sectionHeader(opts.title, opts.actions); p.appendChild(head); }
    var body = el('div', 'panel-body');
    p.appendChild(body);
    return { el: p, head: head, body: body };
  }

  // Data table. columns: [{ key, label, num, render(row) → Node|string, sort(row) → value }]
  // opts: { caption, rowClass(row), sortable, emptyText }
  function table(columns, rows, opts) {
    opts = opts || {};
    var t = el('table', 'data-table');
    if (opts.caption) t.appendChild(el('caption', null, opts.caption));
    var thead = el('thead'), hr = el('tr');
    var tbody = el('tbody');
    var sortKey = null, sortDir = 1;
    function fill() {
      tbody.innerHTML = '';
      var list = rows.slice();
      if (sortKey) {
        var col = columns.filter(function (c) { return c.key === sortKey; })[0];
        var val = col.sort || function (r) { return r[col.key]; };
        list.sort(function (a, b) {
          var x = val(a), y = val(b);
          return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
        });
      }
      if (!list.length && opts.emptyText) {
        var er = el('tr'), ec = el('td', 'data-empty', opts.emptyText);
        ec.colSpan = columns.length;
        er.appendChild(ec); tbody.appendChild(er);
      }
      list.forEach(function (r) {
        var tr = el('tr', opts.rowClass ? opts.rowClass(r) || '' : '');
        columns.forEach(function (c) {
          var td = el('td', c.num ? 'num' : '');
          var v = c.render ? c.render(r) : r[c.key];
          if (v && v.nodeType) td.appendChild(v);
          else td.textContent = v === undefined || v === null ? '' : v;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    columns.forEach(function (c) {
      var th = el('th', c.num ? 'num' : '');
      th.scope = 'col';
      if (opts.sortable && c.label) {
        var sb = el('button', 'th-sort', c.label);
        sb.type = 'button';
        sb.addEventListener('click', function () {
          sortDir = sortKey === c.key ? -sortDir : 1;
          sortKey = c.key;
          hr.querySelectorAll('th').forEach(function (x) { x.removeAttribute('aria-sort'); });
          th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
          fill();
        });
        th.appendChild(sb);
      } else {
        th.textContent = c.label || '';
      }
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    t.appendChild(thead);
    t.appendChild(tbody);
    fill();
    t.setRows = function (r) { rows = r; fill(); };
    return t;
  }

  // Disclosure ("More filters (2 changed)"). opts: { open, count }
  function disclosure(summary, content, opts) {
    opts = opts || {};
    var d = el('details', 'disclosure');
    var s = el('summary', null);
    s.appendChild(el('span', 'disclosure-label', summary));
    var badge = chip('', 'accent', 'disclosure-count');
    s.appendChild(badge);
    d.appendChild(s);
    if (content) d.appendChild(content);
    d.setCount = function (n) {
      badge.textContent = n ? n + ' changed' : '';
      badge.hidden = !n;
    };
    d.setCount(opts.count || 0);
    if (opts.open) d.open = true;
    return d;
  }

  // ---- floating layers: one open at a time, Esc / outside click closes --------
  var openLayer = null;
  function closeLayer() {
    if (!openLayer) return;
    var l = openLayer;
    openLayer = null;
    if (l.keep) l.el.hidden = true; else l.el.remove();
    if (l.trigger) l.trigger.setAttribute('aria-expanded', 'false');
    if (l.onClose) l.onClose();
  }
  function place(layer, trigger) {
    layer.hidden = false;
    var r = trigger.getBoundingClientRect();
    layer.style.top = (r.bottom + window.scrollY + 4) + 'px';
    document.body.appendChild(layer);
    var w = layer.offsetWidth;
    var left = layer.dataset.align === 'start' ? r.left + window.scrollX : r.right + window.scrollX - w;
    layer.style.left = Math.max(8, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 8)) + 'px';
  }
  function openFloating(layer, trigger, onClose, keep) {
    closeLayer();
    place(layer, trigger);
    openLayer = { el: layer, trigger: trigger, onClose: onClose, keep: keep };
    trigger.setAttribute('aria-expanded', 'true');
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('mousedown', function (e) {
      if (openLayer && !openLayer.el.contains(e.target) && !openLayer.trigger.contains(e.target)) closeLayer();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openLayer) {
        var t = openLayer.trigger;
        closeLayer();
        t.focus();
      }
    });
    window.addEventListener('resize', closeLayer);
  }

  // Menu: ⋯ trigger + list of actions. items: [{ label, onClick, disabled, hidden, danger }]
  // items may be a function returning that list, so labels can reflect current state.
  function menu(items, opts) {
    opts = normOpts(opts);
    var trigger = iconButton(opts.glyph || '⋯', opts.ariaLabel || 'More actions',
      { variant: opts.variant || 'secondary', cls: 'menu-trigger' + (opts.cls ? ' ' + opts.cls : ''), size: opts.size });
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    function open() {
      var list = el('div', 'menu');
      list.setAttribute('role', 'menu');
      var buttons = [];
      (typeof items === 'function' ? items() : items).forEach(function (it) {
        if (!it || it.hidden) return;
        var b = el('button', 'menu-item' + (it.danger ? ' danger' : ''), it.label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.disabled = !!it.disabled;
        if (it.title) b.title = it.title;
        b.addEventListener('click', function () { closeLayer(); trigger.focus(); it.onClick(); });
        list.appendChild(b);
        buttons.push(b);
      });
      list.addEventListener('keydown', function (e) {
        var i = buttons.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          var n = buttons.length;
          var j = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
          buttons[j].focus();
        } else if (e.key === 'Tab') { closeLayer(); }
      });
      openFloating(list, trigger);
      var first = buttons.filter(function (b) { return !b.disabled; })[0];
      if (first) first.focus();
    }
    trigger.addEventListener('click', function () {
      if (openLayer && openLayer.trigger === trigger) closeLayer(); else open();
    });
    return trigger;
  }

  // Popover: trigger toggles a floating panel holding `content`. The panel stays in the
  // document while closed (hidden), so controls inside keep working by id.
  function popover(trigger, content, opts) {
    opts = opts || {};
    var box = el('div', 'popover' + (opts.cls ? ' ' + opts.cls : ''));
    box.hidden = true;
    if (opts.align) box.dataset.align = opts.align; // 'start' = left edges line up (default: right edges)
    box.setAttribute('role', 'dialog');
    if (opts.label) box.setAttribute('aria-label', opts.label);
    box.appendChild(content);
    document.body.appendChild(box);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.addEventListener('click', function () {
      if (openLayer && openLayer.trigger === trigger) { closeLayer(); return; }
      openFloating(box, trigger, opts.onClose, true);
      var f = box.querySelector('select, input, button, textarea');
      if (f) f.focus();
    });
    return box;
  }

  // Dialog → Promise<boolean>. opts: { title, body (string|Node), confirmLabel, cancelLabel, danger }
  function dialog(opts) {
    return new Promise(function (resolve) {
      var d = el('dialog', 'ui-dialog' + (opts.danger ? ' danger' : ''));
      d.setAttribute('aria-labelledby', 'ui-dialog-title');
      var t = el('h2', 'ui-dialog-title', opts.title || 'Are you sure?');
      t.id = 'ui-dialog-title';
      d.appendChild(t);
      var body = el('div', 'ui-dialog-body');
      if (opts.body && opts.body.nodeType) body.appendChild(opts.body); else body.textContent = opts.body || '';
      d.appendChild(body);
      var acts = el('div', 'ui-dialog-actions');
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        d.close();
        d.remove();
        resolve(v);
      }
      var cancel = button('secondary', { label: opts.cancelLabel || 'Cancel', onClick: function () { finish(false); } });
      var ok = button(opts.danger ? 'danger' : 'primary', { label: opts.confirmLabel || 'OK', onClick: function () { finish(true); } });
      acts.appendChild(cancel);
      acts.appendChild(ok);
      d.appendChild(acts);
      d.addEventListener('cancel', function (e) { e.preventDefault(); finish(false); });
      document.body.appendChild(d);
      d.showModal();
      (opts.danger ? cancel : ok).focus(); // destructive: safe choice has focus
    });
  }
  function confirmDanger(title, body, confirmLabel) {
    return dialog({ title: title, body: body, confirmLabel: confirmLabel || 'Delete', danger: true });
  }

  // Toast: transient message in a polite live region. tone: info|success|warn|danger
  // opts: { timeout (ms, 0 = sticky), action: { label, onClick } }
  function toast(message, tone, opts) {
    opts = opts || {};
    var host = document.getElementById('toasts');
    if (!host) {
      host = el('div', 'toasts');
      host.id = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    var t = el('div', 'toast tone-' + (tone || 'info'));
    t.appendChild(el('span', 'toast-msg', message));
    if (opts.action) {
      t.appendChild(button('ghost', { size: 'sm', label: opts.action.label, onClick: function () {
        t.remove(); opts.action.onClick();
      } }));
    }
    t.appendChild(iconButton('✕', 'Dismiss', { size: 'sm', onClick: function () { t.remove(); } }));
    host.appendChild(t);
    var ms = opts.timeout === undefined ? (tone === 'danger' ? 8000 : 5000) : opts.timeout;
    if (ms) setTimeout(function () { t.remove(); }, ms);
    return t;
  }

  // Empty state: { title, text, action (Node) }
  function emptyState(opts) {
    var e = el('div', 'empty-state');
    if (opts.title) e.appendChild(el('div', 'empty-title', opts.title));
    if (opts.text) e.appendChild(el('div', 'empty-text', opts.text));
    if (opts.action) e.appendChild(opts.action);
    return e;
  }

  var UI = { el: el, button: button, iconButton: iconButton, select: select, input: input, field: field,
             chip: chip, sectionHeader: sectionHeader, panel: panel, table: table, disclosure: disclosure,
             menu: menu, popover: popover, closePopups: closeLayer, dialog: dialog, confirmDanger: confirmDanger,
             toast: toast, emptyState: emptyState };
  if (typeof module !== 'undefined' && module.exports) module.exports = UI;
  else root.UI = UI;
})(typeof window !== 'undefined' ? window : this);
