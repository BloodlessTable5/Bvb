import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, MERGE_TIME, SUPPLY, WORLD, radius } from '../dist/engine.mjs';

function scene(mass = 900, isPlayer = true) {
  const arena = new Arena(() => .5);
  arena.holders = [];
  arena.food = [];
  arena.reserve = SUPPLY;
  const holder = arena.addHolder('fixture', '#73a7ed', mass, 1000, 1000, isPlayer, 'fixture-wallet');
  if (isPlayer) arena.player = holder;
  return { arena, holder, cell: holder.cells[0] };
}

test('split emits its resolved child position and direction while retaining mass and cooldowns', () => {
  const { arena, holder, cell } = scene();
  cell.x = WORLD.width - radius(cell.mass);
  assert.equal(arena.split({ x: WORLD.width + 100, y: cell.y }).ok, true);
  const child = holder.cells[1];
  const expected = {
    type: 'split', cellId: child.id, sourceId: cell.id, x: child.x, y: child.y,
    mass: 450, dx: 1, dy: 0, color: holder.color, isPlayer: true,
  };
  assert.deepEqual(arena.events, [expected]);
  assert.equal(child.x, WORLD.width - radius(450));
  assert.equal(cell.mass, 450);
  assert.equal(arena.totalMass(), SUPPLY);
  assert.equal(cell.readyAt, MERGE_TIME);
  assert.equal(child.readyAt, MERGE_TIME);
  assert.equal(arena.cooldown(), MERGE_TIME);
  child.x -= 20;
  holder.color = '#ffffff';
  assert.deepEqual(arena.events[0], expected);
});

test('blocked split and consolidation requests emit no action effects', () => {
  const { arena, holder } = scene(100);
  assert.equal(arena.split({ x: 1200, y: 1000 }).ok, false);
  assert.equal(arena.consolidate().ok, false);
  assert.equal(arena.splitHolder(holder, { x: 1200, y: 1000 }, 1), 0);
  assert.deepEqual(arena.events, []);
  arena.dead = true;
  assert.equal(arena.split({ x: 1200, y: 1000 }).ok, false);
  assert.equal(arena.consolidate().ok, false);
  assert.deepEqual(arena.events, []);
});

test('consolidation emits once after cooldown, using the largest cell and the complete holder mass', () => {
  const { arena, holder, cell } = scene();
  arena.split({ x: 1200, y: 1000 });
  arena.events = [];
  assert.equal(arena.consolidate().ok, false);
  assert.deepEqual(arena.events, []);
  assert.equal(arena.merging, false);
  const child = holder.cells[1];
  cell.mass = 300;
  child.mass = 600;
  arena.time = MERGE_TIME;
  assert.equal(arena.consolidate().ok, true);
  assert.equal(arena.consolidate().ok, true);
  assert.equal(arena.merging, true);
  assert.deepEqual(arena.events, [{ type: 'consolidate', cellId: child.id, x: child.x, y: child.y, mass: 900, color: holder.color, isPlayer: true }]);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('explicit merging emits its weighted center only after cooldown, exactly once', () => {
  const { arena, holder, cell } = scene();
  arena.split({ x: 1200, y: 1000 });
  const child = holder.cells[1];
  arena.events = [];
  cell.x = 1000; cell.y = 1000; cell.mass = 300;
  child.x = 1020; child.y = 1010; child.mass = 600;
  cell.vx = child.vx = cell.vy = child.vy = 0;
  arena.update(0, { target: { x: 1000, y: 1000 } });
  assert.equal(holder.cells.length, 2);
  assert.deepEqual(arena.events, []);
  arena.time = MERGE_TIME;
  assert.equal(arena.consolidate().ok, true);
  arena.events = [];
  cell.x = 1000; cell.y = 1000;
  child.x = 1020; child.y = 1010;
  arena.update(0, { target: { x: 1000, y: 1000 } });
  assert.equal(holder.cells.length, 1);
  assert.equal(cell.mass, 900);
  assert.deepEqual(arena.events, [{
    type: 'merge', cellId: cell.id, fromId: child.id,
    x: (1000 * 300 + 1020 * 600) / 900, y: (1000 * 300 + 1010 * 600) / 900,
    fromX: 1020, fromY: 1010, mass: 900, color: holder.color, isPlayer: true,
  }]);
  child.x = 1200;
  assert.equal(arena.events[0].fromX, 1020);
  arena.update(0, { target: { x: 1000, y: 1000 } });
  assert.equal(arena.events.length, 1);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('bot splits identify their owner without changing split limits', () => {
  const { arena, holder, cell } = scene(900, false);
  assert.equal(arena.splitHolder(holder, { x: 1000, y: 1200 }, 2, cell), 1);
  assert.equal(arena.events[0].isPlayer, false);
  assert.equal(arena.events[0].dy, 1);
  assert(Math.abs(arena.events[0].dx) < 1e-10);
  assert.equal(arena.splitHolder(holder, { x: 1000, y: 1200 }, 2, cell), 0);
  assert.equal(arena.events.length, 1);
  assert.equal(arena.totalMass(), SUPPLY);
});
