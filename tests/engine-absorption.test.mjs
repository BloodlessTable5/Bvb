import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, SUPPLY } from '../dist/engine.mjs';

function scene() {
  const arena = new Arena(() => .5);
  arena.holders = [];
  arena.food = [];
  arena.reserve = SUPPLY;
  const eater = arena.addHolder('eater', '#61cbb4', 2000, 1000, 1000, true, 'eater-wallet');
  arena.player = eater;
  return { arena, eater, cell: eater.cells[0] };
}

function prey(arena, mass = 200, x = 1060) {
  const holder = arena.addHolder('prey', '#e992b2', mass, x, 1000, false, 'prey-wallet');
  const cell = holder.cells[0];
  cell.target = { x: cell.x, y: cell.y };
  cell.thinkAt = Infinity;
  return holder;
}

function step(arena) {
  arena.update(.01, { target: { x: 1000, y: 1000 } });
}

test('absorption records a value snapshot before transferring mass and removes the prey once', () => {
  const { arena, cell } = scene();
  const victim = prey(arena), victimCell = victim.cells[0];
  const before = arena.totalMass();
  step(arena);

  const absorption = arena.events.filter(event => event.type === 'absorb');
  assert.deepEqual(absorption, [{
    type: 'absorb', eaterId: cell.id, preyId: victimCell.id,
    x: 1060, y: 1000, mass: 200, color: '#e992b2', name: 'prey', wallet: 'prey-wallet',
    eaterX: 1000, eaterY: 1000, eaterMass: 2000,
  }]);
  assert.equal(cell.mass, 2200);
  assert.equal(victim.cells.length, 0);
  assert.equal(arena.eaten, 1);
  assert.equal(arena.totalMass(), before);
  assert.deepEqual(arena.events.filter(event => event.type === 'eat'), [{ type: 'eat', name: 'prey', mass: 200 }]);

  victimCell.x = 1400;
  victimCell.mass = 100;
  victim.name = 'changed';
  victim.wallet = 'changed';
  cell.x = 1200;
  step(arena);
  assert.equal(arena.events.filter(event => event.type === 'absorb').length, 1);
  assert.equal(absorption[0].x, 1060);
  assert.equal(absorption[0].mass, 200);
  assert.equal(absorption[0].name, 'prey');
  assert.equal(absorption[0].wallet, 'prey-wallet');
  assert.equal(absorption[0].eaterX, 1000);
});

test('multiple captures each snapshot the current eater mass and conserve supply', () => {
  const { arena, cell } = scene();
  prey(arena, 300, 1040);
  prey(arena, 200, 1060);
  step(arena);

  const absorption = arena.events.filter(event => event.type === 'absorb');
  assert.deepEqual(absorption.map(event => [event.eaterMass, event.mass]), [[2000, 300], [2300, 200]]);
  assert.equal(cell.mass, 2500);
  assert.equal(arena.totalMass(), SUPPLY);
  assert.equal(arena.eaten, 2);
});

test('shielded prey cannot be consumed and produces no absorption event', () => {
  const { arena, cell } = scene();
  const victim = prey(arena);
  victim.shieldUntil = 6;
  step(arena);

  assert.equal(victim.cells.length, 1);
  assert.equal(cell.mass, 2000);
  assert.deepEqual(arena.events, []);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('being absorbed still emits death after the visual snapshot', () => {
  const { arena, eater, cell } = scene();
  eater.isPlayer = false;
  cell.target = { x: cell.x, y: cell.y };
  cell.thinkAt = Infinity;
  const victim = prey(arena);
  victim.isPlayer = true;
  arena.player = victim;
  arena.update(.01, { target: { x: 1060, y: 1000 } });

  assert.equal(arena.dead, true);
  assert.equal(cell.mass, 2200);
  assert.deepEqual(arena.events.map(event => event.type), ['absorb', 'death']);
  assert.deepEqual(arena.events[1], { type: 'death', name: 'eater', x: 1060, y: 1000, mass: 200, color: '#e992b2', isPlayer: true });
  assert.equal(arena.totalMass(), SUPPLY);
});
