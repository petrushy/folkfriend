// A session's plan and what has been played from it: the pure rules
// (src/js/sessionPlan.mjs, src/js/tuneNames.mjs).
//
// Run with:  node app/test/sessionPlan.test.mjs

import assert from 'node:assert/strict';
import { normaliseTuneName, matchableNames } from '../src/js/tuneNames.mjs';
import {
    makeTuneItem, makeSetItem, appendItems, moveItem, removeItem, setManualDone,
    nextManualState, planProgress, planContains, sanitisePlan,
} from '../src/js/sessionPlan.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const tune = (tuneID, title, extra = {}) => makeTuneItem({ tuneID, settingID: Number(tuneID) * 10, title, ...extra });
const played = (tuneId, title, startSeconds = 0) => ({ tuneId, title, startSeconds });

console.log('\nnames');

test('spelling, articles, apostrophes and accents do not matter', () => {
    assert.equal(normaliseTuneName("Cooley’s Reel"), normaliseTuneName("Cooleys"));
    assert.equal(normaliseTuneName('The Banshee'), normaliseTuneName('banshee, the'));
    assert.equal(normaliseTuneName('Gånglåt från Mockfjärd'), normaliseTuneName('ganglat fran mockfjard'));
    assert.equal(normaliseTuneName('The Kid on the Mountain'), 'kid on the mountain');
});

test('a name that is only a tune type is never used to match', () => {
    assert.deepEqual(matchableNames(['Polska', 'Reel', 'Ab', 'The Reel']), []);
    assert.deepEqual(matchableNames(['Polska efter Pekkos Per']), ['polska efter pekkos per']);
});

console.log('\ncrossing off');

test('the same tune id crosses off, whatever setting was played', () => {
    const plan = [tune(1, 'The Kesh')];
    const p = planProgress(plan, [played(1, 'Something Else')]);
    assert.equal(p.byId.get(plan[0].id).done, true);
    assert.equal(p.nextId, null);
});

test('a copy in another dataset crosses off by name', () => {
    // Norbeck and thesession give one tune two ids.
    const plan = [tune(99, 'Hälsinge Hambo', { aliases: ['Halsinge Hambo'] })];
    const p = planProgress(plan, [played(2000000001, 'Hälsinge Hambo')]);
    assert.equal(p.byId.get(plan[0].id).done, true);
});

test('a played tune is matched on its aliases as well as its title', () => {
    const plan = [tune(5, 'Drowsy Maggie')];
    const aliases = new Map([['77', ['Drowsy Maggie', 'Maggie Pickens']]]);
    assert.equal(planProgress(plan, [played(77, 'Maggie Pickens')], aliases).byId.get(plan[0].id).done, true);
    assert.equal(planProgress(plan, [played(77, 'Maggie Pickens')]).byId.get(plan[0].id).done, false);
});

test('unrelated tunes do not cross off, and the first unplayed is next', () => {
    const plan = [tune(1, 'The Kesh'), tune(2, 'Morning Dew'), tune(3, 'Silver Spear')];
    const p = planProgress(plan, [played(2, 'Morning Dew')]);
    assert.deepEqual(plan.map(i => p.byId.get(i.id).done), [false, true, false]);
    assert.equal(p.nextId, plan[0].id);
    assert.equal(p.doneCount, 1);
    assert.equal(p.total, 3);
});

test('a tune is played only once heard for long enough, summed over its rows', () => {
    const plan = [tune(1, 'The Kesh')];
    const row = (start, end) => ({ tuneId: 1, title: 'The Kesh', startSeconds: start, endSeconds: end });
    let p = planProgress(plan, [row(0, 20)]);
    assert.equal(p.byId.get(plan[0].id).done, false, '20 s of the default 45 s');
    assert.equal(p.byId.get(plan[0].id).heardSeconds, 20, 'but it is being heard');
    p = planProgress(plan, [row(0, 20), row(300, 330)]);
    assert.equal(p.byId.get(plan[0].id).done, true, 'twice, 50 s in all');
    assert.equal(planProgress(plan, [row(0, 20)], null, { minPlayedSeconds: 15 }).byId.get(plan[0].id).done, true);
    assert.equal(planProgress(plan, [row(0, 20)], null, { minPlayedSeconds: 0 }).byId.get(plan[0].id).done, true);
});

