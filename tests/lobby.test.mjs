import test from 'node:test';
import assert from 'node:assert/strict';
import { LobbyView } from '../dist/lobby.mjs';

class Element {
  constructor() {
    this.textContent = ''; this.style = {}; this.dataset = {}; this.listeners = new Map();
    this.attributes = new Map(); this.classList = { toggle() {} }; this.parentElement = this;
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type) { this.listeners.delete(type); }
  dispatch(type, values = {}) { const event = { preventDefault() { this.prevented = true; }, ...values }; this.listeners.get(type)?.(event); return event; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  replaceChildren(...children) { this.textContent = children.map(child => child.textContent).join(''); }
  append(child) { this.textContent += child.textContent; }
  focus() { this.focused = true; }
}

function fixture(width = 800, height = 420, options = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createTextNode(textContent) { return { textContent }; }, createElement() { return new Element(); },
  };
  const buttons = ['current', 'hour', 'day'].map(value => { const button = new Element(); button.dataset.growthPreview = value; return button; });
  const canvas = new Element();canvas.ownerDocument = document;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  // Drawing itself is exercised in browser QA; these checks cover interaction
  // and state, without depending on implementation details of Canvas strokes.
  const callouts = [], labels = [], fills = [];let circle = null;
  canvas.getContext = () => new Proxy({
    measureText: text => ({ width: text.length * 6 }),
    beginPath() { circle = null; },
    arc(x, y, r) { circle = { x, y, r }; },
    fill() { if (circle) fills.push({ ...circle, color: this.fillStyle }); },
    roundRect: (x, y, w, h) => callouts.push({ x, y, w, h }),
    fillText: (text, x, y, maxWidth) => labels.push({ text, x, y, maxWidth }),
  }, { get(target, key) { return target[key] ?? (() => {}); } });
  canvas.closest = () => ({ querySelectorAll: () => buttons });
  const lobby = new LobbyView({ canvas, reducedMotion: true, ...options });
  const bubbleFill = id => {
    const point = lobby.positions.find(item => item.id === id);
    return fills.findLast(fill => Math.abs(fill.x - point.x) < 1e-8 && Math.abs(fill.y - point.y) < 1e-8 && Math.abs(fill.r - Math.max(.7, point.r)) < 1e-8)?.color;
  };
  return { lobby, canvas, document, buttons, callouts, labels, fills, bubbleFill, element: id => document.getElementById(id) };
}

