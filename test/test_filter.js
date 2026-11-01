// Loot filter engine tests — run: node test/test_filter.js
// Synthetic filters for the semantics; a real NeverSink filter (if present) for scale.
const fs = require('fs');
const path = require('path');
const LF = require('../js/filter.js');
const PoB = require('../js/pob.js');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const j = (x) => JSON.stringify(x);

const REAL = 'C:\\Users\\jorda\\AppData\\Local\\Temp\\claude\\E--Claude-POE-Build-gear-search\\' +
  '36c35634-8368-4dfb-987f-c7a7b0a6758b\\scratchpad\\filters\\sample.filter';

// first-match helper: which block (by its comment tag) does the item land on?
function hit(filterText, item, opts) {
  const p = typeof filterText === 'string' ? LF.parse(filterText) : filterText;
  return LF.matchItem(p, item, opts);
}
const tagOf = (r) => (r.block ? r.block.tags && r.block.tags.tier || r.block.comment : null);

// ---------------------------------------------------------------- parsing
console.log('== parsing ==');
const SRC = [
  '#Online Item Filter',
  '#name: test',
  '',
  '# [[0100]] Currency',
  'Show # %D5 $type->currency $tier->t1exalted',
  '\tClass == "Stackable Currency"',
  '\tBaseType == "Mirror of Kalandra" "Divine Orb" # trailing note',
  '\tStackSize >= 2',
  '\tSetFontSize 45',
  '\tSetTextColor 255 0 0 255',
  '\tCustomAlertSound "my sound.mp3" 300',
  '\tMinimapIcon 0 Red Diamond',
  '',
  '# commented out:',
  '#Show',
  '#\tClass "Rings"',
  '',
  'Hide # $type->junk',
  '\tRarity Normal Magic',
  '\tHasExplicitMod >=2 "Hale" "Healthy"',
  '\tSockets >= 5RGB',
  '\tFrobnicate 12 "a # b"',
  '\tContinue',
  '',
  'Minimal',
  '\tCorrupted True',
  ''
].join('\n');
{
  const p = LF.parse(SRC);
  check('three blocks (comments and commented-out Show ignored)', p.blocks.length === 3, String(p.blocks.length));
  check('eol LF, no BOM, no managed', p.eol === '\n' && p.bom === false && p.managed === null);
  const b0 = p.blocks[0], b1 = p.blocks[1], b2 = p.blocks[2];
  check('visibility Show/Hide/Minimal', b0.visibility === 'Show' && b1.visibility === 'Hide' && b2.visibility === 'Minimal');
  check('index, disabled, managed defaults', b1.index === 1 && b1.disabled === false && b1.managed === false);
  check('NeverSink tags from the Show line', eq(b0.tags, { type: 'currency', tier: 't1exalted' }), j(b0.tags));
  check('type-only tag leaves tier empty; no tags -> null', eq(b1.tags, { type: 'junk', tier: '' }) && b2.tags === null);
  check('block comment kept', b0.comment === '%D5 $type->currency $tier->t1exalted', b0.comment);
  check('line range: header comment/blank lines excluded', b0.startLine === 4 && b0.endLine === 11 && b1.startLine === 17 && b1.endLine === 22,
        [b0.startLine, b0.endLine, b1.startLine, b1.endLine].join(','));
  check('quoted value with op ==', eq(b0.conditions[0], { key: 'Class', op: '==', values: ['Stackable Currency'], raw: b0.conditions[0].raw }));
  check('multiple quoted values, trailing comment stripped', eq(b0.conditions[1].values, ['Mirror of Kalandra', 'Divine Orb']) && b0.conditions[1].op === '==');
  check('numeric value becomes a number', eq(b0.conditions[2].values, [2]) && b0.conditions[2].op === '>=');
  check('bare words, no operator', eq(b1.conditions[0].values, ['Normal', 'Magic']) && b1.conditions[0].op === '');
  check('operator glued to count: HasExplicitMod >=2 "A" "B"', eq(b1.conditions[1].op, '>=') && eq(b1.conditions[1].values, [2, 'Hale', 'Healthy']), j(b1.conditions[1]));
  check('socket spec stays a string', eq(b1.conditions[2].values, ['5RGB']) && b1.conditions[2].op === '>=');
  check('unknown condition key kept, # inside quotes is not a comment', b1.conditions[3].key === 'Frobnicate' && eq(b1.conditions[3].values, [12, 'a # b']));
  check('Continue sets the flag, is not an action', b1.continue === true && b0.continue === false && !b1.actions.some(a => /continue/i.test(a.key)));
  check('actions parsed with args', eq(b0.actions.map(a => a.key), ['SetFontSize', 'SetTextColor', 'CustomAlertSound', 'MinimapIcon']) &&
        eq(b0.actions[1].args, [255, 0, 0, 255]) && eq(b0.actions[2].args, ['my sound.mp3', 300]) && eq(b0.actions[3].args, [0, 'Red', 'Diamond']));
  check('bare Minimal block with one condition', b2.conditions.length === 1 && b2.conditions[0].key === 'Corrupted' && b2.conditions[0].values[0] === 'True');
}
{
  const crlf = LF.parse(SRC.replace(/\n/g, '\r\n'));
  check('CRLF detected, same blocks', crlf.eol === '\r\n' && crlf.blocks.length === 3 && crlf.blocks[0].conditions[1].values.length === 2);
  const bom = LF.parse('\uFEFF' + SRC);
  check('BOM detected and stripped before parsing', bom.bom === true && bom.blocks.length === 3 && bom.blocks[0].startLine === 4);
  check('empty / odd input does not throw', LF.parse('').blocks.length === 0 && LF.parse(null).blocks.length === 0 && LF.parse('# only a comment').blocks.length === 0);
  const tabsSpaces = LF.parse('show\n  class   "Rings"\n  setfontsize 40\n');
  check('keywords are case-insensitive, visibility normalised', tabsSpaces.blocks[0].visibility === 'Show' && tabsSpaces.blocks[0].conditions[0].key === 'class' && tabsSpaces.blocks[0].actions.length === 1);
}
{
  const M = [
    '# header', '', 'Show # $type->a $tier->x', '\tClass "Rings"',
    '', LF.MARK_START, '# note', 'Hide # mine', '\tClass "Belts"', '', 'Show', '\tClass "Amulets"', LF.MARK_END, '',
    'Show # $type->b $tier->y', '\tClass "Gloves"', ''
  ].join('\n');
  const p = LF.parse(M);
  check('managed section found by its markers', p.managed && p.managed.startLine === 5 && p.managed.endLine === 12, j(p.managed));
  check('blocks inside are managed, others are not', eq(p.blocks.map(b => b.managed), [false, true, true, false]), j(p.blocks.map(b => b.managed)));
  check('a block ends at the managed start marker', p.blocks[0].endLine === 3);
  check('block after the end marker still parsed', p.blocks[3].tags.type === 'b' && p.blocks[3].conditions[0].values[0] === 'Gloves');
  const orphan = LF.parse('Show\n\tClass "Rings"\n' + LF.MARK_START + '\nHide\n\tClass "Belts"\n');
  check('start marker without an end marker is not a managed section', orphan.managed === null && orphan.blocks.every(b => !b.managed));
}

