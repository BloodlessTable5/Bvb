// A cosmetic, deterministic map. None of its sizes, links, or coins enter arena physics.
const TAU = Math.PI * 2;
const TOTAL_COINS = 1_000_000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function seededRandom(seed) {
  let state = 2166136261;
  for (const character of String(seed ?? 'guest')) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function bounds(nodes, dx = 0, dy = 0) {
  return nodes.reduce((box, node) => ({
    left: Math.min(box.left, node.x + dx - node.r), right: Math.max(box.right, node.x + dx + node.r),
    top: Math.min(box.top, node.y + dy - node.r), bottom: Math.max(box.bottom, node.y + dy + node.r),
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
}

function divideBudget(total, count, random) {
  const sizes = Array(count).fill(2), extras = total - count * 2;
  const weights = sizes.map(() => .72 + random() * .65);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const fractions = weights.map((weight, index) => {
    const share = extras * weight / weightTotal, whole = Math.floor(share);
    sizes[index] += whole;
    return { index, fraction: share - whole };
  }).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const unallocated = total - sizes.reduce((sum, size) => sum + size, 0);
  for (let i = 0; i < unallocated; i++) sizes[fractions[i].index]++;
  return sizes;
}

function planBranch(budget, depth, random) {
  if (budget <= 5 || depth >= 3 || (depth === 0 && budget < 12)) return { size: budget, budget, depth, children: [] };
  let size, childCount;
  if (depth === 0) {
    size = Math.round(budget * ((budget >= 75 ? .285 : budget >= 35 ? .34 : .46) + (random() - .5) * .04));
    childCount = budget >= 35 ? 3 : 2;
  } else if (depth === 1) {
    size = Math.ceil(budget * (budget >= 18 ? .55 : .62));
    childCount = budget - size >= 10 ? 2 : 1;
  } else {
    size = budget - Math.min(2 + Math.floor(random() * 2), Math.floor((budget - 1) / 2)); childCount = 1;
  }
  size = Math.max(size, childCount * 2);
  const remaining = budget - size;
  if (remaining < childCount * 2) return { size: budget, budget, depth, children: [] };
  return { size, budget, depth, children: divideBudget(remaining, childCount, random).map(value => planBranch(value, depth + 1, random)) };
}

function buildGroup(size, groupId, mainRadius, offshoot, random) {
  const nodes = [], links = [], keys = new Set(), phase = random() * TAU;
  const addLink = (a, b, quiet = false) => {
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (a === b || keys.has(key)) return;
    keys.add(key); links.push({ a, b, ...(quiet ? { quiet: true } : {}) });
  };
  nodes.push({ x: 0, y: 0, r: mainRadius, hub: true, group: groupId, phase, depth: 0, parentIndex: null });
  const anchorCount = size < 6 ? 0 : Math.min(4, Math.max(1, Math.floor(size / 9)));
  const startAngle = random() * TAU;
  for (let index = 1; index < size; index++) {
    const subhub = index <= anchorCount;
    const radius = subhub ? mainRadius * (.32 + random() * .1) : Math.max(3.2, mainRadius * (.13 + random() * .09));
    let parentIndex = 0;
    if (!subhub && anchorCount && random() < .73) parentIndex = 1 + Math.floor(random() * anchorCount);
    else if (!subhub && index > 3 && random() < .6) {
      const candidates = nodes.map((node, i) => ({ node, i })).filter(({ node }) => node.depth < 4);
      parentIndex = candidates[Math.floor(random() * candidates.length)].i;
    }
    const parent = nodes[parentIndex];
    const direction = subhub ? startAngle + (index - 1) * TAU / Math.max(2, anchorCount) : Math.atan2(parent.y, parent.x);
    let best = null;
    // Grow short branches from secondary anchors instead of making every node a hub spoke.
    for (let attempt = 0; attempt < 80; attempt++) {
      const angle = direction + (random() - .5) * (subhub ? 1 : 4.5);
      const reach = parent.r + radius + 7 + random() * 13 + Math.floor(attempt / 20) * 9;
      const candidate = { x: parent.x + Math.cos(angle) * reach, y: parent.y + Math.sin(angle) * reach };
      if (nodes.some(node => Math.hypot(node.x - candidate.x, node.y - candidate.y) < node.r + radius + 6)) continue;
      const score = Math.hypot(candidate.x, candidate.y) + reach * .32 + random() * 8;
      if (!best || score < best.score) best = { ...candidate, score };
    }
    if (!best) {
      const box = bounds(nodes);
      best = { x: box.right + radius + 8, y: parent.y };
    }
    nodes.push({ x: best.x, y: best.y, r: radius, group: groupId, hub: false,
      ...(subhub ? { subhub: true } : {}), phase, depth: parent.depth + 1, parentIndex });
    addLink(parentIndex, index);
  }
  // Nearby lateral connections make the branches read as a network.
  for (let i = 1; i < nodes.length; i++) {
    if (random() > .62) continue;
    const node = nodes[i];
    const nearest = nodes.map((other, j) => ({ j, gap: Math.hypot(node.x - other.x, node.y - other.y) - node.r - other.r }))
      .filter(({ j, gap }) => j !== i && gap < 52 && !keys.has(`${Math.min(i, j)}:${Math.max(i, j)}`))
      .sort((a, b) => a.gap - b.gap || a.j - b.j)[0];
    if (nearest) addLink(i, nearest.j, true);
  }
  return { nodes, links, offshoot, extent: Math.max(...nodes.map(node => Math.hypot(node.x, node.y) + node.r)) };
}

function placeGroup(local, parent, preferredAngle, placedNodes, random) {
  if (!parent) return { x: 0, y: 0 };
  let best = null;
  const oldBounds = bounds(placedNodes), parentDistance = Math.hypot(parent.x, parent.y);
  for (let attempt = 0; attempt < 240; attempt++) {
    const angle = preferredAngle + (random() - .5) * (local.offshoot ? 1.7 : .95);
    const reach = parent.extent * .68 + local.extent * .84 + 20 + random() * 50 + Math.floor(attempt / 80) * 20;
    const x = parent.x + Math.cos(angle) * reach, y = parent.y + Math.sin(angle) * reach;
    if (Math.hypot(x, y) < parentDistance + Math.max(25, parent.extent * (local.offshoot ? .68 : .4))) continue;
    if (local.nodes.some(node => placedNodes.some(other => Math.hypot(node.x + x - other.x, node.y + y - other.y) < node.r + other.r + 20))) continue;
    const nextBounds = bounds(local.nodes, x, y);
    const width = 2 * Math.max(Math.abs(oldBounds.left), Math.abs(oldBounds.right), Math.abs(nextBounds.left), Math.abs(nextBounds.right));
    const height = 2 * Math.max(Math.abs(oldBounds.top), Math.abs(oldBounds.bottom), Math.abs(nextBounds.top), Math.abs(nextBounds.bottom));
    const score = width * height + (width - height * 1.35) ** 2 * .24 + reach * 55;
    if (!best || score < best.score) best = { x, y, score };
  }
  if (best) return best;
  // A finite radial fallback always clears the entire existing map.
  const radius = Math.max(...placedNodes.map(node => Math.hypot(node.x, node.y) + node.r)) + local.extent + 20;
  return { x: Math.cos(preferredAngle) * radius, y: Math.sin(preferredAngle) * radius };
}

function clearRoute(nodes, a, b) {
  const start = nodes[a], end = nodes[b], dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  return nodes.every((node, index) => {
    if (index === a || index === b) return true;
    const progress = clamp(((node.x - start.x) * dx + (node.y - start.y) * dy) / lengthSquared, 0, 1);
    return Math.hypot(node.x - start.x - dx * progress, node.y - start.y - dy * progress) >= node.r + 4;
  });
}

function allocateCoins(nodes) {
  const totalArea = nodes.reduce((sum, node) => sum + node.r ** 2, 0);
  const remainders = nodes.map(node => {
    const quota = TOTAL_COINS * node.r ** 2 / totalArea;
    node.coins = Math.floor(quota);
    return { node, fraction: quota - node.coins };
  }).sort((a, b) => b.fraction - a.fraction || a.node.id - b.node.id);
  const remainder = TOTAL_COINS - nodes.reduce((sum, node) => sum + node.coins, 0);
  for (let i = 0; i < remainder; i++) remainders[i].node.coins++;
}

export function buildConstellation(seed, growth = {}) {
  const count = clamp(Number.isFinite(growth?.nodes) ? Math.floor(growth.nodes) : 1, 1, 180);
  const random = seededRandom(seed), plan = planBranch(count, 0, random);
  const nodes = [], links = [], groups = [], keys = new Set(), connectedGroupPairs = new Set();
  const addLink = (a, b, options = {}) => {
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (a === b || keys.has(key)) return false;
    keys.add(key); links.push({ a, b, ...options }); return true;
  };
  const growBranch = (branch, parent, preferredAngle, radius) => {
    const groupId = groups.length, offshoot = branch.depth > 0 && branch.size <= 3;
    const local = buildGroup(branch.size, groupId, radius, offshoot, random);
    let meanRadius = local.nodes.reduce((sum, node) => sum + node.r, 0) / local.nodes.length;
    if (parent && meanRadius > parent.meanRadius * .9) {
      const shrink = parent.meanRadius * .9 / meanRadius;
      for (const node of local.nodes) node.r *= shrink;
      meanRadius *= shrink;
      local.extent = Math.max(...local.nodes.map(node => Math.hypot(node.x, node.y) + node.r));
    }
    const placement = placeGroup(local, parent, preferredAngle, nodes, random), offset = nodes.length;
    nodes.push(...local.nodes.map((node, i) => {
      const { parentIndex, depth, ...shape } = node;
      return { ...shape, id: offset + i + 1, x: node.x + placement.x, y: node.y + placement.y,
        parentId: i === 0 ? parent?.hubId ?? null : offset + parentIndex + 1,
        depth: (parent?.hubDepth ?? -1) + 1 + depth, tier: branch.depth, subtreeSize: 1 };
    }));
    for (const link of local.links) addLink(link.a + offset, link.b + offset, link.quiet ? { quiet: true } : {});
    groups.push({ id: groupId, hubId: offset + 1, parentGroupId: parent?.groupId ?? null, parentId: parent?.groupId ?? null,
      depth: branch.depth, subtreeSize: branch.budget, memberIds: local.nodes.map((_, i) => offset + i + 1), ...(offshoot ? { offshoot: true } : {}) });
    if (parent) {
      addLink(parent.hubId - 1, offset, { bridge: true, hierarchy: true });
      connectedGroupPairs.add(`${parent.groupId}:${groupId}`);
    }
    const nextParent = { x: placement.x, y: placement.y, extent: local.extent, hubId: offset + 1, hubDepth: nodes[offset].depth, groupId, meanRadius };
    const childCount = branch.children.length;
    const rotation = branch.depth === 0 ? random() * TAU : preferredAngle + (random() - .5) * .5;
    branch.children.forEach((child, index) => {
      const angle = branch.depth === 0 ? rotation + index * TAU / childCount + (random() - .5) * .38
        : rotation + (index - (childCount - 1) / 2) * .9 + (random() - .5) * .35;
      growBranch(child, nextParent, angle, local.nodes[0].r * (.51 + random() * .055));
    });
  };
  growBranch(plan, null, 0, count === 1 ? 43 : 43 + (Math.sqrt(count) - 1) * 1.6);

  // The parent tree is always connected. Sparse sideways routes add organic local meshes.
  const pairs = [];
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    if (nodes[a].group === nodes[b].group) continue;
    pairs.push({ a, b, gap: Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) - nodes[a].r - nodes[b].r });
  }
  pairs.sort((a, b) => a.gap - b.gap || a.a - b.a || a.b - b.b);
  const groupPairKey = pair => `${Math.min(nodes[pair.a].group, nodes[pair.b].group)}:${Math.max(nodes[pair.a].group, nodes[pair.b].group)}`;
  // A few secondary member-to-member routes interrupt the tree silhouette.
  const extras = Math.max(1, Math.floor(groups.length * .6));
  let added = 0;
  const crossDegrees = new Map(), extraGroupPairs = new Set();
  const routes = pairs.filter(pair => pair.gap <= 240 && !nodes[pair.a].hub && !nodes[pair.b].hub)
    .map(pair => ({ ...pair, score: Math.abs(pair.gap - (100 + random() * 60)) + pair.gap * .1 }))
    .sort((a, b) => a.score - b.score || a.a - b.a || a.b - b.b);
  for (const allowExistingPair of [false, true]) {
    for (const pair of routes) {
      if (added >= extras) break;
      const groupPair = groupPairKey(pair);
      if ((!allowExistingPair && connectedGroupPairs.has(groupPair)) || extraGroupPairs.has(groupPair)
        || crossDegrees.has(pair.a) || crossDegrees.has(pair.b) || !clearRoute(nodes, pair.a, pair.b)) continue;
      if (addLink(pair.a, pair.b, { bridge: true, quiet: true })) {
        crossDegrees.set(pair.a, 1); crossDegrees.set(pair.b, 1); extraGroupPairs.add(groupPair); added++;
      }
    }
  }
  for (let index = nodes.length - 1; index > 0; index--) nodes[nodes[index].parentId - 1].subtreeSize += nodes[index].subtreeSize;
  const box = bounds(nodes);
  allocateCoins(nodes);
  return { nodes, links, groups, rootId: 1, width: Math.max(110, 2 * Math.max(-box.left, box.right) + 20),
    height: Math.max(110, 2 * Math.max(-box.top, box.bottom) + 20), totalCoins: TOTAL_COINS };
}

export function findConstellationNode(graph, x, y, padding = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const margin = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  let direct = null, nearby = null, directDistance = Infinity, nearbyDistance = Infinity;
  for (const node of graph?.nodes || []) {
    if (![node.x, node.y, node.r].every(Number.isFinite) || node.r < 0) continue;
    const distance = Math.hypot(x - node.x, y - node.y);
    if (distance <= node.r && distance < directDistance) { direct = node; directDistance = distance; }
    else if (distance <= node.r + margin && distance < nearbyDistance) { nearby = node; nearbyDistance = distance; }
  }
  return direct || nearby;
}
