import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, SUPPLY } from '../dist/engine.mjs';
import { RoundTracker, ProgressionStore, ROUND_SECONDS } from '../dist/progression.mjs';
import { FeeDistributionSimulation } from '../dist/fee-distribution.mjs';
import { FEE_FIXTURE_CONFIG, SYNTHETIC_WALLETS, createFeeRoundFixture, roundEntriesFromTracker, runFeeDryRunScenario } from '../scripts/fee-fixtures.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
const epochClose = FEE_FIXTURE_CONFIG.epochStartMs + FEE_FIXTURE_CONFIG.epochDurationMs;
const recordFixtureFee = (simulation, id = 'synthetic-test-fee', receivedAt = FEE_FIXTURE_CONFIG.epochStartMs + 1000, amount = '1000000000') =>
  simulation.recordFee({ id, receivedAt, amount, asset: 'TEST', confirmed: true });
const arenaRankings = arena => arena.ranking().map(({ holder, mass }) => ({ id: holder.id, name: holder.name, isPlayer: holder.isPlayer, mass }));

test('real rank-time scoring gives consistent fifth place more than a brief first-place burst', () => {
  const fixture = createFeeRoundFixture(), scores = new Map(fixture.tracker.standings().map(entry => [entry.id, entry]));
  assert.equal(fixture.tracker.done, true);assert.equal(fixture.tracker.elapsed, ROUND_SECONDS);
  close(scores.get('alice').points, 216);close(scores.get('bob').points, 50);close(scores.get('cara').points, 486);
  for (const id of ['alice', 'bob', 'cara']) close(scores.get(id).activeSeconds, 360);
  assert.equal(scores.get('alice').meanRank, 5);assert.equal(scores.get('cara').meanRank, 2);
  assert.ok(scores.get('alice').points > scores.get('bob').points);
  assert.deepEqual(new Set(fixture.round.entries.map(entry => entry.wallet)), new Set(Object.values(SYNTHETIC_WALLETS)));
  assert.equal(fixture.round.entries.length, 3);
  assert.ok(fixture.initialRankings.filter(entry => ['alice', 'bob', 'cara'].includes(entry.id)).every(entry => !entry.isPlayer));
  assert.ok(fixture.initialRankings.some(entry => entry.isPlayer && !fixture.registry.get(entry.id).eligible), 'a UI player flag does not establish fixture eligibility');
});

test('the synthetic one-hour report allocates exact integer floors and carries its rounding unit untaxed', () => {
  const report = runFeeDryRunScenario(), first = report.firstEpoch, second = report.secondEpoch;
  assert.deepEqual(report.scoring.map(entry => entry.points), [216, 50, 486]);
  assert.equal(report.config.assetDecimals, 6);assert.equal(report.config.syntheticOnly, true);
  assert.equal(first.receivedFees, '1000000000');assert.equal(first.retainedFees, '800000000');
  assert.equal(first.distributablePool, '200000000');assert.equal(first.totalScoreUnits, '752000000');
  const expectedPoints = new Map([[SYNTHETIC_WALLETS.alice, 216n], [SYNTHETIC_WALLETS.bob, 50n], [SYNTHETIC_WALLETS.cara, 486n]]);
  for (const allocation of first.allocations) {
    const points = expectedPoints.get(allocation.wallet);
    assert.equal(BigInt(allocation.scoreUnits), points * 1_000_000n);
    assert.equal(BigInt(allocation.amount), 200_000_000n * points / 752n);
  }
  assert.deepEqual(first.allocations.map(entry => entry.amount), ['57446808', '13297872', '129255319']);
  assert.equal(first.allocatedTotal, '199999999');assert.equal(first.carryOut, '1');
  assert.equal(BigInt(first.allocatedTotal) + BigInt(first.carryOut) + BigInt(first.retainedFees), 1_000_000_000n);
  assert.equal(second.receivedFees, '0');assert.equal(second.totalScoreUnits, '0');assert.deepEqual(second.allocations, []);
  assert.equal(second.retainedFees, '0');assert.equal(second.carryIn, '1');assert.equal(second.distributablePool, '1');
  assert.equal(second.allocatedTotal, '0');assert.equal(second.carryOut, '1');
  assert.ok(Object.values(report.checks).every(Boolean));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, 'the reusable report contains no BigInt or class instances');
});

