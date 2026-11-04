// Loot filter editing tests — run: node test/test_filter_edit.js
// Synthetic NeverSink-like filters for the rules; the real NeverSink filter (if present) for scale.
const fs = require('fs');
const LF = require('../js/filter.js');
const FE = require('../js/filter-edit.js');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const j = (x) => JSON.stringify(x);

const REAL = 'C:\\Users\\jorda\\AppData\\Local\\Temp\\claude\\E--Claude-POE-Build-gear-search\\' +
  '36c35634-8368-4dfb-987f-c7a7b0a6758b\\scratchpad\\filters\\sample.filter';

const SRC = [
  '#name: synthetic',                                                    // 0
  '',
  'Show # $type->decorators $tier->glow',                                // 2  block 0
  '\tRarity Rare',
  '\tSetBorderColor 175 96 37',
  '\tContinue',
  '',
  'Show # $type->currency->stackedthree $tier->t0',                      // 7  block 1
  '\tAreaLevel < 68',
  '\tStackSize >= 20',
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Chaos Orb"',
  '',
  'Show # %DS4 $type->currency->stackedthree $tier->t1',                 // 13 block 2
  '\tStackSize >= 10',
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Chaos Orb" "Orb of Fusing"',
  '\tSetFontSize 45',
  '',
  'Show # %DS3 $type->currency->stackedthree $tier->t2',                 // 19 block 3
  '\tStackSize >= 3',
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Chaos Orb"',
  '\tSetFontSize 42',
  '',
  'Show # $type->currency->harvest $tier->t1lifeforce',                  // 25 block 4
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Vivid Crystallised Lifeforce" "Primal Crystallised Lifeforce"',
  '\tSetFontSize 40',
  '',
  '# [[4000]] Currency',
  'Show # %D5 $type->currency $tier->t1exalted',                         // 31 block 5
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Mirror of Kalandra" "Divine Orb" # top stuff',
  '\tSetFontSize 45',
  '\tSetTextColor 255 0 0 255 # red',
  '\t# a comment inside the block',
  '\tMinimapIcon 0 Red Star',
  '\tCustomAlertSound "divine sound.mp3" 300',
  '',
  'Show # %H8 $type->currency $tier->t2divine',                          // 40 block 6
  '    Class == "Stackable Currency"',
  '    BaseType == "Exalted Orb" "Orb of Annulment"',
  '    SetFontSize 42',
  '    PlayAlertSound 1 250',
  '',
  'Show # $type->currency $tier->t3chaos',                               // 46 block 7
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Chaos Orb" "Vaal Orb" "Gemcutter\'s Prism"',
  '\tSetFontSize 40',
  '\tPlayAlertSoundPositional 2 200',
  '',
  'Show # $type->currency $tier->t4alch',                                // 52 block 8
  '\tClass == "Stackable Currency"',
  '\tBaseType "Orb of Alchemy" "Chromatic"',
  '\tSetFontSize 38',
  '',
  'Show # $type->currency $tier->t5single',                              // 57 block 9
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Orb of Fusing"',
  '',
  'Hide # $type->currency $tier->t6trans',                               // 61 block 10
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Orb of Transmutation" "Scroll of Wisdom" "Gemcutter\'s Prism"',
  '\tSetFontSize 30',
  '',
  'Show # $type->currency $tier->exshow',                                // 66 block 11
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Stacked Deck"',
  '',
  'Show # $type->currency $tier->restex',                                // 70 block 12
  '\tClass == "Stackable Currency"',
  '\tSetFontSize 45',
  '',
  'Show # $type->currency->heist $tier->highstack',                      // 74 block 13
  '\tStackSize >= 3',
  '\tBaseType == "Rogue\'s Marker"',
  '',
  'Show',                                                                // 78 block 14 (untagged)
  '\tClass "Rings"',
  '\tRarity Rare',
  '\tSetFontSize 40',
  ''
].join('\n');

const P = LF.parse(SRC);
const B = {};
P.blocks.forEach(b => { if (b.tags) B[b.tags.type + ' ' + b.tags.tier] = b.index; });
const T = (tier, type) => B[(type || 'currency') + ' ' + tier];
const cur = (base, extra) => Object.assign({ class: 'Stackable Currency', base: base, rarity: 'Normal', stackSize: 1 }, extra || {});
const lines = (s) => s.split(/\r?\n/);
// line numbers whose text differs (same line count assumed)
function diffLines(a, b) {
  const x = lines(a), y = lines(b), out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(i);
  return out;
}

console.log('== fixture ==');
check('synthetic filter parses to 15 blocks', P.blocks.length === 15, String(P.blocks.length));
check('block index lookup works', T('t1exalted') === 5 && T('t1', 'currency->stackedthree') === 2 && T('restex') === 12);

// ---------------------------------------------------------------- labels
console.log('== tier labels ==');
check('tierLabel t1 -> T1, t2top -> T2 Top', FE.tierLabel('t1') === 'T1' && FE.tierLabel('t2top') === 'T2 Top', FE.tierLabel('t2top'));
check('tierLabel exhide -> Hidden, restex -> Rest', FE.tierLabel('exhide') === 'Hidden' && FE.tierLabel('restex') === 'Rest');
check('tierLabel title-cases the rest', FE.tierLabel('highstack') === 'Highstack' && FE.tierLabel('t1exalted') === 'T1 Exalted' &&
      FE.tierLabel('silver_coin') === 'Silver Coin' && FE.tierLabel('') === '', FE.tierLabel('t1exalted'));
check('isExceptionTier: ex, ex<digits>, exhide, exshow, 2x, 2x<digits>, exotic*',
      ['ex', 'ex2', 'ex12', 'exhide', 'exshow', '2x', '2x3', 'exotic', 'exoticbases', 'EXHIDE', ' ExShow '].every(FE.isExceptionTier));
check('isExceptionTier: normal tiers are not', !['t1', 'restex', 'highstack', 't2top', ''].some(FE.isExceptionTier));
const notEx = ['exalted', 'extra', 'expensive', 'ex2b', 'exhidden', '2xdouble', '2xx', 'x2', 't2x'];
check('isExceptionTier: exact slugs only (no "ex…"/"2x…" prefix match)', !notEx.some(FE.isExceptionTier),
      notEx.filter(FE.isExceptionTier).join(','));
check('an "exalted" tier is a valid move destination now', (() => {
  const f = 'Show # $type->currency $tier->exalted\n\tBaseType == "Exalted Orb"\nShow # $type->currency $tier->t2\n\tBaseType == "Chaos Orb" "Vaal Orb"\n';
  const t = FE.moveTargets(f, { class: 'Stackable Currency', base: 'Chaos Orb', rarity: 'Normal' }, 1);
  return t.length === 1 && t[0].ok === true;
})());

