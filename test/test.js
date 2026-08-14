// End-to-end logic test: build a synthetic PoB XML -> compress to an export
// code -> decode -> parse -> match every mod against the real stats DB.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const PoB = require('../js/pob.js');
const Matcher = require('../js/matcher.js');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
  <Build level="96" className="Witch" ascendClassName="Necromancer"/>
  <Items activeItemSet="1">
    <Item id="1">Rarity: RARE
Blood Salvation
Hubris Circlet
Unique ID: abc123
Item Level: 85
Quality: 0
LevelReq: 69
Hunter Item
Implicits: 0
+109 to maximum Energy Shield
+58 to maximum Life
+42% to Fire Resistance
+35% to Cold Resistance
{crafted}+29 to maximum Mana</Item>
    <Item id="2">Rarity: RARE
Corpse Bite
Steel Ring
Item Level: 84
LevelReq: 64
Implicits: 1
Adds 8 to 13 Physical Damage to Attacks
+68 to maximum Life
+17% to all Elemental Resistances
+45 to Intelligence
{fractured}+38% to Lightning Resistance</Item>
    <Item id="3">Rarity: UNIQUE
Shavronne's Wrappings
Occultist's Vestment
Item Level: 80
Sockets: B-B-B-B-B-B
Implicits: 0
Chaos Damage taken does not bypass Energy Shield
(100-150)% increased Energy Shield</Item>
    <Item id="4">Rarity: RARE
Miracle Bite
Imbued Wand
Item Level: 84
LevelReq: 60
Implicits: 1
{tags:caster}#% increased Spell Damage
{range:0.5}(70-74)% increased Spell Damage
Gain (10-15)% of Lightning Damage as Extra Chaos Damage
+1 to Level of all Lightning Spell Skill Gems
{crafted}10% increased Cast Speed
<ModRange id="2" range="1"/></Item>
    <Item id="5">Rarity: RARE
Cobalt Jewel of Focus
Cobalt Jewel
Item Level: 80
Implicits: 0
7% increased maximum Life
+12% to Fire and Cold Resistances
12% increased Spell Damage</Item>
    <Item id="8">Rarity: RARE
Starter Dome
Iron Hat
Item Level: 12
Implicits: 0
+20 to maximum Life</Item>
    <ItemSet useSecondWeaponSet="false" title="Budget" id="1">
      <Slot name="Helmet" itemId="8"/>
      <Slot name="Ring 1" itemId="2"/>
    </ItemSet>
    <Item id="6">Rarity: RARE
Whisper Bloom
Large Cluster Jewel
Item Level: 75
LevelReq: 54
Implicits: 2
{crafted}Adds 8 Passive Skills
{crafted}Added Small Passive Skills grant: 12% increased Cold Damage
1 Added Passive Skill is Widespread Destruction
1 Added Passive Skill is Prismatic Heart</Item>
    <Item id="7">Rarity: RARE
Grim Gleam
Murderous Eye Jewel
Item Level: 82
Implicits: 0
+40 to maximum Life
Adds 4 to 7 Physical Damage to Attacks</Item>
    <ItemSet useSecondWeaponSet="false" title="Endgame" id="2">
      <Slot name="Helmet" itemId="1"/>
      <Slot name="Ring 1" itemId="2"/>
      <Slot name="Body Armour" itemId="3"/>
      <Slot name="Weapon 1" itemId="4"/>
      <Slot name="Belt Abyssal Socket 1" itemId="7"/>
    </ItemSet>
  </Items>
  <Tree activeSpec="1">
    <Spec><Sockets><Socket nodeId="123" itemId="5"/><Socket nodeId="456" itemId="6"/></Sockets></Spec>
  </Tree>
