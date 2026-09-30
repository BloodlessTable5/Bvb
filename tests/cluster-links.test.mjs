import test from 'node:test';
import assert from 'node:assert/strict';
import { ClusterTransfers, HUB_TRANSFER_DURATION, drawClusterLinks } from '../dist/cluster-links.mjs';
import { updateClusterNetwork } from '../dist/clusters.mjs';

const highlight = '#eaf7ff';
const event = overrides => ({ type: 'hub-feed', fromId: 1, toId: 2,
  x: 1000, y: 1000, toX: 1200, toY: 1000, mass: 6, color: '#73a7ed', isPlayer: true, ...overrides });
const cells = () => [{ c: { id: 1, x: 1000, y: 1000, mass: 100 } },
  { c: { id: 2, x: 1200, y: 1000, mass: 400 } }];
const advance = (transfers, live, seconds) => {
  const steps = Math.ceil(seconds * 60);
  for (let i = 0; i < steps; i++) transfers.update(live, seconds / steps);
};

function recordingContext() {
  let path = [], stack = [];
  const keys = ['globalAlpha', 'globalCompositeOperation', 'lineDash', 'lineDashOffset',
    'lineCap', 'lineJoin', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'shadowColor',
    'filter', 'lineWidth', 'strokeStyle', 'fillStyle'];
  return {
    strokes: [], dots: [], globalAlpha: .75, globalCompositeOperation: 'lighter',
    lineDash: [5, 8], lineDashOffset: 3, lineCap: 'square', lineJoin: 'bevel',
    shadowBlur: 12, shadowOffsetX: 5, shadowOffsetY: 7, shadowColor: '#ff0000', filter: 'blur(2px)',
    state() { return Object.fromEntries(keys.map(key => [key, structuredClone(this[key])])); },
    save() { stack.push(this.state()); }, restore() { Object.assign(this, stack.pop()); },
    setLineDash(value) { this.lineDash = [...value]; },
    beginPath() { path = []; },
    moveTo(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y));path.push({ x, y }); },
    lineTo(x, y) { this.moveTo(x, y); },
    stroke() { this.strokes.push({ points: structuredClone(path), state: this.state() }); },
    arc(x, y, r) { assert.ok([x, y, r].every(Number.isFinite));this.dots.push({ x, y, r }); },
    fill() {},
  };
}

test('cluster links use live visual edges, remain within their owner, and cull offscreen groups', () => {
  const holders = [0, 1].map(group => ({ id: group + 1, color: '#73a7ed', cells:
    Array.from({ length: 6 }, (_, i) => ({ id: group * 10 + i + 1, mass: 100,
      x: 300 + group * 1900 + i % 3 * 170, y: 300 + Math.floor(i / 3) * 170 })) }));
  const visuals = new Map(holders.flatMap(holder => holder.cells.map(c =>
    [c.id, { x: c.x + 50, y: c.y + 20, r: 28 }])));
  const ctx = recordingContext(), before = ctx.state();
  drawClusterLinks(ctx, holders, visuals, 1, { minX: 0, maxX: 1000, minY: 0, maxY: 800 });
  assert.deepEqual(ctx.state(), before, 'link rendering must restore surrounding canvas state');
  assert.ok(ctx.strokes.length > 6, 'a hub group should have multiple visible connections');
  for (const stroke of ctx.strokes) {
    assert.equal(stroke.points.length, 2);
    assert.deepEqual(stroke.state.lineDash, []);
    assert.equal(stroke.state.shadowBlur, 0);
    assert.ok(stroke.state.strokeStyle.startsWith(holders[0].color));
    for (const point of stroke.points) {
      assert.ok(point.x < 1000, 'offscreen groups should not draw or connect across owners');
      const edgeError = Math.min(...holders[0].cells.map(c => {
        const body = visuals.get(c.id);
        return Math.abs(Math.hypot(point.x - body.x, point.y - body.y) - body.r - 4);
      }));
      assert.ok(edgeError < 1e-8, 'links should meet the current visual edge with clearance');
    }
  }
  const hidden = recordingContext();
  drawClusterLinks(hidden, holders, visuals, 1, { minX: 5000, maxX: 5500, minY: 0, maxY: 800 });
  assert.equal(hidden.strokes.length, 0);
});