// ---------------------------------------------------------------- tier group / bases
console.log('== tier group ==');
{
  const g = FE.tierGroup(P, P.blocks[T('t3chaos')]);
  check('tierGroup: the 8 currency tiers in file order', eq(g.map(t => t.tier), ['t1exalted', 't2divine', 't3chaos', 't4alch', 't5single', 't6trans', 'exshow', 'restex']), j(g.map(t => t.tier)));
  check('tierGroup entries carry label, visibility, exception', g[5].label === 'T6 Trans' && g[5].visibility === 'Hide' && g[6].exception === true && g[0].exception === false && g[0].block === P.blocks[5]);
  check('tierGroup of an untagged block is empty', eq(FE.tierGroup(P, P.blocks[14]), []));
  check('tierGroup excludes sub-paths (currency->stackedthree)', !g.some(t => t.index === T('t1', 'currency->stackedthree')));
  check('tierBases lists the BaseType names', eq(FE.tierBases(P.blocks[T('t1exalted')]), ['Mirror of Kalandra', 'Divine Orb']));
  check('tierBases of a class rule is empty', eq(FE.tierBases(P.blocks[T('restex')]), []) && eq(FE.tierBases(null), []));
}

// ---------------------------------------------------------------- move targets
console.log('== move targets ==');
{
  const vaal = cur('Vaal Orb');
  const tg = FE.moveTargets(SRC, vaal, T('t3chaos'));
  const by = {}; tg.forEach(t => { by[t.tier] = t; });
  check('moveTargets lists every other sibling', eq(tg.map(t => t.tier), ['t1exalted', 't2divine', 't4alch', 't5single', 't6trans', 'exshow', 'restex']));
  check('earlier and later tiers with BaseType are ok', by.t2divine.ok && by.t1exalted.ok && by.t4alch.ok && by.t6trans.ok && by.t2divine.label === 'T2 Divine');
  check('exception tier refused', !by.exshow.ok && by.exshow.code === 'exception' && /exception/.test(by.exshow.reason), by.exshow.reason);
  check('tier without a BaseType line refused', !by.restex.ok && by.restex.code === 'no-basetype' && /no BaseType line/.test(by.restex.reason), by.restex.reason);

  const fus = FE.moveTargets(SRC, cur('Orb of Fusing'), T('t5single'));
  const f = {}; fus.forEach(t => { f[t.tier] = t; });
  check('only base + later destination refused (source would still win)', !f.t6trans.ok && f.t6trans.code === 'source-keeps' && /only base/.test(f.t6trans.reason), f.t6trans.reason);
  check('only base + earlier destination is ok (add only)', f.t3chaos.ok && f.t1exalted.ok);

  const chrom = FE.moveTargets(SRC, cur('Chromatic Orb'), T('t4alch'));
  const c = {}; chrom.forEach(t => { c[t.tier] = t; });
  check('substring token keeps it: later destination refused, names the token', !c.t6trans.ok && c.t6trans.code === 'source-keeps' && /"Chromatic"/.test(c.t6trans.reason), c.t6trans.reason);
  check('substring token: earlier destination ok', c.t2divine.ok);

  const st = FE.moveTargets(SRC, cur('Chaos Orb', { stackSize: 3 }), T('t2', 'currency->stackedthree'));
  const s = {}; st.forEach(t => { s[t.tier] = t; });
  check('destination\'s other conditions fail -> refused, quotes the condition', !s.t1.ok && s.t1.code === 'conditions' && /StackSize >= 10/.test(s.t1.reason), s.t1.reason);
  const st12 = FE.moveTargets(SRC, cur('Chaos Orb', { stackSize: 12 }), T('t2', 'currency->stackedthree'));
  const s12 = {}; st12.forEach(t => { s12[t.tier] = t; });
  check('already in the (earlier) destination and source can\'t give it up -> refused', !s12.t1.ok && s12.t1.code === 'already', s12.t1.reason);
  check('unknown condition (AreaLevel) does not refuse; StackSize does', s12.t0.code === 'conditions' && /StackSize >= 20/.test(s12.t0.reason), s12.t0.reason);
  check('untagged source -> no targets', eq(FE.moveTargets(SRC, { class: 'Rings', base: 'Ruby Ring', rarity: 'Rare' }, 14), []));
  check('bad index -> no targets', eq(FE.moveTargets(SRC, vaal, 99), []));
}