// --------------------------------------------------------------- matching
console.log('== matching: strings ==');
const mf = (body) => LF.parse(body.join('\n') + '\n');
{
  const f = mf([
    'Show # one', '\tClass "Currency"', '\tBaseType "Chaos"',
    'Show # two', '\tClass == "Currency"',
    'Show # three', '\tBaseType == "Chaos Orb"',
    'Hide # four', '\tClass "Rings"',
    'Show # rest'
  ]);
  check('Class without op is a substring match', tagOf(hit(f, { class: 'Stackable Currency', base: 'Chaos Orb' })) === 'one');
  check('substring match is case-insensitive', tagOf(hit(f, { class: 'STACKABLE CURRENCY', base: 'CHAOS orb' })) === 'one');
  check('Class == is exact: "Stackable Currency" != "Currency"', tagOf(hit(f, { class: 'Stackable Currency', base: 'Divine Orb' })) === 'rest');
  check('Class == hits on exact (case-insensitive)', tagOf(hit(f, { class: 'currency', base: 'Divine Orb' })) === 'two');
  check('BaseType == exact only', tagOf(hit(f, { class: 'Misc', base: 'Chaos Orb' })) === 'three' &&
        tagOf(hit(f, { class: 'Misc', base: 'Chaos Orb Shard' })) === 'rest');
  check('first matching block wins', hit(f, { class: 'Rings', base: 'Ruby Ring' }).visibility === 'Hide');
  check('diacritics ignored (Maelstrom/Maelström)', tagOf(hit(mf(['Show # m', '\tBaseType == "Maelström Staff"', 'Hide # n']), { class: 'Staves', base: 'Maelstrom Staff' })) === 'm');
  const multi = mf(['Show # m', '\tBaseType "Hubris" "Imperial" "Sea"', 'Hide # n']);
  check('any one of several values is enough', tagOf(hit(multi, { base: 'Hubris Circlet' })) === 'm' && tagOf(hit(multi, { base: 'Sea Ring' })) === 'm');
  check('!= (not exact) and ! (not substring)', tagOf(hit(mf(['Show # a', '\tClass != "Rings"', 'Hide # b']), { class: 'Amulets' })) === 'a' &&
        tagOf(hit(mf(['Show # a', '\tClass ! "ring"', 'Hide # b']), { class: 'Rings' })) === 'b');
  const mag = mf(['Show # m', '\tBaseType "Vaal Regalia"', 'Hide # n']);
  check('magic item: base type found inside its name', tagOf(hit(mag, { name: 'Hale Vaal Regalia of the Whale', base: 'Vaal Regalia', rarity: 'Magic' })) === 'm');
}

console.log('== matching: numbers, rarity ==');
{
  const f = mf([
    'Show # a', '\tItemLevel >= 84', '\tQuality > 0',
    'Show # b', '\tItemLevel < 84', '\tItemLevel > 70',
    'Show # c', '\tItemLevel = 60',
    'Show # d', '\tItemLevel ! 1',
    'Hide # e'
  ]);
  check('>= and > together', tagOf(hit(f, { itemLevel: 84, quality: 1 })) === 'a');
  check('boundary: >= 84 passes, > 0 fails at 0', tagOf(hit(f, { itemLevel: 84, quality: 0 })) !== 'a');
  check('< and > range', tagOf(hit(f, { itemLevel: 80, quality: 0 })) === 'b');
  check('plain = and default (no op)', tagOf(hit(f, { itemLevel: 60 })) === 'c' && tagOf(hit(mf(['Show # x', '\tItemLevel 60', 'Hide # y']), { itemLevel: 60 })) === 'x');
  check('! / != means not equal', tagOf(hit(f, { itemLevel: 1 })) === 'e' && tagOf(hit(f, { itemLevel: 2 })) === 'd');
  check('<= and == and !=', tagOf(hit(mf(['Show # x', '\tStackSize <= 5', '\tMapTier == 14', '\tGemLevel != 1', 'Hide # y']), { stackSize: 5, mapTier: 14, gemLevel: 20 })) === 'x');
  const r = mf(['Show # a', '\tRarity >= Rare', 'Show # b', '\tRarity Normal Magic', 'Show # c', '\tRarity < Magic', 'Hide # d']);
  check('Rarity >= Rare covers Rare and Unique, not Magic', tagOf(hit(r, { rarity: 'Rare' })) === 'a' && tagOf(hit(r, { rarity: 'Unique' })) === 'a' && tagOf(hit(r, { rarity: 'Magic' })) === 'b');
  check('Rarity list is an any-of', tagOf(hit(r, { rarity: 'Normal' })) === 'b');
  check('Rarity order Normal < Magic < Rare < Unique', tagOf(hit(mf(['Show # a', '\tRarity <= Magic', 'Hide # b']), { rarity: 'Magic' })) === 'a' &&
        tagOf(hit(mf(['Show # a', '\tRarity <= Magic', 'Hide # b']), { rarity: 'Rare' })) === 'b' &&
        tagOf(hit(mf(['Show # a', '\tRarity > Rare', 'Hide # b']), { rarity: 'Unique' })) === 'a');
  check('Rarity < Magic is Normal only', tagOf(hit(mf(['Show # a', '\tRarity < Magic', 'Hide # b']), { rarity: 'Normal' })) === 'a' && tagOf(hit(mf(['Show # a', '\tRarity < Magic', 'Hide # b']), { rarity: 'Magic' })) === 'b');
  check('Rarity name case-insensitive', tagOf(hit(mf(['Show # a', '\tRarity unique', 'Hide # b']), { rarity: 'UNIQUE' })) === 'a');
}