test('satellite bridges and small-branch spokes stay visibly stronger at different zoom levels', () => {
  const holder = { wallet: 'fixture-layout-13', color: '#73a7ed', cells: Array.from({ length: 16 }, (_, i) =>
    ({ id: i + 1, x: 400 + i % 4 * 160, y: 400 + Math.floor(i / 4) * 160, mass: 100 })) };
  const network = updateClusterNetwork(holder), secondary = network.links.filter(link => link.secondary);
  const branch = network.groups.find(group => group.offshoot);
  assert.equal(branch.memberIds.length, 2);
  for (const zoom of [.5, 1.5]) {
    const ctx = recordingContext();
    drawClusterLinks(ctx, [holder], null, zoom);
    const strong = ctx.strokes.filter(stroke => stroke.state.strokeStyle === holder.color + 'b0');
    assert.equal(strong.length, secondary.length, 'every extra bridge must be rendered visibly');
    for (const [i, stroke] of strong.entries()) {
      assert.equal(stroke.state.lineWidth * zoom, 1.35, 'bridge thickness is constant on screen');
      const edge = secondary[i], endpoints = [edge.aId, edge.bId].map(id => holder.cells.find(cell => cell.id === id));
      stroke.points.forEach((point, index) => {
        const cell = endpoints[index];
        assert.ok(Math.abs(Math.hypot(point.x - cell.x, point.y - cell.y) - 21 - 4 / zoom) < 1e-8);
      });
    }
    assert.equal(ctx.strokes.filter(stroke => stroke.state.strokeStyle === holder.color + 'a0').length, 1,
      'the two-cell offshoot has its own clear connection');
  }
});

test('hub transfer follows both live cells, stays between their edges, and preserves state', () => {
  const transfers = new ClusterTransfers(), source = event(), original = structuredClone(source), live = cells();
  transfers.add(source, highlight);
  live[0].c.x = 1100;live[0].c.y = 1050;
  live[1].c.x = 1450;live[1].c.y = 1200;
  advance(transfers, live, HUB_TRANSFER_DURATION / 2);
  assert.deepEqual(source, original, 'effect tracking must not mutate simulation events');
  assert.equal(transfers.transfers.length, 1);
  const effect = transfers.transfers[0];
  assert.equal(effect.color, highlight);
  assert.deepEqual([effect.x, effect.y, effect.toX, effect.toY], [1100, 1050, 1450, 1200]);
  const ctx = recordingContext(), before = ctx.state();
  transfers.draw(ctx, 1);
  assert.deepEqual(ctx.state(), before);
  assert.equal(ctx.dots.length, 1);
  const point = ctx.dots[0];
  assert.ok(point.x > effect.x && point.x < effect.toX);
  assert.ok(point.y > effect.y && point.y < effect.toY);
  for (const stroke of ctx.strokes) for (const p of stroke.points) {
    assert.ok(Math.hypot(p.x - effect.x, p.y - effect.y) >= effect.fromRadius + 4 - 1e-8);
    assert.ok(Math.hypot(p.x - effect.toX, p.y - effect.toY) >= effect.toRadius + 4 - 1e-8);
  }
});

test('zero elapsed time freezes transfers, while losing either endpoint removes them', () => {
  for (const removed of [1, 2]) {
    const transfers = new ClusterTransfers(), live = cells();
    transfers.add(event(), highlight);transfers.update(live, 1 / 60);
    const before = structuredClone(transfers.transfers);
    live[0].c.x = 900;live[1].c.y = 1400;
    transfers.update(live, 0);
    assert.deepEqual(transfers.transfers, before);
    transfers.update(live.filter(({ c }) => c.id !== removed), 1 / 60);
    assert.equal(transfers.transfers.length, 0);
  }
});

test('transfer queues are bounded, expire, and reset before IDs can be reused', () => {
  const transfers = new ClusterTransfers();
  for (let i = 0; i < 100; i++) transfers.add(event({ mass: i + 1, isPlayer: false }), highlight);
  assert.ok(transfers.transfers.length <= 32);
  assert.equal(transfers.transfers.at(-1).mass, 100);
  assert.equal(transfers.transfers.at(-1).color, '#73a7ed');
  advance(transfers, cells(), HUB_TRANSFER_DURATION + .05);
  assert.equal(transfers.transfers.length, 0);
  transfers.add(event(), highlight);transfers.reset();
  assert.equal(transfers.transfers.length, 0);
  transfers.add(event({ x: 200, y: 300 }), highlight);
  assert.equal(transfers.transfers[0].x, 200);
  assert.equal(transfers.transfers[0].age, 0);
});

test('reduced motion and non-transfer events do not produce sparks', () => {
  const reduced = new ClusterTransfers({ reducedMotion: true });
  reduced.add(event(), highlight);reduced.update(cells(), 1 / 60);
  assert.deepEqual(reduced.transfers, []);
  const transfers = new ClusterTransfers();
  for (const invalid of [{ type: 'eat' }, { mass: 0 }, { toId: 1 }, { x: NaN }]) transfers.add(event(invalid), highlight);
  assert.deepEqual(transfers.transfers, []);
});