// ---------------------------------------------------------------- move base
console.log('== move base ==');
{
  const vaal = cur('Vaal Orb');
  const r = FE.moveBase(SRC, vaal, 'Vaal Orb', T('t3chaos'), T('t2divine'));
  check('moveBase ok', r.ok, r.reason);
  const L = lines(r.text);
  check('destination line gets the quoted base appended, indent kept', L[42] === '    BaseType == "Exalted Orb" "Orb of Annulment" "Vaal Orb"', L[42]);
  check('source line loses exactly that token', L[48] === '\tBaseType == "Chaos Orb" "Gemcutter\'s Prism"', L[48]);
  check('only those two lines changed', eq(diffLines(SRC, r.text), [42, 48]), j(diffLines(SRC, r.text)));
  check('change recorded as move-basetype', eq(r.change, { kind: 'move-basetype', base: 'Vaal Orb', fromType: 'currency', fromTier: 't3chaos', toType: 'currency', toTier: 't2divine' }), j(r.change));
  check('item now lands on the destination', r.landsOn === T('t2divine'), String(r.landsOn));
  check('input text untouched', SRC.indexOf('"Chaos Orb" "Vaal Orb"') !== -1);

  const back = FE.moveBase(r.text, vaal, 'Vaal Orb', T('t2divine'), T('t3chaos'));
  check('move back: ok, base appended at the end of the source tier', back.ok && lines(back.text)[48] === '\tBaseType == "Chaos Orb" "Gemcutter\'s Prism" "Vaal Orb"', lines(back.text)[48]);
  check('move back restores the destination line byte-for-byte', lines(back.text)[42] === lines(SRC)[42]);

  const cm = FE.moveBase(SRC, cur('Divine Orb'), 'Divine Orb', T('t1exalted'), T('t3chaos'));
  check('moving out of a line with a trailing comment keeps the comment', cm.ok && lines(cm.text)[33] === '\tBaseType == "Mirror of Kalandra" # top stuff', lines(cm.text)[33]);
  const ca = FE.moveBase(SRC, cur('Chaos Orb'), 'Chaos Orb', T('t3chaos'), T('t1exalted'));
  check('adding to a line with a trailing comment goes before the comment', ca.ok && lines(ca.text)[33] === '\tBaseType == "Mirror of Kalandra" "Divine Orb" "Chaos Orb" # top stuff', lines(ca.text)[33]);

  const add = FE.moveBase(SRC, cur('Orb of Fusing'), 'Orb of Fusing', T('t5single'), T('t3chaos'));
  check('only base, earlier destination: added, source untouched', add.ok && eq(diffLines(SRC, add.text), [48]) && lines(add.text)[59] === lines(SRC)[59]);
  check('add-only recorded as add-basetype', eq(add.change, { kind: 'add-basetype', base: 'Orb of Fusing', type: 'currency', tier: 't3chaos' }), j(add.change));
  check('item lands on the earlier destination', add.landsOn === T('t3chaos'), String(add.landsOn));

  const no = FE.moveBase(SRC, cur('Orb of Fusing'), 'Orb of Fusing', T('t5single'), T('t6trans'));
  check('refused move returns the original text and a reason', !no.ok && no.text === SRC && no.code === 'source-keeps' && no.reason && no.change === null);
  check('refused: exception destination', FE.moveBase(SRC, vaal, 'Vaal Orb', T('t3chaos'), T('exshow')).code === 'exception');
  check('refused: no BaseType line', FE.moveBase(SRC, vaal, 'Vaal Orb', T('t3chaos'), T('restex')).code === 'no-basetype');
  check('refused: same tier / bad index', FE.moveBase(SRC, vaal, 'Vaal Orb', 7, 7).code === 'same' && FE.moveBase(SRC, vaal, 'Vaal Orb', 7, 99).code === 'no-block');

  const out = FE.moveBase(SRC, cur('Stacked Deck'), 'Stacked Deck', T('exshow'), T('t1exalted'));
  check('can move out of an exception tier (only base there -> add only, earlier)', out.ok && out.change.kind === 'add-basetype', out.reason);

  const many = FE.moveBases(SRC, null, ['Chaos Orb', 'Vaal Orb'], T('t3chaos'), T('t2divine'));
  check('moveBases moves several in one write (no item = no condition check)', many.ok && lines(many.text)[42] === '    BaseType == "Exalted Orb" "Orb of Annulment" "Chaos Orb" "Vaal Orb"' &&
        lines(many.text)[48] === '\tBaseType == "Gemcutter\'s Prism"' && many.changes.length === 2, lines(many.text)[48]);
  const all = FE.moveBases(SRC, null, ['Chaos Orb', 'Vaal Orb', 'Gemcutter\'s Prism'], T('t3chaos'), T('t2divine'));
  check('moveBases refuses to empty the source tier', !all.ok && all.code === 'only' && /at least one/.test(all.reason), all.reason);
}

// ---------------------------------------------------------------- hide plan
console.log('== hide plan ==');
{
  const flip = FE.hidePlan(SRC, cur('Orb of Fusing'));
  check('(a) tier names only this base -> flip', flip.kind === 'flip' && flip.target === T('t5single') && flip.steps.length === 1 && flip.steps[0].op === 'flip', j(flip));
  const af = FE.applyHide(SRC, cur('Orb of Fusing'));
  check('flip: Show line -> Hide, rest of the line kept', af.ok && lines(af.text)[57] === 'Hide # $type->currency $tier->t5single' && eq(diffLines(SRC, af.text), [57]), lines(af.text)[57]);
  check('flip recorded as set-visibility', eq(af.change, { kind: 'set-visibility', type: 'currency', tier: 't5single', visibility: 'Hide' }), j(af.change));

  const sa = FE.hidePlan(SRC, cur('Vaal Orb'));
  check('(b) strip + add to the nearest Hide tier of the same path', sa.kind === 'strip-add' && sa.target === T('t6trans') &&
        eq(sa.steps.map(s => s.op + ':' + s.tier), ['strip:t3chaos', 'add:t6trans']), j(sa.steps));
  const ah = FE.applyHide(SRC, cur('Vaal Orb'));
  check('strip-add applied: two lines changed, item now hidden', ah.ok && eq(diffLines(SRC, ah.text), [48, 63]) &&
        LF.matchItem(LF.parse(ah.text), cur('Vaal Orb')).visibility === 'Hide', j(diffLines(SRC, ah.text)));
  check('one strip + one add recorded as a move', eq(ah.change, { kind: 'move-basetype', base: 'Vaal Orb', fromType: 'currency', fromTier: 't3chaos', toType: 'currency', toTier: 't6trans' }), j(ah.change));

  const anc = FE.hidePlan(SRC, cur('Primal Crystallised Lifeforce'));
  check('no Hide tier in currency->harvest -> ancestor path currency', anc.kind === 'strip-add' && anc.target === T('t6trans') &&
        anc.steps[0].tier === 't1lifeforce' && anc.steps[0].type === 'currency->harvest', j(anc));
  const aa = FE.applyHide(SRC, cur('Primal Crystallised Lifeforce'));
  check('ancestor hide applied and recorded as a cross-path move', aa.ok && aa.change.fromType === 'currency->harvest' && aa.change.toType === 'currency', j(aa.change));

  const strip = FE.hidePlan(SRC, cur('Gemcutter\'s Prism'));
  check('(c) stripping alone lands it on a Hide tier -> kind strip, no add', strip.kind === 'strip' && strip.target === T('t6trans') &&
        eq(strip.steps.map(s => s.op), ['strip']), j(strip));
  const as = FE.applyHide(SRC, cur('Gemcutter\'s Prism'));
  check('strip applied: one line, recorded as remove-basetype', as.ok && eq(diffLines(SRC, as.text), [48]) &&
        eq(as.change, { kind: 'remove-basetype', base: 'Gemcutter\'s Prism', type: 'currency', tier: 't3chaos' }), j(as.change));

  const none = FE.hidePlan(SRC, cur('Chromatic Orb'));
  check('substring-caught base, no earlier Hide tier -> none', none.kind === 'none' && none.reason === 'No hidden tier is available', j(none));
  const an = FE.applyHide(SRC, cur('Chromatic Orb'));
  check('applyHide on none refuses with the plan reason', !an.ok && an.text === SRC && an.reason === 'No hidden tier is available');
  const hid = FE.hidePlan(SRC, cur('Scroll of Wisdom'));
  check('already hidden -> none with reason', hid.kind === 'none' && /already hidden/.test(hid.reason), hid.reason);
  check('no base -> none', FE.hidePlan(SRC, { class: 'Stackable Currency' }).kind === 'none');
  const ring = FE.hidePlan(SRC, { class: 'Rings', base: 'Ruby Ring', rarity: 'Rare' });
  check('class rule without BaseType: no strip possible -> none', ring.kind === 'none', j(ring));
}

