// Entirely synthetic local fixtures. These labels are not wallet addresses,
// registry flags are not authentication, and no funds are received or sent.
import { RoundTracker, ROUND_SECONDS } from '../dist/progression.mjs';
import { FeeDistributionSimulation, scoreUnitsFromPoints } from '../dist/fee-distribution.mjs';

export const FEE_FIXTURE_CONFIG = Object.freeze({
  epochStartMs: Date.UTC(2026, 0, 1),
  epochDurationMs: 60 * 60 * 1000,
  distributionBps: 2000,
  asset: 'TEST',
  carryIn: '0',
});

export const SYNTHETIC_WALLETS = Object.freeze({
  alice: 'synthetic-wallet-alice', bob: 'synthetic-wallet-bob', cara: 'synthetic-wallet-cara',
});

/** Eligibility comes from an explicit fixture registry, never the UI isPlayer flag. */
export function roundEntriesFromTracker(tracker, actorRegistry) {
  return tracker.standings().flatMap(score => {
    const actor = actorRegistry.get(score.id);
    if (!actor || actor.eligible !== true || actor.isBot !== false || typeof actor.wallet !== 'string' || !actor.wallet.trim()) return [];
    return [{ wallet: actor.wallet.trim(), scoreUnits: scoreUnitsFromPoints(score.points).toString(), eligible: true, isBot: false }];
  });
}

export function createFeeRoundFixture({ id = 'synthetic-round-1', startedAt = FEE_FIXTURE_CONFIG.epochStartMs + 5 * 60 * 1000 } = {}) {
  const tracker = new RoundTracker();
  const registry = new Map([
    ['alice', { wallet: SYNTHETIC_WALLETS.alice, eligible: true, isBot: false }],
    ['bob', { wallet: SYNTHETIC_WALLETS.bob, eligible: true, isBot: false }],
    ['cara', { wallet: SYNTHETIC_WALLETS.cara, eligible: true, isBot: false }],
    ...Array.from({ length: 8 }, (_, index) => [`filler-${index}`, index % 2
      ? { wallet: null, eligible: false, isBot: false }
      : { wallet: `synthetic-bot-${index}`, eligible: false, isBot: true }]),
  ]);
  const initialRankings = [
    { id: 'bob', name: 'Bob', mass: 100, isPlayer: false },
    { id: 'cara', name: 'Cara', mass: 90, isPlayer: false },
    { id: 'filler-0', name: 'Synthetic bot', mass: 80, isPlayer: false },
    { id: 'filler-1', name: 'Unlinked fixture', mass: 70, isPlayer: true },
    { id: 'alice', name: 'Alice', mass: 60, isPlayer: false },
    ...[50, 40, 30, 20, 10, 1].map((mass, index) => ({ id: `filler-${index + 2}`, name: 'Synthetic filler', mass, isPlayer: false })),
  ];
  const laterRankings = initialRankings.map(actor => ({ ...actor,
    mass: actor.id === 'bob' ? 5 : actor.id === 'filler-7' ? 100 : actor.mass,
  }));
  tracker.update(30, initialRankings);
  tracker.update(ROUND_SECONDS - 30, laterRankings);
  const round = { id, startedAt, endedAt: startedAt + ROUND_SECONDS * 1000,
    finalized: true, mode: 'ranked', entries: roundEntriesFromTracker(tracker, registry) };
  return { tracker, registry, initialRankings, laterRankings, round };
}

/** JSON-safe report data for an offline demonstration, with six-decimal TEST units. */
export function runFeeDryRunScenario() {
  const fixture = createFeeRoundFixture(), simulation = new FeeDistributionSimulation(FEE_FIXTURE_CONFIG);
  simulation.recordFee({ id: 'synthetic-fee-1', receivedAt: FEE_FIXTURE_CONFIG.epochStartMs + 1000,
    asset: 'TEST', amount: '1000000000', confirmed: true });
  simulation.recordRound(fixture.round);
  const firstClose = FEE_FIXTURE_CONFIG.epochStartMs + FEE_FIXTURE_CONFIG.epochDurationMs;
  const firstEpoch = simulation.settle(0, firstClose);
  const secondEpoch = simulation.settle(1, firstClose + FEE_FIXTURE_CONFIG.epochDurationMs);
  const scores = new Map(fixture.tracker.standings().map(entry => [entry.id, entry]));
  const scoring = ['alice', 'bob', 'cara'].map(id => {
    const score = scores.get(id), units = scoreUnitsFromPoints(score.points);
    return { wallet: SYNTHETIC_WALLETS[id], name: score.name,
      points: Number(units) / 1_000_000, scoreUnits: units.toString(), activeSeconds: score.activeSeconds };
  });
  return {
    config: { ...FEE_FIXTURE_CONFIG, assetDecimals: 6, roundSeconds: ROUND_SECONDS, syntheticOnly: true },
    scoring, firstEpoch, secondEpoch,
    checks: {
      eligibleWallets: firstEpoch.allocations.length === 3,
      poolConserved: BigInt(firstEpoch.allocatedTotal) + BigInt(firstEpoch.carryOut) === BigInt(firstEpoch.distributablePool),
      feeConserved: BigInt(firstEpoch.retainedFees) + BigInt(firstEpoch.allocatedTotal) + BigInt(firstEpoch.carryOut) === BigInt(firstEpoch.receivedFees),
      carryNotRetaxed: secondEpoch.retainedFees === '0' && secondEpoch.carryIn === firstEpoch.carryOut &&
        secondEpoch.distributablePool === firstEpoch.carryOut && secondEpoch.carryOut === firstEpoch.carryOut,
    },
  };
}