console.log('== matching: sockets ==');
{
  const T = (cond, item) => LF.testCondition(LF.parse('Show\n\t' + cond + '\n').blocks[0].conditions[0], item);
  const six = { sockets: 6, links: 6, socketColours: 'RRGGBB', linkedGroups: ['RRGGBB'] };
  const split = { sockets: 6, socketColours: 'RGBRGB', linkedGroups: ['RGB', 'RGB'] };
  check('Sockets >= 6 / Sockets 6 / Sockets < 6', T('Sockets >= 6', six) === true && T('Sockets 6', six) === true && T('Sockets < 6', six) === false);
  check('LinkedSockets compares the biggest link', T('LinkedSockets 6', six) === true && T('LinkedSockets >= 5', split) === false && T('LinkedSockets 3', split) === true);
  check('SocketGroup RGB finds a group with those colours', T('SocketGroup RGB', split) === true && T('SocketGroup RGB', { linkedGroups: ['RR', 'GB'] }) === false);
  check('SocketGroup >= 5RGB: length and colours', T('SocketGroup >= 5RGB', { linkedGroups: ['RGBRB'] }) === true &&
        T('SocketGroup >= 5RGB', { linkedGroups: ['RGBR'] }) === false && T('SocketGroup >= 5RGB', { linkedGroups: ['RRRRR'] }) === false);
  check('SocketGroup >= 5RGB across groups: any group may satisfy', T('SocketGroup >= 5RGB', { linkedGroups: ['RR', 'RGBGG'] }) === true);
  check('colour counts matter: GG needs two greens', T('SocketGroup GG', { linkedGroups: ['RGB'] }) === false && T('SocketGroup GG', { linkedGroups: ['RGG'] }) === true);
  check('Sockets 3RGB counts across the whole item', T('Sockets >= 3RGB', split) === true && T('Sockets >= 3RGB', { socketColours: 'RRRR', sockets: 4 }) === false);
  check('white socket W is matched literally', T('SocketGroup W', { linkedGroups: ['RGBW'] }) === true && T('SocketGroup W', { linkedGroups: ['RGB'] }) === false);
  check('sockets derived from socketColours / linkedGroups when not given', T('Sockets 4', { socketColours: 'RGBB' }) === true && T('LinkedSockets 3', { linkedGroups: ['RGB', 'B'] }) === true);
  check('no sockets: Sockets 0 and no link', T('Sockets 0', { sockets: 0 }) === true && T('LinkedSockets >= 1', { sockets: 0 }) === false);
  check('link count alone cannot answer a colour question -> unknown', T('SocketGroup RGB', { links: 6 }) === null);
  check('link count alone answers SocketGroup >= 5', T('SocketGroup >= 5', { links: 6 }) === true && T('SocketGroup >= 7', { links: 6 }) === false);
  check('nothing known about sockets -> unknown', T('Sockets >= 5', {}) === null && T('LinkedSockets 6', {}) === null);
  check('currency-like class is assumed socketless (not unknown)', T('LinkedSockets 6', { class: 'Stackable Currency' }) === false &&
        T('LinkedSockets 6', { class: 'Body Armours' }) === null);
}

