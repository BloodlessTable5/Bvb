import test from 'node:test';
import assert from 'node:assert/strict';
import { ABSORPTION_DURATION, BubbleVisuals, paintBubble, paintBubbleShadow } from '../dist/bubbles.mjs';
import { COLORS, WORLD, radius } from '../dist/engine.mjs';

const cell = (id, x, y, mass = 900) => ({
  h: { id, color: '#c3f774' }, c: { id, x, y, mass, vx: 0, vy: 0 },
});
const advance = (visuals, cells, frames = 120) => {
  for (let i = 0; i < frames; i++) visuals.update(cells, 1 / 60);
};
const advanceFor = (visuals, cells, seconds) => {
  const steps = Math.max(1, Math.ceil(seconds * 60));
  for (let i = 0; i < steps; i++) visuals.update(cells, seconds / steps);
};
const polygonArea = points => Math.abs(points.reduce((area, p, i) => {
  const next = points[(i + 1) % points.length];
  return area + p.x * next.y - next.x * p.y;
}, 0)) / 2;
const absorption = (overrides = {}) => ({
  preyId: 1, eaterId: 2, x: 850, y: 850, mass: 160,
  eaterX: 1000, eaterY: 1000, color: '#73a7ed', ...overrides,
});
function assertCircle(body) {
  assert.ok(body.offset.every(value => value === 0), 'circle should have no residual deformation');
  assert.ok(body.velocity.every(value => value === 0), 'circle should have no spring motion');
  for (const point of body.points) {
    assert.ok(Math.abs(Math.hypot(point.x - body.x, point.y - body.y) - body.r) < 1e-9,
      'every membrane point should stay on the circle');
  }
}

// Record geometry and styles at draw time without emulating canvas rasterization.
function recordingContext() {
  const states = [], fills = [], strokes = [], gradients = [];
  const emptyPath = () => ({ controls: [], arcs: [], lines: 0, closed: false });
  let path = emptyPath();
  const finite = (...values) => values.forEach(value => assert.ok(Number.isFinite(value)));
  return {
    fills, strokes, gradients, globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, tx: 0, ty: 0,
    transformScale: 1,
    lineDash: [], lineDashOffset: 0, lineCap: 'butt', lineJoin: 'miter',
    shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, shadowColor: 'transparent', filter: 'none',
    strokeState() { return { lineDash: [...this.lineDash], lineDashOffset: this.lineDashOffset,
      lineCap: this.lineCap, lineJoin: this.lineJoin, shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX, shadowOffsetY: this.shadowOffsetY, shadowColor: this.shadowColor, filter: this.filter }; },
    save() { states.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation,
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, tx: this.tx, ty: this.ty,
      ...this.strokeState() }); },
    restore() { Object.assign(this, states.pop()); },
    getTransform() { return { a: this.transformScale, b: 0 }; },
    setLineDash(values) { this.lineDash = [...values]; },
    translate(x, y) { finite(x, y); this.tx += x; this.ty += y; },
    beginPath() { path = emptyPath(); },
    closePath() { path.closed = true; },
    fill() { fills.push({ style: this.fillStyle, alpha: this.globalAlpha,
      composite: this.globalCompositeOperation, state: this.strokeState(), path: structuredClone(path) }); },
    stroke() { strokes.push({ style: this.strokeStyle, width: this.lineWidth,
      state: this.strokeState(), path: structuredClone(path) }); },
    arc(x, y, r, start, end) {
      finite(x, y, r, start, end);path.arcs.push({ x: x + this.tx, y: y + this.ty, r, start, end });
    },
    moveTo: finite,
    lineTo(...values) { finite(...values); path.lines++; },
    quadraticCurveTo(x, y, nextX, nextY) {
      finite(x, y, nextX, nextY); path.controls.push({ x: x + this.tx, y: y + this.ty });
    },
    createRadialGradient(...values) {
      finite(...values); gradients.push(values); return { addColorStop() {} };
    },
    createLinearGradient(...values) {
      finite(...values); gradients.push(values); return { addColorStop() {} };
    },
  };
}
function filledShape(fill) {
  if (fill.path.arcs.length) {
    const { x, y, r } = fill.path.arcs[0];
    return { x, y, halfWidth: r };
  }
  const points = fill.path.controls;
  assert.ok(points.length >= 4 && points.length % 4 === 0);
  // Opposing shoulders stay symmetric even as the leading edge forms a teardrop.
  const a = points[points.length / 4], b = points[points.length * 3 / 4];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    halfWidth: Math.hypot(a.x - b.x, a.y - b.y) / 2 };
}

