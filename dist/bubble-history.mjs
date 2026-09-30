// Personal-map appearance only. Dates never affect arena strength or rewards.
export const BUBBLE_TINT_DURATION_MS = 24 * 60 * 60 * 1000;

export function bubbleAgeMs(createdAt, now) {
  if (!Number.isFinite(createdAt) || createdAt < 0 || createdAt > 8.64e15 || !Number.isFinite(now)) return null;
  return Math.max(0, now - createdAt);
}

export function bubbleAgeColor(color, ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs >= BUBBLE_TINT_DURATION_MS) return color;
  const progress = Math.max(0, ageMs) / BUBBLE_TINT_DURATION_MS;
  const fresh = .68 * (1 - progress) ** 1.35;
  const accent = [137, 217, 255];
  const channels = [1, 3, 5].map((offset, index) => {
    const base = parseInt(color.slice(offset, offset + 2), 16);
    return Math.round(base + (accent[index] - base) * fresh).toString(16).padStart(2, '0');
  });
  return '#' + channels.join('');
}

export function previewBubbleAgeMs(id, count, previewSeconds) {
  // Invert the cosmetic growth curve: older milestones belong to lower IDs.
  const fraction = Math.max(0, Math.min(1, (id - 1) / Math.max(1, count - 1)));
  return Math.max(0, previewSeconds) * 1000 * (1 - fraction ** (1 / .65));
}

export function bubbleAgeLabel(ageMs) {
  if (ageMs == null) return 'Age unknown';
  const minutes = Math.floor(Math.max(0, ageMs) / 60000);
  if (minutes < 1) return 'Just created';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''} old`;
  return `${Math.floor(hours / 24)}d old`;
}
