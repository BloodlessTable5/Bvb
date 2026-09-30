const MINOR_STEP = 40;
const MAJOR_STEP = 200;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Draw a stationary orientation grid after applying the camera transform.
 * Bounds and width/height are world units; zoom is screen pixels per world unit.
 * Example: drawArenaBackground(ctx, { zoom, minX, maxX, minY, maxY,
 *   width: WORLD.width, height: WORLD.height });
 * The caller supplies the dark base fill and draws its world border afterward.
 */
export function drawArenaBackground(ctx, { zoom, minX, maxX, minY, maxY, width, height }) {
  if (!Number.isFinite(zoom) || zoom <= 0) return;
  const left = clamp(minX, 0, width), right = clamp(maxX, 0, width);
  const top = clamp(minY, 0, height), bottom = clamp(maxY, 0, height);
  if (right <= left || bottom <= top) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.lineWidth = 1 / zoom;

  // The fine lattice fades before it becomes dense at a distant camera scale.
  const fineOpacity = .045 * clamp((zoom - .28) / .36, 0, 1);
  if (fineOpacity > 0) {
    ctx.beginPath();
    for (let x = Math.ceil(left / MINOR_STEP) * MINOR_STEP; x <= right; x += MINOR_STEP) {
      if (x % MAJOR_STEP === 0) continue;
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let y = Math.ceil(top / MINOR_STEP) * MINOR_STEP; y <= bottom; y += MINOR_STEP) {
      if (y % MAJOR_STEP === 0) continue;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.strokeStyle = `rgba(78, 153, 183, ${fineOpacity})`;
    ctx.stroke();
  }

  const firstX = Math.ceil(left / MAJOR_STEP) * MAJOR_STEP;
  const firstY = Math.ceil(top / MAJOR_STEP) * MAJOR_STEP;
  ctx.beginPath();
  for (let x = firstX; x <= right; x += MAJOR_STEP) {
    ctx.moveTo(x, top); ctx.lineTo(x, bottom);
  }
  for (let y = firstY; y <= bottom; y += MAJOR_STEP) {
    ctx.moveTo(left, y); ctx.lineTo(right, y);
  }
  ctx.strokeStyle = 'rgba(78, 153, 183, .08)';
  ctx.stroke();

  // Small survey marks keep the grid legible without bright full-length lines.
  const arm = 2.5 / zoom;
  ctx.beginPath();
  for (let x = firstX; x <= right; x += MAJOR_STEP) {
    for (let y = firstY; y <= bottom; y += MAJOR_STEP) {
      ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
    }
  }
  ctx.strokeStyle = 'rgba(105, 191, 217, .16)';
  ctx.stroke();

  // Stable sector names remain attached to the same world regions at every zoom.
  const labelStep = zoom < .4 ? 800 : 400;
  ctx.font = `${9 / zoom}px ui-monospace, SFMono-Regular, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(112, 161, 186, .21)';
  for (let x = Math.floor(left / labelStep) * labelStep; x < right; x += labelStep) {
    for (let y = Math.floor(top / labelStep) * labelStep; y < bottom; y += labelStep) {
      const labelX = x + 9 / zoom, labelY = y + 9 / zoom;
      if (labelX > right || labelY > bottom || labelX + 30 / zoom < left || labelY + 10 / zoom < top) continue;
      const column = String.fromCharCode(65 + Math.floor(x / 400));
      const row = String(Math.floor(y / 400) + 1).padStart(2, '0');
      ctx.fillText(`${column} / ${row}`, labelX, labelY);
    }
  }
  ctx.restore();
}