test('deep overlaps and crowded contacts stay finite, bounded, and conserve apparent area', () => {
  const visuals = new BubbleVisuals();
  const cells = [
    cell(1, 1000, 1000), cell(2, 1000, 1000), cell(3, 1001, 1000, 5600),
    cell(4, 1080, 1000), cell(5, 920, 1000), cell(6, 1000, 1080),
    cell(7, 1000, 920), cell(8, radius(900), radius(900)),
  ];
  const original = structuredClone(cells);
  for (const entry of cells) { Object.freeze(entry.c); Object.freeze(entry.h); Object.freeze(entry); }
  Object.freeze(cells);
  for (let frame = 0; frame < 240; frame++) {
    // Includes late frames to exercise the renderer's timestep bound.
    visuals.update(cells, frame % 30 === 0 ? .5 : 1 / 60);
    for (const { c } of cells) {
      const body = visuals.get(c.id), r = radius(c.mass);
      assert.ok(body.points.length >= 12);
      for (const p of body.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        const distance = Math.hypot(p.x - c.x, p.y - c.y);
        assert.ok(distance > r * .5 && distance < r * 1.6, `unbounded membrane at frame ${frame}`);
      }
      const areaRatio = polygonArea(body.points) / (Math.PI * r * r);
      assert.ok(areaRatio > .88 && areaRatio < 1.12, `apparent area changed: ${areaRatio}`);
    }
  }
  assert.deepEqual(cells, original, 'cosmetic state must not change simulation data');
  const ctx = recordingContext();
  for (const color of COLORS) paintBubble(ctx, visuals.get(1), color, 1);
  assert.equal(ctx.fills.length, COLORS.length);
  for (const [i, fill] of ctx.fills.entries()) {
    assert.equal(fill.alpha, 1, 'live bubbles should be opaque');
    assert.equal(fill.style, COLORS[i], 'bubble fill should stay its exact flat color');
  }
  assert.equal(ctx.gradients.length, 0, 'flat bubbles should not create gradient shading');
});

test('player highlight changes only color while every bubble has identical glow geometry and strength', () => {
  const visuals = new BubbleVisuals();
  visuals.update([cell(1, 1000, 1000)], 0);
  const body = visuals.get(1), color = COLORS[0], highlight = '#f5aaff';
  const bot = recordingContext(), player = recordingContext();
  paintBubble(bot, body, color, 1);
  paintBubble(player, body, color, 1, { player: true, highlight });
  assert.deepEqual(player.fills, bot.fills, 'custom rings must not recolor or shade the body');
  assert.equal(player.fills.length, 1);
  assert.ok(bot.strokes.length > 0 && player.strokes.length > 0);
  assert.ok(bot.strokes.every(stroke => stroke.style.startsWith(color)));
  assert.ok(player.strokes.every(stroke => stroke.style.startsWith(highlight)));
  for (const ctx of [bot, player]) {
    assert.equal(ctx.gradients.length, 0);
    assert.ok(ctx.strokes.every(stroke => stroke.path.closed &&
      (stroke.path.arcs.length === 1 || stroke.path.controls.length === body.points.length)),
      'highlights should trace the whole bubble instead of adding partial arcs');
  }
  const glow = ctx => ctx.strokes.map(({ style, state, ...geometry }) => ({ ...geometry, opacity: style.slice(7),
    state: { ...state, shadowColor: state.shadowColor === 'transparent' ? 'transparent' : state.shadowColor.slice(7) } }));
  assert.deepEqual(glow(player), glow(bot), 'player rings should have the same padding, widths, and opacity as bot rings');
  const defaultPlayer = recordingContext();
  paintBubble(defaultPlayer, body, color, 1, { player: true });
  assert.ok(defaultPlayer.strokes.every(stroke => stroke.style.startsWith('#eaf7ff')));
  assert.deepEqual(glow(defaultPlayer), glow(bot));
});

