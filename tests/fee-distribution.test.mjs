import test from 'node:test';
import assert from 'node:assert/strict';
import { FeeDistributionSimulation, scoreUnitsFromPoints, SCORE_UNITS_PER_POINT } from '../dist/fee-distribution.mjs';

const simulation = options => new FeeDistributionSimulation({ epochStartMs: 1000, epochDurationMs: 1000, distributionBps: 10000, asset: 'TEST', ...options });
const entry = (wallet, scoreUnits = '1', overrides = {}) => ({ wallet, scoreUnits, eligible: true, isBot: false, ...overrides });
const round = (id, entries, overrides = {}) => ({ id, entries, startedAt: 1000, endedAt: 2000, finalized: true, mode: 'ranked', ...overrides });
const fee = (id, amount, overrides = {}) => ({ id, amount, receivedAt: 1000, asset: 'TEST', confirmed: true, ...overrides });
const conserved = snapshot => {
  assert.equal(BigInt(snapshot.receivedFees) + BigInt(snapshot.carryIn), BigInt(snapshot.retainedFees) + BigInt(snapshot.allocatedTotal) + BigInt(snapshot.carryOut));
  assert.equal(BigInt(snapshot.distributablePool), BigInt(snapshot.allocatedTotal) + BigInt(snapshot.carryOut));
  assert.equal(snapshot.allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount), 0n), BigInt(snapshot.allocatedTotal));
  assert.doesNotThrow(() => JSON.stringify(snapshot));
};

test('new-fee percentages and carried funds conserve funding across populated and empty epochs', () => {
  const sim = simulation({ distributionBps: 3000, carryIn: '7' });
  sim.recordFee(fee('receipt-0', '101'));
  sim.recordRound(round('round-0', [entry('C'), entry('A'), entry('B')]));
  const first = sim.settle(0, 2000); conserved(first);
  assert.equal(first.distributablePool, '37'); assert.equal(first.retainedFees, '71');
  assert.deepEqual(first.allocations.map(row => [row.wallet, row.amount]), [['A', '12'], ['B', '12'], ['C', '12']]);
  assert.equal(first.carryOut, '1');
  sim.recordFee(fee('receipt-1', '50', { receivedAt: 2000 }));
  const empty = sim.settle(1, 3000); conserved(empty);
  assert.equal(empty.distributablePool, '16'); assert.equal(empty.carryOut, '16'); assert.equal(empty.totalScoreUnits, '0');
  sim.recordRound(round('round-2', [entry('A', '2'), entry('B')], { startedAt: 3000, endedAt: 4000 }));
  const last = sim.settle(2, 4000); conserved(last);
  assert.deepEqual(last.allocations.map(row => row.amount), ['10', '5']); assert.equal(last.carryOut, '1');
  assert.equal([first, empty, last].reduce((sum, row) => sum + BigInt(row.retainedFees) + BigInt(row.allocatedTotal), BigInt(last.carryOut)), 158n);
});

test('zero and full percentages apply only to new fees, including tranche rounding', () => {
  for (const [distributionBps, expectedPool, retained] of [[0, '7', '101'], [2500, '32', '76'], [10000, '108', '0']]) {
    const sim = simulation({ distributionBps, carryIn: '7' });
    sim.recordFee(fee('fee', '101')); sim.recordRound(round('round', [entry('A')]));
    const result = sim.settle(0, 2000); conserved(result);
    assert.equal(result.distributablePool, expectedPool); assert.equal(result.retainedFees, retained); assert.equal(result.carryOut, '0');
  }
  const sim = simulation({ distributionBps: 1 }); sim.recordFee(fee('tiny-tranche', '9999'));
  const result = sim.settle(0, 2000); assert.equal(result.distributablePool, '0'); assert.equal(result.retainedFees, '9999');
});