// ---------------------------------------------------------------- block edits
console.log('== editBlock ==');
{
  const i = T('t1exalted');
  const v = FE.editBlock(SRC, i, { visibility: 'Hide' });
  check('visibility: only the word changes, tag comment kept', v.ok && lines(v.text)[31] === 'Hide # %D5 $type->currency $tier->t1exalted' && eq(diffLines(SRC, v.text), [31]));
  check('visibility change recorded', eq(v.change, { kind: 'set-visibility', type: 'currency', tier: 't1exalted', visibility: 'Hide' }));
  check('same visibility = no-op, no change', (r => r.ok && r.text === SRC && r.change === null)(FE.editBlock(SRC, i, { visibility: 'Show' })));

  const c = FE.editBlock(SRC, i, { actions: { SetTextColor: [10, 20, 30] } });
  check('replace in place keeps indent and trailing comment', c.ok && lines(c.text)[35] === '\tSetTextColor 10 20 30 # red' && eq(diffLines(SRC, c.text), [35]), lines(c.text)[35]);
  check('set-action recorded with values', eq(c.change, { kind: 'set-action', type: 'currency', tier: 't1exalted', action: 'SetTextColor', values: [10, 20, 30] }));

  const a = FE.editBlock(SRC, i, { actions: { SetBackgroundColor: [0, 0, 0, 240], PlayEffect: ['Red', 'Temp'] } });
  const al = lines(a.text);
  check('new actions appended after the last action line, same indent, edit order', a.ok && al[39] === '\tSetBackgroundColor 0 0 0 240' && al[40] === '\tPlayEffect Red Temp' && al[41] === '', al.slice(38, 42).join('|'));
  check('two changes recorded, change = first', a.changes.length === 2 && a.change === a.changes[0]);

  const rm = FE.editBlock(SRC, i, { actions: { MinimapIcon: null } });
  check('null removes the action line, inner comment kept', rm.ok && lines(rm.text).length === lines(SRC).length - 1 && lines(rm.text)[36] === '\t# a comment inside the block' && lines(rm.text)[37] === '\tCustomAlertSound "divine sound.mp3" 300');
  check('removal recorded with values null', rm.change && rm.change.values === null && rm.change.action === 'MinimapIcon');

  const ps = FE.editBlock(SRC, i, { actions: { PlayAlertSound: [5] } });
  check('PlayAlertSound replaces CustomAlertSound in place, keeps its volume', ps.ok && lines(ps.text)[38] === '\tPlayAlertSound 5 300' && !/CustomAlertSound/.test(lines(ps.text).slice(31, 40).join('\n')), lines(ps.text)[38]);
  check('volume default recorded in the change', eq(ps.change.values, [5, 300]));
  const cs = FE.editBlock(SRC, T('t2divine'), { actions: { CustomAlertSound: ['my file.mp3'] } });
  check('CustomAlertSound replaces PlayAlertSound, file quoted, old volume kept, 4-space indent', cs.ok && lines(cs.text)[44] === '    CustomAlertSound "my file.mp3" 250', lines(cs.text)[44]);
  const pos = FE.editBlock(SRC, T('t3chaos'), { actions: { PlayAlertSound: [3, 100] } });
  check('a positional sound becomes plain when changed', pos.ok && lines(pos.text)[50] === '\tPlayAlertSound 3 100', lines(pos.text)[50]);
  const posOff = FE.editBlock(SRC, T('t3chaos'), { actions: { PlayAlertSound: null } });
  check('clearing PlayAlertSound clears the positional form too', posOff.ok && !/PlayAlertSound/.test(posOff.text.split('\n').slice(46, 52).join('\n')));
  const vol = FE.editBlock(SRC, T('t5single'), { actions: { PlayAlertSound: [2] } });
  check('no old sound -> volume 300; block with no actions gets it after its last condition', vol.ok && lines(vol.text)[60] === '\tPlayAlertSound 2 300', lines(vol.text)[60]);

  const cont = FE.editBlock(SRC, 0, { actions: { SetFontSize: [40] } });
  check('Continue block: appended before the Continue line', cont.ok && lines(cont.text)[5] === '\tSetFontSize 40' && lines(cont.text)[6] === '\tContinue', lines(cont.text).slice(3, 7).join('|'));
  check('Continue block edit recorded against its own tag', eq(cont.change, { kind: 'set-action', type: 'decorators', tier: 'glow', action: 'SetFontSize', values: [40] }), j(cont.change));
  const un = FE.editBlock(SRC, 14, { visibility: 'Hide', actions: { SetFontSize: [44] } });
  check('untagged block edited, change null', un.ok && lines(un.text)[78] === 'Hide' && lines(un.text)[81] === '\tSetFontSize 44' && un.change === null);
  const other = FE.editBlock(SRC, T('restex'), { actions: { DisableDropSound: [], SetFontSize: [45] } });
  check('other action with no args written bare; identical value = no change', other.ok && lines(other.text)[73] === '\tDisableDropSound' && other.changes.length === 1, lines(other.text)[73]);
  const raw = FE.editBlock(SRC, T('restex'), { actions: { MinimapIcon: '1 blue moon' } });
  check('raw text value accepted and normalised', raw.ok && lines(raw.text)[73] === '\tMinimapIcon 1 Blue Moon', lines(raw.text)[73]);

  check('bad colour refused', (r => !r.ok && r.code === 'bad-value' && r.text === SRC)(FE.editBlock(SRC, i, { actions: { SetTextColor: [300, 0, 0] } })));
  check('bad font size refused', FE.editBlock(SRC, i, { actions: { SetFontSize: [99] } }).code === 'bad-value');
  check('bad minimap icon refused', FE.editBlock(SRC, i, { actions: { MinimapIcon: [5, 'Red', 'Star'] } }).code === 'bad-value' &&
        FE.editBlock(SRC, i, { actions: { MinimapIcon: [0, 'Mauve', 'Star'] } }).code === 'bad-value');
  check('bad PlayEffect / sound refused', FE.editBlock(SRC, i, { actions: { PlayEffect: ['Red', 'Forever'] } }).code === 'bad-value' &&
        FE.editBlock(SRC, i, { actions: { PlayAlertSound: [17] } }).code === 'bad-value' && FE.editBlock(SRC, i, { actions: { CustomAlertSound: [''] } }).code === 'bad-value');
  check('non-action key refused', FE.editBlock(SRC, i, { actions: { BaseType: ['x'] } }).code === 'bad-key');
  check('Minimal visibility not offered', FE.editBlock(SRC, i, { visibility: 'Minimal' }).code === 'bad-value');
  check('bad block index refused', FE.editBlock(SRC, 99, { visibility: 'Hide' }).code === 'no-block');
  check('MinimapIcon -1 accepted (icon off)', FE.editBlock(SRC, i, { actions: { MinimapIcon: [-1] } }).ok);
}

