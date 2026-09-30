// In-memory dry-run arithmetic only. Fixture flags are not authentication, and nothing here sends funds.
export const SCORE_UNITS_PER_POINT = 1_000_000n;
const MAX_INPUT_DIGITS = 256;
const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clone = value => JSON.parse(JSON.stringify(value));

function textId(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a nonempty string`);
  return value.trim();
}

function atomicUnits(value, field, positive = false) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new TypeError(`${field} must be a decimal string or BigInt`);
  }
  const string = String(value);
  if (string.length > MAX_INPUT_DIGITS) throw new RangeError(`${field} exceeds ${MAX_INPUT_DIGITS} digits`);
  const units = BigInt(value);
  if (units < 0n || (positive && units === 0n)) throw new RangeError(`${field} must be ${positive ? 'positive' : 'nonnegative'}`);
  return units;
}

function timestamp(value, field) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer timestamp`);
  return value;
}

function safeNumber(value, field) {
  if (value < -SAFE_INTEGER || value > SAFE_INTEGER) throw new RangeError(`${field} exceeds the safe integer range`);
  return Number(value);
}

/** Quantize practice points to the nearest millionth; all subsequent allocation uses integer arithmetic. */
export function scoreUnitsFromPoints(points) {
  if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) throw new TypeError('points must be finite and nonnegative');
  const scaled = points * Number(SCORE_UNITS_PER_POINT);
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) throw new RangeError('points exceed safe score conversion');
  return BigInt(Math.round(scaled));
}

export class FeeDistributionSimulation {
  #records = new Map();
  #epochs = new Map();
  #settlements = new Map();
  #nextEpoch = 0;
  #carry;

  constructor({ epochStartMs, epochDurationMs, distributionBps, asset, carryIn = '0' } = {}) {
    timestamp(epochStartMs, 'epochStartMs'); timestamp(epochDurationMs, 'epochDurationMs');
    if (epochDurationMs <= 0) throw new RangeError('epochDurationMs must be positive');
    if (!Number.isInteger(distributionBps) || distributionBps < 0 || distributionBps > 10000) {
      throw new RangeError('distributionBps must be an integer from 0 to 10000');
    }
    const configuration = { epochStartMs, epochDurationMs, distributionBps, asset: textId(asset, 'asset') };
    for (const [key, value] of Object.entries(configuration)) Object.defineProperty(this, key, { value, enumerable: true });
    this.#carry = atomicUnits(carryIn, 'carryIn');
    this.#bounds(0);
  }