test('paused time and cosmetic XP never become allocation score', () => {
  const fixture = createFeeRoundFixture(), tracker = new RoundTracker();
  const rankings = fixture.initialRankings.map(entry => ({ ...entry, mass: entry.id === 'alice' ? .5 : entry.mass }));
  const registry = new Map([['alice', { wallet: SYNTHETIC_WALLETS.alice, eligible: true, isBot: false }]]);
  for (let i = 0; i < 100; i++) tracker.update(0, rankings);
  assert.equal(tracker.elapsed, 0);assert.deepEqual(roundEntriesFromTracker(tracker, registry), []);
  tracker.update(ROUND_SECONDS, rankings);
  const alice = tracker.standings().find(entry => entry.id === 'alice');
  assert.equal(alice.meanRank, 11);assert.equal(alice.points, 0);assert.equal(alice.activeSeconds, 360);
  const cosmetics = new ProgressionStore(undefined, { now: () => FEE_FIXTURE_CONFIG.epochStartMs });
  const profile = cosmetics.record(SYNTHETIC_WALLETS.alice, { id: 'synthetic-cosmetic-round', activeSeconds: alice.activeSeconds, points: alice.points, peakShare: 1 });
  assert.equal(profile.xp, 60);
  const entries = roundEntriesFromTracker(tracker, registry);
  assert.deepEqual(entries, [{ wallet: SYNTHETIC_WALLETS.alice, scoreUnits: '0', eligible: true, isBot: false }]);
  const simulation = new FeeDistributionSimulation(FEE_FIXTURE_CONFIG);recordFixtureFee(simulation);
  simulation.recordRound({ id: 'synthetic-zero-score-round', startedAt: FEE_FIXTURE_CONFIG.epochStartMs,
    endedAt: FEE_FIXTURE_CONFIG.epochStartMs + 360_000, finalized: true, mode: 'ranked', entries });
  const settled = simulation.settle(0, epochClose);
  assert.equal(settled.totalScoreUnits, '0');assert.equal(settled.allocatedTotal, '0');assert.deepEqual(settled.allocations, []);
  assert.equal(settled.carryOut, '200000000');
});

test('the same eligible wallet accumulates across real trackers with different round actor IDs', () => {
  const simulation = new FeeDistributionSimulation(FEE_FIXTURE_CONFIG);recordFixtureFee(simulation);
  for (const index of [0, 1]) {
    const tracker = new RoundTracker({ duration: 60 });
    const alice = `alice-round-${index}`, cara = `cara-round-${index}`;
    tracker.update(60, [{ id: alice, name: 'Alice', mass: 100 }, { id: cara, name: 'Cara', mass: 90 }]);
    const registry = new Map([[alice, { wallet: SYNTHETIC_WALLETS.alice, eligible: true, isBot: false }],
      [cara, { wallet: SYNTHETIC_WALLETS.cara, eligible: true, isBot: false }]]);
    const startedAt = FEE_FIXTURE_CONFIG.epochStartMs + index * 120_000;
    simulation.recordRound({ id: `synthetic-repeat-wallet-${index}`, startedAt, endedAt: startedAt + 60_000,
      finalized: true, mode: 'ranked', entries: roundEntriesFromTracker(tracker, registry) });
  }
  const settled = simulation.settle(0, epochClose);
  assert.equal(settled.roundCount, 2);assert.equal(settled.allocations.length, 2);
  assert.deepEqual(settled.allocations.map(entry => [entry.wallet, entry.scoreUnits]), [
    [SYNTHETIC_WALLETS.alice, '200000000'], [SYNTHETIC_WALLETS.cara, '162000000'],
  ]);
  assert.equal(settled.totalScoreUnits, '362000000');
  assert.equal(BigInt(settled.allocations[0].amount), 200_000_000n * 200n / 362n);
  assert.equal(BigInt(settled.allocations[1].amount), 200_000_000n * 162n / 362n);
});