test('tiny allocations carry every rounding unit, while huge atoms and scores stay exact', () => {
  const tiny = simulation(); tiny.recordFee(fee('one-atom', '1'));
  tiny.recordRound(round('three-way', [entry('A'), entry('B'), entry('C')]));
  const first = tiny.settle(0, 2000); conserved(first);
  assert.deepEqual(first.allocations.map(row => row.amount), ['0', '0', '0']); assert.equal(first.carryOut, '1');
  tiny.recordRound(round('next', [entry('A')], { startedAt: 2000, endedAt: 3000 }));
  assert.equal(tiny.settle(1, 3000).allocatedTotal, '1');
  const amount = 10n ** 100n + 123456789n, score = 10n ** 80n + 1n, huge = simulation({ carryIn: 9n });
  huge.recordFee(fee('huge', amount)); huge.recordRound(round('huge-score', [entry('A', score), entry('B', score + 2n)]));
  const result = huge.settle(0, 2000); conserved(result);
  assert.equal(result.receivedFees, amount.toString());
  assert.equal(result.allocations[0].amount, ((amount + 9n) * score / (score * 2n + 2n)).toString());
});

test('wallet scores aggregate across rounds before proportional allocation in deterministic order', () => {
  const sim = simulation(); sim.recordFee(fee('funds', '90'));
  sim.recordRound(round('one', [entry('B', '10'), entry('A', '10')]));
  sim.recordRound(round('two', [entry('A', '30'), entry('B', '10')]));
  const result = sim.settle(0, 2000); conserved(result);
  assert.deepEqual(result.allocations, [{ wallet: 'A', scoreUnits: '40', amount: '60' }, { wallet: 'B', scoreUnits: '20', amount: '30' }]);
  assert.equal(result.roundCount, 2); assert.equal(result.eligibleWalletCount, 2);
});

test('pending fees and practice, unfinished, bot, guest, ineligible or zero-score entries cannot earn allocations', () => {
  const sim = simulation();
  assert.equal(sim.recordFee(fee('pending', '500', { confirmed: false })), false);
  assert.equal(sim.recordRound(round('practice', [entry('A', '999')], { mode: 'practice' })), false);
  assert.equal(sim.recordRound(round('unfinished', [entry('A', '999')], { finalized: false })), false);
  sim.recordFee(fee('confirmed', '99'));
  sim.recordRound(round('excluded', [entry('bot', '50', { isBot: true }), entry(null, '50'), entry(' ', '50'),
    entry('ineligible', '50', { eligible: false }), entry('zero', '0'), entry('unknown-human', '50', { isBot: undefined }),
    entry('unknown-eligibility', '50', { eligible: undefined })]));
  const result = sim.settle(0, 2000); conserved(result);
  assert.equal(result.receivedFees, '99'); assert.equal(result.feeCount, 1); assert.equal(result.roundCount, 1);
  assert.deepEqual(result.allocations, []); assert.equal(result.carryOut, '99');
});

test('accepted record IDs are globally immutable and identical replay is harmless', () => {
  const sim = simulation(), originalFee = fee('receipt', '010');
  assert.equal(sim.recordFee(originalFee), true); assert.equal(sim.recordFee({ ...originalFee, amount: 10n }), false);
  assert.throws(() => sim.recordFee({ ...originalFee, amount: '11' }), /Conflicting/);
  assert.throws(() => sim.recordRound(round('receipt', [entry('A')])), /Conflicting/);
  const originalRound = round('round', [entry('B'), entry('A', '2')]);
  assert.equal(sim.recordRound(originalRound), true);
  assert.equal(sim.recordRound({ ...originalRound, entries: [...originalRound.entries].reverse() }), false);
  assert.throws(() => sim.recordRound({ ...originalRound, entries: [entry('A', '5')] }), /Conflicting/);
  originalRound.entries[0].scoreUnits = '999'; originalFee.amount = '999';
  const result = sim.settle(0, 2000); assert.equal(result.receivedFees, '10'); assert.equal(result.totalScoreUnits, '3');
  assert.equal(sim.recordFee(fee('receipt', '10')), false);
  assert.equal(sim.recordRound(round('round', [entry('A', '2'), entry('B')])), false);
});

test('a wallet cannot appear twice in one round, even with excluded or split entries', () => {
  const sim = simulation();
  for (const entries of [[entry('A'), entry(' A ')], [entry('A'), entry('A', '0', { eligible: false })]]) {
    assert.throws(() => sim.recordRound(round('split-entry', entries)), /Duplicate wallet/);
  }
  assert.equal(sim.recordRound(round('split-entry', [entry('A'), entry(null), entry(null)])), true);
  assert.equal(sim.settle(0, 2000).totalScoreUnits, '1');
});