test('depth remains centered without changing the body or leaking canvas state', () => {
  const visuals = new BubbleVisuals();
  visuals.update([cell(1, 1000, 1000)], 0);
  const body = visuals.get(1), original = structuredClone(body);
  const ctx = recordingContext();
  ctx.globalAlpha = .6;ctx.globalCompositeOperation = 'lighter';ctx.fillStyle = '#abcdef';
  const state = () => ({ alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation,
    fill: ctx.fillStyle, stroke: ctx.strokeStyle, width: ctx.lineWidth, tx: ctx.tx, ty: ctx.ty });
  const before = state();
  paintBubbleShadow(ctx, body, 1);
  assert.deepEqual(state(), before);
  assert.deepEqual(body, original);
  assert.equal(ctx.fills.length, 1);
  assert.equal(ctx.fills[0].composite, 'source-over', 'shadows should darken the ground even within additive lighting');
  const shadow = filledShape(ctx.fills[0]);
  assert.equal(shadow.x, body.x, 'depth should be centered horizontally');
  assert.equal(shadow.y, body.y, 'depth should be centered vertically');
  assert.equal(ctx.gradients.length, 0);
  paintBubble(ctx, body, COLORS[0], 1);
  const surface = filledShape(ctx.fills[1]);
  assert.ok(Math.abs(surface.x - body.x) < 1e-9 && Math.abs(surface.y - body.y) < 1e-9);
  assert.equal(ctx.fills[1].style, COLORS[0], 'depth should leave the surface color flat');
});

test('rings stay continuous and centered across sizes and zooms despite inherited stroke state', () => {
  const bloomWidths = [];
  for (const mass of [80, 900, 6000]) for (const zoom of [.3, .75, 1.8]) for (const dpr of [1, 2]) {
    const visuals = new BubbleVisuals();
    visuals.update([cell(1, 1000, 1000, mass)], 0);
    const body = visuals.get(1);
    for (const paint of [paintBubbleShadow, (ctx, shape, scale) => paintBubble(ctx, shape, COLORS[0], scale)]) {
      const baseline = recordingContext(), inherited = recordingContext();
      baseline.transformScale = inherited.transformScale = zoom * dpr;
      inherited.setLineDash([4, 9]);inherited.lineDashOffset = 6;
      inherited.lineJoin = 'bevel';inherited.lineCap = 'square';
      inherited.shadowBlur = 18;inherited.shadowOffsetX = 9;inherited.shadowOffsetY = -6;
      inherited.shadowColor = '#ff0000';inherited.filter = 'blur(4px)';
      const previous = inherited.strokeState();
      paint(baseline, body, zoom);paint(inherited, body, zoom);
      assert.deepEqual(inherited.strokes, baseline.strokes, 'ring rendering must ignore unrelated canvas stroke state');
      assert.deepEqual(inherited.strokeState(), previous, 'painter should restore surrounding canvas state');
      for (const stroke of inherited.strokes) {
        assert.deepEqual(stroke.state.lineDash, []);
        assert.equal(stroke.path.arcs.length, 1, 'undeformed bubbles should use an exact circle');
        const arc = stroke.path.arcs[0];
        assert.deepEqual(arc, { x: body.x, y: body.y, r: body.r, start: 0, end: Math.PI * 2 });
        assert.deepEqual(stroke.path, inherited.fills[0].path,
          'glow and fill should share one contour for even outward thickness');
        if (paint !== paintBubbleShadow) {
          assert.ok(stroke.state.shadowBlur > 0, 'bloom should have continuous blur instead of broad hard-edged strokes');
          assert.equal(stroke.state.shadowOffsetX, 0);
          assert.equal(stroke.state.shadowOffsetY, 0);
          bloomWidths.push(stroke.state.shadowBlur / dpr);
          assert.ok(stroke.width * zoom < 4, 'the luminous membrane should remain narrow');
        }
      }
      assert.equal(inherited.fills[0].state.shadowBlur, 0, 'the opaque fill must not cast extra glow or shade its surface');
      assert.equal(inherited.fills[0].state.filter, 'none');
    }
  }
  assert.ok(bloomWidths.every(width => Math.abs(width - bloomWidths[0]) < 1e-9),
    'bloom should retain the same CSS width across body sizes, camera zoom, and display density');
  const visuals = new BubbleVisuals();
  advance(visuals, [cell(1, 1000, 1000), cell(2, 1090, 1000)]);
  const deformed = recordingContext();
  paintBubble(deformed, visuals.get(1), COLORS[0], .75);
  assert.equal(deformed.fills[0].path.arcs.length, 0, 'contact deformation should retain its curved membrane');
  assert.ok(deformed.strokes.every(stroke => JSON.stringify(stroke.path) === JSON.stringify(deformed.fills[0].path)));
  assert.ok(deformed.strokes.every(stroke => stroke.state.shadowBlur > 0));
});