  #bounds(epochIndex) {
    if (!Number.isSafeInteger(epochIndex) || epochIndex < 0) throw new RangeError('epochIndex must be a nonnegative safe integer');
    const start = BigInt(this.epochStartMs) + BigInt(epochIndex) * BigInt(this.epochDurationMs);
    return { startMs: safeNumber(start, 'epoch start'), endMs: safeNumber(start + BigInt(this.epochDurationMs), 'epoch end') };
  }

  #epochAt(at) {
    if (at < this.epochStartMs) throw new RangeError('record predates the first epoch');
    const index = safeNumber((BigInt(at) - BigInt(this.epochStartMs)) / BigInt(this.epochDurationMs), 'epochIndex');
    this.#bounds(index);
    return index;
  }

  #isDuplicate(id, record) {
    const previous = this.#records.get(id);
    if (!previous) return false;
    if (previous !== JSON.stringify(record)) throw new Error(`Conflicting reuse of record ID: ${id}`);
    return true;
  }

  #openEpoch(index) {
    if (index < this.#nextEpoch) throw new Error('Cannot submit a new record to a settled epoch');
    if (!this.#epochs.has(index)) this.#epochs.set(index, { fees: 0n, scores: new Map(), feeCount: 0, roundCount: 0 });
    return this.#epochs.get(index);
  }

  recordFee(fee = {}) {
    if (fee?.confirmed !== true) return false;
    const id = textId(fee.id, 'fee id'), asset = textId(fee.asset, 'fee asset');
    if (asset !== this.asset) throw new Error('Fee asset does not match the simulation asset');
    const receivedAt = timestamp(fee.receivedAt, 'receivedAt'), amount = atomicUnits(fee.amount, 'amount', true);
    const epochIndex = this.#epochAt(receivedAt);
    const record = { kind: 'fee', id, receivedAt, asset, amount: amount.toString(), epochIndex };
    if (this.#isDuplicate(id, record)) return false;
    const epoch = this.#openEpoch(epochIndex);
    epoch.fees += amount; epoch.feeCount++;
    this.#records.set(id, JSON.stringify(record));
    return true;
  }

  recordRound(round = {}) {
    if (round?.finalized !== true || round.mode !== 'ranked') return false;
    const id = textId(round.id, 'round id'), startedAt = timestamp(round.startedAt, 'startedAt'), endedAt = timestamp(round.endedAt, 'endedAt');
    const epochIndex = this.#epochAt(startedAt), { endMs } = this.#bounds(epochIndex);
    if (endedAt <= startedAt || endedAt > endMs) throw new RangeError('A round must have positive duration and finish within one epoch');
    if (!Array.isArray(round.entries)) throw new TypeError('round entries must be an array');
    const wallets = new Set();
    const entries = round.entries.map(entry => {
      if (!entry || (entry.wallet !== null && typeof entry.wallet !== 'string')) throw new TypeError('entry wallet must be a string or null');
      const wallet = typeof entry.wallet === 'string' && entry.wallet.trim() ? entry.wallet.trim() : null;
      if (wallet && wallets.has(wallet)) throw new Error(`Duplicate wallet within round: ${wallet}`);
      if (wallet) wallets.add(wallet);
      const scoreUnits = atomicUnits(entry.scoreUnits, 'scoreUnits').toString();
      // Missing eligibility or human flags never grants eligibility.
      return { wallet, scoreUnits, eligible: entry.eligible === true, isBot: entry.isBot !== false };
    }).sort((a, b) => compareText(a.wallet || '', b.wallet || '') || compareText(a.scoreUnits, b.scoreUnits)
      || Number(a.eligible) - Number(b.eligible) || Number(a.isBot) - Number(b.isBot));
    const record = { kind: 'round', id, startedAt, endedAt, epochIndex, entries };
    if (this.#isDuplicate(id, record)) return false;
    const epoch = this.#openEpoch(epochIndex);
    for (const entry of entries) {
      const score = BigInt(entry.scoreUnits);
      if (!entry.wallet || !entry.eligible || entry.isBot || score === 0n) continue;
      epoch.scores.set(entry.wallet, (epoch.scores.get(entry.wallet) || 0n) + score);
    }
    epoch.roundCount++;
    this.#records.set(id, JSON.stringify(record));
    return true;
  }

  settle(epochIndex, nowMs) {
    const { startMs, endMs } = this.#bounds(epochIndex);
    timestamp(nowMs, 'nowMs');
    if (this.#settlements.has(epochIndex)) return clone(this.#settlements.get(epochIndex));
    if (epochIndex !== this.#nextEpoch) throw new Error('Epochs must settle sequentially, starting with epoch 0');
    if (nowMs < endMs) throw new Error('Cannot settle an epoch before it closes');
    const epoch = this.#epochs.get(epochIndex) || { fees: 0n, scores: new Map(), feeCount: 0, roundCount: 0 };
    const newPool = epoch.fees * BigInt(this.distributionBps) / 10000n, pool = newPool + this.#carry;
    const totalScore = [...epoch.scores.values()].reduce((sum, score) => sum + score, 0n);
    const allocations = [...epoch.scores.entries()].sort(([a], [b]) => compareText(a, b)).map(([wallet, score]) => ({
      wallet, scoreUnits: score.toString(), amount: (totalScore ? pool * score / totalScore : 0n).toString(),
    }));
    const allocated = allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount), 0n);
    const snapshot = { epochIndex, startMs, endMs, asset: this.asset, distributionBps: this.distributionBps,
      receivedFees: epoch.fees.toString(), retainedFees: (epoch.fees - newPool).toString(), carryIn: this.#carry.toString(),
      distributablePool: pool.toString(), totalScoreUnits: totalScore.toString(), allocations, allocatedTotal: allocated.toString(),
      carryOut: (pool - allocated).toString(), feeCount: epoch.feeCount, roundCount: epoch.roundCount, eligibleWalletCount: allocations.length };
    this.#carry = pool - allocated; this.#nextEpoch++;
    this.#settlements.set(epochIndex, snapshot);
    return clone(snapshot);
  }
}
