#!/usr/bin/env node
/**
 * The rules behind the item builder's clicks.
 *
 * These lived inside the component, where nothing could reach them, and a
 * single-select group ended up disabling every alternative as soon as one was
 * chosen — the picker looked broken and no test noticed.
 */
import {
  optionLimit, minPicks, isPickBlocked, applyPick, selectionProblems, initialPicks,
} from '../src/selection.js';

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { fail += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};

const opt = (id, name, available = true) => ({ id, name, is_available: available, price_delta: 0 });

const jarSize = {
  id: 1, name: 'Jar Size', input_type: 'single',
  min_select: 1, max_select: 1, is_required: 1,
  options: [opt(1, 'Regular'), opt(2, 'Medium'), opt(3, 'Large')],
};
const fruitMix = {
  id: 3, name: 'Fruit Mix', input_type: 'multi',
  min_select: 1, max_select: 3, is_required: 1,
  options: [opt(10, 'Banana'), opt(11, 'Mango'), opt(12, 'Dragon Fruit'), opt(13, 'Kiwi')],
};
const sweetener = {
  id: 6, name: 'Sweetener', input_type: 'single',
  min_select: 0, max_select: 1, is_required: 0,
  options: [opt(20, 'Honey'), opt(21, 'Muscovado')],
};
const toppings = {
  id: 4, name: 'Nuts & Seeds', input_type: 'multi',
  min_select: 0, max_select: 0, is_required: 0,
  options: [opt(30, 'Walnuts'), opt(31, 'Chia')],
};

console.log('\nLimits');
check('a single-select group caps at one', optionLimit(jarSize) === 1);
check('a capped multi-select reports its cap', optionLimit(fruitMix) === 3);
check('an uncapped multi-select is unlimited', optionLimit(toppings) === Infinity);
check('a required group needs at least one', minPicks(jarSize) === 1);
check('an optional group needs none', minPicks(sweetener) === 0);

console.log('\nSingle-select stays switchable');
// The regression: one chosen must never block the alternatives.
check('an alternative is pickable while one is chosen',
  isPickBlocked(jarSize, [1], jarSize.options[1]) === false);
check('every alternative is pickable',
  jarSize.options.every((o) => !isPickBlocked(jarSize, [1], o)));
check('picking another replaces it',
  JSON.stringify(applyPick(jarSize, [1], jarSize.options[2])) === '[3]');
check('the chosen one is not blocked either',
  isPickBlocked(jarSize, [1], jarSize.options[0]) === false);
check('a required group cannot be emptied by re-tapping',
  JSON.stringify(applyPick(jarSize, [1], jarSize.options[0])) === '[1]');
check('an optional single-select can be cleared',
  JSON.stringify(applyPick(sweetener, [20], sweetener.options[0])) === '[]');

console.log('\nMulti-select respects its cap');
check('under the cap, more is allowed',
  isPickBlocked(fruitMix, [10, 11], fruitMix.options[2]) === false);
check('at the cap, a new one is blocked',
  isPickBlocked(fruitMix, [10, 11, 12], fruitMix.options[3]) === true);
check('at the cap, an already-picked one still unpicks',
  isPickBlocked(fruitMix, [10, 11, 12], fruitMix.options[0]) === false);
check('unpicking at the cap works',
  JSON.stringify(applyPick(fruitMix, [10, 11, 12], fruitMix.options[0])) === '[11,12]');
check('a blocked pick changes nothing',
  JSON.stringify(applyPick(fruitMix, [10, 11, 12], fruitMix.options[3])) === '[10,11,12]');
check('an uncapped group never blocks',
  isPickBlocked(toppings, [30, 31], toppings.options[0]) === false);

console.log('\nSold out');
const soldOut = { ...fruitMix, options: [opt(10, 'Banana'), opt(11, 'Mango', false)] };
check('a sold-out option is blocked', isPickBlocked(soldOut, [], soldOut.options[1]) === true);
check('its neighbours are not', isPickBlocked(soldOut, [], soldOut.options[0]) === false);

console.log('\nOpening state');
const groups = [jarSize, fruitMix, sweetener, toppings];
const start = initialPicks(groups);
check('a required single-select starts chosen', JSON.stringify(start[jarSize.id]) === '[1]');
check('an optional single-select starts empty', JSON.stringify(start[sweetener.id]) === '[]');
check('a multi-select starts empty', JSON.stringify(start[fruitMix.id]) === '[]');
check('the first available option is chosen, not the first listed',
  JSON.stringify(initialPicks([{ ...jarSize, options: [opt(1, 'Regular', false), opt(2, 'Medium')] }])[1]) === '[2]');

console.log('\nProblems reported');
check('a fresh sheet only wants the fruit',
  JSON.stringify(selectionProblems(groups, start)) === '["Pick at least 1 from Fruit Mix"]',
  JSON.stringify(selectionProblems(groups, start)));
check('a complete sheet reports nothing',
  selectionProblems(groups, { ...start, [fruitMix.id]: [10] }).length === 0);
check('too many is reported',
  selectionProblems([fruitMix], { [fruitMix.id]: [10, 11, 12, 13] })
    .includes('Pick at most 3 from Fruit Mix'));

console.log('\n' + '-'.repeat(48));
if (fail === 0) console.log(pass + ' checks passed, 0 failed.');
else {
  console.log(pass + ' passed, ' + fail + ' FAILED');
  for (const f of failures) console.log('  . ' + f);
}
process.exit(fail === 0 ? 0 : 1);