test('isolated bubbles stay exactly round while idle, moving, and changing size', () => {
  const visuals = new BubbleVisuals(), cells = [cell(1, 1000, 1000)];
  for (let frame = 0; frame < 240; frame++) {
    if (frame >= 60) {
      cells[0].c.x += 3;
      cells[0].c.y = 1000 + Math.sin(frame * .2) * 150;
    }
    if (frame === 120) cells[0].c.mass = 1600;
    visuals.update(cells, 1 / 60);
    assertCircle(visuals.get(1));
  }
});

test('own split cells, separated opponents, and world walls do not deform bubbles', () => {
  const r = radius(900);
  const own = [cell(1, 1000, 1000), cell(2, 1090, 1000)];
  own[1].h.id = own[0].h.id;
  const near = [cell(1, 1000, 1000), cell(2, 1000 + r * 2 + 1, 1000)];
  const touching = [cell(1, 1000, 1000), cell(2, 1000 + r * 2, 1000)];
  const walls = [cell(1, r, r), cell(2, WORLD.width - r, r),
    cell(3, r, WORLD.height - r), cell(4, WORLD.width - r, WORLD.height - r)];
  for (const cells of [own, near, touching, walls]) {
    const visuals = new BubbleVisuals();
    for (let frame = 0; frame < 120; frame++) {
      visuals.update(cells, 1 / 60);
      for (const { c } of cells) assertCircle(visuals.get(c.id));
    }
  }
});

test('opponent contact dents both bubbles, then returns to exact circles without recoil', () => {
  const visuals = new BubbleVisuals();
  const cells = [cell(1, 1000, 1000), cell(2, 1090, 1000)];
  advance(visuals, cells);
  for (const { c } of cells) {
    const inContact = Math.max(...visuals.get(c.id).offset.map(Math.abs));
    assert.ok(inContact > .07, 'contact should visibly deform both membranes');
  }
  cells[1].c.x = 1400;
  for (let frame = 0; frame < 30; frame++) {
    const before = cells.map(({ c }) => [...visuals.get(c.id).offset]);
    visuals.update(cells, 1 / 60);
    for (const [j, { c }] of cells.entries()) {
      visuals.get(c.id).offset.forEach((value, i) => {
        assert.ok(Math.abs(value) <= Math.abs(before[j][i]), 'released dent should only decay');
        assert.ok(value * before[j][i] >= 0, 'released dent should not overshoot');
      });
    }
  }
  for (const { c } of cells) assertCircle(visuals.get(c.id));
  const settled = cells.map(({ c }) => structuredClone(visuals.get(c.id).points));
  advance(visuals, cells);
  assert.deepEqual(cells.map(({ c }) => visuals.get(c.id).points), settled);
});

test('absorption animates its ghost without disturbing the round eater', () => {
  const visuals = new BubbleVisuals(), cells = [cell(2, 1000, 1000)];
  visuals.update(cells, 0);
  visuals.absorb(absorption());
  assertCircle(visuals.get(2));
  advanceFor(visuals, cells, ABSORPTION_DURATION * .5);
  assert.equal(visuals.absorptions.length, 1);
  assertCircle(visuals.get(2));
  const ctx = recordingContext();
  visuals.drawAbsorptions(ctx, 1);
  assert.equal(ctx.fills.length, 1);
  assert.ok(filledShape(ctx.fills[0]).halfWidth < radius(160));
});

test('a paused update freezes springs and absorption progression', () => {
  const visuals = new BubbleVisuals(), cells = [cell(2, 1000, 1000), cell(3, 1090, 1000)];
  advance(visuals, cells, 5);
  visuals.absorb(absorption());
  advanceFor(visuals, cells, ABSORPTION_DURATION * .25);
  assert.equal(visuals.absorptions.length, 1);
  const before = structuredClone({
    time: visuals.time, body: visuals.get(2), effects: visuals.absorptions,
  });
  for (let i = 0; i < 120; i++) visuals.update(cells, 0);
  assert.deepEqual({ time: visuals.time, body: visuals.get(2), effects: visuals.absorptions }, before);
});

