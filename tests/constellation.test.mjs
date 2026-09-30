import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConstellation, findConstellationNode } from '../dist/constellation.mjs';

function checkGraph(graph, expectedCount) {
  assert.equal(graph.nodes.length, expectedCount);
  assert.ok(Number.isFinite(graph.width) && graph.width > 0);
  assert.ok(Number.isFinite(graph.height) && graph.height > 0);
  const edgeKeys = new Set(), neighbors = graph.nodes.map(() => []);
  for (const [index, node] of graph.nodes.entries()) {
    assert.equal(node.id, index + 1);
    assert.ok([node.x, node.y, node.r, node.phase].every(Number.isFinite));
    assert.ok(node.r > 0);
    assert.ok(Math.abs(node.x) + node.r <= graph.width / 2);
    assert.ok(Math.abs(node.y) + node.r <= graph.height / 2);
    for (let otherIndex = index + 1; otherIndex < graph.nodes.length; otherIndex++) {
      const other = graph.nodes[otherIndex];
      const clearance = node.group === other.group ? 5.99 : 19.99;
      assert.ok(Math.hypot(node.x - other.x, node.y - other.y) >= node.r + other.r + clearance,
        `Bubbles ${node.id}/${other.id} need breathing room`);
    }
  }
  for (const { a, b } of graph.links) {
    assert.ok(Number.isInteger(a) && Number.isInteger(b));
    assert.ok(a >= 0 && a < expectedCount && b >= 0 && b < expectedCount && a !== b);
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    assert.equal(edgeKeys.has(key), false); edgeKeys.add(key);
    neighbors[a].push(b); neighbors[b].push(a);
  }
  const visited = new Set([0]), queue = [0];
  for (let index = 0; index < queue.length; index++) for (const next of neighbors[queue[index]]) {
    if (!visited.has(next)) { visited.add(next); queue.push(next); }
  }
  assert.equal(visited.size, expectedCount, 'Every bubble belongs to the connected constellation');
  assert.equal(graph.rootId, 1);
  assert.equal(graph.nodes[0].x, 0); assert.equal(graph.nodes[0].y, 0);
  assert.equal(graph.nodes[0].parentId, null);
  assert.equal(graph.nodes[0].subtreeSize, expectedCount);
  for (const node of graph.nodes.slice(1)) {
    assert.ok(node.parentId > 0 && node.parentId < node.id, 'The parent tree cannot contain a cycle');
    const parent = graph.nodes[node.parentId - 1];
    assert.equal(node.depth, parent.depth + 1);
    assert.ok(edgeKeys.has(`${node.parentId - 1}:${node.id - 1}`));
    assert.ok(graph.nodes[0].r > node.r);
  }
  assert.ok(graph.links.length < expectedCount * 3);
  const membership = new Set();
  for (const group of graph.groups) {
    assert.ok(group.memberIds.includes(group.hubId));
    assert.equal(graph.nodes[group.hubId - 1].hub, true);
    for (const id of group.memberIds) {
      assert.equal(membership.has(id), false); membership.add(id);
      assert.equal(graph.nodes[id - 1].group, group.id);
    }
  }
  assert.equal(membership.size, expectedCount);
  assert.equal(graph.totalCoins, 1_000_000);
  assert.equal(graph.nodes.reduce((sum, node) => sum + node.coins, 0), graph.totalCoins);
  const totalArea = graph.nodes.reduce((sum, node) => sum + node.r ** 2, 0);
  for (const node of graph.nodes) {
    assert.ok(Number.isInteger(node.coins) && node.coins > 0);
    assert.ok(Math.abs(node.coins - graph.totalCoins * node.r ** 2 / totalArea) < 1 + 1e-9);
  }
}

test('a new constellation starts with one 43px bubble and the full cosmetic allocation', () => {
  const graph = buildConstellation('new', { nodes: 1, clusters: 1 });
  checkGraph(graph, 1);
  assert.equal(graph.nodes[0].r, 43);
  assert.equal(graph.nodes[0].x, 0); assert.equal(graph.nodes[0].y, 0);
  assert.equal(graph.nodes[0].coins, 1_000_000);
});

