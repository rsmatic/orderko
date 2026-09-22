/**
 * What a customer may pick while building an item.
 *
 * `priceCart` in rules.js decides whether a finished basket is *valid*; this
 * decides what the picker should let you do on the way there. They read the
 * same group fields, so keeping this beside them stops the two drifting.
 */

/** How many may be picked. Infinity when a multi-select group has no cap. */
export const optionLimit = (group) =>
  (group.input_type === 'single' ? 1 : group.max_select || Infinity);

/** How many must be picked. A required group implies at least one. */
export const minPicks = (group) =>
  (group.is_required ? Math.max(1, group.min_select) : group.min_select);

/**
 * Whether tapping this option would do nothing.
 *
 * The cap only blocks a *multi*-select group. In a single-select group a new
 * pick replaces the old one, so being "full" never blocks anything — treating
 * it as a cap is what greyed out every alternative once one was chosen.
 */
export function isPickBlocked(group, currentIds, option) {
  if (!option.is_available) return true;
  if (currentIds.includes(option.id)) return false;
  if (group.input_type === 'single') return false;

  const limit = optionLimit(group);
  return limit !== Infinity && currentIds.length >= limit;
}

/** The ids after tapping `option`; the same array back if the tap is a no-op. */
export function applyPick(group, currentIds, option) {
  const isOn = currentIds.includes(option.id);

  if (group.input_type === 'single') {
    // Tapping the chosen one again clears it, unless the group demands a pick.
    if (isOn) return minPicks(group) > 0 ? currentIds : [];
    return [option.id];
  }

  if (isOn) return currentIds.filter((id) => id !== option.id);
  if (isPickBlocked(group, currentIds, option)) return currentIds;
  return [...currentIds, option.id];
}

/** Human-readable reasons the current picks are not yet a valid item. */
export function selectionProblems(groups, selectedByGroup) {
  const problems = [];

  for (const group of groups) {
    const picked = (selectedByGroup[group.id] ?? []).length;
    const min = minPicks(group);
    const max = optionLimit(group);

    if (picked < min) problems.push(`Pick at least ${min} from ${group.name}`);
    if (max !== Infinity && picked > max) problems.push(`Pick at most ${max} from ${group.name}`);
  }

  return problems;
}

/**
 * The picks a group should open with: the first available option of a
 * required single-select group, so the sheet starts valid rather than
 * showing an error before anything is touched.
 */
export function initialPicks(groups) {
  const initial = {};

  for (const group of groups) {
    const available = (group.options ?? []).filter((o) => o.is_available);
    initial[group.id] = group.input_type === 'single' && minPicks(group) > 0 && available.length
      ? [available[0].id]
      : [];
  }

  return initial;
}