test('preview bubble inspection leaves actual saved progression unchanged', () => {
  const { lobby, canvas, buttons, labels, element } = fixture();
  const profile = Object.freeze({ xp: .7, activeSeconds: 4, history: Object.freeze([]) });
  lobby.update(profile, { seed: 'selection-wallet', name: 'Alice' });
  buttons[2].dispatch('click');
  assert.equal(lobby.graph.nodes.length, 180);
  assert.equal(element('lobby-growth').textContent, '1 bubble');
  assert.equal(element('lobby-active-time').textContent, '4s');
  assert.equal(element('lobby-xp-label').textContent, '0.7 / 100 XP');
  const point = lobby.positions[23], node = lobby.graph.nodes[23];
  canvas.dispatch('click', { clientX: point.x, clientY: point.y });
  assert.equal(lobby.selectedId, node.id);
  assert.match(element('bubble-selection-title').textContent, /Preview · Bubble #024/);
  assert.equal(element('bubble-selection-value').textContent, '$' + node.coins.toLocaleString('en-US'));
  assert.match(element('bubble-selection-tokens').textContent, new RegExp(`${node.coins.toLocaleString('en-US')} tokens`));
  assert.match(element('constellation-coin-note').textContent, /Preview · Cosmetic value/);
  assert.equal(canvas.focused, true);
  assert.deepEqual(profile, { xp: .7, activeSeconds: 4, history: [] });
  const thousands = lobby.graph.nodes.find(item => item.coins >= 1_000 && item.coins < 1_000_000);
  assert.ok(thousands);labels.length = 0;lobby.selectBubble(thousands.id);
  assert.ok(labels.some(label => /^\$[\d.,]+K$/.test(label.text)));
  lobby.showCurrent();
  assert.equal(lobby.graph.nodes.length, 1);
  assert.equal(lobby.selectedId, null);
  assert.equal(element('constellation-coin-note').textContent, 'Cosmetic value');
  lobby.selectBubble(1);
  assert.equal(element('bubble-selection-value').textContent, '$1,000,000');
  assert.equal(element('bubble-selection-tokens').textContent, '1,000,000 tokens · 100.00% of supply');
  assert.equal(element('constellation-supply').textContent, '$1M collection · 1,000,000 tokens');
});

test('keyboard and visible controls can reach every bubble and clear selection', () => {
  const { lobby, canvas, buttons, element } = fixture();
  buttons[1].dispatch('click');
  assert.equal(lobby.graph.nodes.length, 23);
  const first = canvas.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(first.prevented, true);
  assert.equal(lobby.selectedId, 1);
  for (let id = 2; id <= 23; id++) { canvas.dispatch('keydown', { key: 'ArrowRight' }); assert.equal(lobby.selectedId, id); }
  canvas.dispatch('keydown', { key: 'ArrowRight' });assert.equal(lobby.selectedId, 1);
  element('bubble-previous').dispatch('click');assert.equal(lobby.selectedId, 23);
  element('bubble-next').dispatch('click');assert.equal(lobby.selectedId, 1);
  canvas.dispatch('keydown', { key: 'End' });assert.equal(lobby.selectedId, 23);
  canvas.dispatch('keydown', { key: 'Home' });assert.equal(lobby.selectedId, 1);
  canvas.dispatch('keydown', { key: 'Escape' });assert.equal(lobby.selectedId, null);
  canvas.dispatch('keydown', { key: 'Enter' });assert.equal(lobby.selectedId, 1);
  assert.equal(canvas.dispatch('keydown', { key: 'Tab' }).prevented, undefined);
});

test('selection uses displayed positions, clears on empty space or identity change, and works with reduced motion', () => {
  const { lobby, canvas, buttons, element } = fixture();
  buttons[1].dispatch('click');
  const point = lobby.positions[0];
  canvas.dispatch('click', { clientX: point.x, clientY: point.y });assert.equal(lobby.selectedId, 1);
  canvas.dispatch('click', { clientX: -100, clientY: -100 });assert.equal(lobby.selectedId, null);
  lobby.selectBubble(2);
  lobby.update({ xp: 0, activeSeconds: 0 }, { seed: 'different-identity', color: '#73a7ed', highlight: '#ff82d6' });
  assert.equal(lobby.selectedId, null);
  assert.equal(lobby.appearance.color, '#73a7ed');assert.equal(lobby.appearance.highlight, '#ff82d6');
  assert.equal(lobby.time, 0);
  lobby.selectBubble(9999);assert.equal(lobby.selectedId, null);
  assert.match(element('bubble-selection-title').textContent, /Select a bubble/);
  lobby.destroy();assert.equal(canvas.listeners.size, 0);
});

test('selected holdings remain visible on a narrow canvas without covering the chosen bubble', () => {
  for (const width of [284, 520]) {
    const { lobby, buttons, callouts } = fixture(width, 350);
    for (const preview of [0, 2]) {
      buttons[preview].dispatch('click');
      for (const node of lobby.graph.nodes) {
        lobby.selectBubble(node.id);
        const box = callouts.at(-1), point = lobby.positions.find(item => item.id === node.id);
        assert.ok(box.x >= 12 && box.x + box.w <= width - 12 + 1e-8);
        assert.ok(box.y >= 35 && box.y + box.h <= 266);
        const closestX = Math.max(box.x, Math.min(box.x + box.w, point.x));
        const closestY = Math.max(box.y, Math.min(box.y + box.h, point.y));
        assert.ok(Math.hypot(point.x - closestX, point.y - closestY) >= point.r, `callout covers bubble ${node.id} at ${width}px`);
      }
    }
  }
});

test('recursive wallet remains at the visual anchor and selection traces its ancestry', () => {
  const { lobby, buttons, labels } = fixture(520, 450);
  lobby.update({ xp: 0, activeSeconds: 0 }, { name: 'My wallet', seed: 'recursive-wallet' });
  buttons[2].dispatch('click');
  const root = lobby.graph.nodes.find(node => node.id === lobby.graph.rootId);
  assert.deepEqual([root.x, root.y], [0, 0]);
  lobby.reducedMotion = false;lobby.pointer.x = .7;lobby.pointer.y = -.4;
  labels.length = 0;lobby.draw(.05);
  const displayedRoot = lobby.positions.find(point => point.id === root.id);
  assert.equal(displayedRoot.x, 260 + lobby.pointer.currentX * 10);
  assert.equal(displayedRoot.y, 450 * .44 + lobby.pointer.currentY * 7);
  assert.ok(labels.some(label => ['My wallet', 'YOU'].includes(label.text)));
  const leaf = lobby.graph.nodes.reduce((deepest, node) => node.depth > deepest.depth ? node : deepest);
  lobby.selectBubble(leaf.id);
  assert.equal(lobby.selectionPath.size, leaf.depth);
  let branch = leaf;
  while (branch.parentId != null) {
    assert.ok(lobby.selectionPath.has(`${Math.min(branch.id, branch.parentId)}:${Math.max(branch.id, branch.parentId)}`));
    branch = lobby.graph.nodes.find(node => node.id === branch.parentId);
  }
  assert.equal(branch.id, root.id);
  assert.ok(labels.some(label => /^\$[\d.,]+(?:[KMBT])?$/.test(label.text)));
  assert.ok(labels.some(label => /^[\d,]+ tokens$/.test(label.text)));
  lobby.selectBubble(null);assert.equal(lobby.selectionPath.size, 0);
});

test('saved creation dates survive appearance changes while age and tint advance on the open page', () => {
  let now = Date.UTC(2026, 5, 12, 12, 0);
  const createdAt = now - 60_000;
  const profile = Object.freeze({ xp: 0, activeSeconds: 0, bubbleBirths: Object.freeze([Object.freeze({ id: 1, createdAt })]) });
  const { lobby, element, bubbleFill } = fixture(520, 450, { now: () => now });
  lobby.update(profile, { seed: 'dated-wallet', color: '#c3f774' });lobby.selectBubble(1);
  const date = new Date(createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  assert.equal(element('bubble-selection-created').textContent, `Created ${date} · 1m old`);
  assert.notEqual(bubbleFill(1), '#c3f774');
  const firstFill = bubbleFill(1);
  lobby.setAppearance({ color: '#e992b2', highlight: '#ff82d6' });lobby.draw(0);
  assert.equal(element('bubble-selection-created').textContent, `Created ${date} · 1m old`);
  assert.notEqual(bubbleFill(1), firstFill);assert.notEqual(bubbleFill(1), '#e992b2');
  now += 120_000;lobby.draw(.016);
  assert.equal(element('bubble-selection-created').textContent, `Created ${date} · 3m old`);
  now = createdAt + 24 * 60 * 60 * 1000 + 60_000;lobby.draw(.016);
  assert.equal(element('bubble-selection-created').textContent, `Created ${date} · 24h 1m old`);
  assert.equal(bubbleFill(1), '#e992b2');
  assert.equal(lobby.time, 0, 'reduced-motion does not freeze wall-clock aging');
  assert.deepEqual(profile.bubbleBirths, [{ id: 1, createdAt }]);
});

test('unknown birth dates stay unknown and profile changes replace date metadata at the same bubble count', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0), oldBirth = Date.UTC(2023, 0, 2, 10, 0), newBirth = now - 5 * 60_000;
  const { lobby, element, bubbleFill } = fixture(520, 450, { now: () => now });
  const legacy = { xp: 0, activeSeconds: 0, bubbleBirths: [{ id: 1, createdAt: null }] };
  lobby.update(legacy, { seed: 'legacy-wallet', color: '#c3f774' });lobby.selectBubble(1);
  assert.equal(element('bubble-selection-created').textContent, 'Creation date not recorded');
  assert.equal(bubbleFill(1), '#c3f774');
  lobby.update({ xp: 0, activeSeconds: 0 }, { seed: 'missing-wallet' });lobby.selectBubble(1);
  assert.equal(element('bubble-selection-created').textContent, 'Creation date not recorded');
  assert.equal(bubbleFill(1), '#c3f774');
  lobby.update({ xp: 0, activeSeconds: 0, bubbleBirths: [{ id: 1, createdAt: oldBirth }] }, { seed: 'wallet-a' });lobby.selectBubble(1);
  const oldText = element('bubble-selection-created').textContent;
  assert.match(oldText, /2023/);assert.equal(bubbleFill(1), '#c3f774');
  lobby.update({ xp: 0, activeSeconds: 0, bubbleBirths: [{ id: 1, createdAt: newBirth }] }, { seed: 'wallet-b' });
  assert.equal(lobby.graph.nodes.length, 1);assert.equal(lobby.selectedId, null);
  lobby.selectBubble(1);
  assert.match(element('bubble-selection-created').textContent, /2026.* · 5m old$/);
  assert.notEqual(element('bubble-selection-created').textContent, oldText);
  assert.notEqual(bubbleFill(1), '#c3f774');
  const graph = lobby.graph;
  lobby.update({ xp: 0, activeSeconds: 0, bubbleBirths: [{ id: 1, createdAt: newBirth - 60_000 }] }, { seed: 'wallet-b' });lobby.draw(0);
  assert.equal(lobby.graph, graph, 'changing saved dates does not require a different topology');
  assert.match(element('bubble-selection-created').textContent, / · 6m old$/);
  lobby.selectBubble(null);
  assert.equal(element('bubble-selection-created').hidden, true);
  assert.equal(element('bubble-selection-created').textContent, '');
});