console.log('== matching: booleans, influence, mods ==');
{
  const T = (cond, item, opts) => LF.testCondition(LF.parse('Show\n\t' + cond + '\n').blocks[0].conditions[0], item, opts);
  check('Corrupted True/False', T('Corrupted True', { corrupted: true }) === true && T('Corrupted True', { corrupted: false }) === false && T('Corrupted False', { corrupted: false }) === true);
  check('Identified / Mirrored / FracturedItem / SynthesisedItem', T('Identified False', { identified: false }) === true && T('Mirrored True', { mirrored: true }) === true &&
        T('FracturedItem True', { fractured: true }) === true && T('SynthesisedItem True', { synthesised: true }) === true);
  check('boolean with != flips', T('Corrupted != True', { corrupted: true }) === false);
  check('missing Corrupted / Identified is unknown', T('Corrupted True', {}) === null && T('Identified True', {}) === null);
  check('rare flags assumed false when not given; strict says unknown', T('Mirrored False', {}) === true && T('Mirrored True', {}) === false && T('Mirrored False', {}, { strict: true }) === null);
  check('AnyEnchantment follows item.enchanted', T('AnyEnchantment True', { enchanted: true }) === true && T('AnyEnchantment True', { enchanted: false }) === false && T('AnyEnchantment True', {}) === null);
  check('HasInfluence Shaper Elder: any of them', T('HasInfluence Shaper Elder', { influences: ['Elder'] }) === true && T('HasInfluence Shaper Elder', { influences: ['Hunter'] }) === false);
  check('HasInfluence None', T('HasInfluence None', { influences: [] }) === true && T('HasInfluence None', { influences: ['Shaper'] }) === false);
  check('HasInfluence == needs the exact set', T('HasInfluence == Shaper Elder', { influences: ['Elder', 'Shaper'] }) === true && T('HasInfluence == Shaper Elder', { influences: ['Shaper'] }) === false);
  check('HasInfluence matches "Searing Exarch" / "SearingExarch"', T('HasInfluence SearingExarch', { influences: ['Searing Exarch'] }) === true);
  check('ShaperItem True derives from influences', T('ShaperItem True', { influences: ['Shaper'] }) === true && T('ElderItem True', { influences: ['Shaper'] }) === false);
  check('influences missing -> unknown', T('HasInfluence Shaper', {}) === null);
  const mods = { explicitMods: ['Hale', 'of the Bear', 'Healthy'] };
  check('HasExplicitMod: substring by default', T('HasExplicitMod "Hale"', mods) === true && T('HasExplicitMod "Sanguine"', mods) === false && T('HasExplicitMod "Sanguine" "Bear"', mods) === true);
  check('HasExplicitMod ==: exact mod name', T('HasExplicitMod == "Hale"', mods) === true && T('HasExplicitMod == "Hal"', mods) === false);
  check('HasExplicitMod >=2 counts matching mods', T('HasExplicitMod >=2 "Hale" "Healthy" "Sanguine"', mods) === true && T('HasExplicitMod >=3 "Hale" "Healthy" "Sanguine"', mods) === false);
  check('HasExplicitMod =0 means none of them', T('HasExplicitMod =0 "Sanguine" "Stalwart"', mods) === true && T('HasExplicitMod =0 "Hale"', mods) === false);
  check('Normal items have no explicit mods (known)', T('HasExplicitMod "Hale"', { rarity: 'Normal' }) === false && T('HasExplicitMod "Hale"', { rarity: 'Rare' }) === null);
  check('CorruptedMods / EnchantmentPassiveNum default to 0 when clearly absent', T('CorruptedMods 0', { corrupted: false }) === true && T('CorruptedMods >= 1', {}) === null &&
        T('EnchantmentPassiveNum 3', { enchanted: false }) === false);
  check('unknown condition key -> unknown (never silently true)', T('Frobnicate 3', { itemLevel: 1 }) === null);
}

console.log('== matching: Continue and unknown fields ==');
{
  const f = mf([
    'Show # style-a', '\tClass "Rings"', '\tSetTextColor 1 2 3', '\tSetFontSize 30', '\tContinue',
    'Show # style-b', '\tRarity Rare', '\tSetFontSize 45', '\tContinue',
    'Show # final', '\tClass "Rings"', '\tSetBorderColor 9 9 9',
    'Hide # never'
  ]);
  const r = hit(f, { class: 'Rings', rarity: 'Rare' });
  check('Continue blocks go to the trail, matching goes on', r.trail.length === 2 && r.trail[0].block.comment === 'style-a' && r.trail[1].block.comment === 'style-b', j(r.trail.map(t => t.block.comment)));
  check('shown block is the first non-Continue match', r.block.comment === 'final' && r.index === 2);
  check('trail entries carry their index', eq(r.trail.map(t => t.index), [0, 1]));
  check('merged actions: later block overrides earlier per key', eq(r.actions.map(a => a.key + ':' + a.args.join(',')).sort(), ['SetBorderColor:9,9,9', 'SetFontSize:45', 'SetTextColor:1,2,3']), j(r.actions.map(a => a.key + ':' + a.args.join(','))));
  check('non-matching Continue block is not in the trail', hit(f, { class: 'Rings', rarity: 'Magic' }).trail.length === 1);
  check('only Continue blocks match -> block null', hit(mf(['Show # a', '\tClass "Rings"', '\tContinue']), { class: 'Rings' }).block === null);
  check('no match -> index -1', hit(mf(['Show', '\tClass "Rings"']), { class: 'Belts' }).index === -1);

  const u = mf(['Show # needs-area', '\tClass "Rings"', '\tAreaLevel >= 68', 'Hide # fallback']);
  const known = hit(u, { class: 'Rings', areaLevel: 70 }), unk = hit(u, { class: 'Rings' });
  check('all fields known -> certain', known.certain === true && known.block.comment === 'needs-area');
  check('missing field: block is a possible match, certain:false', unk.certain === false && unk.block.comment === 'needs-area' && eq(unk.unknown, ['AreaLevel']));
  check('a known failing condition still rules the block out', hit(u, { class: 'Belts' }).block.comment === 'fallback' && hit(u, { class: 'Belts' }).certain === true);
  check('known-false beats unknown: area too low skips the block', hit(u, { class: 'Rings', areaLevel: 60 }).block.comment === 'fallback');
  check('an unknown on an earlier block makes the answer uncertain', hit(mf(['Show # a', '\tQuality > 0', 'Show # b', '\tClass "Rings"']), { class: 'Rings' }).certain === false);
  check('Hide result reports visibility', hit(mf(['Hide', '\tClass "Rings"']), { class: 'Rings' }).visibility === 'Hide');
}

