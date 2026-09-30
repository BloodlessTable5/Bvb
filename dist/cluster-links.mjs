import { radius } from './engine.mjs';
import { updateClusterNetwork } from './clusters.mjs';

export const HUB_TRANSFER_DURATION = .35;
const TAU = Math.PI * 2;
const LINK_STYLES = {
  neighbor: { width: .55, halo: 2.5, alpha: '28', glow: '08' },
  spoke: { width: .8, halo: 3, alpha: '65', glow: '12' },
  bridge: { width: 1.1, halo: 4, alpha: '98', glow: '20' },
  secondary: { width: 1.35, halo: 4.5, alpha: 'b0', glow: '28' },
  offshoot: { width: 1, halo: 3.5, alpha: 'a0', glow: '20' },
};

function lineState(ctx) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([]);ctx.lineDashOffset = 0;ctx.lineCap = 'round';ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;ctx.shadowOffsetX = 0;ctx.shadowOffsetY = 0;
  ctx.shadowColor = 'transparent';ctx.filter = 'none';
}

function edgeSegment(a, b, zoom) {
  const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
  const from = a.r + 4 / zoom, to = b.r + 4 / zoom;
  if (!Number.isFinite(distance) || distance <= from + to) return null;
  const nx = dx / distance, ny = dy / distance;
  return { x1: a.x + nx * from, y1: a.y + ny * from,
    x2: b.x - nx * to, y2: b.y - ny * to, nx, ny };
}

function outside(segment, bounds, padding) {
  return bounds && (Math.max(segment.x1, segment.x2) + padding < bounds.minX ||
    Math.min(segment.x1, segment.x2) - padding > bounds.maxX ||
    Math.max(segment.y1, segment.y2) + padding < bounds.minY ||
    Math.min(segment.y1, segment.y2) - padding > bounds.maxY);
}

// Membership is cached by clusters.mjs; endpoints always use the current bodies.
export function drawClusterLinks(ctx, holders, visuals, zoom, bounds) {
  if (!Number.isFinite(zoom) || zoom <= 0) return;
  ctx.save();lineState(ctx);
  for (const holder of holders) {
    if (holder.cells.length < 2) continue;
    const network = updateClusterNetwork(holder);
    const live = new Map(holder.cells.map(cell => [cell.id, cell]));
    // Quiet cross-links sit below the hub spokes and inter-group bridges.
    for (const kind of ['neighbor', 'spoke', 'bridge']) for (const link of network.links) {
      if (link.kind !== kind || link.aId === link.bId) continue;
      const a = live.get(link.aId), b = live.get(link.bId);
      if (!a || !b) continue;
      const bodyA = visuals?.get(a.id) || { x: a.x, y: a.y, r: radius(a.mass) };
      const bodyB = visuals?.get(b.id) || { x: b.x, y: b.y, r: radius(b.mass) };
      const segment = edgeSegment(bodyA, bodyB, zoom);
      if (!segment || outside(segment, bounds, 3 / zoom)) continue;
      const style = LINK_STYLES[link.secondary ? 'secondary' : link.offshoot ? 'offshoot' : kind];
      ctx.beginPath();ctx.moveTo(segment.x1, segment.y1);ctx.lineTo(segment.x2, segment.y2);
      ctx.strokeStyle = holder.color + style.glow;ctx.lineWidth = style.halo / zoom;ctx.stroke();
      ctx.strokeStyle = holder.color + style.alpha;ctx.lineWidth = style.width / zoom;ctx.stroke();
    }
  }
  ctx.restore();
}

export class ClusterTransfers {
  constructor({ reducedMotion = false } = {}) { this.reducedMotion = reducedMotion;this.reset(); }

  reset() { this.transfers = []; }

  add(event, highlight) {
    if (this.reducedMotion || event.type !== 'hub-feed' || event.fromId === event.toId ||
      !(event.mass > 0) || ![event.mass, event.x, event.y, event.toX, event.toY].every(Number.isFinite)) return;
    this.transfers.push({ fromId: event.fromId, toId: event.toId,
      x: event.x, y: event.y, toX: event.toX, toY: event.toY,
      mass: event.mass, color: event.isPlayer && highlight ? highlight : event.color,
      fromRadius: 0, toRadius: 0, age: 0, duration: HUB_TRANSFER_DURATION });
    if (this.transfers.length > 32) this.transfers.splice(0, this.transfers.length - 32);
  }

  update(cells, elapsed) {
    const dt = Math.max(0, Math.min(elapsed, .05));
    if (!dt) return;
    const live = new Map(cells.map(({ c }) => [c.id, c]));
    this.transfers = this.transfers.filter(transfer => {
      const from = live.get(transfer.fromId), to = live.get(transfer.toId);
      if (!from || !to) return false;
      transfer.age += dt;
      if (transfer.age >= transfer.duration) return false;
      transfer.x = from.x;transfer.y = from.y;transfer.fromRadius = radius(from.mass);
      transfer.toX = to.x;transfer.toY = to.y;transfer.toRadius = radius(to.mass);
      return true;
    });
  }

  draw(ctx, zoom) {
    if (!Number.isFinite(zoom) || zoom <= 0 || !this.transfers.length) return;
    ctx.save();lineState(ctx);
    const opacity = ctx.globalAlpha;
    for (const transfer of this.transfers) {
      const segment = edgeSegment({ x: transfer.x, y: transfer.y, r: transfer.fromRadius },
        { x: transfer.toX, y: transfer.toY, r: transfer.toRadius }, zoom);
      if (!segment) continue;
      const p = transfer.age / transfer.duration, progress = p * p * (3 - 2 * p);
      const x = segment.x1 + (segment.x2 - segment.x1) * progress;
      const y = segment.y1 + (segment.y2 - segment.y1) * progress;
      const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
      const tail = Math.min(5 / zoom, length * .2, length * progress);
      ctx.globalAlpha = opacity * Math.sin(Math.PI * p) * .8;
      ctx.beginPath();ctx.moveTo(x - segment.nx * tail, y - segment.ny * tail);ctx.lineTo(x, y);
      ctx.strokeStyle = transfer.color + '22';ctx.lineWidth = 3.5 / zoom;ctx.stroke();
      ctx.strokeStyle = transfer.color + 'b0';ctx.lineWidth = 1.2 / zoom;ctx.stroke();
      ctx.beginPath();ctx.arc(x, y, 1.3 / zoom, 0, TAU);
      ctx.fillStyle = transfer.color + 'cc';ctx.fill();
    }
    ctx.restore();
  }
}
