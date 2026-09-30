// Cosmetic soft bodies. Simulation positions, collision radii and mass stay authoritative.
import { radius } from './engine.mjs';

const TAU = Math.PI * 2;
const POINTS = 40;
export const ABSORPTION_DURATION = .3;
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const directions = Array.from({ length: POINTS }, (_, i) => ({
  x: Math.cos(i / POINTS * TAU), y: Math.sin(i / POINTS * TAU), angle: i / POINTS * TAU,
}));

export class BubbleVisuals {
  constructor({ reducedMotion = false } = {}) {
    this.reducedMotion = reducedMotion;
    this.reset();
  }

  reset() { this.bodies = new Map(); this.absorptions = []; this.time = 0; }

  absorb(event) {
    if (this.reducedMotion) return;
    // If an eater is itself swallowed, its unfinished trails follow the new eater.
    for (const effect of this.absorptions) {
      if (effect.eaterId === event.preyId) {
        effect.eaterId = event.eaterId;
        effect.eaterX = event.eaterX; effect.eaterY = event.eaterY;
      }
    }
    this.absorptions.push({ ...event, age: 0, duration: ABSORPTION_DURATION });
    // Bound transient work even after a busy catch-up frame.
    if (this.absorptions.length > 64) this.absorptions.splice(0, this.absorptions.length - 64);
  }

  update(cells, elapsed) {
    const dt = clamp(elapsed, 0, .05);
    this.time += dt;
    const live = new Set();
    for (const { c } of cells) {
      live.add(c.id);
      let body = this.bodies.get(c.id);
      if (!body) {
        body = { x: c.x, y: c.y, r: radius(c.mass),
          offset: new Float64Array(POINTS), velocity: new Float64Array(POINTS),
          target: new Float64Array(POINTS), contacts: [], points: [] };
        this.bodies.set(c.id, body);
      }
      if (dt > 0) {
        body.r += (radius(c.mass) - body.r) * (1 - Math.exp(-dt * 11));
      }
      if (this.reducedMotion) body.r = radius(c.mass);
      body.x = c.x; body.y = c.y; body.contacts.length = 0;
    }
    for (const id of this.bodies.keys()) if (!live.has(id)) this.bodies.delete(id);

    // Find each contact once; perimeter springs reuse these directional pressures.
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i].c, ra = radius(a.mass), bodyA = this.bodies.get(a.id);
      for (let j = i + 1; j < cells.length; j++) {
        if (cells[i].h.id === cells[j].h.id) continue;
        const b = cells[j].c, rb = radius(b.mass);
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        const overlap = ra + rb - d;
        if (overlap <= 0 || d < Math.max(ra, rb) * .22) continue;
        const angle = Math.atan2(dy, dx);
        bodyA.contacts.push({ angle, depth: Math.min(.23, overlap / ra * rb / (ra + rb)) });
        this.bodies.get(b.id).contacts.push({ angle: angle + Math.PI, depth: Math.min(.23, overlap / rb * ra / (ra + rb)) });
      }
    }

    for (const { c } of cells) {
      const body = this.bodies.get(c.id);
      for (let i = 0; i < POINTS; i++) {
        const angle = directions[i].angle;
        let target = 0;
        for (const contact of body.contacts) {
          const toward = Math.cos(angle - contact.angle);
          // Flatten the contact patch and displace volume into the shoulders.
          target += contact.depth * (.28 * Math.pow(Math.sin(angle - contact.angle), 2) - Math.pow(Math.max(0, toward), 8));
        }
        body.target[i] = clamp(target, -.26, .17);
      }
      if (this.reducedMotion) body.offset.set(body.target);
      else if (!body.contacts.length) {
        // Once contact ends, return directly to a circle without spring recoil.
        if (dt > 0) {
          body.velocity.fill(0);
          const decay = Math.exp(-dt * 28);
          for (let i = 0; i < POINTS; i++) {
            const value = body.offset[i] * decay;
            body.offset[i] = Math.abs(value) < .00025 ? 0 : value;
          }
        }
      }
      else {
        const steps = Math.max(1, Math.ceil(dt * 120)), step = dt / steps;
        for (let s = 0; s < steps; s++) {
          for (let i = 0; i < POINTS; i++) {
            const adjacent = body.offset[(i + POINTS - 1) % POINTS] + body.offset[(i + 1) % POINTS] - 2 * body.offset[i];
            body.velocity[i] += ((body.target[i] - body.offset[i]) * 115 + adjacent * 22 - body.velocity[i] * 12) * step;
          }
          for (let i = 0; i < POINTS; i++) body.offset[i] = clamp(body.offset[i] + body.velocity[i] * step, -.3, .24);
        }
      }
      // Keep the apparent area steady while the membrane flexes.
      const areaScale = Math.sqrt(POINTS / body.offset.reduce((sum, value) => sum + (1 + value) ** 2, 0));
      body.points = directions.map((dir, i) => {
        const r = body.r * (1 + body.offset[i]) * areaScale;
        return { x: c.x + dir.x * r, y: c.y + dir.y * r };
      });
      body.round = body.offset.every(value => value === 0);
    }
    for (const effect of this.absorptions) {
      const eater = this.bodies.get(effect.eaterId);
      if (eater) { effect.eaterX = eater.x; effect.eaterY = eater.y; }
      effect.age += dt;
    }
    this.absorptions = this.absorptions.filter(effect => effect.age < effect.duration);
  }

  get(id) { return this.bodies.get(id); }

  drawAbsorptions(ctx, zoom) {
    for (const effect of this.absorptions) {
      const body = this.bodies.get(effect.eaterId);
      const destination = body || { x: effect.eaterX, y: effect.eaterY };
      const p = effect.age / effect.duration, pull = p * p * (2 - p);
      const x = effect.x + (destination.x - effect.x) * pull;
      const y = effect.y + (destination.y - effect.y) * pull;
      const angle = Math.atan2(destination.y - effect.y, destination.x - effect.x);
      const stretch = Math.sin(Math.PI * p), r = radius(effect.mass) * Math.pow(1 - p, .85);
      const points = directions.map(dir => {
        // A narrowing teardrop: the leading edge reaches toward the eater first.
        const u = dir.x * r * (1 + stretch * .72) + Math.max(0, dir.x) ** 4 * r * stretch * .48;
        const v = dir.y * r * (1 - stretch * .62);
        return { x: x + u * Math.cos(angle) - v * Math.sin(angle), y: y + u * Math.sin(angle) + v * Math.cos(angle) };
      });
      paintBubble(ctx, { x, y, r, points }, effect.color, zoom, {
        player: effect.isPlayer, highlight: effect.highlight || effect.color,
        opacity: Math.min(1, (1 - p) * 2.6),
      });
    }
  }
}