test('fee timestamps use half-open windows and rounds may end exactly at their epoch close', () => {
  const sim = simulation();
  sim.recordFee(fee('start', '10')); sim.recordFee(fee('last', '20', { receivedAt: 1999 }));
  sim.recordFee(fee('next-start', '40', { receivedAt: 2000 }));
  assert.throws(() => sim.recordFee(fee('before', '5', { receivedAt: 999 })), /predates/);
  assert.throws(() => sim.recordRound(round('straddle', [entry('A')], { startedAt: 1999, endedAt: 2001 })), /within one epoch/);
  for (const score of ['0', '10']) assert.throws(() => sim.recordRound(round('instant', [entry('A', score)], { startedAt: 1500, endedAt: 1500 })), /positive duration/);
  sim.recordRound(round('closes-exactly', [entry('A')], { startedAt: 1900, endedAt: 2000 }));
  sim.recordRound(round('opens-next', [entry('B')], { startedAt: 2000, endedAt: 2100 }));
  assert.equal(sim.settle(0, 2000).receivedFees, '30'); assert.equal(sim.settle(1, 3000).receivedFees, '40');
});

test('settlement requires sequential closed epochs and rejects new late submissions', () => {
  const sim = simulation();
  assert.throws(() => sim.settle(1, 5000), /sequentially/);
  assert.throws(() => sim.settle(0, 1999), /before it closes/);
  sim.settle(0, 2000);
  assert.throws(() => sim.recordFee(fee('late-fee', '1')), /settled epoch/);
  assert.throws(() => sim.recordRound(round('late-round', [entry('A')])), /settled epoch/);
  assert.throws(() => sim.settle(2, 5000), /sequentially/);
  assert.equal(sim.settle(1, 3000).epochIndex, 1);
});

test('cached settlement snapshots are deeply detached and replay cannot distribute carry twice', () => {
  const sim = simulation({ carryIn: '11' }); sim.recordRound(round('round', [entry('A'), entry('B')]));
  const first = sim.settle(0, 2000), expected = structuredClone(first);
  first.allocations[0].amount = '999'; first.allocations.push({ wallet: 'intruder', amount: '999' }); first.carryOut = '999';
  assert.deepEqual(sim.settle(0, 5000), expected);
  assert.equal(sim.settle(1, 5000).carryIn, '1');
  assert.deepEqual(sim.settle(0, 5000), expected);
});

test('invalid units, assets, timing and configuration are rejected without partial acceptance', () => {
  for (const amount of [0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1, -1n, '-1', '1.5', '1e3', '', '9'.repeat(257)]) {
    assert.throws(() => simulation({ carryIn: amount }));
    assert.throws(() => simulation().recordFee(fee('bad', amount)));
    assert.throws(() => simulation().recordRound(round('bad', [entry('A', amount)])));
  }
  for (const config of [{ epochDurationMs: 0 }, { epochDurationMs: -1 }, { epochDurationMs: 1.5 },
    { epochStartMs: NaN }, { epochStartMs: Number.MAX_SAFE_INTEGER }, { distributionBps: -1 },
    { distributionBps: 10001 }, { distributionBps: .5 }, { asset: '' }]) assert.throws(() => simulation(config));
  const sim = simulation();
  assert.throws(() => sim.recordFee(fee('fee', '5', { asset: 'OTHER' })), /asset/);
  assert.throws(() => sim.recordFee(fee('fee', '0')), /positive/);
  for (const receivedAt of [NaN, Infinity, 1000.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sim.recordFee(fee('fee', '5', { receivedAt })));
  assert.throws(() => sim.settle(-1, 2000)); assert.throws(() => sim.settle(0, Infinity));
  assert.equal(sim.recordFee(fee('fee', '5')), true, 'Rejected inputs must not reserve IDs or mutate totals');
  assert.equal(sim.settle(0, 2000).receivedFees, '5');
});

test('the practice-score adapter explicitly quantizes once and refuses invalid or unsafe conversion', () => {
  assert.equal(SCORE_UNITS_PER_POINT, 1_000_000n);
  assert.equal(scoreUnitsFromPoints(81.125), 81_125_000n);
  assert.equal(scoreUnitsFromPoints(.0000006), 1n); assert.equal(scoreUnitsFromPoints(.0000004), 0n);
  for (const points of [-1, NaN, Infinity, '1', 1n, Number.MAX_SAFE_INTEGER]) assert.throws(() => scoreUnitsFromPoints(points));
});