// --------------------------------------------------------------- ruleBlock
console.log('== ruleBlock / actionsOf ==');
{
  const lines = LF.ruleBlock({
    visibility: 'Show', comment: 'PoB: Chaos',
    conditions: { Class: ['Stackable Currency'], BaseType: ['Chaos Orb', 'Divine Orb'], Rarity: '>= Rare', ItemLevel: '>= 84',
                  Corrupted: false, HasExplicitMod: ['>=2', 'Hale', 'Healthy'], Sockets: '>= 5RGB', StackSize: 4 },
    textColor: [255, 0, 0, 255], borderColor: [1, 2, 3], backgroundColor: [0, 0, 0, 200], fontSize: 45,
    sound: [1, 300], minimapIcon: [0, 'Red', 'Diamond'], effect: ['Red', 'Temp']
  });
  check('ruleBlock lines', eq(lines, [
    'Show # PoB: Chaos',
    '\tClass "Stackable Currency"',
    '\tBaseType "Chaos Orb" "Divine Orb"',
    '\tRarity >= Rare',
    '\tItemLevel >= 84',
    '\tCorrupted False',
    '\tHasExplicitMod >=2 "Hale" "Healthy"',
    '\tSockets >= 5RGB',
    '\tStackSize 4',
    '\tSetTextColor 255 0 0 255',
    '\tSetBorderColor 1 2 3',
    '\tSetBackgroundColor 0 0 0 200',
    '\tSetFontSize 45',
    '\tPlayAlertSound 1 300',
    '\tMinimapIcon 0 Red Diamond',
    '\tPlayEffect Red Temp'
  ]), '\n' + lines.join('\n'));
  const back = LF.parse(lines.join('\n')).blocks[0];
  check('written block parses back to the same meaning', back.conditions.length === 8 && back.conditions[0].values[0] === 'Stackable Currency' &&
        eq(back.conditions[6].values, ['5RGB']) && back.conditions[6].op === '>=' && eq(back.conditions[5].values, [2, 'Hale', 'Healthy']) && back.conditions[5].op === '>=' &&
        back.actions.length === 7, j(back.conditions.map(c => c.key + c.op)));

  check('Hide, Continue, no comment', eq(LF.ruleBlock({ visibility: 'Hide', conditions: { Class: ['Rings'] }, continue: true }), ['Hide', '\tClass "Rings"', '\tContinue']));
  check('Rarity list is written bare', LF.ruleBlock({ conditions: { Rarity: ['Rare', 'Unique'] } })[1] === '\tRarity Rare Unique');
  check('== kept on text keys', LF.ruleBlock({ conditions: { BaseType: '== Chaos Orb' } })[1] === '\tBaseType == "Chaos Orb"');
  check('comment newlines flattened', LF.ruleBlock({ comment: 'a\nb' })[0] === 'Show # a b');
  check('default visibility Show; empty rule is just the header', eq(LF.ruleBlock({}), ['Show']));
  check('explicit actions: arbitrary key/args, quoted when needed', eq(LF.ruleBlock({ actions: [{ key: 'CustomAlertSound', args: ['my sound.mp3', 250] }, { key: 'DisableDropSound', args: ['True'] }] }).slice(1),
        ['\tCustomAlertSound "my sound.mp3" 250', '\tDisableDropSound True']));
  check('explicit action beats the shortcut for the same key', eq(LF.ruleBlock({ fontSize: 30, actions: [{ key: 'SetFontSize', args: [45] }] }), ['Show', '\tSetFontSize 45']));
  check('custom file sound shortcut -> CustomAlertSound', LF.ruleBlock({ sound: ['beep.mp3', 200] })[1] === '\tCustomAlertSound "beep.mp3" 200');
  check('positional sound shortcut', LF.ruleBlock({ sound: [2, 300, 'positional'] })[1] === '\tPlayAlertSoundPositional 2 300');

  const ref = LF.parse(SRC).blocks[0];
  const acts = LF.actionsOf(ref);
  check('actionsOf copies key/args of every action (no Continue)', acts.length === 4 && acts[1].key === 'SetTextColor' && eq(acts[1].args, [255, 0, 0, 255]));
  acts[1].args[0] = 0;
  check('actionsOf is a copy (editing it leaves the block alone)', ref.actions[1].args[0] === 255);
  const look = LF.ruleBlock({ visibility: 'Show', conditions: { BaseType: ['Chaos Orb'] }, actions: LF.actionsOf(ref) });
  check('an override can reuse a tier block\'s look', look.indexOf('\tSetTextColor 255 0 0 255') !== -1 && look.indexOf('\tCustomAlertSound "my sound.mp3" 300') !== -1 && look.indexOf('\tSetFontSize 45') !== -1, look.join(' | '));
}