// ---------------------------------------------------------------- actionTarget
console.log('== actionTarget ==');
{
  const ring = { class: 'Rings', base: 'Ruby Ring', rarity: 'Rare' };
  const m = LF.matchItem(P, ring);
  check('fixture: rare ring goes through the Continue decorator to the class rule', m.index === 14 && m.trail.length === 1 && m.trail[0].index === 0);
  check('action set only in the Continue block -> that block', FE.actionTarget(P, m, 'SetBorderColor') === 0);
  check('action set by the winner -> the winner', FE.actionTarget(P, m, 'SetFontSize') === 14);
  check('action nobody sets -> the winner', FE.actionTarget(P, m, 'SetTextColor') === 14);
  const mc = LF.matchItem(P, cur('Chaos Orb'));
  check('sound keys count as one (CustomAlertSound vs PlayAlertSoundPositional)', FE.actionTarget(P, mc, 'CustomAlertSound') === mc.index && mc.index === T('t3chaos'));
  check('no match -> -1', FE.actionTarget(P, LF.matchItem(P, { class: 'Boots', base: 'Iron Greaves', rarity: 'Normal' }), 'SetFontSize') === -1);
}

// ---------------------------------------------------------------- thresholds
console.log('== thresholds ==');
{
  const segs = FE.thresholdSegments(SRC, cur('Chaos Orb'), 'StackSize');
  check('stack segments: 1-2 base tier, 3-9 stacked t2, 10+ stacked t1 (AreaLevel tier skipped)',
        eq(segs.map(s => [s.from, s.to, s.index]), [[1, 2, T('t3chaos')], [3, 9, T('t2', 'currency->stackedthree')], [10, null, T('t1', 'currency->stackedthree')]]), j(segs.map(s => [s.from, s.to, s.index])));
  check('segments carry the block', segs[1].block && segs[1].block.index === T('t2', 'currency->stackedthree') && segs[1].block.tags.tier === 't2');
  check('no matching stack blocks -> []', eq(FE.thresholdSegments(SRC, cur('Divine Orb'), 'StackSize'), []));
  check('Quality with no Quality blocks -> []; unknown key -> []', eq(FE.thresholdSegments(SRC, cur('Chaos Orb'), 'Quality'), []) && eq(FE.thresholdSegments(SRC, cur('Chaos Orb'), 'ItemLevel'), []));
  const one = FE.thresholdSegments(SRC, cur('Rogue\'s Marker', { class: 'Heist Coin' }), 'StackSize');
  check('below the boundary nothing matches: index -1, then highstack', eq(one.map(s => [s.from, s.to, s.index]), [[1, 2, -1], [3, null, T('highstack', 'currency->heist')]]), j(one.map(s => [s.from, s.to, s.index])));

  const r = FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 3, 5);
  check('setThreshold rewrites the value only', r.ok && lines(r.text)[20] === '\tStackSize >= 5' && eq(diffLines(SRC, r.text), [20]), j(diffLines(SRC, r.text)));
  check('other groups with the same value untouched (heist StackSize >= 3)', lines(r.text)[75] === '\tStackSize >= 3');
  check('set-threshold recorded', eq(r.change, { kind: 'set-threshold', type: 'currency->stackedthree', tier: 't2', condition: 'StackSize', op: '>=', value: 5 }), j(r.change));
  check('refused: crossing the next boundary up', (x => !x.ok && x.code === 'crosses' && /10/.test(x.reason))(FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 3, 10)));
  check('refused: crossing the next boundary down', FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 10, 3).code === 'crosses' &&
        FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 10, 25).code === 'crosses');
  check('within the neighbours is fine', FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 10, 15).ok);
  check('refused: no such value / unchanged / bad key / bad value', FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 7, 8).code === 'not-found' &&
        FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 3, 3).code === 'unchanged' &&
        FE.setThreshold(SRC, 'currency->stackedthree', 'ItemLevel', 3, 4).code === 'bad-key' &&
        FE.setThreshold(SRC, 'currency->stackedthree', 'StackSize', 3, 0).code === 'bad-value');
  const glued = 'Show # $type->x $tier->a\n\tStackSize >=5 # five\n\tBaseType == "A"\n\nShow # $type->x $tier->b\n\tStackSize >= 1\n\tBaseType == "A"\n';
  const g = FE.setThreshold(glued, 'x', 'StackSize', 5, 6);
  check('operator glued to the number, trailing comment kept', g.ok && lines(g.text)[1] === '\tStackSize >=6 # five', lines(g.text)[1]);
}

// ---------------------------------------------------------------- EOL / BOM
console.log('== line endings and BOM ==');
{
  const crlf = SRC.replace(/\n/g, '\r\n');
  const r = FE.moveBase(crlf, cur('Vaal Orb'), 'Vaal Orb', T('t3chaos'), T('t2divine'));
  check('CRLF: move ok, every line still CRLF', r.ok && !/[^\r]\n/.test(r.text) && r.text.split('\r\n').length === crlf.split('\r\n').length);
  const a = FE.editBlock(crlf, T('t1exalted'), { actions: { PlayEffect: ['Red'] } });
  check('CRLF: appended line ends in CRLF', a.ok && a.text.indexOf('\tCustomAlertSound "divine sound.mp3" 300\r\n\tPlayEffect Red\r\n') !== -1 && !/[^\r]\n/.test(a.text));
  const bom = '\uFEFF' + crlf;
  const b = FE.applyHide(bom, cur('Vaal Orb'));
  check('BOM kept through an edit', b.ok && b.text.charCodeAt(0) === 0xFEFF && b.text.charCodeAt(1) !== 0xFEFF);
  const back = FE.moveBase(FE.moveBase(bom, null, 'Gemcutter\'s Prism', T('t3chaos'), T('t2divine')).text, null, 'Gemcutter\'s Prism', T('t2divine'), T('t3chaos'));
  check('BOM + CRLF: move a last-listed base away and back = identical bytes', back.ok && back.text === bom);
  // mixed endings: a LF block inside a CRLF file keeps LF on its new line
  const mixed = crlf.replace('\tSetFontSize 38\r\n', '\tSetFontSize 38\n');
  const mx = FE.editBlock(mixed, T('t4alch'), { actions: { PlayEffect: ['Blue'] } });
  check('mixed EOL: new line copies the line it follows', mx.ok && mx.text.indexOf('\tSetFontSize 38\n\tPlayEffect Blue\n\r\n') !== -1, JSON.stringify(mx.text.slice(mx.text.indexOf('SetFontSize 38'), mx.text.indexOf('SetFontSize 38') + 40)));
  const noNl = 'Show # $type->x $tier->a\n\tBaseType == "A" "B"\n\tSetFontSize 30';
  const nn = FE.editBlock(noNl, 0, { actions: { PlayEffect: ['Red'] } });
  check('file without a final newline: appended line is last, still no final newline', nn.ok && nn.text === noNl + '\n\tPlayEffect Red', JSON.stringify(nn.text));
  const nd = FE.editBlock(noNl, 0, { actions: { SetFontSize: null } });
  check('deleting the unterminated last line leaves no trailing newline', nd.ok && nd.text === 'Show # $type->x $tier->a\n\tBaseType == "A" "B"', JSON.stringify(nd.text));
}

