/* js/app/34-syndicate.js — Betrayal / Syndicate planner: a copy of your in-game board (who sits in
   which division, at which rank, who leads) plus a goal, and the next moves that get the board there.
   Mounted inside the Syndicate mechanic sheet through window.__mechanicExtras.syndicate (the guides
   view calls it with a container). The js/app/ files are one program split by feature: they load in
   order (index.html) and share their top-level names. */
'use strict';

// ==== Syndicate planner =============================================================
// Data: data/syndicate.js (tools/make_syndicate.py, from the verified research in
// tools/guides/guides-3.29.json). Every reward, goal, value hint and rule sentence comes from it;
// this file only compares your board with the goal and words the moves. Each suggestion carries
// the research sentence it follows (s.rules), so the "why" can always be checked.
// Saved: pobtf-syndicate in storage (persist(), so it survives restarts through the bridge).

var SYND_KEY = 'pobtf-syndicate';
var SYND_MAX_RANK = 3;
var SYND_NEAR_FULL = 80; // intel % at which a house counts as "close to full" (a UI threshold)

window.__mechanicExtras = window.__mechanicExtras || {};
window.__mechanicExtras.syndicate = syndicatePlanner;

function syndData() { return window.POE_SYNDICATE || null; }
function syndGoal(D, id) { return D.goals.filter(function (g) { return g.id === id; })[0] || D.goals[0]; }
function syndDivName(D, d) {
  var p = D.divisions.filter(function (x) { return x[0] === d; })[0];
  return p ? p[1] : d;
}
function syndIsDiv(D, d) { return D.divisions.some(function (x) { return x[0] === d; }); }
// "in a Research encounter" / "in an Intervention encounter"
function syndIn(what) { return ' in ' + (/^[AEIOU]/.test(what) ? 'an ' : 'a ') + what + ' encounter'; }
// "Haku", "Haku and Leo", "Haku, Leo and Rin"
function syndList(names) {
  if (names.length < 2) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// ---- state ------------------------------------------------------------------------
// { v, goal, tol (Test of Loyalty), unbreaking (scarab), intel: {div: 0..100},
//   m: { name: { d: division | null (unassigned) | 'away', r: 0..3, l: leader, riv: [names] } } }
function syndBlank(D) {
  var m = {}, intel = {};
  D.members.forEach(function (x) { m[x.name] = { d: null, r: 0, l: false, riv: [] }; });
  D.divisions.forEach(function (x) { intel[x[0]] = 0; });
  var def = D.goals.filter(function (g) { return g.fillerDivisions && g.fillerDivisions.length; })[0] || D.goals[0];
  return { v: 1, goal: def.id, tol: true, unbreaking: false, intel: intel, m: m };
}

function syndNormalize(D, s) {
  var st = syndBlank(D);
  if (!s || typeof s !== 'object') return st;
  if (D.goals.some(function (g) { return g.id === s.goal; })) st.goal = s.goal;
  if (typeof s.tol === 'boolean') st.tol = s.tol;
  if (typeof s.unbreaking === 'boolean') st.unbreaking = s.unbreaking;
  Object.keys(st.intel).forEach(function (d) {
    var n = s.intel ? Number(s.intel[d]) : NaN;
    if (n >= 0 && n <= 100) st.intel[d] = Math.round(n);
  });
  var leaders = {};
  Object.keys(st.m).forEach(function (name) {
    var x = s.m && s.m[name];
    if (!x || typeof x !== 'object') return;
    var o = st.m[name];
    if (x.d === 'away' || syndIsDiv(D, x.d)) o.d = x.d;
    var r = Math.round(Number(x.r));
    o.r = syndIsDiv(D, o.d) && r >= 0 && r <= SYND_MAX_RANK ? r : 0;
    o.l = !!x.l && syndIsDiv(D, o.d) && !leaders[o.d];
    if (o.l) leaders[o.d] = name;
    o.riv = (Array.isArray(x.riv) ? x.riv : []).filter(function (n, i, a) {
      return n !== name && st.m[n] && a.indexOf(n) === i;
    });
  });
  // rivalries go both ways
  Object.keys(st.m).forEach(function (a) {
    st.m[a].riv.forEach(function (b) { if (st.m[b].riv.indexOf(a) === -1) st.m[b].riv.push(a); });
  });
  return st;
}

function syndLoad(D) {
  var s = null;
  try { s = JSON.parse(localStorage.getItem(SYND_KEY)); } catch (e) { s = null; }
  return syndNormalize(D, s);
}
function syndSave(st) {
  try { persist(SYND_KEY, JSON.stringify(st)); } catch (e) { /* storage full or off */ }
}

// Put a member somewhere. d: a division key, null (unassigned) or 'away'. r/leader optional.
function syndPlace(D, st, name, d, r, leader) {
  var o = st.m[name];
  if (!o) return;
  if (!syndIsDiv(D, d)) {
    o.d = d === 'away' ? 'away' : null;
    o.r = 0;
    o.l = false;
    return;
  }
  var from = o.d;
  o.d = d;
  if (r !== undefined && r !== null) o.r = Math.max(0, Math.min(SYND_MAX_RANK, r));
  else if (from !== d && o.r === 0) o.r = 1;
  if (leader !== undefined) o.l = !!leader;
  else if (from !== d) o.l = false;
  if (o.l) {
    Object.keys(st.m).forEach(function (n) { if (n !== name && st.m[n].d === d) st.m[n].l = false; });
  }
}
function syndToggleRival(st, a, b) {
  var A = st.m[a], B = st.m[b];
  if (!A || !B || a === b) return;
  var i = A.riv.indexOf(b);
  if (i === -1) { A.riv.push(b); if (B.riv.indexOf(a) === -1) B.riv.push(a); }
  else { A.riv.splice(i, 1); var j = B.riv.indexOf(a); if (j !== -1) B.riv.splice(j, 1); }
}

// ---- the plan: board vs goal -> member status + suggested moves ----------------------
function syndPlan(D, st) {
  var goal = syndGoal(D, st.goal), M = st.m, R = D.rules;
  var names = D.members.map(function (x) { return x.name; });
  var dn = function (d) { return syndDivName(D, d); };
  var inDiv = function (d) {
    return names.filter(function (n) { return M[n].d === d; })
      .sort(function (a, b) { return (M[b].l - M[a].l) || (M[b].r - M[a].r) || (a < b ? -1 : 1); });
  };
  var ranksIn = function (d) {
    return inDiv(d).reduce(function (s, n) { return s + (M[n].l ? 0 : M[n].r); }, 0);
  };
  var out = [];
  function add(prio, kind, text, why, rules, who) {
    out.push({ prio: prio, kind: kind, text: text, why: why || '',
               rules: [].concat(rules || []).filter(Boolean), who: who || [] });
  }
  var goalRule = function (re) { return goal.rules.filter(function (r) { return re.test(r); })[0]; };

  // goal targets -> needs (one member in one division). Alternatives ("as an alternative") only
  // keep a member where it is. A member wanted in two divisions (Aisling: Fortification or
  // Research) counts where it already sits, else the first one listed.
  var needs = [];
  goal.targets.forEach(function (t) {
    if (!t.alt) needs.push({ division: t.division, options: t.members.slice(), leaderFree: t.leaderFree, note: t.note,
                             text: t.text, alsoOk: [] });
  });
  var single = {};
  needs.forEach(function (n) { if (n.options.length === 1) (single[n.options[0]] = single[n.options[0]] || []).push(n); });
  Object.keys(single).forEach(function (who) {
    var list = single[who];
    if (list.length < 2) return;
    var keep = list.filter(function (n) { return M[who].d === n.division; })[0] || list[0];
    list.forEach(function (n) { if (n !== keep) { n.dropped = true; keep.alsoOk.push(n.division); } });
  });
  needs = needs.filter(function (n) { return !n.dropped; });
  var targetDivs = [];
  needs.forEach(function (n) { if (targetDivs.indexOf(n.division) === -1) targetDivs.push(n.division); });
  // A member in a target house that no target there lists has to leave it anyway (R.move), so
  // sending it on to its own target costs nothing extra: it goes before an unassigned option.
  var mustLeave = function (o) {
    var d = M[o].d;
    return targetDivs.indexOf(d) !== -1 &&
      !goal.targets.some(function (t) { return t.division === d && t.members.indexOf(o) !== -1; });
  };
  var cost = function (o) { return M[o].d === 'away' ? 9 : M[o].d === null ? 0 : mustLeave(o) ? -1 : 1 + M[o].r; };
  // One member, one division: single-option targets pick first, a member is never used twice, and a
  // target whose every option is already used stays unmet (flagged below) instead of reusing one.
  var taken = {};
  needs.slice().sort(function (a, b) { return (a.options.length > 1) - (b.options.length > 1); }).forEach(function (n) {
    var free = n.options.filter(function (o) { return !taken[o]; });
    var here = free.filter(function (o) { return M[o].d === n.division; })
      .sort(function (a, b) { return M[b].r - M[a].r; });
    n.member = here[0] || free.slice().sort(function (a, b) { return cost(a) - cost(b); })[0] || null;
    if (n.member) taken[n.member] = 1;
  });
  needs.filter(function (n) { return !n.member; }).forEach(function (n) {
    add(15, 'warn', 'No free member for ' + n.options.join(' or ') + ' in ' + syndDivName(D, n.division),
      syndList(n.options) + (n.options.length > 1 ? ' already fill' : ' already fills') +
      ' another target of this goal, and a member sits in one division at a time.', [n.text], n.options);
  });
  needs = needs.filter(function (n) { return n.member; });

  var wanted = {}, wantedAny = {}, keep = {}, removeSet = {};
  D.divisions.forEach(function (x) { wanted[x[0]] = {}; });
  needs.forEach(function (n) {
    wanted[n.division][n.member] = 1;
    n.options.forEach(function (o) { wantedAny[o] = 1; });
    n.alsoOk.forEach(function (d) { wanted[d][n.member] = 1; });
  });
  goal.targets.forEach(function (t) {
    if (t.alt) t.members.forEach(function (o) { wanted[t.division][o] = 1; wantedAny[o] = 1; });
  });
  goal.keep.forEach(function (k) { keep[k] = 1; });
  goal.remove.forEach(function (k) { removeSet[k] = 1; });
  var fillerDivs = goal.fillerDivisions || [];
  var fillerSize = goal.fillerSize || 0;
  var inPlace = function (n) { return M[n.member].d === n.division || n.alsoOk.indexOf(M[n.member].d) !== -1; };

  // member status for the cards
  var status = {};
  names.forEach(function (n) {
    var o = M[n], s = '';
    if (o.d && o.d !== 'away' && wanted[o.d][n]) s = 'ok';
    else if (needs.some(function (x) { return x.member === n; })) s = 'want';
    // 'keep' means "don't remove it from the Syndicate", not "never move it": a kept member in a
    // target house that doesn't want it is still out of place
    else if (o.d && targetDivs.indexOf(o.d) !== -1) s = 'out';
    else if (removeSet[n]) s = 'remove';
    else if (fillerDivs.indexOf(o.d) !== -1) s = 'filler';
    status[n] = s;
  });
  var wantTo = {};
  needs.forEach(function (n) { wantTo[n.member] = n.division; });

  if (!names.some(function (n) { return M[n].d !== null; })) {
    add(0, 'info', 'Copy your board first: click a member, then a division row (or drag it there).',
      'Every member starts as Unassigned. Mark the ones the game does not show as Away / dead.', []);
  }

  // 1. each target: get it into its division, then to rank 3
  needs.forEach(function (n) {
    var who = n.member, o = M[who], D_ = dn(n.division), also = n.alsoOk.map(dn);
    var where = D_ + (also.length ? ' (or ' + also.join(', ') + ')' : '');
    var rr = goal.rankRewards || {};
    if (inPlace(n)) {
      var here = dn(o.d);
      if (o.l) {
        add(20, 'warn', who + ' is stuck as the ' + here + ' leader',
          n.leaderFree ? 'This goal wants ' + who + ' leader-free in ' + D_ + '.' : '', [R.stuckLeader], [who]);
        return;
      }
      if (o.r >= SYND_MAX_RANK) return; // ready: see the safehouse moves
      var to = Math.min(SYND_MAX_RANK, o.r + (st.tol ? 2 : 1));
      if (o.r === 0) {
        add(30, 'execute', 'Execute ' + who + syndIn(here) + ' (needs a witness)',
          who + ' is rank 0: executing it places it in the encounter\'s division.', [R.recruit], [who]);
        return;
      }
      var why = who + ' is rank ' + o.r + ' in ' + here + '; the goal wants rank 3' +
        (st.tol ? '. Test of Loyalty adds the extra rank.' : '.');
      if (rr[String(o.r)]) why = 'Rank ' + o.r + ' = ' + rr[String(o.r)] + '. Only if you need rank 3 = ' + (rr['3'] || 'the top reward') + '.';
      add(30, 'execute', 'Execute ' + who + syndIn(here) + ' (needs a witness) → rank ' + to, why, [R.execute], [who]);
      return;
    }
    if (o.d === null) {
      add(30, 'execute', 'Execute ' + who + syndIn(where) + ' (needs a witness)',
        who + ' is unassigned: executing it places it in that encounter\'s division.', [R.recruit], [who]);
    } else if (o.d === 'away') {
      add(55, 'remove', who + ' is away: remove your least-wanted member when an encounter offers it',
        'A random missing member replaces the one you remove, so ' + who + ' can come back.', [R.remove], [who]);
    } else if (o.l) {
      add(20, 'warn', who + ' is stuck as the ' + dn(o.d) + ' leader (the goal wants it in ' + where + ')', '', [R.stuckLeader], [who]);
    } else if (o.r === 0) {
      add(30, 'execute', 'Execute ' + who + syndIn(where) + ' (needs a witness)',
        who + ' is rank 0 in ' + dn(o.d) + ': executing it places it in the encounter\'s division.', [R.recruit], [who]);
    } else {
      var times = o.r > 1 ? ', ' + o.r + ' times to rank 0' : '';
      add(30, 'interrogate', 'Interrogate ' + who + ' out of ' + dn(o.d) + ' (-1 rank' + times + '), then execute ' + who + syndIn(where),
        who + ' is rank ' + o.r + ' in ' + dn(o.d) + '. A Bargain can also switch its division.' +
        (st.unbreaking ? ' Unbreaking gives a 50% chance to keep the rank, so it slows this down.' : ''),
        [R.move].concat(st.unbreaking ? [R.unbreaking] : []), [who]);
    }
  });

  // 2. rank-3 targets: never interrogate them before their house
  var top = needs.filter(function (n) { return inPlace(n) && !M[n.member].l && M[n.member].r >= SYND_MAX_RANK; })
    .map(function (n) { return n.member; });
  if (top.length) {
    add(22, 'warn', 'Don\'t interrogate ' + syndList(top) + ' before ' + (top.length > 1 ? 'their safehouses' : 'its safehouse'),
      'A rank-3 target loses a rank.' + (st.unbreaking ? ' Unbreaking only gives a 50% chance to keep it.' : ''), [R.rank3], top);
    add(70, 'release', 'Release ' + syndList(top) + ' when every other choice would hurt ' + (top.length > 1 ? 'them' : 'it'),
      '', [R.release, goalRule(/^Release/)], top);
  }

  // 3. safehouses
  D.divisions.forEach(function (x) {
    var d = x[0], Dn = x[1], intel = st.intel[d] || 0;
    var full = intel >= 100, near = intel >= SYND_NEAR_FULL;
    var asap = (goal.runAsap || []).indexOf(d) !== -1;
    var here = needs.filter(function (n) { return n.division === d; });
    var members = inDiv(d);
    if (here.length) {
      var rr = goal.rankRewards || {};
      var ranked = here.map(function (n) {
        var o = M[n.member];
        return n.member + (o.d === d ? (o.l ? ' leader' : ' rank ' + o.r) : ' not here yet');
      });
      var ready = here.every(function (n) { var o = M[n.member]; return o.d === d && !o.l && o.r >= SYND_MAX_RANK; });
      var rankGoal = Object.keys(rr).length && here.every(function (n) { var o = M[n.member]; return o.d === d && !o.l && o.r >= 1; });
      var between = fillerDivs.length && targetDivs.length > 1 ? R.between : null;
      var bar = full ? ' now: the bar is full' : intel ? ' when the bar is full (' + intel + '% now)' : ' when the bar is full';
      if (rankGoal) {
        var n0 = here[0], r0 = M[n0.member].r;
        add(10, 'run', 'Run the ' + Dn + ' safehouse at the rank you need: ' + n0.member + ' rank ' + r0 + ' = ' + rr[String(r0)],
          'Raid' + bar + '.', [goalRule(/^Pick the rank/), R.check], [n0.member]);
      } else if (ready) {
        add(10, 'run', 'Run the ' + Dn + ' safehouse: ' + syndList(ranked),
          (full ? 'The bar is full: run it now.' : 'Run it when the bar is full' + (intel ? ' (' + intel + '% now).' : '.')) +
          (between ? ' Two target houses: space their runs out.' : ''),
          [R.raid, R.check, between], here.map(function (n) { return n.member; }));
      } else if (asap) {
        add(12, 'run', 'Run the ' + Dn + ' safehouse as soon as it fills' + (full ? ' (full now)' : ''),
          'Now: ' + syndList(ranked) + '. Rank-3 targets pay more.', [goalRule(/as soon as it fills/), R.raid],
          here.map(function (n) { return n.member; }));
      } else {
        var wants = Object.keys(rr).length ? 'the rank you need' : 'rank 3';
        add(26, 'hold', 'Hold the ' + Dn + ' safehouse: ' + syndList(ranked) + ' (wants ' + wants + ')',
          full ? 'The bar is full already: a full house stops spawning until you run it or about 3 maps pass.' : 'Get the targets to ' + wants + ' first.',
          full ? [R.raid, R.fullHouse] : [R.raid], here.map(function (n) { return n.member; }));
      }
      // a Leader joins once the house holds 3 total ranks
      var hasLeader = members.some(function (n) { return M[n].l; });
      var tr = ranksIn(d);
      if (!hasLeader && tr >= 3) {
        var lf = here.filter(function (n) { return n.leaderFree; }).map(function (n) { return n.member; });
        add(lf.length ? 24 : 80, lf.length ? 'warn' : 'info', Dn + ' holds ' + tr + ' ranks: a Leader can join as reinforcement',
          lf.length ? 'This goal wants ' + syndList(lf) + ' leader-free in ' + Dn + '.' : '', [R.leader, lf.length ? R.stuckLeader : null]);
      }
    } else if (fillerDivs.indexOf(d) !== -1) {
      add(25, 'avoid', 'Don\'t raid ' + Dn + ': filler house' + (intel ? ' (' + intel + '% full)' : ''),
        members.length + (fillerSize ? '/' + fillerSize : '') + ' members.', [R.filler, goalRule(/^Never raid/)], members);
      if (near) {
        add(21, 'warn', Dn + ' is close to full (' + intel + '%)',
          'It\'s a filler house: leave it unrun, and avoid interrogating its members (that adds ' + Dn + ' intel).',
          [R.interrogate, R.fullHouse], members);
      }
      if (fillerSize && members.length > fillerSize) {
        add(42, 'info', Dn + ' has ' + members.length + ' members; this board wants ' + fillerSize,
          'Move the extra ones to the other filler house.', goal.removeText, []);
      }
    } else if (asap && members.length) {
      add(full ? 10 : 12, 'run', full ? 'Run the ' + Dn + ' safehouse now: the bar is full' : 'Run the ' + Dn + ' safehouse as soon as it fills',
        (goal.targetText || []).join(' '), [goalRule(/as soon as it fills/)], members);
    }
  });

  // 4. members in a target house that the goal doesn't want there: out (interrogate, then execute elsewhere).
  // Targets on their way to another house are step 1's. Each move counts toward its destination, so
  // the evictions spread over the least-loaded houses and never push a filler house past fillerSize.
  var sizeOf = function (d) { return inDiv(d).length; };
  var dests = fillerDivs.length ? fillerDivs.slice() : D.divisions.map(function (x) { return x[0]; })
    .filter(function (d) { return targetDivs.indexOf(d) === -1; });
  var houseLoad = {};
  dests.forEach(function (d) { houseLoad[d] = sizeOf(d); });
  var roomIn = function (d) { return !fillerSize || fillerDivs.indexOf(d) === -1 || houseLoad[d] < fillerSize; };
  targetDivs.forEach(function (d) {
    inDiv(d).forEach(function (who) {
      var o = M[who];
      if (wanted[d][who] || wantTo[who] || o.l) return;
      var why = who + ' isn\'t a target in ' + dn(d) + (removeSet[who] ? ' and is on this goal\'s remove list' : '') + '.' +
        (keep[who] ? ' This goal keeps ' + who + ' in the Syndicate: move it, don\'t remove it.' : '');
      var dest = dests.filter(roomIn).sort(function (a, b) { return houseLoad[a] - houseLoad[b]; })[0];
      if (!dest && fillerDivs.length && !keep[who]) {
        add(40, 'remove', 'Remove ' + who + ' when an encounter offers it: the filler houses are full',
          why + ' ' + fillerDivs.map(function (x) { return dn(x) + ' ' + houseLoad[x] + '/' + fillerSize; }).join(', ') + '.',
          [R.remove, (goal.removeText || [])[0]], [who]);
        return;
      }
      if (dest) houseLoad[dest]++;
      var to = dest ? syndIn(dn(dest)) : ' in another division\'s encounter';
      var text = o.r > 0 ? 'Interrogate ' + who + ' out of ' + dn(d) + ' (-1 rank' + (o.r > 1 ? ', ' + o.r + ' times to rank 0' : '') + '), then execute ' + who + to
        : 'Execute ' + who + to + ': at rank 0 it moves there';
      add(40, o.r > 0 ? 'interrogate' : 'execute', text,
        why + (o.r > 0 && st.unbreaking ? ' Unbreaking can keep the rank (50%).' : ''),
        [o.r > 0 ? R.move : R.recruit, dest && fillerDivs.length ? (goal.removeText || [])[0] : null], [who]);
    });
  });

  // 5. remove-list members elsewhere
  var rem = goal.remove.filter(function (n) {
    return M[n] && M[n].d !== 'away' && targetDivs.indexOf(M[n].d) === -1;
  });
  if (rem.length) {
    add(50, 'remove', 'Remove ' + syndList(rem) + ' when an encounter offers it', 'Least wanted for this goal.', [R.remove], rem);
  }

  // 6. 2-2-5-5: unassigned non-targets fill the filler houses; full fillers with nobody unassigned can lock
  if (fillerDivs.length) {
    var spare = names.filter(function (n) { return M[n].d === null && !wantedAny[n]; });
    // room left after the step-4 moves above
    var open = fillerDivs.filter(function (d) { return !fillerSize || houseLoad[d] < fillerSize; });
    if (spare.length && open.length) {
      add(45, 'execute', 'Execute ' + syndList(spare) + syndIn(open.map(dn).join(' or ')) + ': filler',
        fillerDivs.map(function (d) { return dn(d) + ' ' + sizeOf(d) + (fillerSize ? '/' + fillerSize : ''); }).join(', ') + '.',
        [R.recruit, (goal.removeText || [])[0]], spare);
    }
    var unassigned = names.filter(function (n) { return M[n].d === null; }).length;
    if (fillerSize && fillerDivs.every(function (d) { return sizeOf(d) >= fillerSize; }) && !unassigned) {
      add(23, 'warn', 'Filler houses are full and nobody is unassigned: the two-member houses can lock', '', [R.lock]);
    }
  }

  // 7. Betray: link each target with an unwanted member as Rivals. Only for a goal whose research
  // asks for it (linkRivals: the 2-2-5-5 board); R.betray's "4 targets with the 10 unwanted" is that board.
  if (needs.length && goal.linkRivals) {
    var pool = names.filter(function (n) { return !wantedAny[n] && !keep[n] && M[n].d !== 'away'; });
    var load = {}; // rivals each unwanted member has, counting the pairs suggested here (spreads the picks)
    pool.forEach(function (n) { load[n] = M[n].riv.length; });
    needs.forEach(function (n) {
      var who = n.member;
      if (M[who].d === 'away' || M[who].riv.some(function (x) { return pool.indexOf(x) !== -1; })) return;
      var pick = pool.slice().sort(function (a, b) {
        return ((fillerDivs.indexOf(M[b].d) !== -1) - (fillerDivs.indexOf(M[a].d) !== -1)) ||
          (load[a] - load[b]) || (a < b ? -1 : 1);
      })[0];
      if (!pick) return;
      load[pick]++;
      add(60, 'betray', 'Betray to make ' + who + ' and ' + pick + ' Rivals',
        who + ' has no Rival among the unwanted members yet. When both are defeated in one encounter, choose Betray.',
        [R.betray, goalRule(/Rivals/)], [who, pick]);
    });
  }

  // 8. Bargains are random: read them on placed targets
  var placed = needs.filter(inPlace).map(function (n) { return n.member; });
  if (placed.length) {
    add(72, 'bargain', 'Read every Bargain on ' + syndList(placed) + ' before you accept', '', [R.bargainRisk], placed);
  }

  out.sort(function (a, b) { return a.prio - b.prio; });
  return { goal: goal, needs: needs, wanted: wanted, wantTo: wantTo, status: status, targetDivs: targetDivs,
           fillerDivs: fillerDivs, fillerSize: fillerSize, suggestions: out, ranksIn: ranksIn, inDiv: inDiv };
}

var SYND_KINDS = {
  run: ['Run', 'success'], hold: ['Wait', 'info'], avoid: ['Avoid', 'danger'], warn: ['Warning', 'warn'],
  execute: ['Execute', 'accent'], interrogate: ['Interrogate', 'magic'], remove: ['Remove', 'neutral'],
  betray: ['Betray', 'exarch'], release: ['Release', 'neutral'], bargain: ['Bargain', 'neutral'], info: ['Note', 'neutral']
};

// member status in words (card chips and tooltips), so it never rests on the border colour alone
var SYND_STATUS = { ok: 'target here', out: 'not wanted here', want: 'wanted in %s', remove: 'remove (least wanted for this goal)',
                    filler: 'filler' };
var SYND_SEQ = 0; // unique editor ids when more than one planner is mounted

// plain-text copy of the board and the moves
function syndBoardText(D, st) {
  var P = syndPlan(D, st), M = st.m;
  var who = function (n) { var o = M[n]; return n + (o.l ? ' (leader)' : '') + ' R' + o.r; };
  var lines = ['Syndicate board (goal: ' + P.goal.name + ')'];
  D.divisions.forEach(function (x) {
    var list = P.inDiv(x[0]);
    lines.push(x[1] + (st.intel[x[0]] ? ' [' + st.intel[x[0]] + '% intel]' : '') + ': ' + (list.length ? list.map(who).join(', ') : '-'));
  });
  var un = D.members.filter(function (x) { return M[x.name].d === null; }).map(function (x) { return x.name; });
  var away = D.members.filter(function (x) { return M[x.name].d === 'away'; }).map(function (x) { return x.name; });
  lines.push('Unassigned: ' + (un.join(', ') || '-'));
  lines.push('Away / dead: ' + (away.join(', ') || '-'));
  var riv = [];
  D.members.forEach(function (x) {
    M[x.name].riv.forEach(function (b) { if (x.name < b) riv.push(x.name + ' x ' + b); });
  });
  if (riv.length) lines.push('Rivals: ' + riv.join(', '));
  lines.push('', 'Next moves:');
  P.suggestions.forEach(function (s, i) { lines.push((i + 1) + '. ' + s.text + (s.why ? ' (' + s.why + ')' : '')); });
  return lines.join('\n');
}

// ---- UI ---------------------------------------------------------------------------
function syndicatePlanner(container) {
  var D = syndData();
  var root = UI.el('div', 'synd');
  if (container) container.appendChild(root);
  if (!D) {
    root.appendChild(UI.emptyState({ title: 'Syndicate planner unavailable', text: 'data/syndicate.js did not load.' }));
    return root;
  }
  var st = syndLoad(D);
  var sel = null;      // the member whose editor is open
  var dragName = null;
  var byName = {};
  D.members.forEach(function (x) { byName[x.name] = x; });

  function save() { syndSave(st); }
  // render() rebuilds the board and the editor, which destroys the focused control. Rebuilt controls
  // carry data-fk (a stable key); change() puts focus back on the same one, so keyboard users keep
  // their place (and arrow keys keep working in the Rank group).
  function focusKey() {
    var a = document.activeElement;
    var k = a && root.contains(a) ? a.closest('[data-fk]') : null;
    return k ? k.dataset.fk : null;
  }
  function refocus(key) {
    var n = key ? root.querySelector('[data-fk="' + CSS.escape(key) + '"]') : null;
    if (!n || n.disabled) return false;
    n.focus();
    return true;
  }
  // the picked member's editor: its current place (division or pool), else the first division
  function focusEditor() {
    var n = editor.querySelector('.synd-ed-places [aria-pressed="true"]') || editor.querySelector('.synd-ed-place');
    if (n) n.focus();
  }
  function change() {
    var k = focusKey();
    save();
    render();
    if (!refocus(k) && k && sel) focusEditor();
  }

  // -- top bar: goal, passives, copy, reset
  var top = UI.el('div', 'synd-top');
  var goalSel = UI.select(D.goals.map(function (g) { return [g.id, g.name]; }), st.goal, {
    cls: 'synd-goal-select', ariaLabel: 'Goal',
    onChange: function () { st.goal = goalSel.value; change(); }
  });
  top.appendChild(UI.field('Goal', goalSel));
  function toggle(label, key, title) {
    var w = UI.el('label', 'synd-check');
    var c = UI.el('input');
    c.type = 'checkbox';
    c.checked = !!st[key];
    c.addEventListener('change', function () { st[key] = c.checked; change(); });
    w.appendChild(c);
    w.appendChild(UI.el('span', null, label));
    w.title = title;
    return w;
  }
  top.appendChild(toggle('Test of Loyalty', 'tol', 'Atlas passive: executed members gain an extra rank'));
  top.appendChild(toggle('Unbreaking scarab', 'unbreaking', 'Interrogated members have a 50% chance to keep their rank'));
  var acts = UI.el('span', 'synd-actions');
  acts.appendChild(UI.button('secondary', { label: 'Copy board as text', size: 'sm', onClick: copyBoard }));
  acts.appendChild(UI.button('danger', { label: 'Reset board', size: 'sm', onClick: resetBoard }));
  top.appendChild(acts);
  root.appendChild(top);

  var goalBox = UI.el('div', 'synd-goal');
  var main = UI.el('div', 'synd-main');
  var left = UI.el('div', 'synd-left');
  var board = UI.el('div', 'synd-board');
  var pools = UI.el('div', 'synd-pools');
  var editor = UI.el('div', 'synd-editor');
  editor.id = 'synd-editor-' + (++SYND_SEQ);
  editor.setAttribute('role', 'group');
  var side = UI.el('div', 'synd-side');
  left.appendChild(board);
  left.appendChild(pools);
  left.appendChild(editor);
  main.appendChild(left);
  main.appendChild(side);
  root.appendChild(goalBox);
  root.appendChild(main);
  var foot = UI.el('details', 'synd-foot');
  foot.appendChild(UI.el('summary', null, 'What each choice does'));
  var ul = UI.el('ul', 'synd-acts');
  D.actions.forEach(function (a) { ul.appendChild(UI.el('li', null, a)); });
  foot.appendChild(ul);
  foot.appendChild(UI.el('p', 'synd-note', 'Patch ' + D.asOf + ' research. Value hints: ' + D.priceSource + ', ' + D.priceDate +
    ' (rough). Each move names the rule it follows.'));
  root.appendChild(foot);

  // Esc while a member is picked cancels the pick (and returns to its card) instead of closing the
  // Cheat sheets page: caught on the way down (capture), so it works wherever focus is, and
  // defaultPrevented makes the page's own Esc handler skip it. A dialog's Esc is left alone.
  // (The guide view rebuilds the planner on each render: an old one, once out of the page, unhooks.)
  var wasShown = false;
  document.addEventListener('keydown', function onEsc(e) {
    if (root.isConnected) wasShown = true;
    else { if (wasShown) document.removeEventListener('keydown', onEsc, true); return; }
    if (e.key !== 'Escape' || !sel || e.defaultPrevented || document.querySelector('dialog[open]') ||
        !root.getClientRects().length) return; // a hidden view's planner leaves Esc alone
    e.preventDefault();
    e.stopPropagation();
    var name = sel;
    sel = null;
    render();
    refocus('card:' + name);
  }, true);

  function copyBoard() {
    var text = syndBoardText(D, st);
    var done = function () { UI.toast('Board copied to the clipboard.', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function resetBoard() {
    UI.confirmDanger('Reset the Syndicate board?',
      'Every member goes back to Unassigned at rank 0, with no leaders, rivals or intel. The goal stays.', 'Reset').then(function (ok) {
      if (!ok) return;
      var b = syndBlank(D);
      b.goal = st.goal; b.tol = st.tol; b.unbreaking = st.unbreaking;
      st = b;
      sel = null;
      change();
    });
  }

  // -- drag and drop (a bonus: clicking does everything too)
  function dropTarget(node, place) {
    node.addEventListener('dragover', function (e) { if (dragName) { e.preventDefault(); node.classList.add('is-drop'); } });
    node.addEventListener('dragleave', function () { node.classList.remove('is-drop'); });
    node.addEventListener('drop', function (e) {
      e.preventDefault();
      node.classList.remove('is-drop');
      var n = dragName || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      dragName = null;
      if (n && st.m[n]) { place(n); sel = null; save(); render(); refocus('card:' + n); }
    });
    // click: with a member picked, put it here
    node.addEventListener('click', function (e) {
      if (!sel || e.target.closest('.synd-card') || e.target.closest('input')) return;
      var n = sel;
      place(n);
      sel = null;
      save();
      render();
      refocus('card:' + n);
    });
  }

  function pips(r) {
    var p = UI.el('span', 'synd-pips');
    p.setAttribute('role', 'img');
    p.setAttribute('aria-label', 'rank ' + r);
    for (var i = 1; i <= SYND_MAX_RANK; i++) p.appendChild(UI.el('span', 'synd-pip' + (i <= r ? ' on' : '')));
    return p;
  }

  function card(name, P, compact) {
    var o = st.m[name], m = byName[name], s = P.status[name];
    var c = UI.el('button', 'synd-card' + (compact ? ' is-compact' : '') + (s ? ' is-' + s : '') +
      (o.l ? ' is-leader' : '') + (sel === name ? ' is-sel' : ''));
    c.type = 'button';
    c.dataset.name = name;
    c.dataset.fk = 'card:' + name;
    c.draggable = true;
    // the card opens the member's editor
    c.setAttribute('aria-expanded', sel === name ? 'true' : 'false');
    c.setAttribute('aria-controls', editor.id);
    var head = UI.el('span', 'synd-card-head');
    head.appendChild(UI.el('span', 'synd-card-name', name));
    if (o.l) head.appendChild(UI.el('span', 'synd-crown', 'Leader'));
    if (!compact) head.appendChild(pips(o.r));
    c.appendChild(head);
    var tip = [name + ': ' + m.best];
    if (!compact && o.d && o.d !== 'away') {
      c.appendChild(UI.el('span', 'synd-card-reward', m.rewards[o.d]));
      tip.push(syndDivName(D, o.d) + ': ' + m.rewards[o.d]);
      var hint = (D.values[name] || {})[o.d];
      var tags = UI.el('span', 'synd-card-tags');
      if (hint) tags.appendChild(UI.chip(hint.split(' ')[0], 'unique', 'synd-hint')).title = hint + ' (' + D.priceDate + ')';
      else if (m.ssf && m.good.indexOf(o.d) !== -1) tags.appendChild(UI.chip('top SSF pick', 'gem', 'synd-hint'));
      // status in words as well as the border colour
      if (s === 'ok') tags.appendChild(UI.chip('target', 'success', 'synd-status'));
      else if (s === 'out') tags.appendChild(UI.chip('not wanted here', 'warn', 'synd-status'));
      else if (s === 'want') tags.appendChild(UI.chip('→ ' + syndDivName(D, P.wantTo[name]), 'accent', 'synd-status'));
      else if (s === 'remove') tags.appendChild(UI.chip('remove', 'danger', 'synd-status'));
      if (o.riv.length) tags.appendChild(UI.chip('⚔ ' + o.riv.length, 'neutral')).title = 'Rivals: ' + o.riv.join(', ');
      if (tags.childNodes.length) c.appendChild(tags);
    } else if (P.wantTo[name]) {
      c.appendChild(UI.chip('→ ' + syndDivName(D, P.wantTo[name]), 'accent', 'synd-want synd-status'));
    } else if (s === 'remove') {
      c.appendChild(UI.chip('remove', 'danger', 'synd-status'));
    }
    var word = SYND_STATUS[s] ? SYND_STATUS[s].replace('%s', syndDivName(D, P.wantTo[name] || '')) : '';
    if (word) tip.push('Status: ' + word);
    c.title = tip.join('\n');
    c.addEventListener('click', function (e) {
      e.stopPropagation();
      sel = sel === name ? null : name;
      render();
      // picked: straight to its editor; unpicked: back to the card
      if (sel) focusEditor(); else refocus('card:' + name);
    });
    c.addEventListener('dragstart', function (e) {
      dragName = name;
      try { e.dataTransfer.setData('text/plain', name); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* fine */ }
    });
    c.addEventListener('dragend', function () { dragName = null; });
    return c;
  }

  function renderGoal(P) {
    goalBox.innerHTML = '';
    var g = P.goal;
    var t = UI.el('div', 'synd-goal-targets');
    g.targets.forEach(function (x) {
      var ch = UI.chip(x.members.join(' or ') + ' → ' + syndDivName(D, x.division) + (x.note ? ' (' + x.note + ')' : '') +
        (x.alt ? ' · alternative' : ''), x.alt ? 'neutral' : 'accent');
      t.appendChild(ch);
    });
    (g.targetText || []).forEach(function (x) { t.appendChild(UI.chip(x, 'accent')); });
    if (g.remove.length) t.appendChild(UI.chip('Remove: ' + g.remove.join(', '), 'neutral'));
    (g.removeText || []).forEach(function (x) { t.appendChild(UI.chip(x, 'neutral')); });
    goalBox.appendChild(t);
    var rl = UI.el('ul', 'synd-goal-rules');
    g.rules.forEach(function (r) { rl.appendChild(UI.el('li', null, r)); });
    goalBox.appendChild(rl);
    if (g.fillerDivisions && g.fillerDivisions.length && D.strategy) {
      goalBox.appendChild(UI.el('p', 'synd-note', D.strategy.name + ': ' + D.strategy.investment + ' Scarabs: ' +
        D.strategy.scarabs.join(', ') + '.'));
    }
  }

  function renderBoard(P) {
    board.innerHTML = '';
    D.divisions.forEach(function (x) {
      var d = x[0];
      var isT = P.targetDivs.indexOf(d) !== -1, isF = P.fillerDivs.indexOf(d) !== -1;
      var col = UI.el('section', 'synd-col' + (isT ? ' is-target' : '') + (isF ? ' is-filler' : ''));
      col.dataset.div = d;
      col.setAttribute('aria-label', x[1]);
      var head = UI.el('div', 'synd-col-head');
      var title = UI.el('div', 'synd-col-title');
      title.appendChild(UI.el('span', 'synd-col-name', x[1]));
      if (isT) title.appendChild(UI.chip('Target', 'success'));
      if (isF) title.appendChild(UI.chip('Filler', 'neutral'));
      head.appendChild(title);
      var list = P.inDiv(d);
      var meta = UI.el('div', 'synd-col-meta', list.length + (isF && P.fillerSize ? '/' + P.fillerSize : '') + ' members · ' + P.ranksIn(d) + ' ranks');
      head.appendChild(meta);
      var intel = UI.el('label', 'synd-intel');
      var rng = UI.el('input');
      rng.type = 'range'; rng.min = 0; rng.max = 100; rng.step = 10;
      rng.value = st.intel[d] || 0;
      rng.setAttribute('aria-label', x[1] + ' intelligence %');
      var pct = UI.el('span', 'synd-intel-pct', (st.intel[d] || 0) + '%');
      rng.addEventListener('input', function () {
        st.intel[d] = Number(rng.value);
        pct.textContent = rng.value + '%';
        col.classList.toggle('is-full', st.intel[d] >= 100);
        renderSide(syndPlan(D, st));
      });
      rng.addEventListener('change', save);
      intel.appendChild(UI.el('span', 'synd-intel-label', 'Intel'));
      intel.appendChild(rng);
      intel.appendChild(pct);
      head.appendChild(intel);
      if (st.intel[d] >= 100) col.classList.add('is-full');
      col.appendChild(head);
      var rows = [['L', 'Leader']];
      for (var r = SYND_MAX_RANK; r >= 1; r--) rows.push([String(r), 'Rank ' + r]);
      if (list.some(function (n) { return !st.m[n].l && st.m[n].r === 0; })) rows.push(['0', 'Rank 0']);
      rows.forEach(function (rw) {
        var row = UI.el('div', 'synd-row' + (rw[0] === 'L' ? ' is-leader-row' : ''));
        row.dataset.rank = rw[0];
        row.appendChild(UI.el('span', 'synd-row-label', rw[1]));
        var slot = UI.el('div', 'synd-slot');
        var here = list.filter(function (n) {
          return rw[0] === 'L' ? st.m[n].l : !st.m[n].l && String(st.m[n].r) === rw[0];
        });
        here.forEach(function (n) { slot.appendChild(card(n, P)); });
        if (!here.length) slot.appendChild(UI.el('span', 'synd-empty', sel ? 'Put ' + sel + ' here' : ''));
        row.appendChild(slot);
        dropTarget(row, function (n) {
          if (rw[0] === 'L') syndPlace(D, st, n, d, st.m[n].d === d ? st.m[n].r : Math.max(1, st.m[n].r), true);
          else syndPlace(D, st, n, d, Number(rw[0]), false);
        });
        col.appendChild(row);
      });
      board.appendChild(col);
    });
  }

  function renderPools(P) {
    pools.innerHTML = '';
    [[null, 'Unassigned'], ['away', 'Away / dead']].forEach(function (p) {
      var box = UI.el('section', 'synd-pool' + (p[0] ? ' is-away' : ''));
      box.dataset.pool = p[0] || 'none';
      box.appendChild(UI.el('div', 'synd-pool-title', p[1]));
      var list = UI.el('div', 'synd-pool-list');
      D.members.forEach(function (x) { if (st.m[x.name].d === p[0]) list.appendChild(card(x.name, P, true)); });
      if (!list.childNodes.length) list.appendChild(UI.el('span', 'synd-empty', sel ? 'Put ' + sel + ' here' : 'None'));
      box.appendChild(list);
      dropTarget(box, function (n) { syndPlace(D, st, n, p[0]); });
      pools.appendChild(box);
    });
  }

  function renderEditor() {
    editor.innerHTML = '';
    editor.hidden = !sel;
    if (!sel) return;
    var name = sel, o = st.m[name], m = byName[name];
    editor.setAttribute('aria-label', 'Edit ' + name);
    var head = UI.el('div', 'synd-ed-head');
    head.appendChild(UI.el('span', 'synd-ed-name', name));
    head.appendChild(UI.el('span', 'synd-ed-best', m.best));
    head.appendChild(UI.iconButton('✕', 'Close', { size: 'sm', onClick: function () {
      sel = null;
      render();
      refocus('card:' + name);
    } }));
    editor.appendChild(head);
    var places = UI.el('div', 'synd-ed-places');
    D.divisions.forEach(function (x) {
      var b = UI.el('button', 'synd-ed-place' + (o.d === x[0] ? ' is-on' : ''));
      b.type = 'button';
      b.dataset.div = x[0];
      b.dataset.fk = 'place:' + x[0];
      b.setAttribute('aria-pressed', o.d === x[0] ? 'true' : 'false');
      b.appendChild(UI.el('span', 'synd-ed-div', x[1]));
      b.appendChild(UI.el('span', 'synd-ed-reward', m.rewards[x[0]]));
      var hint = (D.values[name] || {})[x[0]];
      if (hint) b.appendChild(UI.el('span', 'synd-ed-hint', hint));
      b.addEventListener('click', function () { syndPlace(D, st, name, x[0]); change(); });
      places.appendChild(b);
    });
    [[null, 'Unassigned'], ['away', 'Away / dead']].forEach(function (p) {
      var b = UI.button(o.d === p[0] ? 'primary' : 'secondary', { label: p[1], size: 'sm', cls: 'synd-ed-pool',
        onClick: function () { syndPlace(D, st, name, p[0]); change(); } });
      b.setAttribute('aria-pressed', o.d === p[0] ? 'true' : 'false');
      b.dataset.fk = 'pool:' + (p[0] || 'none');
      places.appendChild(b);
    });
    editor.appendChild(places);
    var ctl = UI.el('div', 'synd-ed-ctl');
    var inDivision = syndIsDiv(D, o.d);
    var rank = UI.segmented([['0', '0'], ['1', '1'], ['2', '2'], ['3', '3']], String(o.r), {
      ariaLabel: 'Rank', onChange: function (v) { syndPlace(D, st, name, o.d, Number(v), o.l); change(); }
    });
    rank.querySelectorAll('button').forEach(function (b) {
      b.dataset.fk = 'rank:' + b.dataset.value;
      if (!inDivision) b.disabled = true;
    });
    // Not UI.field: a <label> forwards clicks on its caption to its first button ("0") and would
    // reset the rank. A plain wrapper; the group's name comes from its own aria-label.
    var rankField = UI.el('div', 'field synd-ed-rank');
    rankField.appendChild(UI.el('span', 'field-label', 'Rank'));
    rankField.appendChild(rank);
    ctl.appendChild(rankField);
    var lw = UI.el('label', 'synd-check');
    var lc = UI.el('input');
    lc.dataset.fk = 'leader';
    lc.type = 'checkbox';
    lc.checked = o.l;
    lc.disabled = !inDivision;
    lc.addEventListener('change', function () { syndPlace(D, st, name, o.d, o.r, lc.checked); change(); });
    lw.appendChild(lc);
    lw.appendChild(UI.el('span', null, 'Leader'));
    ctl.appendChild(lw);
    editor.appendChild(ctl);
    var rv = UI.el('div', 'synd-ed-rivals');
    rv.setAttribute('role', 'group');
    rv.setAttribute('aria-label', 'Rivals of ' + name);
    rv.appendChild(UI.el('span', 'field-label', 'Rivals'));
    D.members.forEach(function (x) {
      if (x.name === name) return;
      var on = o.riv.indexOf(x.name) !== -1;
      var b = UI.el('button', 'synd-rival' + (on ? ' is-on' : ''), x.name);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.dataset.fk = 'rival:' + x.name;
      b.addEventListener('click', function () { syndToggleRival(st, name, x.name); change(); });
      rv.appendChild(b);
    });
    editor.appendChild(rv);
  }

  function renderSide(P) {
    side.innerHTML = '';
    side.appendChild(UI.el('div', 'synd-side-title', 'Next moves'));
    var ol = UI.el('ol', 'synd-moves');
    P.suggestions.forEach(function (s) {
      var k = SYND_KINDS[s.kind] || SYND_KINDS.info;
      var li = UI.el('li', 'synd-move is-' + s.kind);
      li.dataset.kind = s.kind;
      var line = UI.el('div', 'synd-move-line');
      line.appendChild(UI.chip(k[0], k[1], 'synd-move-kind'));
      line.appendChild(UI.el('span', 'synd-move-text', s.text));
      li.appendChild(line);
      if (s.why) li.appendChild(UI.el('div', 'synd-move-why', s.why));
      s.rules.forEach(function (r) { li.appendChild(UI.el('div', 'synd-move-rule', 'Rule: ' + r)); });
      ol.appendChild(li);
    });
    if (!P.suggestions.length) ol.appendChild(UI.el('li', 'synd-move', 'Nothing to change: the board matches this goal.'));
    side.appendChild(ol);
  }

  function render() {
    var P = syndPlan(D, st);
    if (goalSel.value !== st.goal) goalSel.value = st.goal;
    renderGoal(P);
    renderBoard(P);
    renderPools(P);
    renderEditor();
    renderSide(P);
    root.classList.toggle('is-picking', !!sel);
  }
  render();
  root.syndRefresh = function () { st = syndLoad(D); render(); };
  return root;
}