// ----------------------------------------------------------- applyManaged
console.log('== buildManaged / applyManaged ==');
const RULES = [
  { visibility: 'Show', comment: 'Chaos Orb -> tier 1', conditions: { Class: ['Stackable Currency'], BaseType: ['Chaos Orb'] }, textColor: [255, 255, 255, 255], fontSize: 45 },
  { visibility: 'Hide', comment: 'junk rings', conditions: { Class: ['Rings'], Rarity: 'Normal' } }
];
const FILE_LF = [
  '#Online Item Filter', '#name: x', '#=====', '# NeverSink-ish header', '#=====', '',
  '# [[0100]] Global overriding rules', '#-----', '# !! Waypoint', 'Show # $type->6l $tier->hightier', '\tLinkedSockets 6', '\tSetFontSize 45', '',
  'Show # $type->currency $tier->t4chaos', '\tBaseType == "Chaos Orb"', '\tSetFontSize 40', ''
].join('\n');
{
  const section = LF.buildManaged(RULES, 'Generated by the app\nsecond line', '\n');
  const lines = section.split('\n');
  check('buildManaged: markers around header + blocks', lines[0] === LF.MARK_START && lines[lines.length - 2] === LF.MARK_END && lines[lines.length - 1] === '' && lines[1] === '# Generated by the app' && lines[2] === '# second line', section);
  check('buildManaged contains each rule block', section.indexOf('Show # Chaos Orb -> tier 1\n\tClass "Stackable Currency"\n\tBaseType "Chaos Orb"') !== -1 && section.indexOf('Hide # junk rings') !== -1);
  const secCrlf = LF.buildManaged(RULES, 'x', '\r\n');
  check('buildManaged honours the eol', secCrlf.indexOf('\r\n') > 0 && secCrlf.replace(/\r\n/g, '').indexOf('\n') === -1 && secCrlf.endsWith(LF.MARK_END + '\r\n'));
  check('no rules -> empty section', LF.buildManaged([], 'x') === '' && LF.buildManaged(null) === '');
  check('default header when none is given', LF.buildManaged(RULES).split('\n')[1].indexOf('# ') === 0);

  const added = LF.applyManaged(FILE_LF, section);
  const p = LF.parse(added);
  check('insert: section lands above the first block\'s own header comments', added.indexOf(LF.MARK_START) === FILE_LF.indexOf('# [[0100]]'), 'at ' + added.indexOf(LF.MARK_START));
  check('insert: the leading file header is untouched', added.indexOf('#Online Item Filter\n#name: x\n#=====\n# NeverSink-ish header\n#=====\n\n' + LF.MARK_START) === 0);
  check('insert: managed blocks come first and are flagged', p.managed && eq(p.blocks.map(b => b.managed), [true, true, false, false]) && p.blocks.length === 4, j(p.blocks.map(b => b.managed)));
  check('insert: original blocks all still there', p.blocks[2].tags.tier === 'hightier' && p.blocks[3].tags.tier === 't4chaos');
  check('insert: a managed rule now wins over the NeverSink block', hit(p, { class: 'Stackable Currency', base: 'Chaos Orb' }).block.comment === 'Chaos Orb -> tier 1' &&
        hit(p, { class: 'Stackable Currency', base: 'Chaos Orb' }).block.managed === true);
  check('insert: file ends the same', added.slice(-FILE_LF.length + FILE_LF.indexOf('# [[0100]]')) === FILE_LF.slice(FILE_LF.indexOf('# [[0100]]')));

  const section2 = LF.buildManaged([{ visibility: 'Hide', comment: 'only one now', conditions: { BaseType: ['Chaos Orb'] } }], 'v2', '\n');
  const replaced = LF.applyManaged(added, section2);
  const p2 = LF.parse(replaced);
  check('replace: old rules gone, new ones in', replaced.indexOf('junk rings') === -1 && replaced.indexOf('only one now') !== -1 && p2.blocks.length === 3 && p2.blocks[0].managed);
  check('replace: exactly one section', replaced.split(LF.MARK_START).length === 2 && replaced.split(LF.MARK_END).length === 2);
  check('replace is stable (same input twice -> same output)', LF.applyManaged(replaced, section2) === replaced);
  check('replace then remove -> original bytes', LF.applyManaged(replaced, '') === FILE_LF);
  check('insert then remove -> original bytes (LF)', LF.applyManaged(added, '') === FILE_LF);
  check('remove with nothing to remove is a no-op', LF.applyManaged(FILE_LF, '') === FILE_LF);

  const FILE_CRLF = FILE_LF.replace(/\n/g, '\r\n');
  const addedC = LF.applyManaged(FILE_CRLF, section);                    // section built with LF
  check('CRLF: section is converted to the file\'s endings', addedC.indexOf('\n') === addedC.indexOf('\r\n') + 1 && addedC.replace(/\r\n/g, '').indexOf('\n') === -1);
  check('CRLF: insert then remove -> original bytes', LF.applyManaged(addedC, '') === FILE_CRLF);
  check('CRLF: parses with eol CRLF and managed flagged', LF.parse(addedC).eol === '\r\n' && LF.parse(addedC).blocks[0].managed === true);

  const FILE_BOM = '\uFEFF' + FILE_CRLF;
  const addedB = LF.applyManaged(FILE_BOM, section);
  check('BOM kept on insert, still a single BOM', addedB.charCodeAt(0) === 0xFEFF && addedB.charCodeAt(1) !== 0xFEFF && addedB.slice(1, 6) === '#Onli');
  check('BOM: insert then remove -> original bytes', LF.applyManaged(addedB, '') === FILE_BOM);
  check('BOM: replace keeps the BOM', LF.applyManaged(addedB, section2).charCodeAt(0) === 0xFEFF && LF.parse(LF.applyManaged(addedB, section2)).bom === true);

  const bare = 'Show # $type->a $tier->x\n\tClass "Rings"\n';
  check('no header at all: section goes first', LF.applyManaged(bare, section).indexOf(LF.MARK_START) === 0 && LF.applyManaged(LF.applyManaged(bare, section), '') === bare);
  const noBlocks = '# just comments\n# more\n';
  check('no blocks: appended, removable', LF.applyManaged(noBlocks, section).indexOf('# more\n' + LF.MARK_START) !== -1 && LF.applyManaged(LF.applyManaged(noBlocks, section), '') === noBlocks);
  check('empty file gets just the section', LF.applyManaged('', section) === section);
  const odd = '# h\n\n\n\n# sec\nShow\n\tClass "Rings"\n\n\n';
  check('blank-line runs above the first block survive a round trip', LF.applyManaged(LF.applyManaged(odd, section), '') === odd);
  const mixed = '# h\r\n\r\n# sec\nShow\r\n\tClass "Rings"\n';
  check('mixed line endings survive a round trip', LF.applyManaged(LF.applyManaged(mixed, section), '') === mixed);
  const keep = FILE_LF.replace('Show # $type->6l', '# Show # $type->decoy\nShow # $type->6l');
  check('user edits outside the section stay put across rewrites', LF.applyManaged(LF.applyManaged(keep, section), section2).indexOf('# Show # $type->decoy') !== -1);
}