// ---------------------------------------------------------------- compaction
console.log('== compactChanges ==');
{
  const mv = (base, a, b, ty) => ({ kind: 'move-basetype', base: base, fromType: ty || 'currency', fromTier: a, toType: ty || 'currency', toTier: b });
  const vis = (tier, v) => ({ kind: 'set-visibility', type: 'currency', tier: tier, visibility: v });
  check('latest set-visibility per tier wins', eq(FE.compactChanges([vis('t1', 'Hide'), vis('t2', 'Hide'), vis('t1', 'Show')]), [vis('t2', 'Hide'), vis('t1', 'Show')]));
  check('move and back cancels out', eq(FE.compactChanges([mv('Vaal Orb', 't3', 't2'), mv('Vaal Orb', 't2', 't3')]), []));
  check('chained moves merge to origin -> final', eq(FE.compactChanges([mv('Vaal Orb', 't3', 't2'), mv('Vaal Orb', 't2', 't1')]), [mv('Vaal Orb', 't3', 't1')]));
  check('different bases stay separate', FE.compactChanges([mv('A', 't3', 't2'), mv('B', 't3', 't2')]).length === 2);
  check('removal after a move supersedes it (removal at the origin)', eq(FE.compactChanges([mv('Vaal Orb', 't3', 't2'), { kind: 'remove-basetype', base: 'Vaal Orb', type: 'currency', tier: 't2' }]),
        [{ kind: 'remove-basetype', base: 'Vaal Orb', type: 'currency', tier: 't3' }]));
  check('add then remove of the same base/tier cancels; remove then add too',
        eq(FE.compactChanges([{ kind: 'add-basetype', base: 'X', type: 'c', tier: 't1' }, { kind: 'remove-basetype', base: 'X', type: 'c', tier: 't1' }]), []) &&
        eq(FE.compactChanges([{ kind: 'remove-basetype', base: 'X', type: 'c', tier: 't1' }, { kind: 'add-basetype', base: 'X', type: 'c', tier: 't1' }]), []));
  check('add then move away = add at the new tier', eq(FE.compactChanges([{ kind: 'add-basetype', base: 'X', type: 'currency', tier: 't3' }, mv('X', 't3', 't1')]),
        [{ kind: 'add-basetype', base: 'X', type: 'currency', tier: 't1' }]));
  const sa = (action, values, tier) => ({ kind: 'set-action', type: 'currency', tier: tier || 't1', action: action, values: values });
  check('latest set-action per tier+action wins', eq(FE.compactChanges([sa('SetFontSize', [40]), sa('SetTextColor', [1, 2, 3]), sa('SetFontSize', [42])]), [sa('SetTextColor', [1, 2, 3]), sa('SetFontSize', [42])]));
  check('setting one sound supersedes another sound key', eq(FE.compactChanges([sa('PlayAlertSound', [1, 300]), sa('CustomAlertSound', ['a.mp3', 300])]), [sa('CustomAlertSound', ['a.mp3', 300])]));
  check('clearing one sound key does not drop another', FE.compactChanges([sa('CustomAlertSound', ['a.mp3', 300]), sa('PlayAlertSound', null)]).length === 2);
  const th = (v) => ({ kind: 'set-threshold', type: 's', tier: 't2', condition: 'StackSize', op: '>=', value: v });
  check('latest threshold per tier+condition wins', eq(FE.compactChanges([th(4), th(5)]), [th(5)]));
  const input = [mv('A', 't3', 't2')];
  FE.compactChanges(input.concat([mv('A', 't2', 't1')]));
  check('compaction does not mutate its input', input[0].fromTier === 't3' && input[0].toTier === 't2');
  check('empty / junk input', eq(FE.compactChanges([]), []) && eq(FE.compactChanges(null), []) && eq(FE.compactChanges([null, {}]), []));
}

