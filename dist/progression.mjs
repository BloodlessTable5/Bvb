export const ROUND_SECONDS = 360;
export const SCORING_DESCRIPTION = 'Active time in the top 10 earns points: 100 per minute at #1, tapering quadratically through #10. Tied masses share a midrank.';

const VERSION = 1;
const HISTORY_LIMIT = 20;
const RECENT_ID_LIMIT = 2048;
const MAX_AMOUNT = 1e12;
const amount = value => Number.isFinite(value) ? Math.min(MAX_AMOUNT, Math.max(0, value)) : 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const compareIds = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = `${typeof a}:${String(a)}`, right = `${typeof b}:${String(b)}`;
  return left < right ? -1 : left > right ? 1 : 0;
};
const validId = id => typeof id === 'string' ? id.length > 0 : Number.isFinite(id);
const earnedXp = (activeSeconds, points) => activeSeconds / 6 + points * .25;

export function rankWeight(rank, population) {
  if (!Number.isFinite(rank) || !Number.isInteger(population) || population < 2 || rank < 1 || rank > population) return 0;
  return Math.max(0, (11 - rank) / 10) ** 2;
}

export class RoundTracker {
  constructor({ duration = ROUND_SECONDS } = {}) {
    this.duration = Number.isFinite(duration) && duration > 0 ? Math.min(duration, MAX_AMOUNT) : ROUND_SECONDS;
    this.elapsed = 0;
    this.entries = new Map();
  }

  get remaining() { return Math.max(0, this.duration - this.elapsed); }
  get done() { return this.remaining === 0; }

  update(dt, rankings = []) {
    if (!Number.isFinite(dt) || dt <= 0 || this.done) return this;
    let step = Math.min(dt, this.remaining);
    if (this.remaining - step < 1e-9) step = this.remaining;
    this.elapsed = Math.min(this.duration, this.elapsed + step);
    const unique = new Map();
    for (const entry of Array.isArray(rankings) ? rankings : []) {
      if (!entry || !validId(entry.id) || !Number.isFinite(entry.mass) || entry.mass <= 0) continue;
      if (!unique.has(entry.id) || unique.get(entry.id).mass < entry.mass) unique.set(entry.id, entry);
    }
    const live = [...unique.values()].sort((a, b) => b.mass - a.mass || compareIds(a.id, b.id));
    for (let first = 0; first < live.length;) {
      let end = first + 1;
      while (end < live.length && live[end].mass === live[first].mass) end++;
      const rank = (first + 1 + end) / 2, weight = rankWeight(rank, live.length);
      for (let i = first; i < end; i++) {
        const entry = live[i];
        let record = this.entries.get(entry.id);
        if (!record) {
          record = { id: entry.id, name: '', isPlayer: false, points: 0, rankSeconds: 0, activeSeconds: 0 };
          this.entries.set(entry.id, record);
        }
        record.name = typeof entry.name === 'string' ? entry.name.slice(0, 80) : 'anon';
        record.isPlayer = entry.isPlayer === true;
        record.points += step * (100 / 60) * weight;
        record.rankSeconds += step * rank;
        record.activeSeconds += step;
      }
      first = end;
    }
    return this;
  }

  standings() {
    return [...this.entries.values()].map(entry => ({
      ...entry, meanRank: entry.activeSeconds > 0 ? entry.rankSeconds / entry.activeSeconds : null,
    })).sort((a, b) => Math.abs(b.points - a.points) > 1e-9 ? b.points - a.points : compareIds(a.id, b.id));
  }

  snapshot() {
    return { duration: this.duration, elapsed: this.elapsed, remaining: this.remaining, done: this.done, standings: this.standings() };
  }
}

function emptyProfile() {
  return { version: VERSION, xp: 0, activeSeconds: 0, rounds: 0, points: 0, bestShare: 0, history: [], bubbleBirths: [] };
}

const cloneProfile = profile => ({ ...profile, history: profile.history.map(record => ({ ...record })),
  bubbleBirths: profile.bubbleBirths.map(birth => ({ ...birth })) });
const emptyEnvelope = (createdAt = null) => ({ version: VERSION,
  profile: { ...emptyProfile(), bubbleBirths: [{ id: 1, createdAt }] }, recordedIds: [] });
const validAmount = value => Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
const birthDate = value => Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? Math.floor(value) : null;

function normalizeBirths(profile) {
  const count = progressionFor(profile).nodes, known = new Map();
  for (const birth of Array.isArray(profile.bubbleBirths) ? profile.bubbleBirths : []) {
    if (!Number.isInteger(birth?.id) || birth.id < 1 || birth.id > count) continue;
    const createdAt = birthDate(birth.createdAt);
    if (createdAt !== null && (!known.has(birth.id) || createdAt < known.get(birth.id))) known.set(birth.id, createdAt);
  }
  // Existing nodes without recorded dates remain explicitly unknown during v1 migration.
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, createdAt: known.get(index + 1) ?? null }));
}