export function traceBubble(ctx, body, padding = 0) {
  ctx.beginPath();
  if (body.round) {
    ctx.arc(body.x, body.y, Math.max(0, body.r + padding), 0, TAU);
    ctx.closePath();
    return;
  }
  const points = body.points;
  const scale = 1 + padding / Math.max(body.r, 1);
  const at = i => ({ x: body.x + (points[i].x - body.x) * scale, y: body.y + (points[i].y - body.y) * scale });
  const first = at(0), last = at(points.length - 1);
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < points.length; i++) {
    const current = at(i), next = at((i + 1) % points.length);
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  ctx.closePath();
}

function membraneStroke(ctx) {
  ctx.setLineDash([]);ctx.lineDashOffset = 0;
  ctx.lineCap = 'round';ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;ctx.shadowOffsetX = 0;ctx.shadowOffsetY = 0;
  ctx.shadowColor = 'transparent';ctx.filter = 'none';
}

// Draw all shadows before any bubble fills so their depth stays beneath neighbors.
export function paintBubbleShadow(ctx, body, zoom) {
  if (body.r < .1 || !body.points.length) return;
  ctx.save();ctx.globalCompositeOperation = 'source-over';
  membraneStroke(ctx);
  traceBubble(ctx, body);
  ctx.strokeStyle = '#01040924';ctx.lineWidth = 10 / zoom;ctx.stroke();
  ctx.strokeStyle = '#01040968';ctx.lineWidth = 4 / zoom;ctx.stroke();
  ctx.fillStyle = '#010409b0';ctx.fill();
  ctx.restore();
}

export function paintBubble(ctx, body, color, zoom, { player = false, opacity = 1, highlight = player ? '#eaf7ff' : color } = {}) {
  const { r, points } = body;
  if (r < .1 || !points.length) return;
  ctx.save();ctx.globalAlpha *= opacity;ctx.globalCompositeOperation = 'source-over';
  membraneStroke(ctx);
  // A narrow luminous membrane casts a smooth bloom instead of stacked hard bands.
  // Canvas shadow blur uses raster pixels, so compensate for DPR without changing
  // its on-screen width as the world camera zooms. No full-canvas blur is needed.
  const transform = ctx.getTransform();
  const rasterScale = Math.hypot(transform.a, transform.b) / zoom;
  traceBubble(ctx, body);
  ctx.shadowColor = highlight + 'c0';ctx.shadowBlur = 12 * rasterScale;
  ctx.strokeStyle = highlight + 'd0';ctx.lineWidth = 3.6 / zoom;ctx.stroke();
  // The opaque surface hides the inward bloom and remains entirely unshaded.
  ctx.shadowBlur = 0;ctx.shadowColor = 'transparent';
  traceBubble(ctx, body);
  ctx.fillStyle = color;ctx.fill();
  ctx.restore();
}
