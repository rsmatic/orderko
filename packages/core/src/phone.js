/**
 * Phone numbers, as something two pieces of code can agree on.
 *
 * One mobile gets typed a dozen ways — 0915 386 8303, +639153868303,
 * 63 915 386 8303, 0915-386-8303 — so comparing the text a customer entered
 * against the text they registered with is hopeless. Everything collapses to
 * the last ten digits instead, which is what still identifies the line once
 * the country code and the trunk prefix are stripped off.
 *
 * Ten is right for the Philippines (9XX XXX XXXX after the 0) and happens to
 * suit most countries. A shorter landline keeps all of its digits, so a
 * 7-digit number and an 11-digit mobile ending in the same seven can never be
 * confused — their keys are different lengths.
 */

/** @returns {string|null} — null when there is not enough here to identify anyone. */
export function phoneKey(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

/** True when the text is a phone number rather than an email address. */
export const looksLikePhone = (raw) => !String(raw ?? '').includes('@');

/**
 * 09153868303 → "0915 386 8303". Display only — never store the result, or
 * the spaces end up in the data and the next comparison has to strip them
 * again. Anything that is not a local 11-digit mobile is handed back as typed.
 */
export function formatPhone(raw) {
  const text = String(raw ?? '').trim();
  const key = phoneKey(text);
  if (!key || key.length !== 10) return text;
  const local = `0${key}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}