test('splitting a real arena holder keeps one combined-mass score and one eligible allocation', () => {
  const arena = new Arena(() => .5);arena.holders = [];arena.food = [];arena.reserve = SUPPLY;
  const player = arena.addHolder('Synthetic Alice', '#73a7ed', 900, 1000, 1000, true, SYNTHETIC_WALLETS.alice);
  const bot = arena.addHolder('Synthetic bot', '#c3f774', 800, 2500, 1800, false, 'synthetic-bot');arena.player = player;
  const tracker = new RoundTracker();tracker.update(180, arenaRankings(arena));
  assert.equal(arena.split({ x: 1400, y: 1000 }).ok, true);assert.equal(player.cells.length, 2);
  assert.ok(player.cells.every(cell => cell.mass < bot.cells[0].mass));
  assert.equal(arenaRankings(arena)[0].id, player.id);tracker.update(180, arenaRankings(arena));
  const registry = new Map([[player.id, { wallet: SYNTHETIC_WALLETS.alice, eligible: true, isBot: false }],
    [bot.id, { wallet: 'synthetic-bot', eligible: false, isBot: true }]]);
  const entries = roundEntriesFromTracker(tracker, registry);
  assert.deepEqual(entries, [{ wallet: SYNTHETIC_WALLETS.alice, scoreUnits: '600000000', eligible: true, isBot: false }]);
  assert.equal(tracker.standings().length, 2);close(arena.totalMass(), SUPPLY);
  const simulation = new FeeDistributionSimulation(FEE_FIXTURE_CONFIG);recordFixtureFee(simulation);
  simulation.recordRound({ id: 'synthetic-split-round', startedAt: FEE_FIXTURE_CONFIG.epochStartMs,
    endedAt: FEE_FIXTURE_CONFIG.epochStartMs + 360_000, finalized: true, mode: 'ranked', entries });
  const settled = simulation.settle(0, epochClose);
  assert.equal(settled.allocations.length, 1);assert.equal(settled.allocations[0].amount, '200000000');assert.equal(settled.carryOut, '0');
});

test('a real six-minute round ending at an epoch boundary settles before the next boundary-starting round', () => {
  const simulation = new FeeDistributionSimulation(FEE_FIXTURE_CONFIG);
  recordFixtureFee(simulation, 'synthetic-before-boundary', epochClose - 1, '1000000');
  recordFixtureFee(simulation, 'synthetic-at-boundary', epochClose, '3000000');
  for (const [index, wallet] of [[0, SYNTHETIC_WALLETS.alice], [1, SYNTHETIC_WALLETS.cara]]) {
    const tracker = new RoundTracker();tracker.update(360, [{ id: 'human', mass: 100 }, { id: 'bot', mass: 50 }]);
    const registry = new Map([['human', { wallet, eligible: true, isBot: false }]]);
    const startedAt = index ? epochClose : epochClose - 360_000;
    simulation.recordRound({ id: `synthetic-boundary-round-${index}`, startedAt, endedAt: startedAt + 360_000,
      finalized: true, mode: 'ranked', entries: roundEntriesFromTracker(tracker, registry) });
  }
  const first = simulation.settle(0, epochClose);
  assert.equal(first.receivedFees, '1000000');assert.equal(first.roundCount, 1);
  assert.deepEqual(first.allocations.map(entry => [entry.wallet, entry.amount]), [[SYNTHETIC_WALLETS.alice, '200000']]);
  const second = simulation.settle(1, epochClose + FEE_FIXTURE_CONFIG.epochDurationMs);
  assert.equal(second.receivedFees, '3000000');assert.equal(second.roundCount, 1);
  assert.deepEqual(second.allocations.map(entry => [entry.wallet, entry.amount]), [[SYNTHETIC_WALLETS.cara, '600000']]);
});