test('a rejected detection un-crosses (nothing is stored about playing)', () => {
    const plan = [tune(1, 'The Kesh')];
    assert.equal(planProgress(plan, [played(1, 'The Kesh')]).byId.get(plan[0].id).done, true);
    assert.equal(planProgress(plan, []).byId.get(plan[0].id).done, false);
});

test('the manual override wins both ways, and a second tap hands it back', () => {
    let plan = [tune(1, 'The Kesh'), tune(2, 'Morning Dew')];
    const heard = [played(1, 'The Kesh')];
    let p = planProgress(plan, heard);
    plan = setManualDone(plan, plan[0].id, nextManualState(plan[0], p.byId.get(plan[0].id)));
    plan = setManualDone(plan, plan[1].id, nextManualState(plan[1], p.byId.get(plan[1].id)));
    p = planProgress(plan, heard);
    assert.equal(p.byId.get(plan[0].id).done, false, 'heard, but the user says not');
    assert.equal(p.byId.get(plan[1].id).done, true, 'not heard, but the user says played');
    plan = setManualDone(plan, plan[0].id, nextManualState(plan[0], p.byId.get(plan[0].id)));
    assert.equal(planProgress(plan, heard).byId.get(plan[0].id).done, true);
});

test('a set is done only when every tune in it is', () => {
    const set = makeSetItem({ title: 'Kesh set', tunes: [
        { tuneID: 1, title: 'The Kesh' }, { tuneID: 2, title: 'Morning Dew' }] });
    const plan = [set];
    let p = planProgress(plan, [played(1, 'The Kesh')]);
    assert.equal(p.byId.get(set.id).done, false);
    assert.equal(p.nextId, set.tunes[1].id, 'next points INTO the set');
    p = planProgress(plan, [played(1, 'The Kesh'), played(2, 'Morning Dew')]);
    assert.equal(p.byId.get(set.id).done, true);
});

console.log('\nediting');

test('adding skips tunes already planned, by the same rule', () => {
    const plan = [tune(1, 'The Kesh')];
    const { plan: next, added, skipped } = appendItems(plan, [
        tune(1, 'Kesh Jig'), tune(50, 'kesh, the'), tune(2, 'Morning Dew'), tune(2, 'Morning Dew')]);
    assert.equal(added, 1);
    assert.equal(skipped, 3);
    assert.deepEqual(next.map(i => i.title), ['The Kesh', 'Morning Dew']);
    assert.equal(planContains(next, { tuneID: 2 }), true);
});

test('a set keeps its other tunes when one is already planned', () => {
    const plan = [tune(1, 'The Kesh')];
    const set = makeSetItem({ title: 'S', tunes: [{ tuneID: 1, title: 'The Kesh' }, { tuneID: 3, title: 'Silver Spear' }] });
    const { plan: next, skipped } = appendItems(plan, [set]);
    assert.equal(skipped, 1);
    assert.deepEqual(next[1].tunes.map(t => t.title), ['Silver Spear']);
});

test('order is the user\'s: move within the plan and within a set', () => {
    const set = makeSetItem({ title: 'S', tunes: [{ tuneID: 3, title: 'A' }, { tuneID: 4, title: 'B' }] });
    let plan = [tune(1, 'One'), set, tune(2, 'Two')];
    plan = moveItem(plan, plan[2].id, -1);
    assert.deepEqual(plan.map(i => i.title), ['One', 'Two', 'S']);
    plan = moveItem(plan, plan[0].id, -1); // already first
    assert.deepEqual(plan.map(i => i.title), ['One', 'Two', 'S']);
    plan = moveItem(plan, set.tunes[0].id, 1);
    assert.deepEqual(plan[2].tunes.map(t => t.title), ['B', 'A']);
});

test('removing the last tune of a set removes the set', () => {
    const set = makeSetItem({ title: 'S', tunes: [{ tuneID: 3, title: 'A' }] });
    const plan = removeItem([tune(1, 'One'), set], set.tunes[0].id);
    assert.deepEqual(plan.map(i => i.title), ['One']);
});

test('a stored plan that is not shaped like one is read as empty, not trusted', () => {
    assert.deepEqual(sanitisePlan(null), []);
    assert.deepEqual(sanitisePlan([{ kind: 'tune' }, 7, { id: 'x', kind: 'set' }]), []);
    assert.equal(sanitisePlan([tune(1, 'One')]).length, 1);
});

console.log(`\n${passed} passed`);