function readEnvelope(raw) {
  try {
    const saved = JSON.parse(raw), profile = saved?.profile;
    if (saved?.version !== VERSION || profile?.version !== VERSION ||
      !['xp', 'activeSeconds', 'rounds', 'points', 'bestShare'].every(key => validAmount(profile[key])) ||
      !Number.isInteger(profile.rounds) || profile.bestShare > 100 || !Array.isArray(profile.history) || !Array.isArray(saved.recordedIds) ||
      !saved.recordedIds.every(id => typeof id === 'string' && id.length > 0) ||
      !profile.history.every(record => record && typeof record.id === 'string' && record.id.length > 0 &&
        ['activeSeconds', 'points', 'peakShare', 'xp'].every(key => validAmount(record[key])) && record.peakShare <= 100)) return null;
    return { version: VERSION, profile: {
      version: VERSION, xp: profile.xp, activeSeconds: profile.activeSeconds, rounds: profile.rounds,
      points: profile.points, bestShare: profile.bestShare,
      history: profile.history.slice(0, HISTORY_LIMIT).map(record => ({
        id: record.id, activeSeconds: record.activeSeconds, points: record.points, peakShare: record.peakShare, xp: record.xp,
      })),
      bubbleBirths: normalizeBirths(profile),
    }, recordedIds: [...new Set(saved.recordedIds)].slice(-RECENT_ID_LIMIT) };
  } catch { return null; }
}

/** Device-local cosmetic progress. The clock labels births; it never awards XP or offline growth. */
export class ProgressionStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = typeof now === 'function' ? now : Date.now;
    this.memory = new Map();
    this.unsaved = new Set();
  }

  key(value) {
    return 'holder.progression.v1:' + encodeURIComponent(typeof value === 'string' && value.trim() ? value.trim() : 'guest');
  }

  timestamp() {
    try { return birthDate(this.now()); } catch { return null; }
  }

  write(key, saved) {
    this.memory.set(key, saved);
    try {
      if (typeof this.storage?.setItem !== 'function') throw new Error('Storage unavailable');
      this.storage.setItem(key, JSON.stringify(saved)); this.unsaved.delete(key);
    } catch { this.unsaved.add(key); }
    return saved;
  }

  read(key) {
    const fallback = () => {
      if (!this.memory.has(key)) this.memory.set(key, emptyEnvelope(this.timestamp()));
      return this.memory.get(key);
    };
    if (this.unsaved.has(key) || typeof this.storage?.getItem !== 'function') return fallback();
    try {
      const raw = this.storage.getItem(key), saved = raw == null ? fallback() : readEnvelope(raw);
      // An unreadable or newer save may contain progress we cannot interpret. Loading must leave it intact.
      if (!saved) return fallback();
      this.memory.set(key, saved);
      // Persist first-load births and additive v1 migrations so refresh cannot restamp them.
      if (JSON.stringify(saved) !== raw) this.write(key, saved);
      return saved;
    } catch { return fallback(); }
  }

  load(key) { return cloneProfile(this.read(this.key(key)).profile); }

  record(key, entry = {}) {
    const storageKey = this.key(key), saved = this.read(storageKey);
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const activeSeconds = amount(entry?.activeSeconds);
    if (!id || !activeSeconds || saved.recordedIds.includes(id)) return cloneProfile(saved.profile);
    // Score cannot exceed an entire active interval spent at first place.
    const points = Math.min(amount(entry.points), activeSeconds * (100 / 60));
    const peakShare = clamp(amount(entry.peakShare), 0, 100), xp = earnedXp(activeSeconds, points);
    const previous = saved.profile;
    const profile = {
      version: VERSION, xp: amount(previous.xp + xp), activeSeconds: amount(previous.activeSeconds + activeSeconds),
      rounds: amount(previous.rounds + 1), points: amount(previous.points + points), bestShare: Math.max(previous.bestShare, peakShare),
      history: [{ id, activeSeconds, points, peakShare, xp }, ...previous.history].slice(0, HISTORY_LIMIT),
      bubbleBirths: previous.bubbleBirths.map(birth => ({ ...birth })),
    };
    const count = progressionFor(profile).nodes;
    if (count > profile.bubbleBirths.length) {
      const createdAt = this.timestamp();
      while (profile.bubbleBirths.length < count) profile.bubbleBirths.push({ id: profile.bubbleBirths.length + 1, createdAt });
    }
    const next = { version: VERSION, profile, recordedIds: [...saved.recordedIds, id].slice(-RECENT_ID_LIMIT) };
    this.write(storageKey, next);
    return cloneProfile(profile);
  }
}

export function progressionFor(profile = {}) {
  const xp = amount(profile?.xp);
  const level = Math.floor((Math.sqrt(9 + (xp / 25) * 4) - 3) / 2) + 1;
  const levelStart = 25 * (level - 1) * (level + 2), xpForLevel = 100 + (level - 1) * 50;
  const xpIntoLevel = Math.max(0, xp - levelStart);
  const nodes = Math.min(180, 1 + Math.floor(179 * Math.min(xp / 30000, 1) ** .65));
  return { level, nodes, clusters: nodes < 4 ? 1 : Math.ceil(nodes / 18),
    levelProgress: clamp(xpIntoLevel / xpForLevel, 0, 1), xpToNext: Math.max(0, xpForLevel - xpIntoLevel), xpIntoLevel, xpForLevel };
}

/** Illustrative cosmetic preview at 40 score points per active minute. */
export function previewProfile(activeSeconds) {
  const seconds = amount(activeSeconds), points = seconds * (40 / 60);
  return { ...emptyProfile(), activeSeconds: seconds, points, xp: earnedXp(seconds, points), rounds: Math.floor(seconds / ROUND_SECONDS) };
}