test('the same identity and growth reproduce geometry without mutating inputs', () => {
  const growth = Object.freeze({ nodes: 180, clusters: 10 });
  const a = buildConstellation('wallet-A', growth), b = buildConstellation('wallet-A', growth);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.nodes.map(({ x, y }) => [x, y]), buildConstellation('wallet-B', growth).nodes.map(({ x, y }) => [x, y]));
});

test('small, intermediate, and mature maps stay connected, separated, and conserve coins', () => {
  for (const seed of ['guest', 'wallet-A', 'wallet-B']) for (const nodes of [2, 3, 7, 23, 54, 180]) {
    checkGraph(buildConstellation(seed, { nodes, clusters: Math.ceil(nodes / 18) }), nodes);
  }
});

test('recursive neighborhoods taper in population and average size around a dominant central wallet', () => {
  for (const seed of ['guest', 'wallet-A', 'wallet-B']) {
    const hour = buildConstellation(seed, { nodes: 23, clusters: 2 });
    assert.ok(hour.groups.some(group => group.depth >= 2));
    assert.ok(hour.groups.some(group => group.offshoot && [2, 3].includes(group.memberIds.length)));
    const mature = buildConstellation(seed, { nodes: 180, clusters: 10 });
    assert.equal(Math.max(...mature.groups.map(group => group.depth)), 3);
    assert.ok(mature.groups.filter(group => group.offshoot && [2, 3].includes(group.memberIds.length)).length >= 4);
    const nextLargest = Math.max(...mature.nodes.slice(1).map(node => node.r));
    assert.ok(mature.nodes[0].r >= nextLargest * 1.7);
    for (const group of mature.groups.slice(1)) {
      const parent = mature.groups[group.parentGroupId];
      assert.equal(group.depth, parent.depth + 1);
      assert.ok(group.memberIds.length < parent.memberIds.length, 'The direct neighborhood gets smaller outward');
      const mean = entry => entry.memberIds.reduce((sum, id) => sum + mature.nodes[id - 1].r, 0) / entry.memberIds.length;
      assert.ok(mean(group) <= mean(parent) * .9 + 1e-8, 'Actual local mean radius tapers, including tiny offshoots');
      const hub = mature.nodes[group.hubId - 1], parentHub = mature.nodes[parent.hubId - 1];
      assert.ok(Math.hypot(hub.x, hub.y) > Math.hypot(parentHub.x, parentHub.y));
    }
    const memberLinks = mature.links.filter(link => !mature.nodes[link.a].hub && !mature.nodes[link.b].hub);
    assert.ok(memberLinks.length > mature.nodes.length / 2, 'Most branches need connections beyond the primary hub');
    assert.ok(memberLinks.filter(link => link.bridge && link.quiet).length >= 3);
    assert.ok(mature.links.filter(link => link.bridge).length > mature.groups.length - 1, 'Cross-links supplement the parent tree');
  }
});

test('invalid growth is bounded and cannot produce invalid geometry', () => {
  for (const growth of [undefined, null, {}, { nodes: NaN, clusters: Infinity }, { nodes: -30, clusters: -2 }]) checkGraph(buildConstellation(undefined, growth), 1);
  const graph = buildConstellation(0, { nodes: 2000, clusters: 2000 });
  checkGraph(graph, 180); assert.ok(graph.groups.length < 30);
});

test('hit testing prefers a real circle over a nearer padded target and returns the node object', () => {
  const near = { id: 1, x: 0, y: 0, r: 2 }, large = { id: 2, x: 10, y: 0, r: 6 };
  const graph = { nodes: [near, large] };
  assert.equal(findConstellationNode(graph, 4, 0, 5), large);
  assert.equal(findConstellationNode(graph, 3, 0, 2), near);
  assert.equal(findConstellationNode(graph, 30, 0, 2), null);
  assert.equal(findConstellationNode(graph, NaN, 0, 2), null);
  assert.equal(findConstellationNode(null, 0, 0), null);
  const actual = buildConstellation('guest', { nodes: 180, clusters: 10 });
  for (const node of actual.nodes) assert.equal(findConstellationNode(actual, node.x, node.y), node);
});
