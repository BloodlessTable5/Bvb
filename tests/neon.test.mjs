import test from 'node:test';
import assert from 'node:assert/strict';
import { DEATH_EFFECT_DURATION, NeonEffects } from '../dist/neon.mjs';

const highlight = '#eaf7ff';
const event = (type, overrides = {}) => ({
  type, cellId: 2, x: 1000, y: 1000, mass: 450, color: '#73a7ed',
  isPlayer: true, dx: 1, dy: 0, ...overrides,
});
const cellsAt = (x, y, id = 2) => [{ c: { id, x, y, mass: 450 } }];
const advanceFor = (effects, cells, seconds) => {
  const steps = Math.max(1, Math.ceil(seconds * 60));
  for (let i = 0; i < steps; i++) effects.update(cells, seconds / steps);
};

test('split trail samples the actual cell path and stops following a consumed cell', () => {
  const effects = new NeonEffects(), split = event('split');
  const original = structuredClone(split);
  effects.add(split, highlight);
  const cells = cellsAt(1020, 1010);
  effects.update(cells, 1 / 60);
  cells[0].c.x = 1030; cells[0].c.y = 1040;
  effects.update(cells, 1 / 60);
  assert.deepEqual(effects.trails[0].points, [
    { x: 1000, y: 1000 }, { x: 1020, y: 1010 }, { x: 1030, y: 1040 },
  ]);
  assert.equal(effects.trails[0].color, highlight);
  assert.deepEqual(split, original, 'recording a trail should not alter the simulation event');
  const lastPath = structuredClone(effects.trails[0].points);
  cells[0].c.x = 2000;
  effects.update([], 1 / 60);
  assert.deepEqual(effects.trails[0].points, lastPath,
    'consumed cells should leave a fixed fading trail instead of a fabricated path');
  advanceFor(effects, [], 1);
  assert.equal(effects.trails.length, 0);
});

test('merge and consolidation follow their live target while death stays at its snapshot', () => {
  const effects = new NeonEffects();
  for (const type of ['merge', 'consolidate', 'death']) effects.add(event(type), highlight);
  effects.update(cellsAt(1200, 1100), 1 / 60);
  for (const burst of effects.bursts) {
    assert.deepEqual({ x: burst.x, y: burst.y },
      burst.type === 'death' ? { x: 1000, y: 1000 } : { x: 1200, y: 1100 });
  }
  effects.update(cellsAt(1300, 1250), 1 / 60);
  const positions = effects.bursts.map(({ x, y }) => ({ x, y }));
  assert.deepEqual(positions, [{ x: 1300, y: 1250 }, { x: 1300, y: 1250 }, { x: 1000, y: 1000 }]);
  effects.update([], 1 / 60);
  assert.deepEqual(effects.bursts.map(({ x, y }) => ({ x, y })), positions,
    'a vanished target should leave the effect at its last known position');
});

test('zero elapsed time freezes both ages and tracked positions', () => {
  const effects = new NeonEffects();
  for (const type of ['split', 'merge', 'consolidate', 'death']) effects.add(event(type), highlight);
  effects.update(cellsAt(1030, 1050), 1 / 60);
  const before = structuredClone({ trails: effects.trails, bursts: effects.bursts });
  for (let i = 0; i < 60; i++) effects.update(cellsAt(2000, 2000), 0);
  assert.deepEqual({ trails: effects.trails, bursts: effects.bursts }, before);
});

test('reset clears effects before cell IDs are reused', () => {
  const effects = new NeonEffects();
  effects.add(event('split'), highlight);
  effects.add(event('death'), highlight);
  effects.update(cellsAt(1100, 1000), 1 / 60);
  effects.reset();
  assert.deepEqual(effects.trails, []);
  assert.deepEqual(effects.bursts, []);
  effects.add(event('split', { x: 200, y: 300 }), highlight);
  assert.deepEqual(effects.trails[0].points, [{ x: 200, y: 300 }]);
  assert.equal(effects.trails[0].age, 0);
});

test('reduced motion suppresses action effects', () => {
  const effects = new NeonEffects({ reducedMotion: true });
  for (const type of ['split', 'merge', 'consolidate', 'death']) effects.add(event(type), highlight);
  advanceFor(effects, cellsAt(1100, 1200), 1);
  assert.deepEqual(effects.trails, []);
  assert.deepEqual(effects.bursts, []);
});

test('busy scenes keep bounded queues and path samples, then expire completely', () => {
  const effects = new NeonEffects();
  for (let i = 0; i < 200; i++) {
    effects.add(event('split', { cellId: i, isPlayer: false }), highlight);
    effects.add(event(i % 2 ? 'merge' : 'death', { cellId: i }), highlight);
  }
  assert.ok(effects.trails.length <= 48);
  assert.ok(effects.bursts.length <= 40);
  assert.equal(effects.trails.at(-1).cellId, 199, 'queue limits should retain the newest effects');
  assert.equal(effects.bursts.at(-1).cellId, 199);
  assert.equal(effects.trails.at(-1).color, '#73a7ed', 'bot effects should keep their own color');
  for (let i = 0; i < 70; i++) effects.update(cellsAt(1000 + i * 3, 1000 + i * 2, 199), 1 / 240);
  const trail = effects.trails.at(-1);
  assert.ok(trail.points.length > 1 && trail.points.length <= 24);
  assert.deepEqual(trail.points.at(-1), { x: 1207, y: 1138 });
  advanceFor(effects, [], DEATH_EFFECT_DURATION + .1);
  assert.deepEqual(effects.trails, []);
  assert.deepEqual(effects.bursts, []);
});