test('previews use relative ages without calendar dates, saved history mutation, or clock-driven preview growth', () => {
  let now = Date.UTC(2026, 5, 12, 12, 0);
  const createdAt = Date.UTC(2023, 0, 2, 10, 0), baseColor = '#c3f774';
  const profile = Object.freeze({ xp: 1200, activeSeconds: 3600,
    bubbleBirths: Object.freeze(Array.from({ length: 23 }, (_, index) => Object.freeze({ id: index + 1, createdAt }))) });
  const { lobby, buttons, element, bubbleFill } = fixture(520, 450, { now: () => now });
  lobby.update(profile, { seed: 'preview-dated-wallet', color: baseColor });lobby.selectBubble(1);
  const savedText = element('bubble-selection-created').textContent;
  assert.match(savedText, /2023/);assert.equal(lobby.graph.nodes.length, 23);
  buttons[1].dispatch('click');lobby.selectBubble(1);
  assert.equal(lobby.graph.nodes.length, 23, 'preview can have the same count as saved growth');
  assert.equal(element('bubble-selection-created').textContent, 'Illustrative age · 1h old');
  assert.doesNotMatch(element('bubble-selection-created').textContent, /Created|2023|2026/);
  lobby.selectBubble(23);
  assert.equal(element('bubble-selection-created').textContent, 'Illustrative age · Just created');
  buttons[2].dispatch('click');lobby.selectBubble(1);
  assert.equal(element('bubble-selection-created').textContent, 'Illustrative age · 25h old');
  assert.equal(bubbleFill(1), baseColor, 'the oldest preview bubble has completed its tint fade');
  lobby.selectBubble(180);
  assert.equal(element('bubble-selection-created').textContent, 'Illustrative age · Just created');
  const previewFill = bubbleFill(180);assert.notEqual(previewFill, baseColor);
  now += 48 * 60 * 60 * 1000;lobby.draw(.016);
  assert.equal(element('bubble-selection-created').textContent, 'Illustrative age · Just created');
  assert.equal(bubbleFill(180), previewFill);
  assert.equal(element('lobby-growth').textContent, '23 bubbles');
  assert.equal(element('lobby-active-time').textContent, '1h');
  assert.ok(profile.bubbleBirths.every(birth => birth.createdAt === createdAt));
  lobby.showCurrent();lobby.selectBubble(1);
  assert.match(element('bubble-selection-created').textContent, /Created .*2023/);
  assert.equal(bubbleFill(1), baseColor);
});
