#!/usr/bin/env node
/**
 * Mobile numbers as a sign-in identifier.
 *
 * A customer will not type their number back the way they first entered it,
 * so the only thing that matters here is that every spelling of one number
 * collapses to the same key — and that two different numbers never do.
 */
import { phoneKey, formatPhone, looksLikePhone } from '../src/phone.js';

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { fail += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};

console.log('\nOne number, many spellings');

const SAME = [
  '09153868303',
  '0915 386 8303',
  '0915-386-8303',
  '+639153868303',
  '+63 915 386 8303',
  '63 915 386 8303',
  '9153868303',
  '(0915) 386 8303',
];
const keys = SAME.map(phoneKey);
check('every spelling gives one key', new Set(keys).size === 1, JSON.stringify(keys));
check('and that key is the ten significant digits', keys[0] === '9153868303', String(keys[0]));

console.log('\nDifferent numbers stay different');

check('a different subscriber differs', phoneKey('09153868304') !== phoneKey('09153868303'));
check('a different network differs', phoneKey('09171234567') !== phoneKey('09153868303'));
check(
  'a landline is not confused with a mobile ending the same way',
  phoneKey('88123456') !== phoneKey('09158123456'),
  phoneKey('88123456') + ' vs ' + phoneKey('09158123456'),
);

console.log('\nNothing usable');

check('empty is not a number', phoneKey('') === null);
check('spaces are not a number', phoneKey('   ') === null);
check('letters are not a number', phoneKey('abcdefgh') === null);
check('too few digits to identify anyone', phoneKey('12345') === null);
check('an email is not a number', phoneKey('cust@orderko.test') === null);

console.log('\nTelling the two identifiers apart');

check('an email is not a phone', looksLikePhone('cust@orderko.test') === false);
check('a number is a phone', looksLikePhone('0915 386 8303') === true);

console.log('\nDisplay');

check('a local mobile is grouped for reading', formatPhone('09153868303') === '0915 386 8303',
  formatPhone('09153868303'));
check('an international spelling is shown locally', formatPhone('+639153868303') === '0915 386 8303',
  formatPhone('+639153868303'));
check('anything else is left as typed', formatPhone('8812 3456') === '8812 3456',
  formatPhone('8812 3456'));
check('blank stays blank', formatPhone('') === '');
check('formatting never changes the key',
  phoneKey(formatPhone('+639153868303')) === phoneKey('+639153868303'));

console.log('\n' + '-'.repeat(48));
if (fail === 0) console.log(pass + ' checks passed, 0 failed.');
else {
  console.log(pass + ' passed, ' + fail + ' FAILED');
  for (const f of failures) console.log('  . ' + f);
}
process.exit(fail === 0 ? 0 : 1);