// ---------------------------------------------------------------- replay
console.log('== replayChanges ==');
{
  // record a session of edits on the synthetic filter
  let t = SRC; const rec = [];
  function step(r) { check('session step ok', r.ok, r.reason); t = r.text; rec.push.apply(rec, r.changes); }
  step(FE.moveBase(t, cur('Vaal Orb'), 'Vaal Orb', T('t3chaos'), T('t2divine')));
  step(FE.moveBase(t, cur('Gemcutter\'s Prism'), 'Gemcutter\'s Prism', T('t3chaos'), T('t2divine')));
  step(FE.editBlock(t, T('t5single'), { visibility: 'Hide' }));
  step(FE.editBlock(t, T('t1exalted'), { actions: { SetFontSize: [40] } }));
  step(FE.setThreshold(t, 'currency->stackedthree', 'StackSize', 3, 5));
  step(FE.moveBase(t, cur('Orb of Annulment'), 'Orb of Annulment', T('t2divine'), T('t3chaos')));
  const edited = t;
  check('session recorded 6 changes', rec.length === 6, j(rec.map(c => c.kind)));

  const same = FE.replayChanges(SRC, rec);
  check('replay onto the same original reproduces the edited text', same.text === edited && same.skipped.length === 0 && same.applied.length === 6, j(same.skipped));
  check('replay of an empty list = identical text', FE.replayChanges(SRC, []).text === SRC);
  check('replay is idempotent on the edited text', FE.replayChanges(edited, rec).text === edited);

  // a new version: Vaal Orb gone, Gemcutter's moved to t4alch by the author, t5single gone,
  // Annulment moved to t1exalted, tiers reordered and a tier inserted
  const NEW = SRC
    .replace('"Chaos Orb" "Vaal Orb" "Gemcutter\'s Prism"', '"Chaos Orb"')
    .replace('BaseType "Orb of Alchemy" "Chromatic"', 'BaseType "Orb of Alchemy" "Chromatic" "Gemcutter\'s Prism"')
    .replace('Show # $type->currency $tier->t5single\n\tClass == "Stackable Currency"\n\tBaseType == "Orb of Fusing"\n\n', '')
    .replace('"Exalted Orb" "Orb of Annulment"', '"Exalted Orb"')
    .replace('"Mirror of Kalandra" "Divine Orb"', '"Mirror of Kalandra" "Divine Orb" "Orb of Annulment"')
    .replace('# [[4000]] Currency\n', '# [[4000]] Currency\nShow # $type->currency $tier->t0new\n\tClass == "Stackable Currency"\n\tBaseType == "Hinekora\'s Lock"\n\n');
  const np = LF.parse(NEW);
  check('fixture: new version parses, t5single gone, t0new added', np.blocks.length === 15 && !np.blocks.some(b => b.tags && b.tags.tier === 't5single') &&
        np.blocks.some(b => b.tags && b.tags.tier === 't0new'));
  const r = FE.replayChanges(NEW, rec);
  const skippedBy = {}; r.skipped.forEach(s => { skippedBy[s.change.kind + ':' + (s.change.base || s.change.tier)] = s.reason; });
  check('base gone -> skipped with reason', /is gone/.test(skippedBy['move-basetype:Vaal Orb'] || ''), j(skippedBy));
  check('tier gone -> skipped with reason', /gone/.test(skippedBy['set-visibility:t5single'] || ''), j(skippedBy));
  const rp = LF.parse(r.text), tierOf = (tier) => rp.blocks.find(b => b.tags && b.tags.type === 'currency' && b.tags.tier === tier);
  check('a move finds the base where the new version put it', FE.tierBases(tierOf('t2divine')).indexOf('Gemcutter\'s Prism') !== -1 &&
        FE.tierBases(tierOf('t4alch')).indexOf('Gemcutter\'s Prism') === -1, j(FE.tierBases(tierOf('t4alch'))));
  check('a move from a tier that no longer names it strips it from its new home', FE.tierBases(tierOf('t3chaos')).indexOf('Orb of Annulment') !== -1 &&
        FE.tierBases(tierOf('t1exalted')).indexOf('Orb of Annulment') === -1, j(FE.tierBases(tierOf('t1exalted'))));
  check('action and threshold edits land on the renumbered tiers', tierOf('t1exalted').actions.find(a => a.key === 'SetFontSize').args[0] === 40 &&
        rp.blocks.find(b => b.tags && b.tags.tier === 't2' && b.tags.type === 'currency->stackedthree').conditions[0].values[0] === 5);
  check('applied + skipped account for every compacted change', r.applied.length + r.skipped.length === FE.compactChanges(rec).length && r.skipped.length === 2, r.applied.length + '+' + r.skipped.length);
  check('new tier untouched', r.text.indexOf('Show # $type->currency $tier->t0new\n\tClass == "Stackable Currency"\n\tBaseType == "Hinekora\'s Lock"\n') !== -1);

  const odd = FE.replayChanges(NEW, [
    { kind: 'add-basetype', base: 'Vaal Orb', type: 'currency', tier: 'restex' },
    { kind: 'remove-basetype', base: 'Exalted Orb', type: 'currency', tier: 't2divine' },
    { kind: 'remove-basetype', base: 'Chromatic Orb', type: 'currency', tier: 't4alch' },
    { kind: 'remove-basetype', base: 'Orb of Annulment', type: 'currency', tier: 't2divine' },
    { kind: 'move-basetype', base: 'Chaos Orb', fromType: 'currency', fromTier: 't3chaos', toType: 'currency', toTier: 'restex' },
    { kind: 'set-threshold', type: 'currency', tier: 't1exalted', condition: 'StackSize', op: '>=', value: 4 },
    { kind: 'add-basetype', base: 'Vaal Orb', type: 'currency', tier: 'gone' },
    { kind: 'teleport' }
  ]);
  const why = odd.skipped.map(s => s.reason);
  check('skip: target has no BaseType line', /no BaseType line/.test(why[0]), why[0]);
  check('skip: removal would leave an empty line', /only base/.test(why[1]), why[1]);
  check('skip: base not named (substring catch)', /gone/.test(why[2]), why[2]);
  check('remove falls back to the same-path block naming it', odd.applied.length === 1 && odd.applied[0].base === 'Orb of Annulment' &&
        FE.tierBases(LF.parse(odd.text).blocks.find(b => b.tags && b.tags.tier === 't1exalted')).indexOf('Orb of Annulment') === -1);
  check('skip: move target without BaseType, threshold tier without the condition, tier gone, unknown kind',
        odd.skipped.length === 7 && /no BaseType line/.test(why[3]) && /no StackSize/.test(why[4]) && /gone/.test(why[5]) && /Unknown/.test(why[6]), j(why));
  const subs = FE.replayChanges(SRC, [{ kind: 'move-basetype', base: 'Orb of Alchemy', fromType: 'currency', fromTier: 't4alch', toType: 'currency', toTier: 't6trans' },
                                      { kind: 'move-basetype', base: 'Chromatic', fromType: 'currency', fromTier: 't4alch', toType: 'currency', toTier: 't6trans' }]);
  check('skip: move whose source would still catch it (only base after the first move)', subs.applied.length === 1 && subs.skipped.length === 1 && /only base/.test(subs.skipped[0].reason), j(subs.skipped));
  const crl = SRC.replace(/\n/g, '\r\n'), crNew = NEW.replace(/\n/g, '\r\n');
  const rc = FE.replayChanges(crNew, rec);
  check('replay onto a CRLF new version keeps CRLF everywhere', !/[^\r]\n/.test(rc.text) && rc.text === r.text.replace(/\n/g, '\r\n'));
  check('replay onto CRLF original reproduces the CRLF edit', FE.replayChanges(crl, rec).text === edited.replace(/\n/g, '\r\n'));
}

// ---------------------------------------------------------------- audit
console.log('== audit split ==');
{
  const s = FE.auditSplit(['A', 'B', 'C', 'D'], { A: 100, b: 5, C: 50 }, 20);
  check('above (dearest first), below, unpriced', eq(s.above, ['A', 'C']) && eq(s.below, ['B']) && eq(s.unpriced, ['D']), j(s));
  check('price lookup ignores case', s.below[0] === 'B');
  check('movable lists equal the halves when the tier keeps something', eq(s.moveAbove, ['A', 'C']) && eq(s.moveBelow, ['B']));
  const allUp = FE.auditSplit(['A', 'C'], { A: 100, C: 50 }, 20);
  check('all above -> keep the cheapest one', eq(allUp.moveAbove, ['A']), j(allUp));
  const allDown = FE.auditSplit(['A', 'C'], { A: 10, C: 5 }, 20);
  check('all below -> keep the dearest one', eq(allDown.moveBelow, ['C']), j(allDown));
  check('threshold is inclusive above; NaN is unpriced', eq(FE.auditSplit(['A', 'B'], { A: 20, B: NaN }, 20).above, ['A']) && eq(FE.auditSplit(['A', 'B'], { A: 20, B: NaN }, 20).unpriced, ['B']));
}

