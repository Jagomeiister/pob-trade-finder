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
    <Item id="9">Rarity: MAGIC
Flagellant's Silver Flask of the Kakapo
Item Level: 70
Implicits: 0
Gain 3 Charges when you are Hit by an Enemy
59% reduced Effect of Curses on you during Effect</Item>
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
      <Slot name="Flask 1" itemId="9"/>
    </ItemSet>
  </Items>
  <Tree activeSpec="1">
    <Spec><Sockets><Socket nodeId="123" itemId="5"/><Socket nodeId="456" itemId="6"/></Sockets></Spec>
  </Tree>
  <Skills sortGemsByDPS="true" activeSkillSet="1">
    <SkillSet id="1" title="Main">
      <Skill enabled="true" slot="Body Armour" mainActiveSkill="1">
        <Gem enabled="true" gemId="Metadata/Items/Gems/SkillGemRaiseSpectre" nameSpec="Raise Spectre" level="21" quality="23" count="1"/>
        <Gem enabled="true" gemId="Metadata/Items/Gems/SupportGemMinionDamage" nameSpec="Minion Damage Support" level="20" quality="20" count="1"/>
        <Gem enabled="false" gemId="Metadata/Items/Gems/X" nameSpec="Disabled Gem" level="1" quality="0" count="1"/>
      </Skill>
      <Skill enabled="true" slot="Helmet">
        <Gem enabled="true" gemId="Metadata/Items/Gems/SkillGemRaiseSpectre" nameSpec="Raise Spectre" level="21" quality="23" count="1"/>
        <Gem enabled="true" gemId="Metadata/Items/Gems/SupportGemEmpower" nameSpec="Empower" level="4" quality="0" count="1"/>
      </Skill>
      <Skill enabled="true" slot="Weapon 1" source="Item:5:Whisper Bloom">
        <Gem enabled="true" nameSpec="Granted By Item" level="20" quality="0" count="1"/>
      </Skill>
      <Skill enabled="true" slot="Gloves">
        <Gem enabled="true" nameSpec="Mana-Infused Staff" level="20" quality="0" count="1"/>
      </Skill>
    </SkillSet>
    <SkillSet id="2" title="Leveling">
      <Skill enabled="true" slot="Body Armour">
        <Gem enabled="true" gemId="Metadata/Items/Gems/SkillGemSummonRagingSpirit" nameSpec="Summon Raging Spirit" level="1" quality="0" count="1"/>
      </Skill>
    </SkillSet>
  </Skills>
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

  console.log('== gems ==');
  assert(build.gemGroups.length === 2, 'two enabled link groups: ' + build.gemGroups.length);
  assert(build.gemGroups[0].slot === 'Body Armour' && build.gemGroups[1].slot === 'Helmet',
    'group slots preserved: ' + build.gemGroups.map(g => g.slot).join(', '));
  assert(build.gemGroups[0].title === 'Raise Spectre setup', 'group titled from main gem: ' + build.gemGroups[0].title);
  assert(build.gemGroups[0].gems.length === 2 && build.gemGroups[1].gems.length === 2,
    'gems per group (disabled skipped)');
  assert(build.gems.length === 4, 'flattened gems keep per-group copies: ' + build.gems.length);
  assert(!build.gems.some(g => g.name === 'Disabled Gem'), 'disabled gems skipped');
  assert(build.gemGroups[0].offGems.length === 1 && build.gemGroups[0].offGems[0].name === 'Disabled Gem' &&
    build.gemGroups[0].offGems[0].enabled === false && build.gemGroups[1].offGems.length === 0,
    'unticked gems kept per group as options: ' + JSON.stringify(build.gemGroups.map(g => g.offGems)));
  assert(!build.gems.some(g => g.name === 'Summon Raging Spirit'), 'inactive skill set skipped');
  assert(!build.gems.some(g => g.name === 'Granted By Item'), 'item-granted skills skipped');
  assert(!build.gems.some(g => g.name === 'Mana-Infused Staff'), 'gemId-less granted skills skipped even without source attr');

  console.log('== game clipboard item ==');
  const gameText = ['Item Class: Rings', 'Rarity: Rare', 'Corpse Bite', 'Steel Ring', '--------',
    'Requirements:', 'Level: 64', '--------', 'Item Level: 84', '--------',
    'Adds 8 to 13 Physical Damage to Attacks (implicit)', '--------',
    '+68 to maximum Life', '+45 to Intelligence (crafted)', '+38% to Lightning Resistance (fractured)',
    '--------', 'Corrupted'].join('\n');
  assert(PoB.looksLikeGameItem(gameText), 'game format detected');
  const gi = PoB.parseGameItem(gameText);
  assert(gi.name === 'Corpse Bite' && gi.base === 'Steel Ring', 'game item name/base');
  assert(gi.slotGuess === 'Ring 1', 'slot guessed from Item Class');
  assert(gi.itemLevel === 84 && gi.corrupted === true, 'ilvl + corrupted parsed');
  assert(gi.mods.length === 4, 'game item mods: ' + gi.mods.length);
  assert(gi.mods[0].kind === 'implicit', 'implicit suffix parsed');
  assert(gi.mods[1].line === '+68 to maximum Life', 'clean explicit line');
  assert(gi.mods[2].crafted === true && gi.mods[3].fractured === true, 'crafted/fractured suffixes');
  const gMatch = Matcher.matchMod(index, gi.mods[1], 'Ring 1');
  assert(!!gMatch, 'pasted item mods flow through the matcher');
  assert(!PoB.looksLikeGameItem('just some text'), 'plain text not misdetected');

  // advanced copy (default since 3.29): { headers }, roll ranges, reminder text
  const advText = ['Item Class: Rings', 'Rarity: Rare', 'Doom Loop', 'Two-Stone Ring', '--------', 'Item Level: 84', '--------',
    '{ Implicit Modifier — Elemental, Fire, Cold, Resistance }', '+12(12-16)% to Fire and Cold Resistances (implicit)', '--------',
    '{ Prefix Modifier "Prime" (Tier: 2) — Life }', '+70(70-79) to maximum Life',
    '{ Master Crafted Suffix Modifier "of Craft" (Rank: 1) — Attribute }', '+30(26-30) to Intelligence (crafted)',
    '{ Fractured Suffix Modifier "of the Volcano" (Tier: 1) — Elemental, Fire, Resistance }', '+46(46-48)% to Fire Resistance',
    '(Fire Resistance reduces Fire Damage taken)'].join('\n');
  const adv = PoB.parseGameItem(advText);
  assert(adv.mods.length === 4, 'advanced: headers and reminder text are not mods: ' + adv.mods.map(m => m.line).join(' | '));
  assert(adv.mods[0].kind === 'implicit' && adv.mods[0].line === '+12% to Fire and Cold Resistances', 'advanced: implicit, range stripped');
  assert(adv.mods[1].line === '+70 to maximum Life' && adv.mods[1].tier === 2, 'advanced: tier kept, range stripped');
  assert(adv.mods[2].crafted === true && adv.mods[3].fractured === true, 'advanced: crafted/fractured from headers');
  assert(!!Matcher.matchMod(index, adv.mods[1], 'Ring 1'), 'advanced mods flow through the matcher');
  const cur = PoB.parseGameItem(['Item Class: Stackable Currency', 'Rarity: Currency', 'Chaos Orb', '--------',
    'Stack Size: 1,234/5000', '--------', 'Reforges a rare item with new random modifiers'].join('\n'));
  assert(cur.stackSize === 1234 && cur.itemClass === 'Stackable Currency' && cur.name === 'Chaos Orb', 'currency stack size + class');
  const gem = PoB.parseGameItem(['Item Class: Skill Gems', 'Rarity: Gem', 'Vaal Grace', '--------', 'Vaal, Aura, Spell',
    'Level: 21 (Max)', 'Quality: +23% (augmented)', '--------', 'Requirements:', 'Level: 72'].join('\n'));
  assert(gem.gemLevel === 21 && gem.quality === 23, 'gem level + quality: ' + gem.gemLevel + '/' + gem.quality);

  console.log('== multi-line stats, anoints, cluster singular ==');
  const mFlask = Matcher.matchMod(index, { line: 'Removes all Burning when used', kind: 'explicit', crafted: false, fractured: false }, 'Flask 2');
  assert(!!mFlask && mFlask.entry.text.includes('\n'), 'multi-line stat matched via a single line: ' + (mFlask ? JSON.stringify(mFlask.entry.text.slice(0, 40)) : 'NO MATCH'));
  const mAnoint = Matcher.matchMod(index, { line: 'Allocates Whispers of Doom', kind: 'implicit', crafted: true, fractured: false }, 'Amulet');
  assert(!!mAnoint && mAnoint.entry.id.indexOf('enchant.') === 0, 'anoint matched to enchant stat: ' + (mAnoint ? mAnoint.entry.id : 'NO MATCH'));
  const mJsock = Matcher.matchMod(index, { line: '1 Added Passive Skill is a Jewel Socket', kind: 'implicit', crafted: true, fractured: false }, 'Jewel');
  assert(!!mJsock && /Jewel Sockets/.test(mJsock.entry.text), 'singular jewel-socket line matched: ' + (mJsock ? mJsock.entry.text : 'NO MATCH'));

  console.log('== full real-listing corpus (309 lines) ==');
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-modcorpus.json'), 'utf8'));
  let corpusMisses = 0;
  for (const c of corpus) {
    for (const line of c.line.split('\n')) {
      const mod = { line, kind: c.kind === 'enchant' ? 'implicit' : (c.kind === 'implicit' ? 'implicit' : 'explicit'),
                    crafted: c.kind === 'crafted' || c.kind === 'enchant', fractured: c.kind === 'fractured' };
      if (!Matcher.matchMod(index, mod, c.cat.includes('armour') ? 'Helmet' : 'Ring 1')) corpusMisses++;
    }
  }
  assert(corpusMisses === 0, 'every real listing mod line matches (misses: ' + corpusMisses + ')');

  console.log('== tree stages (several PoB specs) ==');
  const specsXml = '<PathOfBuilding><Build className="Witch" ascendClassName="Elementalist"/><Tree activeSpec="2">' +
    '<Spec title="Level 30" treeVersion="3_29" nodes="1,2,3" masteryEffects="{10,20}"/>' +
    '<Spec title="Level 70" treeVersion="3_29" nodes="1,2,3,4,5" masteryEffects="{10,20},{11,21}">' +
    '<Sockets><Socket nodeId="26725" itemId="7"/></Sockets></Spec>' +
    '<Spec treeVersion="3_29" nodes="1,2,3,4,5,6,7"></Spec></Tree></PathOfBuilding>';
  const st = PoB.parseBuild(specsXml);
  assert(st.treeSpecs.length === 3, 'all three trees read (' + st.treeSpecs.length + ')');
  assert(st.treeSpecs[0].title === 'Level 30' && st.treeSpecs[2].title === '', 'tree titles kept');
  assert(st.treeActive === 1 && st.tree === st.treeSpecs[1] && st.tree.nodes.length === 5, 'active tree = activeSpec');
  assert(st.tree.masteries.length === 2 && st.tree.sockets[0].nodeId === 26725, 'masteries + sockets per tree');
  assert(st.treeSpecs[0].sockets.length === 0 && st.treeSpecs[2].nodes.length === 7, 'self-closing and empty specs');

  console.log('== pseudo ids exist in DB ==');
  ['pseudo.pseudo_total_life', 'pseudo.pseudo_total_fire_resistance',
   'pseudo.pseudo_total_elemental_resistance', 'pseudo.pseudo_total_all_elemental_resistances',
   'pseudo.pseudo_total_intelligence'].forEach(id => {
    assert(!!Matcher.lookupById(index, id), 'exists: ' + id);
  });

  console.log('== pasted items: base type, flags, map tier, eldritch ==');
  const G = (lines) => PoB.parseGameItem(lines.join('\n'));
  const MAGIC_ADV = ['Item Class: Body Armours', 'Rarity: Magic', 'Hale Vaal Regalia of the Penguin', '--------',
    'Energy Shield: 233 (augmented)', '--------', 'Requirements:', 'Level: 68', 'Int: 194', '--------', 'Sockets: B-B B', '--------',
    'Item Level: 79', '--------',
    '{ Prefix Modifier "Hale" (Tier: 9) — Life }', '+22(20-29) to maximum Life',
    '{ Suffix Modifier "of the Penguin" (Tier: 6) — Elemental, Cold, Resistance }', '+15(12-17)% to Cold Resistance',
    '(Cold Resistance reduces Cold Damage taken)'];
  const MAGIC_PLAIN = ['Item Class: Body Armours', 'Rarity: Magic', 'Hale Vaal Regalia of the Penguin', '--------',
    'Energy Shield: 233 (augmented)', '--------', 'Requirements:', 'Level: 68', 'Int: 194', '--------', 'Item Level: 79', '--------',
    '+22 to maximum Life', '+15% to Cold Resistance'];
  const FLASK = ['Item Class: Life Flasks', 'Rarity: Magic', 'Saturated Divine Life Flask of Staunching', '--------',
    'Recovers 3600 (augmented) Life over 10.50 (augmented) Seconds', 'Consumes 15 of 45 Charges on use', 'Currently has 45 Charges', '--------',
    'Requirements:', 'Level: 81', '--------', 'Item Level: 84', '--------',
    '50% increased Amount Recovered', '33% reduced Recovery rate', 'Grants Immunity to Bleeding for 4 seconds if used while Bleeding',
    'Grants Immunity to Corrupted Blood for 4 seconds if used while affected by Corrupted Blood', '--------',
    'Right click to drink. Can only hold charges while in belt. Refills as you kill monsters.'];
  const MAGIC_MAP = ['Item Class: Maps', 'Rarity: Magic', 'Antagonist\'s Lair of the Hydra Map of Exposure', '--------',
    'Map Tier: 16', 'Item Quantity: +31% (augmented)', 'Item Rarity: +17% (augmented)', '--------', 'Item Level: 83', '--------',
    'Rare Monsters each have a Nemesis Mod', '20% more Rare Monsters', 'Players have -10% to all maximum Resistances', '--------',
    'Travel to this Map by using it in a personal Map Device. Maps can only be used once.'];
  const SUPERIOR = ['Item Class: Body Armours', 'Rarity: Normal', 'Superior Vaal Regalia', '--------',
    'Quality: +12% (augmented)', 'Energy Shield: 217 (augmented)', '--------', 'Requirements:', 'Level: 68', 'Int: 194', '--------',
    'Sockets: B-B-G', '--------', 'Item Level: 84'];
  const UNUSABLE = ['Item Class: Two Hand Swords', 'Rarity: Rare', 'You cannot use this item. Its stats will be ignored', '--------',
    'Havoc Edge', 'Reaver Sword', '--------', 'Two Hand Sword', 'Physical Damage: 92-191 (augmented)', 'Critical Strike Chance: 5.00%',
    'Attacks per Second: 1.25', 'Weapon Range: 1.3 metres', '--------', 'Requirements:', 'Level: 66', 'Str: 121 (unmet)', 'Dex: 121 (unmet)', '--------',
    'Sockets: R-R-G', '--------', 'Item Level: 75', '--------', '+40% to Global Critical Strike Multiplier (implicit)', '--------',
    'Adds 12 to 24 Physical Damage', '+30 to maximum Life'];
  const RARE_MAP = ['Item Class: Maps', 'Rarity: Rare', 'Grim Halls', 'Strand Map', '--------',
    'Map Tier: 14', 'Item Quantity: +72% (augmented)', 'Item Rarity: +38% (augmented)', 'Monster Pack Size: +25% (augmented)',
    'Quality: +20% (augmented)', '--------', 'Item Level: 81', '--------',
    'Area has patches of Burning Ground', 'Monsters deal 90% extra Physical Damage as Fire', '--------',
    'Travel to this Map by using it in a personal Map Device. Maps can only be used once.'];
  const BLIGHTED = ['Item Class: Maps', 'Rarity: Normal', 'Blighted Strand Map', '--------', 'Map Tier: 11', '--------',
    'Item Level: 78', '--------', 'Area is infested with Fungal Growths (implicit)', 'Map\'s Item Quantity Modifiers also affect Blight Chest count (implicit)',
    '--------', 'Travel to this Map by using it in a personal Map Device. Maps can only be used once.'];
  const RAVAGED = ['Item Class: Maps', 'Rarity: Rare', 'Doom Spires', 'Blight-ravaged Strand Map', '--------', 'Map Tier: 16', '--------',
    'Item Level: 83', '--------', 'Area is infested with Fungal Growths (implicit)', '--------', 'Monsters have 50% increased Area of Effect'];
  const ELDRITCH = ['Item Class: Body Armours', 'Rarity: Rare', 'Doom Shell', 'Vaal Regalia', '--------', 'Energy Shield: 412 (augmented)', '--------',
    'Requirements:', 'Level: 68', 'Int: 194', '--------', 'Item Level: 86', '--------',
    '{ Searing Exarch Implicit Modifier (Grand) — Mana }', '12(11-13)% increased Mana Regeneration Rate (implicit)',
    '{ Eater of Worlds Implicit Modifier (Exquisite) — Damage }', '9(8-10)% increased Global Damage (implicit)', '--------',
    '{ Prefix Modifier "Seraphim\'s" (Tier: 2) — Defences, Energy Shield }', '+42(39-42)% increased Energy Shield', '+13(12-13)% increased Stun and Block Recovery',
    '{ Suffix Modifier "of Bameth" (Tier: 1) — Chaos, Resistance }', '+33(31-35)% to Chaos Resistance', '--------',
    'Searing Exarch Item', 'Eater of Worlds Item'];
  const ELDRITCH_PLAIN = ['Item Class: Body Armours', 'Rarity: Rare', 'Doom Shell', 'Vaal Regalia', '--------', 'Item Level: 86', '--------',
    '12% increased Mana Regeneration Rate (implicit)', '--------', '+33% to Chaos Resistance', '--------', 'Searing Exarch Item'];
  const FRACTURED = ['Item Class: Rings', 'Rarity: Rare', 'Rune Turn', 'Two-Stone Ring', '--------', 'Requirements:', 'Level: 50', '--------',
    'Item Level: 84', '--------', '+14% to Cold and Lightning Resistances (implicit)', '--------',
    '+42% to Fire Resistance (fractured)', '+70 to maximum Life', '--------', 'Fractured Item'];
  const MIRRORED = ['Item Class: Rings', 'Rarity: Rare', 'Corpse Bite', 'Steel Ring', '--------', 'Item Level: 84', '--------',
    'Adds 8 to 13 Physical Damage to Attacks (implicit)', '--------', '+68 to maximum Life', '--------', 'Mirrored'];
  const TRANSFIG = ['Item Class: Skill Gems', 'Rarity: Gem', 'Kinetic Bolt of Fragmentation', '--------', 'Projectile, Attack', 'Level: 20 (Max)',
    'Cost: 7 Mana', 'Quality: +20% (augmented)', '--------', 'Requirements:', 'Level: 70', 'Dex: 79', 'Int: 110', '--------',
    'Fires a projectile that changes direction when it hits a wall and fragments when it expires.', '--------',
    'Place into an item socket of the right colour to gain this skill. Right click to remove from a socket.'];
  const PLAIN_GEM = TRANSFIG.map(l => l === 'Kinetic Bolt of Fragmentation' ? 'Kinetic Bolt' : l);
  const STRANDS = ['Item Class: Body Armours', 'Rarity: Rare', 'Grim Shell', 'Vaal Regalia', '--------', 'Energy Shield: 300 (augmented)', '--------',
    'Item Level: 84', '--------', 'Memory Strands: 37', '--------', '+90 to maximum Life'];
  const SYNTH = ['Item Class: Rings', 'Rarity: Rare', 'Blood Loop', 'Synthesised Two-Stone Ring', '--------', 'Item Level: 84', '--------',
    '10% increased Attack Speed (implicit)', '+14% to Cold and Lightning Resistances (implicit)', '--------', '+60 to maximum Life', '--------', 'Synthesised Item'];
  const VESTIGIAL = ['Item Class: Body Armours', 'Rarity: Normal', 'Vestigial Simple Robe', '--------', 'Energy Shield: 18', '--------', 'Item Level: 40'];
  const FOULBORN = ['Item Class: Belts', 'Rarity: Unique', 'Foulborn Headhunter', 'Leather Belt', '--------', 'Item Level: 84', '--------',
    '+32 to maximum Life (implicit)', '--------', '+46 to Strength', '+45 to Dexterity (mutated)', '+55 to maximum Life',
    'When you Kill a Rare monster, you gain its Modifiers for 60 seconds', '--------', '"A man\'s soul rules from a cavern of bone."'];
  const REPLICA = ['Item Class: Body Armours', 'Rarity: Unique', 'Replica Farrul\'s Fur', 'Triumphant Lamellar', '--------', 'Item Level: 84', '--------',
    '+90 to maximum Life'];
  const UNID_UNIQUE = ['Item Class: Belts', 'Rarity: Unique', 'Leather Belt', '--------', 'Item Level: 84', '--------',
    '+32 to maximum Life (implicit)', '--------', 'Unidentified'];

  // no name tables loaded: the old behaviour for a plain magic copy (the whole name)
  const noTab = G(MAGIC_PLAIN);
  assert(noTab.base === 'Hale Vaal Regalia of the Penguin' && noTab.name === noTab.base, 'magic, no headers, no base tables: base stays the whole name');
  const adv1 = G(MAGIC_ADV);
  assert(adv1.base === 'Vaal Regalia' && adv1.name === 'Hale Vaal Regalia of the Penguin', 'magic advanced copy: affix names peeled off -> "' + adv1.base + '", name kept');
  assert(adv1.mods.length === 2 && adv1.mods[0].affix === 'Hale' && adv1.mods[0].affixType === 'prefix' &&
         adv1.mods[1].affix === 'of the Penguin' && adv1.mods[1].affixType === 'suffix' && adv1.mods[0].line === '+22 to maximum Life',
         'advanced copy keeps the affix names on the mods: ' + adv1.mods.map(m => m.affix).join(', '));
  assert(adv1.advanced === true && adv1.identified === true && adv1.sockets === 'B-B B', 'advanced flag, identified, sockets still parsed');

  global.window = {};
  ['basetypes', 'baseicons', 'filtericons', 'gemtypes'].forEach(n => require(path.join(__dirname, '..', 'data', n + '.js')));
  const plain = G(MAGIC_PLAIN);
  assert(plain.base === 'Vaal Regalia' && plain.name === 'Hale Vaal Regalia of the Penguin', 'magic, no headers: base from the known-base lookup -> "' + plain.base + '"');
  assert(G(FLASK).base === 'Divine Life Flask', 'magic flask base -> "' + G(FLASK).base + '"');
  const mmap = G(MAGIC_MAP);
  assert(mmap.base === 'Lair of the Hydra Map' && mmap.mapTier === 16, 'magic guardian map: base with its own "of" kept, tier 16 -> "' + mmap.base + '" T' + mmap.mapTier);
  const unidMagic = G(['Item Class: Body Armours', 'Rarity: Magic', 'Vaal Regalia', '--------', 'Item Level: 79', '--------', 'Unidentified']);
  assert(unidMagic.base === 'Vaal Regalia' && unidMagic.identified === false, 'unidentified magic: base is its only line');

  const sup = G(SUPERIOR);
  assert(sup.base === 'Vaal Regalia' && sup.name === 'Superior Vaal Regalia' && sup.quality === 12, 'Superior stripped from the base, name kept: "' + sup.base + '"');
  const un = G(UNUSABLE);
  assert(un.name === 'Havoc Edge' && un.base === 'Reaver Sword' && un.unusable === true, 'unusable item: warning dropped, name/base from the next section: ' + un.name + ' / ' + un.base);
  assert(un.itemLevel === 75 && un.sockets === 'R-R-G' && un.mods.some(m => m.kind === 'implicit' && /Critical Strike Multiplier/.test(m.line)) &&
         !un.mods.some(m => /cannot use/.test(m.line)), 'unusable item: the rest still parses, warning is not a mod');

  const rmap = G(RARE_MAP);
  assert(rmap.mapTier === 14 && rmap.base === 'Strand Map' && rmap.quality === 20, 'map tier parsed: ' + rmap.mapTier);
  assert(!rmap.mods.some(m => /Map Tier/.test(m.line)) && rmap.mods.some(m => m.line === 'Area has patches of Burning Ground'),
         'Map Tier is still not a mod line, the map mods still are');
  assert(rmap.blightedMap === false && rmap.uberBlightedMap === false, 'ordinary map: not blighted');
  const bl = G(BLIGHTED);
  assert(bl.base === 'Strand Map' && bl.name === 'Blighted Strand Map' && bl.blightedMap === true && bl.uberBlightedMap === false && bl.mapTier === 11,
         'blighted map: base "' + bl.base + '", BlightedMap, T' + bl.mapTier);
  const rv = G(RAVAGED);
  assert(rv.base === 'Strand Map' && rv.uberBlightedMap === true && rv.blightedMap === true, 'blight-ravaged map: base "' + rv.base + '", both blight flags');
  const incub = G(['Item Class: Incubators', 'Rarity: Normal', 'Blighted Incubator', '--------', 'Item Level: 1']);
  assert(incub.base === 'Blighted Incubator' && incub.blightedMap === false, '"Blighted Incubator" is a real base and not a map');
  assert(sup.mapTier === undefined, 'no map tier on a non-map');

  const el = G(ELDRITCH);
  assert(el.influences.indexOf('Searing Exarch') !== -1 && el.influences.indexOf('Eater of Worlds') !== -1,
         'eldritch lines still in influences (the trade search and cards read them there)');
  assert(JSON.stringify(el.eldritch) === '["Searing Exarch","Eater of Worlds"]', 'eldritch lines in their own field: ' + JSON.stringify(el.eldritch));
  assert(el.searingExarchImplicits === 3 && el.eaterOfWorldsImplicits === 5, 'eldritch tiers from the headers (Grand 3, Exquisite 5): ' +
         el.searingExarchImplicits + '/' + el.eaterOfWorldsImplicits);
  assert(el.mods.filter(m => m.kind === 'implicit').length === 2 && el.mods[0].eldritch === 'Searing Exarch' && el.mods[1].eldritch === 'Eater of Worlds',
         'eldritch implicits: kind implicit, source on the mod');
  assert(el.mods[2].affix === 'Seraphim\'s' && el.mods[3].affix === 'Seraphim\'s' && el.mods[2].affixSeq === el.mods[3].affixSeq &&
         el.mods[4].affix === 'of Bameth' && el.mods[4].affixSeq !== el.mods[2].affixSeq, 'hybrid mod: both lines share one header number');
  const elp = G(ELDRITCH_PLAIN);
  assert(elp.searingExarchImplicits === undefined && elp.eaterOfWorldsImplicits === 0, 'eldritch without headers: tier unknown (unset); absent Eater = 0');
  assert(G(MIRRORED).searingExarchImplicits === 0 && G(MIRRORED).eldritch.length === 0, 'no eldritch line -> tier 0');

  const fr = G(FRACTURED);
  assert(fr.fractured === true && !fr.mods.some(m => m.line === 'Fractured Item') && fr.mods.some(m => m.fractured), 'fractured item: flag set, marker line is not a mod');
  assert(G(MIRRORED).fractured === false && G(MIRRORED).mirrored === true && !G(MIRRORED).mods.some(m => m.line === 'Mirrored'),
         'mirrored item: flag set, marker line is not a mod; not fractured');
  assert(fr.mirrored === false && fr.synthesised === false && fr.vestigial === false && fr.zanaMemory === false && fr.scourged === false &&
         fr.memoryStrands === 0 && fr.replica === false && fr.foulborn === false && fr.transfiguredGem === false,
         'flags known false on a full copy without their markers');

  const tg = G(TRANSFIG), pg = G(PLAIN_GEM);
  assert(tg.transfiguredGem === true && pg.transfiguredGem === false && tg.gemLevel === 20 && tg.quality === 20,
         'transfigured gem from the gem table (Kinetic Bolt of Fragmentation yes, Kinetic Bolt no)');
  const ms = G(STRANDS);
  assert(ms.memoryStrands === 37 && !ms.mods.some(m => /Memory Strands/.test(m.line)) && ms.mods.length === 1, 'memory strands parsed, not a mod');
  const sy = G(SYNTH);
  assert(sy.synthesised === true && sy.base === 'Two-Stone Ring' && !sy.mods.some(m => m.line === 'Synthesised Item'), 'synthesised: base "' + sy.base + '", flag, marker not a mod');
  const ve = G(VESTIGIAL);
  assert(ve.vestigial === true && ve.base === 'Simple Robe' && ve.name === 'Vestigial Simple Robe', 'vestigial: base "' + ve.base + '", name kept');
  const fb = G(FOULBORN);
  assert(fb.foulborn === true && fb.imbued === true && fb.replica === false && fb.mods.some(m => m.mutated && m.line === '+45 to Dexterity'),
         'foulborn unique: flags, (mutated) suffix taken off the mod line');
  assert(G(REPLICA).replica === true && G(REPLICA).foulborn === false, 'replica unique');
  const uu = G(UNID_UNIQUE);
  assert(uu.replica === undefined && uu.foulborn === undefined && uu.identified === false && uu.base === 'Leather Belt',
         'unidentified unique: replica/foulborn unknown (unset), not false');
  const spaced = G(['Item Class: Stackable Currency', 'Rarity: Currency', 'Chaos Orb', '--------', 'Stack Size: 1 234/5 000']);
  assert(spaced.stackSize === 1234, 'stack size with a space as thousands separator: ' + spaced.stackSize);
  delete window.POE_GEM_TYPES;
  assert(G(PLAIN_GEM).transfiguredGem === undefined && G(TRANSFIG.concat(['--------', 'Transfigured'])).transfiguredGem === true,
         'no gem table: transfigured unknown unless the copy says "Transfigured"');
  delete global.window;

  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL TESTS PASSED'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
