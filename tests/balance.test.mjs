import test from 'node:test';
import assert from 'node:assert/strict';
import { movementSpeed, foodMultiplier, foodReward } from '../dist/balance.mjs';

test('movement speed favors small cells smoothly while keeping large cells near their existing pace', () => {
  const targets = [[80, 270, 280], [900, 185, 200], [5600, 145, 155]];
  for (const [mass, low, high] of targets) {
    assert.ok(movementSpeed(mass) >= low && movementSpeed(mass) <= high,
      `speed at ${mass} mass should be between ${low} and ${high}`);
  }
  const masses = [0, 1, 40, 80, 160, 450, 900, 1200, 5600, 50000, 1e9];
  let previous = Infinity;
  for (const mass of masses) {
    const speed = movementSpeed(mass);
    assert.ok(speed >= 125 && speed <= 300);
    assert.ok(speed < previous, 'each larger mass should move more slowly');
    previous = speed;
  }
  assert.equal(movementSpeed(-100), movementSpeed(0));
  for (const mass of [80, 900, 5600]) {
    assert.ok(Math.abs(movementSpeed(mass + .01) - movementSpeed(mass - .01)) < .02,
      'crossing common sizes should not cause a speed jump');
  }
});

test('food value tapers from 2x at 80 mass to ordinary value at 1200', () => {
  assert.equal(foodMultiplier(-10), 2);
  assert.equal(foodMultiplier(0), 2);
  assert.equal(foodMultiplier(80), 2);
  assert.equal(foodMultiplier(640), 1.25);
  assert.equal(foodMultiplier(1200), 1);
  assert.equal(foodMultiplier(50000), 1);
  let previous = 2;
  for (let mass = 80; mass <= 2000; mass += 10) {
    const multiplier = foodMultiplier(mass);
    assert.ok(multiplier >= 1 && multiplier <= previous);
    assert.ok(foodReward(mass, 20, 100).total <= foodReward(mass - 10, 20, 100).total);
    previous = multiplier;
  }
  for (const mass of [80, 1200]) {
    assert.ok(Math.abs(foodMultiplier(mass + .01) - foodMultiplier(mass - .01)) < .001);
  }
});

test('ordinary dots spend their funded bonus budget while preserving total supply', () => {
  const mass = 80, dot = 20, bonusBudget = 20, reserve = 49880;
  const reward = foodReward(mass, dot, bonusBudget);
  assert.deepEqual(reward, { base: 20, bonus: 20, total: 40, multiplier: 2 });
  assert.equal(mass + reward.total + reserve + bonusBudget - reward.bonus, mass + dot + bonusBudget + reserve);
  const grown = foodReward(1200, dot, bonusBudget);
  assert.deepEqual(grown, { base: 20, bonus: 0, total: 20, multiplier: 1 });
  assert.equal(bonusBudget - grown.bonus, 20, 'a large cell returns the unused allowance to the reserve');
});

test('partial or empty dot budgets cap the actual bonus and reported multiplier', () => {
  assert.deepEqual(foodReward(80, 20, 7), { base: 20, bonus: 7, total: 27, multiplier: 1.35 });
  for (const bonusBudget of [0, -10, NaN, undefined]) {
    assert.deepEqual(foodReward(80, 20, bonusBudget), { base: 20, bonus: 0, total: 20, multiplier: 1 });
  }
  assert.deepEqual(foodReward(80, 20, 20), { base: 20, bonus: 20, total: 40, multiplier: 2 });
});

test('ejected pellets always return base mass without spending a bonus budget or creating an arbitrage', () => {
  const initialMass = 80, ejectedMass = 12, bonusBudget = 12;
  for (const mass of [initialMass - ejectedMass, 80, 900, 5000]) {
    const reward = foodReward(mass, ejectedMass, bonusBudget, { ejected: true });
    assert.deepEqual(reward, { base: 12, bonus: 0, total: 12, multiplier: 1 });
    assert.equal(bonusBudget - reward.bonus, bonusBudget);
  }
  const pickup = foodReward(initialMass - ejectedMass, ejectedMass, bonusBudget, { ejected: true });
  assert.equal(initialMass - ejectedMass + pickup.total, initialMass);
});

test('empty or invalid food never spends its bonus budget or produces an invalid multiplier', () => {
  for (const foodMass of [0, -20, NaN, Infinity, undefined]) {
    assert.deepEqual(foodReward(80, foodMass, 100), { base: 0, bonus: 0, total: 0, multiplier: 1 });
  }
});