// ---------------------------------------------------------------- matcher changes the editor relies on
console.log('== PlaySound, unknown-only blocks ==');
{
  const f = ['Show # $type->currency $tier->t1', '\tClass == "Stackable Currency"', '\tBaseType == "Divine Orb"', '\tPlaySound 1 300', '',
             'Show # $type->currency $tier->t2', '\tClass == "Stackable Currency"', '\tBaseType == "Chaos Orb" "Vaal Orb"', '\tPlaySound 2 300', ''].join('\n');
  const chaos = cur('Chaos Orb');
  const mv = FE.moveBase(f, chaos, 'Chaos Orb', 1, 0);
  check('a block with the legacy PlaySound action maps and edits (PlaySound is an action in both parsers)', mv.ok && FE.tierBases(LF.parse(mv.text).blocks[0]).indexOf('Chaos Orb') !== -1, mv.reason);
  check('PlaySound no longer makes the match uncertain', LF.matchItem(LF.parse(f), chaos).certain === true);
  // a Show block that only asks what the item can't answer no longer swallows it, so the
  // hide plan works from the tier that really shows it
  const u = ['Show # $type->odd $tier->x', '\tHasEnchantment "Enchantment Blah"', '',
             'Show # $type->currency $tier->t2', '\tClass == "Stackable Currency"', '\tBaseType == "Chaos Orb" "Vaal Orb"', '',
             'Hide # $type->currency $tier->t9', '\tClass == "Stackable Currency"', '\tBaseType == "Scroll of Wisdom"', ''].join('\n');
  const m = LF.matchItem(LF.parse(u), chaos);
  check('unknown-only block skipped: winner is the real tier, flagged uncertain, listed as possible', m.index === 1 && m.certain === false &&
        m.possible.length === 1 && m.possible[0].index === 0, j({ index: m.index, certain: m.certain, possible: m.possible.map(x => x.index) }));
  const hp = FE.hidePlan(u, chaos);
  check('hidePlan moves the base from that tier to the Hide tier', hp.kind === 'strip-add' && hp.steps[0].index === 1 && hp.target === 2, j(hp));
}

// ---------------------------------------------------------------- the real filter
console.log('== real NeverSink filter ==');
if (!fs.existsSync(REAL)) {
  console.log('SKIP real filter not found: ' + REAL);
} else {
  const buf = fs.readFileSync(REAL);
  const text = buf.toString('utf8');
  const p = LF.parse(text);
  const t1 = p.blocks.find(b => b.tags && b.tags.type === 'currency' && b.tags.tier === 't1exalted');
  const t2 = p.blocks.find(b => b.tags && b.tags.type === 'currency' && b.tags.tier === 't2divine');
  const t2b = FE.tierBases(t2), last = t2b[t2b.length - 1];
  const item = { class: 'Stackable Currency', base: last, rarity: 'Normal', stackSize: 1 };
  let t0 = Date.now();
  const up = FE.moveBase(text, item, last, t2.index, t1.index);
  const down = up.ok ? FE.moveBase(up.text, item, last, t1.index, t2.index) : up;
  check('real: move the last t2divine base to t1exalted ok, 2 lines changed', up.ok && eq(diffLines(text, up.text).length, 2), up.reason || j(diffLines(text, up.text)));
  check('real: and back = byte-identical file', down.ok && Buffer.from(down.text, 'utf8').equals(buf), down.reason);
  check('real: move recorded with the real tags', up.change && up.change.fromTier === 't2divine' && up.change.toTier === 't1exalted');
  console.log('  (two moves on ' + p.blocks.length + ' blocks: ' + (Date.now() - t0) + ' ms)');
  const tg = FE.moveTargets(text, item, t2.index);
  check('real: currency move targets offered, restex refused (no BaseType)', tg.length > 5 && tg.some(x => x.ok) && tg.some(x => x.tier === 'restex' && !x.ok), j(tg.map(x => x.tier + ':' + x.ok)));

  const items = [
    { class: 'Stackable Currency', base: 'Chaos Orb', rarity: 'Normal', stackSize: 1 },
    { class: 'Stackable Currency', base: 'Divine Orb', rarity: 'Normal', stackSize: 1 },
    { class: 'Stackable Currency', base: 'Scroll of Wisdom', rarity: 'Normal', stackSize: 1 },
    { class: 'Rings', base: 'Ruby Ring', rarity: 'Rare', itemLevel: 84 },
    { class: 'Body Armours', base: 'Vaal Regalia', rarity: 'Normal', itemLevel: 86 },
    { class: 'Stackable Currency', base: 'Totally Made Up Orb', rarity: 'Normal' }
  ];
  let threw = null, kinds = [];
  t0 = Date.now();
  try { items.forEach(it => kinds.push(FE.hidePlan(text, it).kind)); } catch (e) { threw = e; }
  check('real: hidePlan on a few items does not throw', !threw && kinds.every(k => ['flip', 'strip-add', 'strip', 'none'].indexOf(k) !== -1), threw ? threw.stack : kinds.join(','));
  console.log('  (hide plans: ' + kinds.join(', ') + ' in ' + (Date.now() - t0) + ' ms)');
  const h = FE.applyHide(text, items[0]);
  check('real: hiding Chaos Orb works and edits only a couple of lines', h.ok && diffLines(text, h.text).length <= 3 &&
        LF.matchItem(LF.parse(h.text), items[0]).visibility === 'Hide', h.reason || j(diffLines(text, h.text)));
  check('real: replay of an empty list = identical text', FE.replayChanges(text, []).text === text);
  check('real: replaying the hide onto the original gives the same text', h.ok && FE.replayChanges(text, h.changes).text === h.text);
  const segs = FE.thresholdSegments(text, items[0], 'StackSize');
  check('real: stack segments for Chaos Orb come out ordered', Array.isArray(segs) && segs.every((s, i) => i === 0 || s.from === segs[i - 1].to + 1), j(segs.map(s => [s.from, s.to, s.index])));
  const eb = FE.editBlock(text, t1.index, { actions: { SetFontSize: [44], PlayEffect: null } });
  check('real: editBlock on t1exalted touches 2 lines, CRLF kept', eb.ok && !/[^\r]\n/.test(eb.text) && lines(eb.text).length === lines(text).length - 1, eb.reason);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
