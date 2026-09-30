import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, SUPPLY, WORLD, MERGE_TIME, radius, clusterGap, resolveClusterSpacing, CLUSTER_GAP_MIN, CLUSTER_GAP_MAX, CLUSTER_COHESION_SLACK, CLUSTER_GROUP_GAP } from '../dist/engine.mjs';
import { updateClusterNetwork } from '../dist/clusters.mjs';

function scene(masses, { x = 1000, y = 1000, isPlayer = true, address = 'cluster-wallet' } = {}) {
  const arena = new Arena(() => .5);
  arena.holders = []; arena.food = []; arena.reserve = SUPPLY;
  arena.addFood = () => false;
  const holder = arena.addHolder('cluster', '#73a7ed', masses.reduce((a, b) => a + b), x, y, isPlayer, address);
  holder.cells = masses.map(mass => ({ ...arena.makeCell(mass, x, y), readyAt: MERGE_TIME, target: { x, y }, thinkAt: Infinity }));
  if (isPlayer) arena.player = holder;
  return { arena, holder };
}

function verifyGaps(cells, tolerance = .2) {
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i], b = cells[j];
    const gap = Math.hypot(a.x - b.x, a.y - b.y) - radius(a.mass) - radius(b.mass);
    assert(gap >= clusterGap(a, b) - tolerance, `gap ${gap.toFixed(3)} below ${clusterGap(a, b)} for cells ${i}, ${j}`);
  }
}

function verifyWalls(cells) {
  for (const cell of cells) {
    const r = radius(cell.mass);
    assert(cell.x >= r - 1e-8 && cell.x <= WORLD.width - r + 1e-8);
    assert(cell.y >= r - 1e-8 && cell.y <= WORLD.height - r + 1e-8);
  }
}

test('surface gap scales gently with radii and remains bounded', () => {
  assert.equal(CLUSTER_GAP_MIN, 18);
  assert.equal(CLUSTER_GAP_MAX, 28);
  assert.equal(clusterGap({ mass: 80 }, { mass: 80 }), CLUSTER_GAP_MIN);
  assert.equal(clusterGap({ mass: 10000 }, { mass: 10000 }), CLUSTER_GAP_MAX);
  assert(clusterGap({ mass: 3500 }, { mass: 3500 }) > CLUSTER_GAP_MIN);
});