</PathOfBuilding>`;

function toPobCode(xml) {
  return zlib.deflateSync(Buffer.from(xml, 'utf8')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

async function main() {
  let failures = 0;
  const assert = (cond, msg) => {
    console.log((cond ? '  PASS ' : '  FAIL ') + msg);
    if (!cond) failures++;
  };

  console.log('== decode round-trip ==');
  const code = toPobCode(XML);
  const xml = await PoB.decodePobCode(code);
  assert(xml.includes('<PathOfBuilding'), 'decoded XML matches input');

  console.log('== parse ==');
  const build = PoB.parseBuild(xml);
  assert(build.ascendClass === 'Necromancer', 'ascendancy parsed: ' + build.ascendClass);
  assert(build.itemSets.length === 2, 'two gear sets parsed');
  assert(build.itemSets[0].title === 'Budget' && build.itemSets[1].title === 'Endgame', 'set titles parsed');
  assert(build.activeSetIndex === 0, 'active set is Budget (id 1)');
  assert(build.slots.length === 2, 'active-set slots: ' + build.slots.length);
  assert(build.itemSets[1].slots.length === 5, 'Endgame slots incl abyssal socket: ' + build.itemSets[1].slots.length);
  assert(build.jewels.length === 2, 'tree jewels found (cobalt + cluster)');

  const helm = build.items['1'];
  assert(helm.name === 'Blood Salvation' && helm.base === 'Hubris Circlet', 'helm name/base');
  assert(helm.mods.length === 5, 'helm mod count: ' + helm.mods.length);
  assert(helm.mods[4].crafted === true, 'crafted tag detected');

  const ring = build.items['2'];
  assert(ring.mods[0].kind === 'implicit', 'ring implicit detected');
  assert(ring.mods[4].fractured === true, 'fractured tag detected');

  const body = build.items['3'];
  assert(body.maxLinks === 6, 'six-link detected');

  const wand = build.items['4'];
  const spellDmg = wand.mods.find(m => m.line.includes('increased Spell Damage') && m.line.match(/^\d/));
  assert(!!spellDmg && spellDmg.line.startsWith('72%'), 'range (70-74) with {range:0.5} tag resolved to 72%: ' + (spellDmg && spellDmg.line));
  const gainExtra = wand.mods.find(m => m.line.includes('Extra Chaos'));
  assert(!!gainExtra && gainExtra.line.startsWith('Gain 15%'), 'ModRange id=2 range=1 resolved (10-15) to 15: ' + (gainExtra && gainExtra.line));
  assert(!wand.mods.some(m => m.line.charAt(0) === '<'), 'no ModRange XML garbage in mods');
  const shav = build.items['3'];
  assert(shav.mods.some(m => m.line === '125% increased Energy Shield'), 'unique range resolved to midpoint 125');
  const shavES = shav.mods.find(m => m.line.includes('increased Energy Shield'));
  const shavChaos = shav.mods.find(m => m.line.includes('Chaos Damage taken'));
  assert(shavES.ranged === true, 'unique rolled mod flagged ranged');
  assert(shavChaos.ranged === false, 'unique fixed mod flagged not ranged');

  console.log('== stat matching against real trade DB ==');
  const stats = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stats.json'), 'utf8'));
  const index = Matcher.buildStatIndex(stats);

  const expectMatch = (item, slot, lineIncludes, note) => {
    const mod = item.mods.find(m => m.line.includes(lineIncludes));
    if (!mod) { assert(false, 'mod not found: ' + lineIncludes); return null; }
    const match = Matcher.matchMod(index, mod, slot);
    assert(!!match, note + ' -> ' + (match ? match.entry.id + ' ("' + match.entry.text + '")' : 'NO MATCH'));
    return match;
  };

  const mLife = expectMatch(helm, 'Helmet', 'maximum Life', 'helm life');
  assert(mLife && mLife.avg === 58, 'helm life value = 58');
  assert(mLife && mLife.pseudo && mLife.pseudo.entry.id.includes('pseudo_total_life'), 'life has pseudo total');

  const mES = expectMatch(helm, 'Helmet', 'maximum Energy Shield', 'helm flat ES (should prefer local)');
  const mFire = expectMatch(helm, 'Helmet', 'Fire Resistance', 'helm fire res');
  assert(mFire && mFire.pseudo, 'fire res has pseudo total');
  expectMatch(helm, 'Helmet', 'maximum Mana', 'helm crafted mana');

  expectMatch(ring, 'Ring 1', 'Physical Damage to Attacks', 'ring implicit phys');
  const mAllRes = expectMatch(ring, 'Ring 1', 'all Elemental Resistances', 'ring all-res');
  expectMatch(ring, 'Ring 1', 'Intelligence', 'ring int');
  expectMatch(ring, 'Ring 1', 'Lightning Resistance', 'ring fractured res');

  const mSpell = expectMatch(wand, 'Weapon 1', '72% increased Spell Damage', 'wand spell damage');
  const mGem = expectMatch(wand, 'Weapon 1', 'Lightning Spell Skill Gems', 'wand +1 lightning gems');
  const mCast = expectMatch(wand, 'Weapon 1', 'Cast Speed', 'wand crafted cast speed');
  const mExtra = expectMatch(wand, 'Weapon 1', 'Extra Chaos', 'wand gain-as-extra (range resolved)');

  const jewel = build.items['5'];
  expectMatch(jewel, 'Jewel', 'increased maximum Life', 'jewel %life');
  const mDual = expectMatch(jewel, 'Jewel', 'Fire and Cold', 'jewel dual res');
  assert(mDual && mDual.pseudo && mDual.pseudo.multiplier === 2, 'dual res folds to total ele res x2');

  console.log('== influence / item level ==');
  assert(helm.influences.length === 1 && helm.influences[0] === 'Hunter', 'helm Hunter influence parsed');
  assert(helm.itemLevel === 85, 'helm item level parsed: ' + helm.itemLevel);

  console.log('== cluster jewel ==');
  const cluster = build.items['6'];
  const mCount = expectMatch(cluster, 'Jewel', 'Adds 8 Passive', 'cluster passive count');
  assert(mCount && mCount.entry.text === 'Adds # Passive Skills', 'passive count entry text');
  const mGrant = expectMatch(cluster, 'Jewel', 'grant: 12% increased Cold', 'cluster small-passive grant (exact match)');
  assert(mGrant && mGrant.entry.id.indexOf('|') !== -1, 'grant id embeds option: ' + (mGrant && mGrant.entry.id));
  assert(mGrant && mGrant.fixedText, 'grant flagged fixedText (no value clause)');
  const mNotable = expectMatch(cluster, 'Jewel', 'Widespread Destruction', 'cluster notable');
  assert(mNotable && mNotable.fixedText, 'notable flagged fixedText');
  expectMatch(cluster, 'Jewel', 'Prismatic Heart', 'second cluster notable');

  console.log('== defensive parsing ==');
  const noImplicits = PoB.parseItemText(
    'Rarity: RARE\nTest Ring\nIron Ring\nItem Level: 80\n+50 to maximum Life\n+30% to Fire Resistance');
  assert(noImplicits.mods.length === 2, 'missing Implicits marker -> mods still parsed: ' + noImplicits.mods.length);
  assert(noImplicits.mods[0].kind === 'explicit', 'fallback mods are explicit');
  const stacked = PoB.parseItemText(
    'Rarity: UNIQUE\n{variant:1}{crafted}Shavronne\'s Wrappings\nOccultist\'s Vestment\nImplicits: 0\nChaos Damage taken does not bypass Energy Shield');
  assert(stacked.name === "Shavronne's Wrappings", 'stacked name tags stripped: "' + stacked.name + '"');

  console.log('== abyss jewel ==');
  const abyss = build.items['7'];
  expectMatch(abyss, 'Belt Abyssal Socket 1', 'maximum Life', 'abyss jewel life');
  expectMatch(abyss, 'Belt Abyssal Socket 1', 'Physical Damage to Attacks', 'abyss jewel phys');

  console.log('== singular/plural fallback ==');
  const pluralMod = { line: 'Gain 3 Charges when you are Hit by an Enemy', kind: 'explicit', crafted: false, fractured: false };
  const mPlural = Matcher.matchMod(index, pluralMod, 'Flask 3');
  assert(!!mPlural, 'plural item line matches singular stat text: ' + (mPlural ? mPlural.entry.text : 'NO MATCH'));

  console.log('== alias + sign fallbacks ==');
  const mBlock = Matcher.matchMod(index, { line: '+20% Chance to Block', kind: 'explicit', crafted: false, fractured: false }, 'Weapon 2');
  assert(!!mBlock && /Block Attack Damage/.test(mBlock.entry.text), 'short "Chance to Block" aliases to Attack Damage stat: ' + (mBlock ? mBlock.entry.text : 'NO MATCH'));
  const mNegBlock = Matcher.matchMod(index, { line: '-1% Chance to Block Attack Damage for every 200 Fire Damage taken from Hits Recently', kind: 'explicit', crafted: false, fractured: false }, 'Body Armour');
  assert(!!mNegBlock, 'negative roll of +# template matches: ' + (mNegBlock ? mNegBlock.entry.text : 'NO MATCH'));
  assert(mNegBlock && mNegBlock.values[0] === -1, 'negative value preserved: ' + (mNegBlock && mNegBlock.values[0]));

  console.log('== pseudo ids exist in DB ==');
  ['pseudo.pseudo_total_life', 'pseudo.pseudo_total_fire_resistance',
   'pseudo.pseudo_total_elemental_resistance', 'pseudo.pseudo_total_all_elemental_resistances',
   'pseudo.pseudo_total_intelligence'].forEach(id => {
    assert(!!Matcher.lookupById(index, id), 'exists: ' + id);
  });

  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL TESTS PASSED'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
