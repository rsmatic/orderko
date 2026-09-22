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

/**
 * How many must be picked. A required group implies at least one.
 *
 * Clamped to what the group actually allows: a group demanding more than it
 * permits can never be satisfied, and the customer is left with a disabled
 * button and no way forward. `groupRuleProblem` stops that being saved, but a
 * store written before it existed still has to be orderable.
 */
export const minPicks = (group) => {
  const wanted = group.is_required ? Math.max(1, group.min_select) : group.min_select;
  return Math.min(wanted, optionLimit(group));
};

/**
 * Why a group's rules cannot be met, or null when they can.
 *
 * A single-select group holds exactly one pick, so any min or max above one
 * is a contradiction rather than a preference.
 */
export function groupRuleProblem(group) {
  const min = Number(group.min_select ?? 0);
  const max = Number(group.max_select ?? 0);

  if (group.input_type === 'single') {
    if (min > 1) {
      return 'A "pick one" group cannot ask for more than one choice. ' +
        'Set the minimum to 0 or 1, or make it "pick several".';
    }
    if (max > 1) {
      return 'A "pick one" group cannot allow more than one choice. ' +
        'Set the maximum to 0 or 1, or make it "pick several".';
    }
    return null;
  }

  if (max > 0 && min > max) {
    return `This group asks for at least ${min} but allows at most ${max}.`;
  }
  return null;
}

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