test('sixteen coincident cells settle into a compact gently flowing cluster after cooldown', () => {
  const { arena, holder } = scene(Array.from({ length: 16 }, (_, i) => 240 + i * 40));
  arena.time = MERGE_TIME + 1;
  // Fully coincident groups must untangle and route distant branches home first.
  for (let i = 0; i < 360; i++) arena.update(1 / 60, { target: arena.center(holder) });
  verifyGaps(holder.cells);
  assert.equal(holder.cells.length, 16);
  assert.equal(arena.events.filter(event => event.type === 'merge').length, 0);
  const before = holder.cells.map(cell => ({ x: cell.x, y: cell.y }));
  const centerBefore = arena.center(holder);
  for (let i = 0; i < 30; i++) arena.update(1 / 60, { target: arena.center(holder) });
  const largestMove = Math.max(...holder.cells.map((cell, i) => Math.hypot(cell.x - before[i].x, cell.y - before[i].y)));
  assert(largestMove > .1 && largestMove < 8, `settled cluster should shuffle gently without large excursions: ${largestMove}`);
  assert(Math.hypot(arena.center(holder).x - centerBefore.x, arena.center(holder).y - centerBefore.y) < 1e-7);
  verifyGaps(holder.cells);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('different-size player cells flow at their own speeds while staying compact around the cursor', () => {
  const { arena, holder } = scene([300, 1200]);
  holder.cells[1].x = 1180;
  arena.time = MERGE_TIME + 1;
  for (let i = 0; i < 90; i++) arena.update(1 / 60, { target: arena.center(holder) });
  const initial = holder.cells[1].x - holder.cells[0].x;
  const start = arena.center(holder), target = { x: start.x + 480, y: start.y + 160 };
  for (let i = 0; i < 240; i++) arena.update(1 / 60, { target });
  assert(Math.hypot(arena.center(holder).x - target.x, arena.center(holder).y - target.y) < 1.1);
  assert(Math.abs(holder.cells[1].x - holder.cells[0].x - initial) > 1, 'different speeds should rearrange relative offsets');
  verifyGaps(holder.cells);
  assert.equal(holder.cells.length, 2);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('idle motion changes relative geometry without moving the mass center', () => {
  const { arena, holder } = scene([500, 350, 200]);
  holder.cells[1].x += 140;
  holder.cells[2].x += 50; holder.cells[2].y += 135;
  arena.time = MERGE_TIME + 1;
  for (let i = 0; i < 90; i++) arena.update(1 / 60, { target: arena.center(holder) });
  const center = arena.center(holder);
  const distances = () => holder.cells.flatMap((a, i) => holder.cells.slice(i + 1).map(b => Math.hypot(a.x - b.x, a.y - b.y)));
  const before = distances();
  const relativeBefore = Math.atan2(holder.cells[1].y - holder.cells[0].y, holder.cells[1].x - holder.cells[0].x);
  for (let i = 0; i < 120; i++) arena.update(1 / 60, { target: center });
  assert(Math.hypot(arena.center(holder).x - center.x, arena.center(holder).y - center.y) < 1e-7);
  assert(Math.max(...distances().map((d, i) => Math.abs(d - before[i]))) > .3, 'idle flow should change geometry, not rigidly spin the formation');
  const relativeAfter = Math.atan2(holder.cells[1].y - holder.cells[0].y, holder.cells[1].x - holder.cells[0].x);
  assert(Math.abs(relativeAfter - relativeBefore) > .04);
  verifyGaps(holder.cells);
});

test('smaller split cells make the whole holder travel faster without drifting apart', () => {
  const whole = scene([900]), split = scene([450, 450]);
  split.holder.cells[1].x += 120;
  const starts = [whole, split].map(({ arena, holder }) => arena.center(holder));
  for (const state of [whole, split]) {
    const start = state.arena.center(state.holder);
    for (let i = 0; i < 120; i++) state.arena.update(1 / 60, { target: { x: start.x + 1000, y: start.y } });
  }
  const traveled = [whole, split].map(({ arena, holder }, i) => arena.center(holder).x - starts[i].x);
  assert(traveled[1] > traveled[0] * 1.1, 'splitting should provide a meaningful movement advantage');
  const [a, b] = split.holder.cells;
  assert(Math.hypot(a.x - b.x, a.y - b.y) - radius(a.mass) - radius(b.mass) < clusterGap(a, b) + CLUSTER_COHESION_SLACK + 3);
  verifyGaps(split.holder.cells);
  assert.equal(split.arena.totalMass(), SUPPLY);
});

test('turning and releasing movement preserve a compact cluster with a stationary idle center', () => {
  const { arena, holder } = scene([600, 350, 200]);
  resolveClusterSpacing(holder.cells);
  const start = arena.center(holder);
  for (let i = 0; i < 60; i++) arena.update(1 / 60, { target: { x: start.x + 800, y: start.y } });
  const atTurn = arena.center(holder);
  const before = holder.cells.map(cell => ({ x: cell.x - atTurn.x, y: cell.y - atTurn.y }));
  for (let i = 0; i < 60; i++) arena.update(1 / 60, { target: { x: atTurn.x, y: atTurn.y - 800 } });
  const stopped = arena.center(holder);
  assert(stopped.y < atTurn.y - 100);
  assert(Math.max(...holder.cells.map((cell, i) => Math.hypot(cell.x - stopped.x - before[i].x, cell.y - stopped.y - before[i].y))) > 3);
  for (let i = 0; i < 60; i++) arena.update(1 / 60, { target: stopped });
  assert(Math.hypot(arena.center(holder).x - stopped.x, arena.center(holder).y - stopped.y) < 1e-7);
  verifyGaps(holder.cells);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('split launch remains visible but returns to a close cluster within one second', () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const { arena, holder } = scene([900]);
    assert.equal(arena.split({ x: 1600, y: 1000 }).ok, true);
    const [source, child] = holder.cells;
    assert.equal(child.vx, 820);
    let widestGap = 0;
    for (let i = 0; i < Math.round(1 / dt); i++) {
      arena.update(dt, { target: arena.center(holder) });
      widestGap = Math.max(widestGap, Math.hypot(source.x - child.x, source.y - child.y) - radius(source.mass) - radius(child.mass));
    }
    const finalGap = Math.hypot(source.x - child.x, source.y - child.y) - radius(source.mass) - radius(child.mass);
    const restingGap = clusterGap(source, child) + CLUSTER_COHESION_SLACK;
    assert(widestGap > restingGap + 15, 'split should retain a brief visible outward launch');
    assert(finalGap <= restingGap + 3, `gap ${finalGap.toFixed(2)} should settle near ${restingGap} within one second`);
    assert(child.vx > 0 && child.vx < 10, 'launch impulse should decay naturally');
    verifyGaps(holder.cells);
    assert.equal(holder.cells.length, 2);
    assert.equal(arena.totalMass(), SUPPLY);
  }
});

test('crowded corner formations respect walls and maintain breathing room while pushed at the boundary', () => {
  const { arena, holder } = scene(Array.from({ length: 16 }, (_, i) => i % 3 === 0 ? 800 : 260), { x: 20, y: 20 });
  arena.time = MERGE_TIME + 1;
  for (let i = 0; i < 180; i++) arena.update(1 / 60, { target: { x: 0, y: 0 } });
  verifyWalls(holder.cells);
  verifyGaps(holder.cells, .5);
  assert.equal(holder.cells.length, 16);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('manual consolidation bypasses spacing and merges the whole cluster exactly once per removed cell', () => {
  const { arena, holder } = scene([600, 400, 300, 200]);
  resolveClusterSpacing(holder.cells);
  assert.equal(arena.consolidate().ok, false);
  arena.time = MERGE_TIME;
  assert.equal(arena.consolidate().ok, true);
  for (let i = 0; i < 180 && holder.cells.length > 1; i++) arena.update(1 / 60, { target: { x: 2000, y: 2000 } });
  assert.equal(holder.cells.length, 1);
  assert.equal(holder.cells[0].mass, 1500);
  assert.equal(arena.events.filter(event => event.type === 'merge').length, 3);
  assert.equal(arena.merging, false);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('explicit consolidation quickly reunites a branch from 500 world units away', () => {
  const { arena, holder } = scene([600, 400]);
  holder.cells[1].x += 500;
  arena.time = MERGE_TIME;
  assert.equal(arena.consolidate().ok, true);
  for (let i = 0; i < 42 && holder.cells.length > 1; i++) arena.update(1 / 60, { target: { x: 1000, y: 1000 } });
  assert.equal(holder.cells.length, 1, 'consolidation should finish within 0.7 seconds');
  assert.equal(holder.cells[0].mass, 1000);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('bots stay spaced through cooldown and deliberately regroup afterward', () => {
  const { arena, holder } = scene([500, 300, 200], { isPlayer: false });
  for (let i = 0; i < 120; i++) arena.update(1 / 60);
  verifyGaps(holder.cells);
  assert.equal(holder.cells.length, 3);
  arena.time = MERGE_TIME;
  for (let i = 0; i < 180 && holder.cells.length > 1; i++) arena.update(1 / 60);
  assert.equal(holder.cells.length, 1);
  assert.equal(holder.cells[0].mass, 1000);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('many cells gather into stable local groups with visible space between groups', () => {
  const { arena, holder } = scene(Array.from({ length: 12 }, (_, i) => 260 + i * 30), { x: 1600, y: 1200 });
  arena.time = MERGE_TIME + 1;
  const network = updateClusterNetwork(holder), initialCenter = arena.center(holder);
  assert.equal(network.groups.length, 3);
  assert.ok(network.groups.some(group => group.offshoot && [2, 3].includes(group.memberIds.length)));
  for (let i = 0; i < 360; i++) arena.update(1 / 60, { target: initialCenter });
  assert.equal(updateClusterNetwork(holder), network, 'movement should retain membership and hub identities');
  const cells = new Map(holder.cells.map(cell => [cell.id, cell]));
  for (const { hubId, memberIds } of network.groups) {
    const hub = cells.get(hubId);
    for (const id of memberIds) {
      if (id === hubId) continue;
      const cell = cells.get(id), gap = Math.hypot(cell.x - hub.x, cell.y - hub.y) - radius(cell.mass) - radius(hub.mass);
      assert(gap < clusterGap(cell, hub) + CLUSTER_COHESION_SLACK + 35, `members should gather near their own hub: ${id} gap ${gap}`);
    }
  }
  for (let i = 0; i < holder.cells.length; i++) for (let j = i + 1; j < holder.cells.length; j++) {
    const a = holder.cells[i], b = holder.cells[j];
    if (network.hubByCell.get(a.id) === network.hubByCell.get(b.id)) continue;
    const gap = Math.hypot(a.x - b.x, a.y - b.y) - radius(a.mass) - radius(b.mass);
    assert(gap > CLUSTER_GROUP_GAP - 10, `inter-group gap should be visibly larger: ${gap}`);
  }
  assert(Math.hypot(arena.center(holder).x - initialCenter.x, arena.center(holder).y - initialCenter.y) < 1e-7);
  verifyGaps(holder.cells);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('three-group formations move against walls and still consolidate all sixteen cells', () => {
  const { arena, holder } = scene(Array.from({ length: 16 }, (_, i) => 200 + i * 20));
  arena.time = MERGE_TIME + 1;
  for (let i = 0; i < 240; i++) arena.update(1 / 60, { target: { x: 0, y: 0 } });
  assert.equal(updateClusterNetwork(holder).groups.length, 3);
  verifyWalls(holder.cells);
  verifyGaps(holder.cells, .5);
  const mass = arena.mass(holder);
  assert.equal(arena.consolidate().ok, true);
  for (let i = 0; i < 240 && holder.cells.length > 1; i++) arena.update(1 / 60, { target: { x: 0, y: 0 } });
  assert.equal(holder.cells.length, 1);
  assert.equal(holder.cells[0].mass, mass);
  assert.equal(arena.events.filter(event => event.type === 'merge').length, 15);
  assert.equal(updateClusterNetwork(holder).groups.length, 0);
  assert.equal(arena.totalMass(), SUPPLY);
});

test('seven-cell cores and small offshoots keep their shape while moving, stopping, and consolidating', () => {
  for (const [address, sizes] of [['fixture-layout-3', [7, 6, 3]], ['fixture-layout-13', [7, 7, 2]], ['fixture-layout-10', [7, 6, 3]], ['fixture-layout-14', [7, 7, 2]]]) {
    const { arena, holder } = scene(Array.from({ length: 16 }, (_, i) => 260 + i * 30), { x: 1600, y: 1200, address });
    holder.cells.forEach((cell, i) => { cell.x += (i % 4 - 1.5) * 110; cell.y += (Math.floor(i / 4) - 1.5) * 110; });
    arena.time = MERGE_TIME + 1;
    const network = updateClusterNetwork(holder);
    assert.deepEqual(network.groups.map(group => group.memberIds.length), sizes);
    for (let i = 0; i < 360; i++) arena.update(1 / 60, { target: arena.center(holder) });
    const start = arena.center(holder);
    for (let i = 0; i < 60; i++) arena.update(1 / 60, { target: { x: start.x + 600, y: start.y - 200 } });
    const stopped = arena.center(holder);
    for (let i = 0; i < 120; i++) arena.update(1 / 60, { target: stopped });
    assert.equal(updateClusterNetwork(holder), network);
    assert(Math.hypot(arena.center(holder).x - stopped.x, arena.center(holder).y - stopped.y) < 1e-7);
    verifyGaps(holder.cells);
    verifyWalls(holder.cells);
    const cells = new Map(holder.cells.map(cell => [cell.id, cell]));
    for (const link of network.links.filter(link => link.kind === 'spoke')) {
      const a = cells.get(link.aId), b = cells.get(link.bId);
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - radius(a.mass) - radius(b.mass);
      assert(gap < clusterGap(a, b) + CLUSTER_COHESION_SLACK + 35, `${address}: satellite stayed far from its hub (${gap})`);
    }
    assert.equal(arena.consolidate().ok, true);
    for (let i = 0; i < 240 && holder.cells.length > 1; i++) arena.update(1 / 60, { target: stopped });
    assert.equal(holder.cells.length, 1);
    assert.equal(arena.totalMass(), SUPPLY);
  }
});