test('absorption follows moving eaters and redirects during chain consumption', () => {
  const visuals = new BubbleVisuals();
  let cells = [cell(2, 1000, 1000), cell(3, 1300, 1100, 5600)];
  visuals.update(cells, 0);
  visuals.absorb(absorption());
  visuals.absorb(absorption({ preyId: 2, eaterId: 3, x: 1000, y: 1000,
    mass: 900, eaterX: 1300, eaterY: 1100 }));
  assert.ok(visuals.absorptions.every(effect => effect.eaterId === 3));
  assert.ok(visuals.absorptions.every(effect => effect.eaterX === 1300 && effect.eaterY === 1100),
    'chain retargeting should immediately replace fallback destination');
  cells = [cell(3, 1500, 1250, 5600)];
  advanceFor(visuals, cells, ABSORPTION_DURATION * .4);
  assert.equal(visuals.get(2), undefined, 'consumed body should be pruned');
  const ctx = recordingContext();
  visuals.drawAbsorptions(ctx, .7);
  const shapes = ctx.fills.map(filledShape);
  assert.equal(shapes.length, 2);
  for (let i = 0; i < visuals.absorptions.length; i++) {
    const effect = visuals.absorptions[i], progress = effect.age / effect.duration;
    const pull = progress * progress * (2 - progress);
    assert.ok(Math.abs(shapes[i].x - (effect.x + (1500 - effect.x) * pull)) < 1e-8);
    assert.ok(Math.abs(shapes[i].y - (effect.y + (1250 - effect.y) * pull)) < 1e-8);
  }
  assert.equal(ctx.globalAlpha, 1, 'drawing should restore canvas opacity');
  visuals.update([], 0);
  assert.equal(visuals.get(3), undefined);
  const afterMerge = recordingContext();
  visuals.drawAbsorptions(afterMerge, .7);
  assert.deepEqual(afterMerge.fills.map(filledShape), shapes,
    'a disappearing chain eater should retain its last observed position without a visible jump');
  assert.ok(visuals.absorptions.every(effect => effect.eaterX === 1500 && effect.eaterY === 1250));
});

test('absorption remains drawable if its eater disappears, then expires', () => {
  const visuals = new BubbleVisuals();
  visuals.absorb(absorption());
  advanceFor(visuals, [], ABSORPTION_DURATION * .45);
  const ctx = recordingContext();
  visuals.drawAbsorptions(ctx, 1);
  assert.equal(ctx.fills.length, 1);
  const shape = filledShape(ctx.fills[0]);
  assert.ok(shape.x > 850 && shape.x < 1000);
  assert.ok(shape.halfWidth < radius(160), 'victim should shrink as it is pulled in');
  advanceFor(visuals, [], ABSORPTION_DURATION);
  assert.equal(visuals.absorptions.length, 0);
});

test('reset clears transient bodies before cell IDs are reused', () => {
  const visuals = new BubbleVisuals();
  advance(visuals, [cell(2, 1000, 1000)]);
  visuals.absorb(absorption());
  const oldBody = visuals.get(2);
  visuals.reset();
  assert.equal(visuals.time, 0);
  assert.equal(visuals.bodies.size, 0);
  assert.equal(visuals.absorptions.length, 0);
  visuals.update([cell(2, 2000, 1600, 160)], 0);
  assert.notEqual(visuals.get(2), oldBody);
  assert.equal(visuals.get(2).r, radius(160));
  assertCircle(visuals.get(2));
});

test('reduced motion preserves contact shape without oscillation or suction', () => {
  const visuals = new BubbleVisuals({ reducedMotion: true });
  const cells = [cell(1, 1000, 1000), cell(2, 1090, 1000)];
  visuals.update(cells, 1 / 60);
  const shape = structuredClone(visuals.get(1).points);
  advance(visuals, cells, 120);
  assert.deepEqual(visuals.get(1).points, shape);
  assert.ok(Math.max(...visuals.get(1).offset.map(Math.abs)) > .07);
  visuals.absorb(absorption());
  assert.equal(visuals.absorptions.length, 0);
  cells[1].c.x = 1600;
  cells[0].c.mass = 1200;
  visuals.update(cells, 1 / 60);
  assert.equal(visuals.get(1).r, radius(1200));
  assert.ok(visuals.get(1).offset.every(value => value === 0));
});