// ---------------------------------------------------------- fromAppItem
console.log('== fromAppItem ==');
{
  const chaosText = ['Item Class: Stackable Currency', 'Rarity: Currency', 'Chaos Orb', '--------', 'Stack Size: 12/10', '--------',
    'Reforges a rare item with new random modifiers', '--------', 'Right click this item then left click a rare item to apply it.'].join('\n');
  const chaos = LF.fromAppItem(PoB.parseGameItem(chaosText));
  check('currency: class/base/stack, rarity "Normal" (filters call currency Normal)', chaos['class'] === 'Stackable Currency' && chaos.base === 'Chaos Orb' && chaos.stackSize === 12 && chaos.rarity === 'Normal', j(chaos));
  check('currency: no sockets, uncorrupted, identified', chaos.sockets === 0 && chaos.corrupted === false && chaos.identified === true && eq(chaos.linkedGroups, []));

  const bodyText = ['Item Class: Body Armours', 'Rarity: Rare', 'Doom Veil', 'Vaal Regalia', '--------', 'Quality: +20% (augmented)', 'Energy Shield: 500', '--------',
    'Requirements:', 'Level: 68', 'Int: 194', '--------', 'Sockets: R-G-B-B-B-B', '--------', 'Item Level: 84', '--------',
    '{ Prefix Modifier "Hale" (Tier: 3) }', '+90 to maximum Life', '--------', 'Shaper Item', '--------', 'Corrupted'].join('\n');
  const body = LF.fromAppItem(PoB.parseGameItem(bodyText));
  check('rare body armour: class/base/name/rarity', body['class'] === 'Body Armours' && body.base === 'Vaal Regalia' && body.name === 'Doom Veil' && body.rarity === 'Rare', j(body));
  check('numbers: itemLevel, quality, corrupted, influences', body.itemLevel === 84 && body.quality === 20 && body.corrupted === true && eq(body.influences, ['Shaper']));
  check('sockets "R-G-B-B-B-B" -> 6 sockets, 6 links, colours, one group', body.sockets === 6 && body.links === 6 && body.socketColours === 'RGBBBB' && eq(body.linkedGroups, ['RGBBBB']));
  check('6-link body armour answers SocketGroup/LinkedSockets', LF.testCondition({ key: 'LinkedSockets', op: '', values: [6] }, body) === true &&
        LF.testCondition({ key: 'SocketGroup', op: '>=', values: ['5RGB'] }, body) === true);

  const split = LF.fromAppItem({ rarity: 'MAGIC', name: 'Hale Hubris Circlet', base: 'Hubris Circlet', sockets: 'R-G B', maxLinks: 2, corrupted: false, itemLevel: 0, influences: [], mods: [] });
  check('split sockets "R-G B" -> groups, biggest link', eq(split.linkedGroups, ['RG', 'B']) && split.links === 2 && split.sockets === 3 && split.rarity === 'Magic');
  check('itemLevel 0 / no class (PoB item) stay unset, not "0"', split.itemLevel === undefined && split['class'] === undefined && split.identified === undefined);

  const gem = LF.fromAppItem({ rarity: 'GEM', name: 'Awakened Spell Echo Support', base: 'Awakened Spell Echo Support', itemClass: 'Support Gems', gemLevel: 5, quality: 20, stackSize: 0, itemLevel: 0, corrupted: false, influences: [], mods: [], sockets: '' });
  check('gem: level + quality kept, rarity Normal', gem.gemLevel === 5 && gem.quality === 20 && gem.rarity === 'Normal' && gem.stackSize === undefined);
  const map = LF.fromAppItem({ rarity: 'NORMAL', name: 'Strand Map', base: 'Strand Map', itemClass: 'Maps', mapTier: 16, itemLevel: 83, corrupted: false, influences: [], mods: [], sockets: '' });
  check('map tier carried', map.mapTier === 16 && map['class'] === 'Maps');
  check('unique / relic -> Unique, divination card -> Normal', LF.fromAppItem({ rarity: 'UNIQUE' }).rarity === 'Unique' && LF.fromAppItem({ rarity: 'RELIC' }).rarity === 'Unique' && LF.fromAppItem({ rarity: 'DIVINATION' }).rarity === 'Normal');
  const unid = LF.fromAppItem({ rarity: 'RARE', itemClass: 'Rings', base: 'Ruby Ring', name: 'Ruby Ring', mods: [{ line: 'Unidentified', kind: 'explicit' }], sockets: '', influences: [], corrupted: false });
  check('"Unidentified" line -> identified:false', unid.identified === false);
  const ench = LF.fromAppItem({ rarity: 'RARE', itemClass: 'Helmets', base: 'Hubris Circlet', name: 'X', mods: [{ line: '+30 to maximum Life', kind: 'implicit', crafted: true }], sockets: '', influences: [], corrupted: false });
  check('enchant (implicit + crafted) on a pasted item -> enchanted:true', ench.enchanted === true && LF.fromAppItem(PoB.parseGameItem(bodyText)).enchanted === false);
  check('null / empty input is harmless', eq(LF.fromAppItem(null), {}) && typeof LF.fromAppItem({}).rarity === 'string');
  const chaosHit = hit(mf(['Show # no', '\tLinkedSockets 6', 'Show # cur', '\tClass == "Stackable Currency"', '\tBaseType == "Chaos Orb"', '\tStackSize >= 10', 'Hide']), chaos);
  check('fromAppItem output goes straight into matchItem', tagOf(chaosHit) === 'cur' && chaosHit.certain === true);
}

// ----------------------------------------------------------- tierBlocks
console.log('== tierBlocks ==');
{
  const f = LF.parse([
    'Show # $type->currency $tier->t1', '\tBaseType "Mirror"',
    'Show # $type->divination $tier->d1', '\tBaseType "The Doctor"',
    'Hide # $type->currency $tier->t9junk', '\tBaseType "Scroll"',
    LF.MARK_START, 'Show # $type->currency $tier->fake', '\tBaseType "X"', LF.MARK_END,
    'Show # no tags', '\tBaseType "Y"'
  ].join('\n'));
  const t = LF.tierBlocks(f, 'currency');
  check('tierBlocks: blocks of that $type in file order with tiers', eq(t.map(x => x.tier), ['t1', 't9junk']) && eq(t.map(x => x.index), [0, 2]), j(t.map(x => x.tier)));
  check('tierBlocks: visibility + block reference, managed blocks left out', t[1].visibility === 'Hide' && t[0].block === f.blocks[0]);
  check('tierBlocks: unknown type -> empty; case-insensitive type', LF.tierBlocks(f, 'nope').length === 0 && LF.tierBlocks(f, 'CURRENCY').length === 2);
}

