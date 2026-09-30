const nonnegative = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Keep fields plentiful but make farming a slower source of arena mass.
// Dot visuals retain their original size independently of this reward scale.
export const NATURAL_DOT_MASS_SCALE = .35;

// Small cells get a useful steering-speed advantage without changing large
// holders much. The curve has no size tiers or abrupt speed changes.
export function movementSpeed(mass) {
  return 125 + 175 / (1 + (nonnegative(mass) / 600) ** .85);
}

// Arena dots are worth twice their mass to the smallest cells. The extra
// reward decreases continuously, reaching ordinary value at 1,200 mass.
export function foodMultiplier(mass) {
  const remaining = 1 - clamp((nonnegative(mass) - 80) / 1120, 0, 1);
  return 1 + remaining ** 2;
}

/**
 * Quote a food pickup without mutating the cell, food, or supply reserve.
 * Each natural dot carries a bonus budget funded when that dot is spawned.
 * The caller transfers `total` to the cell, removes the food and its budget,
 * and returns the unused budget (`bonusBudget - bonus`) to the supply reserve.
 * Ejected food never earns a bonus, regardless of who originally ejected it.
 * `multiplier` is the realized total/base; foodMultiplier gives the nominal
 * size-based rate before the dot's budget limit. Empty food reports 1x.
 */
export function foodReward(mass, foodMass, bonusBudget, { ejected = false } = {}) {
  const base = nonnegative(foodMass);
  const available = nonnegative(bonusBudget);
  const bonus = ejected ? 0 : Math.min(available, base * (foodMultiplier(mass) - 1));
  const total = base + bonus;
  return { base, bonus, total, multiplier: base > 0 ? total / base : 1 };
}
