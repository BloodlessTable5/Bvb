import { progressionFor, previewProfile } from './progression.mjs';
import { buildConstellation, findConstellationNode } from './constellation.mjs';
import { bubbleAgeMs, bubbleAgeColor, previewBubbleAgeMs, bubbleAgeLabel } from './bubble-history.mjs';

const TAU = Math.PI * 2;
// Deliberately fictional display units for the home portrait; never a quote.
const COSMETIC_DOLLARS_PER_TOKEN = 1;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const validColor = (value, fallback) => /^#[\da-f]{6}$/i.test(value || '') ? value : fallback;
const finite = value => Number.isFinite(value) ? Math.max(0, value) : 0;

function cosmeticDollars(tokens, compact = false) {
  const value = finite(tokens) * COSMETIC_DOLLARS_PER_TOKEN;
  if (compact) for (const [scale, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (value >= scale) return `$${(value / scale).toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
  }
  return `$${value.toLocaleString('en-US')}`;
}

function activeTime(seconds) {
  if (finite(seconds) < 60) return `${Math.floor(finite(seconds))}s`;
  const minutes = Math.floor(finite(seconds) / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

export class LobbyView {
  constructor({ canvas, reducedMotion = false, onConnect, onDisconnect, now = Date.now } = {}) {
    if (!canvas) throw new Error('LobbyView requires a canvas.');
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.reducedMotion = reducedMotion;
    this.now = now; this.historyMinute = -1; this.bubbleAges = new Map();
    this.document = canvas.ownerDocument; this.home = canvas.closest('#lobby-home');
    this.profile = { xp: 0, activeSeconds: 0 }; this.preview = 'current'; this.signature = '';
    this.appearance = { name: 'anon', color: '#c3f774', highlight: '#eaf7ff', seed: 'guest' };
    this.identity = { identityLabel: 'Guest constellation', connected: false, walletStatus: 'Play as a guest, or connect your address.' };
    this.time = 0; this.width = 0; this.height = 0; this.dpr = 1; this.pointer = { x: 0, y: 0, currentX: 0, currentY: 0 };
    this.ripple = null; this.listeners = []; this.graph = buildConstellation('guest', progressionFor(this.profile));
    this.selectedId = null; this.hoverId = null; this.positions = []; this.selectionPath = new Set();
    this.listen(canvas, 'pointermove', event => {
      const rect = canvas.getBoundingClientRect();
      this.pointer.x = clamp((event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1, -1, 1);
      this.pointer.y = clamp((event.clientY - rect.top) / Math.max(1, rect.height) * 2 - 1, -1, 1);
      this.hoverId = this.hitNode(event.clientX - rect.left, event.clientY - rect.top)?.id ?? null;
      canvas.style.cursor = this.hoverId == null ? 'default' : 'pointer';
    });
    this.listen(canvas, 'pointerleave', () => { this.pointer.x = 0; this.pointer.y = 0; this.hoverId = null; });
    this.listen(canvas, 'pointerdown', event => {
      if (this.reducedMotion) return;
      const rect = canvas.getBoundingClientRect();
      this.ripple = { x: event.clientX - rect.left, y: event.clientY - rect.top, age: 0 };
    });
    this.listen(canvas, 'click', event => {
      const rect = canvas.getBoundingClientRect();
      this.selectBubble(this.hitNode(event.clientX - rect.left, event.clientY - rect.top)?.id ?? null);
      canvas.focus({ preventScroll: true });
    });
    this.listen(canvas, 'keydown', event => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') this.selectBubble(null);
      else if (event.key === 'Home') this.selectBubble(this.graph.nodes[0].id);
      else if (event.key === 'Enter' || event.key === ' ') this.selectBubble(this.selectedId ?? this.graph.nodes[0].id);
      else if (event.key === 'End') this.selectBubble(this.graph.nodes.at(-1).id);
      else this.advanceSelection(['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
    });
    this.listen(this.element('bubble-previous'), 'click', () => this.advanceSelection(-1));
    this.listen(this.element('bubble-next'), 'click', () => this.advanceSelection(1));
    for (const button of this.home.querySelectorAll('[data-growth-preview]')) this.listen(button, 'click', () => {
      this.preview = button.dataset.growthPreview; this.refresh(); this.draw(0);
    });
    if (onConnect) this.listen(this.element('wallet-connect'), 'click', onConnect);
    if (onDisconnect) this.listen(this.element('wallet-disconnect'), 'click', onDisconnect);
    if (globalThis.ResizeObserver) { this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); }
    this.update(this.profile); this.resize();
  }

  element(id) { return this.document.getElementById(id); }
  listen(element, event, callback) { if (element) { element.addEventListener(event, callback); this.listeners.push([element, event, callback]); } }

  update(profile, options = {}) {
    this.profile = profile || { xp: 0, activeSeconds: 0 };
    this.setAppearance(options);
    for (const key of ['identityLabel', 'connected', 'walletStatus']) if (key in options) this.identity[key] = options[key];
    this.element('wallet-identity').textContent = this.identity.identityLabel || (this.identity.connected ? 'Address connected' : 'Guest constellation');
    this.element('wallet-identity').parentElement.classList.toggle('is-connected', Boolean(this.identity.connected));
    this.element('wallet-connect').hidden = Boolean(this.identity.connected);
    this.element('wallet-disconnect').hidden = !this.identity.connected;
    this.element('wallet-status').textContent = this.identity.walletStatus || (this.identity.connected ? 'Address connected · saved on this browser' : 'Play as a guest, or connect your address.');
    this.refresh();
  }

  setAppearance(options = {}) {
    if ('name' in options) this.appearance.name = String(options.name || 'anon').slice(0, 18);
    if ('color' in options) { this.appearance.color = validColor(options.color, '#c3f774'); this.historyMinute = -1; }
    if ('highlight' in options) this.appearance.highlight = validColor(options.highlight, '#eaf7ff');
    if ('seed' in options) this.appearance.seed = String(options.seed || 'guest');
  }

  showCurrent() { this.preview = 'current'; this.refresh(); this.draw(0); }

  hitNode(x, y) { return findConstellationNode({ nodes: this.positions }, x, y, 5); }

  selectBubble(id) {
    this.selectedId = this.graph.nodes.some(node => node.id === id) ? id : null;
    this.refreshSelection(); this.draw(0);
  }

  advanceSelection(direction) {
    const index = this.graph.nodes.findIndex(node => node.id === this.selectedId);
    const next = index < 0 ? (direction > 0 ? 0 : this.graph.nodes.length - 1)
      : (index + direction + this.graph.nodes.length) % this.graph.nodes.length;
    this.selectBubble(this.graph.nodes[next].id);
  }

  refreshAges() {
    const now = this.now(), previewing = this.preview !== 'current';
    this.historyMinute = Math.floor(now / 60000);
    const births = new Map((this.profile.bubbleBirths || []).map(birth => [birth.id, birth.createdAt]));
    this.bubbleAges = new Map(this.graph.nodes.map(node => {
      const createdAt = births.get(node.id) ?? null;
      const ageMs = previewing ? previewBubbleAgeMs(node.id, this.graph.nodes.length, this.preview === 'hour' ? 3600 : 25 * 3600)
        : bubbleAgeMs(createdAt, now);
      return [node.id, { createdAt: previewing ? null : createdAt, ageMs, color: bubbleAgeColor(this.appearance.color, ageMs) }];
    }));
    this.element('constellation-age-gradient').style.background = `linear-gradient(90deg, ${bubbleAgeColor(this.appearance.color, 0)}, ${this.appearance.color})`;
  }

  refreshSelection() {
    const selected = this.graph.nodes.find(node => node.id === this.selectedId), previewing = this.preview !== 'current';
    this.selectionPath.clear();
    const seen = new Set();let branch = selected;
    while (branch?.parentId != null && !seen.has(branch.id)) {
      seen.add(branch.id);
      const parent = this.graph.nodes.find(node => node.id === branch.parentId);
      if (!parent) break;
      this.selectionPath.add(`${Math.min(branch.id, parent.id)}:${Math.max(branch.id, parent.id)}`);branch = parent;
    }
    this.element('bubble-selection-title').textContent = selected
      ? `${previewing ? 'Preview · ' : ''}Bubble #${String(selected.id).padStart(3, '0')}${selected.id === (this.graph.rootId ?? 1) ? ' · Your wallet' : ''}` : 'Select a bubble';
    this.element('bubble-selection-value').textContent = selected
      ? cosmeticDollars(selected.coins) : '—';
    this.element('bubble-selection-tokens').textContent = selected
      ? `${selected.coins.toLocaleString('en-US')} tokens · ${(selected.coins / this.graph.totalCoins * 100).toFixed(2)}% of supply`
      : 'Click a bubble or use the arrow keys to inspect its value and creation date.';
    const created = this.element('bubble-selection-created'), history = this.bubbleAges.get(selected?.id);
    created.hidden = !selected;
    created.textContent = !selected ? '' : previewing ? `Illustrative age · ${bubbleAgeLabel(history?.ageMs)}`
      : history?.ageMs == null ? 'Creation date not recorded'
      : `Created ${new Date(history.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${bubbleAgeLabel(history.ageMs)}`;
    this.element('constellation-supply').textContent = `${cosmeticDollars(this.graph.totalCoins, true)} collection · ${this.graph.totalCoins.toLocaleString('en-US')} tokens`;
    this.element('constellation-coin-note').textContent = `${previewing ? 'Preview · ' : ''}Cosmetic value`;
    this.element('bubble-previous').disabled = this.graph.nodes.length < 2;
    this.element('bubble-next').disabled = this.graph.nodes.length < 2;
  }

  refresh() {
    const actual = progressionFor(this.profile), previewing = this.preview !== 'current';
    const shown = previewing ? progressionFor(previewProfile(this.preview === 'hour' ? 3600 : 25 * 3600)) : actual;
    this.element('lobby-level').textContent = String(actual.level).padStart(2, '0');
    this.element('lobby-active-time').textContent = activeTime(this.profile.activeSeconds);
    const growth = this.element('lobby-growth');
    growth.replaceChildren(this.document.createTextNode(String(actual.nodes) + ' '));
    const unit = this.document.createElement('small'); unit.textContent = actual.nodes === 1 ? 'bubble' : 'bubbles'; growth.append(unit);
    const progress = clamp(finite(actual.levelProgress) * 100, 0, 100);
    this.element('lobby-xp-fill').style.width = `${progress}%`;
    this.element('lobby-xp-track').setAttribute('aria-valuenow', String(Math.round(progress)));
    const shownXp = actual.xpIntoLevel < 10 ? actual.xpIntoLevel.toFixed(1) : Math.floor(actual.xpIntoLevel);
    this.element('lobby-xp-label').textContent = `${shownXp} / ${Math.ceil(actual.xpForLevel)} XP`;
    this.element('constellation-count').textContent = `${String(shown.nodes).padStart(2, '0')} / 180${previewing ? ' · PREVIEW' : ''}`;
    this.element('constellation-origin').hidden = shown.nodes > 1;
    this.element('constellation-preview-label').textContent = previewing
      ? `Illustrative ${this.preview === 'hour' ? '1-hour' : '25-hour'} milestone · your saved growth is unchanged`
      : 'Your saved growth · cosmetic only';
    this.canvas.setAttribute('aria-label', `${previewing ? 'Illustrative growth preview' : 'Your saved cosmetic constellation'}: ${shown.nodes} ${shown.nodes === 1 ? 'bubble' : 'bubbles'}. Select a bubble to inspect its value, tokens, and creation date.`);
    for (const button of this.home.querySelectorAll('[data-growth-preview]')) button.setAttribute('aria-pressed', String(button.dataset.growthPreview === this.preview));
    const signature = `${this.appearance.seed}:${shown.nodes}:${shown.clusters}`;
    if (signature !== this.signature) {
      this.signature = signature; this.graph = buildConstellation(this.appearance.seed, shown);
      this.selectedId = null; this.hoverId = null; this.positions = [];
    }
    this.refreshAges(); this.refreshSelection();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.width = rect.width; this.height = rect.height;
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.round(this.width * this.dpr), height = Math.round(this.height * this.dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this.draw(0);
  }

  draw(elapsed = 0) {
    if (!this.ctx || !this.width || !this.height) return;
    if (Math.floor(this.now() / 60000) !== this.historyMinute) { this.refreshAges(); this.refreshSelection(); }
    const dt = clamp(finite(elapsed), 0, .05), moving = !this.reducedMotion;
    if (moving) this.time += dt;
    const ease = moving ? 1 - Math.exp(-dt * 4) : 1;
    this.pointer.currentX += (this.pointer.x - this.pointer.currentX) * ease;
    this.pointer.currentY += (this.pointer.y - this.pointer.currentY) * ease;
    const ctx = this.ctx, width = this.width, height = this.height, color = this.appearance.color, highlight = this.appearance.highlight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);ctx.clearRect(0, 0, width, height);
    ctx.save();ctx.lineCap = 'round';ctx.lineJoin = 'round';ctx.setLineDash([]);
    // A few quiet reference points are decorative, never counted as growth.
    ctx.fillStyle = '#89a8a72b';
    for (let i = 0; i < 9; i++) { const x = width * ((i * .173 + .11) % 1), y = 58 + (height - 160) * ((i * .337 + .21) % 1); ctx.beginPath();ctx.arc(x, y, i % 3 ? .75 : 1.2, 0, TAU);ctx.fill(); }
    const scale = Math.min(1.35, (width - 58) / this.graph.width, (height - 144) / this.graph.height);
    const shiftX = this.pointer.currentX * 10, shiftY = this.pointer.currentY * 7;
    const centerX = width * .5 + shiftX, centerY = height * .44 + shiftY;
    if (this.graph.nodes.length === 1) {
      ctx.strokeStyle = '#79938213';ctx.lineWidth = 1;
      for (const radius of [93, 143]) { ctx.beginPath();ctx.arc(centerX, centerY, radius, 0, TAU);ctx.stroke(); }
      ctx.strokeStyle = '#8ca8932a';
      for (let i = 0; i < 4; i++) { const angle = i * Math.PI / 2;ctx.beginPath();ctx.moveTo(centerX + Math.cos(angle) * 140, centerY + Math.sin(angle) * 140);ctx.lineTo(centerX + Math.cos(angle) * 146, centerY + Math.sin(angle) * 146);ctx.stroke(); }
    }
    const positions = this.graph.nodes.map(node => {
      const root = node.id === (this.graph.rootId ?? 1);
      const wave = moving ? this.time * .22 + (node.phase || 0) : (node.phase || 0);
      const driftX = moving && !root ? Math.sin(wave) * 2.2 : 0, driftY = moving && !root ? Math.cos(wave * .81) * 2 : 0;
      const firstGrowth = this.graph.nodes.length === 1 ? 1 + clamp(finite(this.profile.xp) / 10, 0, 1) * .12 : 1;
      return { id: node.id, x: centerX + (node.x + driftX) * scale, y: centerY + (node.y + driftY) * scale, r: node.r * scale * firstGrowth };
    });
    this.positions = positions;
    for (const link of this.graph.links) {
      const a = positions[link.a], b = positions[link.b], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (length <= a.r + b.r + 3) continue;
      const nx = dx / length, ny = dy / length;
      ctx.beginPath();ctx.moveTo(a.x + nx * (a.r + 2), a.y + ny * (a.r + 2));ctx.lineTo(b.x - nx * (b.r + 2), b.y - ny * (b.r + 2));
      const selectedLink = a.id === this.selectedId || b.id === this.selectedId || this.selectionPath.has(`${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`);
      ctx.lineWidth = selectedLink ? 1.5 : link.bridge ? 1.05 : .7;
      const opacity = selectedLink ? 'cf' : link.bridge ? (link.quiet ? '72' : 'a6') : link.quiet ? '2c' : '56';
      ctx.strokeStyle = (selectedLink ? highlight : color) + opacity;ctx.stroke();
    }
    for (let index = 0; index < positions.length; index++) {
      const point = positions[index], node = this.graph.nodes[index];
      ctx.beginPath();ctx.arc(point.x, point.y, Math.max(.7, point.r), 0, TAU);
      ctx.shadowColor = highlight + '78';ctx.shadowBlur = Math.min(13, point.r * .6) * this.dpr;
      ctx.shadowOffsetX = 0;ctx.shadowOffsetY = 0;ctx.strokeStyle = highlight + 'c0';ctx.lineWidth = point.r > 15 ? 1.4 : .8;ctx.stroke();
      ctx.shadowBlur = 0;ctx.fillStyle = this.bubbleAges.get(node.id)?.color || color;ctx.fill();
      const root = node.id === (this.graph.rootId ?? 1);
      if (root || (node.hub && point.r > 21)) {
        const size = root ? clamp(point.r * .3, 8, 12) : 8;
        ctx.font = `600 ${size}px "DM Sans",sans-serif`;ctx.textAlign = 'center';ctx.textBaseline = 'middle';ctx.fillStyle = '#102017';
        const label = root ? (point.r >= 24 ? this.appearance.name : 'YOU') : '·';
        if (root && point.r < 12) {
          ctx.fillStyle = highlight;ctx.textBaseline = 'bottom';ctx.fillText('YOU', point.x, point.y - point.r - 4);
        } else ctx.fillText(label, point.x, point.y, point.r * 1.55);
        if (root && point.r > 34 && this.graph.nodes.length > 1) {
          ctx.font = '500 6px "DM Sans",sans-serif';ctx.fillStyle = '#1020179e';ctx.fillText('YOUR WALLET', point.x, point.y + 13, point.r * 1.6);
        }
      }
    }
    for (const point of positions) if (point.id === this.selectedId || point.id === this.hoverId) {
      const selected = point.id === this.selectedId;
      ctx.beginPath();ctx.arc(point.x, point.y, Math.max(point.r + (selected ? 5 : 3), selected ? 8 : 5), 0, TAU);
      ctx.lineWidth = selected ? 1.6 : 1;ctx.strokeStyle = highlight + (selected ? 'f0' : '76');ctx.stroke();
    }
    if (this.ripple && moving) {
      this.ripple.age += dt;const progress = this.ripple.age / .65;
      if (progress >= 1) this.ripple = null;
      else { ctx.globalAlpha = (1 - progress) * .2;ctx.strokeStyle = highlight;ctx.lineWidth = 1;ctx.beginPath();ctx.arc(this.ripple.x, this.ripple.y, 8 + progress * 45, 0, TAU);ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    const selectedPoint = positions.find(point => point.id === this.selectedId);
    if (selectedPoint) this.drawSelectionCallout(ctx, selectedPoint, highlight);
    ctx.restore();
  }

  drawSelectionCallout(ctx, point, highlight) {
    const node = this.graph.nodes.find(item => item.id === point.id);
    const title = `${this.preview !== 'current' ? 'Preview' : 'Cosmetic value'} · #${String(node.id).padStart(3, '0')}`;
    const amount = cosmeticDollars(node.coins, true), tokens = `${node.coins.toLocaleString('en-US')} tokens`;
    const age = bubbleAgeLabel(this.bubbleAges.get(node.id)?.ageMs);
    const compact = this.width < 400;
    ctx.font = '8px "DM Sans",sans-serif';const titleWidth = ctx.measureText(title).width;
    ctx.font = `${compact ? 8 : 9}px "DM Sans",sans-serif`;const tokenWidth = ctx.measureText(tokens).width;
    const ageWidth = ctx.measureText(age).width;
    ctx.font = `500 ${compact ? 14 : 16}px "Space Grotesk",sans-serif`;const amountWidth = ctx.measureText(amount).width;
    const boxWidth = Math.min(this.width - 24, Math.max(titleWidth, tokenWidth, amountWidth, ageWidth) + 22), boxHeight = compact ? 57 : 72;
    const safeTop = 35, safeBottom = this.height - 84, gap = point.r + 11;
    const candidates = [
      { x: point.x + gap, y: point.y - boxHeight / 2 },
      { x: point.x - gap - boxWidth, y: point.y - boxHeight / 2 },
      { x: point.x - boxWidth / 2, y: point.y - gap - boxHeight },
      { x: point.x - boxWidth / 2, y: point.y + gap },
      { x: 12, y: safeTop }, { x: this.width - boxWidth - 12, y: safeTop },
      { x: 12, y: safeBottom - boxHeight }, { x: this.width - boxWidth - 12, y: safeBottom - boxHeight },
    ].map(box => ({ x: clamp(box.x, 12, this.width - boxWidth - 12), y: clamp(box.y, safeTop, safeBottom - boxHeight) }));
    const clearance = box => Math.hypot(point.x - clamp(point.x, box.x, box.x + boxWidth), point.y - clamp(point.y, box.y, box.y + boxHeight));
    const box = candidates.find(candidate => clearance(candidate) >= point.r + 3) || candidates.reduce((best, candidate) => clearance(candidate) > clearance(best) ? candidate : best);
    ctx.beginPath();ctx.roundRect(box.x, box.y, boxWidth, boxHeight, 6);
    ctx.fillStyle = '#0b191ef5';ctx.fill();ctx.strokeStyle = highlight + '58';ctx.lineWidth = .8;ctx.stroke();
    ctx.textAlign = 'left';ctx.textBaseline = 'top';ctx.fillStyle = '#90a89b';ctx.font = '8px "DM Sans",sans-serif';
    ctx.fillText(title, box.x + 11, box.y + 7);
    ctx.font = `500 ${compact ? 14 : 16}px "Space Grotesk",sans-serif`;ctx.fillStyle = highlight;ctx.fillText(amount, box.x + 11, box.y + 18);
    ctx.font = `${compact ? 8 : 9}px "DM Sans",sans-serif`;ctx.fillStyle = '#8da595';ctx.fillText(tokens, box.x + 11, box.y + (compact ? 32 : 41));
    ctx.fillStyle = '#779bb1';ctx.fillText(age, box.x + 11, box.y + (compact ? 43 : 55));
  }

  destroy() { this.observer?.disconnect();for (const [element, event, callback] of this.listeners) element.removeEventListener(event, callback);this.listeners = []; }
}