// ------------------------------------------------------ real NeverSink filter
console.log('== real NeverSink filter ==');
if (!fs.existsSync(REAL)) {
  console.log('SKIP real filter not found at ' + REAL);
} else {
  const buf = fs.readFileSync(REAL);
  const text = buf.toString('utf8');
  const t0 = Date.now();
  const p = LF.parse(text);
  const ms = Date.now() - t0;
  check('block count is 569', p.blocks.length === 569, String(p.blocks.length));
  check('CRLF filter, no BOM, no managed section', p.eol === '\r\n' && p.bom === false && p.managed === null);
  check('parses fast (< 1s)', ms < 1000, ms + 'ms');
  check('NeverSink tags read on most blocks', p.blocks.filter(b => b.tags && b.tags.type).length >= 550, String(p.blocks.filter(b => b.tags && b.tags.type).length));
  check('every block has a visibility and non-negative line range', p.blocks.every(b => /^(Show|Hide|Minimal)$/.test(b.visibility) && b.endLine >= b.startLine));
  check('Continue blocks recognised (29 in the file)', p.blocks.filter(b => b.continue).length === 29, String(p.blocks.filter(b => b.continue).length));

  const chaosItem = { class: 'Stackable Currency', base: 'Chaos Orb', name: 'Chaos Orb', rarity: 'Normal', stackSize: 1, areaLevel: 83 };
  const mirrorItem = { class: 'Stackable Currency', base: 'Mirror of Kalandra', name: 'Mirror of Kalandra', rarity: 'Normal', stackSize: 1, areaLevel: 83 };
  const rc = LF.matchItem(p, chaosItem), rm = LF.matchItem(p, mirrorItem);
  check('Chaos Orb matches a currency block', rc.block && rc.block.tags.type === 'currency' && rc.certain, rc.block && j(rc.block.tags));
  check('Mirror of Kalandra matches a higher tier than Chaos Orb', rm.block.tags.type === 'currency' && rm.index < rc.index, rm.block.tags.tier + ' (#' + rm.index + ') vs ' + rc.block.tags.tier + ' (#' + rc.index + ')');
  const tiers = LF.tierBlocks(p, 'currency').map(x => x.tier);
  check('tierBlocks lists the currency tiers, top tier first', tiers.indexOf(rm.block.tags.tier) !== -1 && tiers.indexOf(rm.block.tags.tier) < tiers.indexOf(rc.block.tags.tier), tiers.join(','));
  const scroll = LF.matchItem(p, { class: 'Stackable Currency', base: 'Scroll of Wisdom', name: 'Scroll of Wisdom', rarity: 'Normal', stackSize: 1, areaLevel: 83 });
  check('Scroll of Wisdom is hidden at endgame', scroll.visibility === 'Hide');

  const sixL = { class: 'Body Armours', base: 'Vaal Regalia', name: 'Doom Veil', rarity: 'Rare', itemLevel: 84, quality: 0, sockets: 6, links: 6,
                 socketColours: 'BBBBBB', linkedGroups: ['BBBBBB'], corrupted: false, mirrored: false, identified: true, influences: [], areaLevel: 83 };
  const r6 = LF.matchItem(p, sixL);
  check('6-link body armour hits a $type->6l block', r6.block && r6.block.tags.type === '6l' && r6.certain, r6.block && j(r6.block.tags));
  const fiveL = LF.matchItem(p, Object.assign({}, sixL, { links: 5, linkedGroups: ['BBBBB', 'B'] }));
  check('a 5-link of the same item does not', !(fiveL.block && fiveL.block.tags && fiveL.block.tags.type === '6l'), fiveL.block && j(fiveL.block.tags));
  const noInfo = LF.matchItem(p, { class: 'Stackable Currency', base: 'Chaos Orb', rarity: 'Normal' });
  check('missing area level / stack size shows up as uncertain-or-correct, never throws', typeof noInfo.certain === 'boolean');

  // the app's flow: managed rule on top of the real filter
  const section = LF.buildManaged([{ visibility: 'Show', comment: 'Chaos Orb override', conditions: { Class: ['Stackable Currency'], BaseType: ['Chaos Orb'] },
    actions: LF.actionsOf(LF.matchItem(p, mirrorItem).block) }], 'test', p.eol);
  const added = LF.applyManaged(text, section);
  const pa = LF.parse(added);
  check('applyManaged on the real filter: +1 block, flagged managed, first', pa.blocks.length === 570 && pa.blocks[0].managed === true && pa.blocks[1].managed === false, String(pa.blocks.length));
  const over = LF.matchItem(pa, chaosItem);
  check('override now wins for Chaos Orb and borrows the Mirror look', over.block.managed === true && over.block.actions.length === rm.block.actions.length &&
        over.block.actions.length > 0 && over.block.actions[0].raw === rm.block.actions[0].raw);
  check('everything else still matches as before (Mirror, 6-link)', LF.matchItem(pa, mirrorItem).index === rm.index + 1 && LF.matchItem(pa, sixL).index === r6.index + 1);
  const at = added.indexOf(LF.MARK_START);
  check('real filter: only the section + one blank line were added, above the first block\'s header', added.length === text.length + section.length + p.eol.length &&
        added.slice(0, at) === text.slice(0, at) && added.slice(at + section.length + p.eol.length) === text.slice(at) &&
        text.slice(at).indexOf('# [[0100]] Global overriding rules') < text.slice(at).indexOf('Show # %D8 $type->6l'), 'at char ' + at);
  const removed = LF.applyManaged(added, '');
  check('applyManaged + remove leaves the file byte-identical', Buffer.from(removed, 'utf8').equals(buf), removed.length + ' vs ' + text.length);
  const re = LF.applyManaged(added, LF.buildManaged([{ visibility: 'Hide', comment: 'again', conditions: { Class: ['Rings'] } }], 'x', p.eol));
  check('rewrite then remove is byte-identical too', Buffer.from(LF.applyManaged(re, ''), 'utf8').equals(buf) && LF.parse(re).blocks.length === 570);
  const bomText = '\uFEFF' + text;
  check('BOM + CRLF real file: add/remove byte-identical, BOM kept', LF.applyManaged(LF.applyManaged(bomText, section), '') === bomText && LF.applyManaged(bomText, section).charCodeAt(0) === 0xFEFF);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
