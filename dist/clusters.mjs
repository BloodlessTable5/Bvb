export const HUB_FEED_SHARE = .30;
export const HUB_MASS_CAP = .45;

const networks = new WeakMap();
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const finiteMass = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const liveCells = holder => [...new Map((holder.cells || [])
  .filter(c => Number.isFinite(c.id) && Number.isFinite(c.x) && Number.isFinite(c.y))
  .map(c => [c.id, c])).values()].sort((a, b) => a.id - b.id);

function holderSeed(holder, cells) {
  const identity = holder.wallet || (holder.id ?? cells.map(c => c.id).join(','));
  let seed = 2166136261;
  for (const character of String(identity)) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return seed >>> 0;
}

function seededFraction(seed, salt) {
  let value = seed ^ salt;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function groupCapacities(cellCount, seed) {
  // Normal split counts (8 and 16) always expose a small branch. A third
  // group starts at 11 so keeping that branch never creates an oversized core.
  const offshoot = cellCount >= 8;
  if (offshoot) {
    const small = cellCount === 10 ? 3 : seededFraction(seed, 0x8e6c3921) < .5 ? 2 : 3;
    const remaining = cellCount - small, cores = Math.ceil(remaining / 7);
    const base = Math.floor(remaining / cores), extra = remaining % cores;
    return { sizes: [...Array.from({ length: cores }, (_, i) => base + (i < extra ? 1 : 0)), small], offshoot };
  }
  const groupCount = Math.ceil(cellCount / 6);
  const base = Math.floor(cellCount / groupCount), remainder = cellCount % groupCount;
  const offset = Math.floor(seededFraction(seed, 0x6c72de19) * groupCount);
  return { sizes: Array.from({ length: groupCount }, (_, i) => base + ((i + offset) % groupCount < remainder ? 1 : 0)), offshoot };
}

function secondaryBridge(a, b, byId, allCells, seed, salt) {
  const candidates = [];
  for (const aId of a.memberIds) if (aId !== a.hubId) {
    for (const bId of b.memberIds) if (bId !== b.hubId) {
      const from = byId.get(aId), to = byId.get(bId), length = Math.sqrt(distanceSquared(from, to));
      const dx = to.x - from.x, dy = to.y - from.y, squared = Math.max(1, length * length);
      let occlusions = 0;
      for (const cell of allCells) if (cell.id !== aId && cell.id !== bId) {
        const t = ((cell.x - from.x) * dx + (cell.y - from.y) * dy) / squared;
        if (t <= 0 || t >= 1) continue;
        const clearance = 2.1 * Math.sqrt(finiteMass(cell.mass)) + 6;
        if (Math.hypot(cell.x - from.x - t * dx, cell.y - from.y - t * dy) < clearance) occlusions++;
      }
      candidates.push({ aId, bId, score: length + occlusions * 120 });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.aId - b.aId || a.bId - b.bId);
  // Choose among similarly short, unobstructed routes. Seeded variation is
  // resolved only during membership changes, never rerolled while moving.
  const shortlist = candidates.filter(candidate => candidate.score <= candidates[0].score + 65).slice(0, 3);
  return shortlist[Math.floor(seededFraction(seed, salt) * shortlist.length)];
}

function centralCell(cells) {
  let weight = 0, x = 0, y = 0;
  const largest = Math.max(1, ...cells.map(c => finiteMass(c.mass)));
  for (const c of cells) {
    const w = Math.sqrt(Math.max(1, finiteMass(c.mass)));
    weight += w; x += c.x * w; y += c.y * w;
  }
  const center = { x: x / weight, y: y / weight };
  return cells.reduce((best, c) => {
    const score = distanceSquared(c, center) / (1 + finiteMass(c.mass) / largest);
    const previous = distanceSquared(best, center) / (1 + finiteMass(best.mass) / largest);
    return score < previous || (score === previous && (c.mass > best.mass || (c.mass === best.mass && c.id < best.id))) ? c : best;
  });
}

function spanningTree(cells, add, kind) {
  if (cells.length < 2) return;
  const connected = new Set([cells[0].id]);
  while (connected.size < cells.length) {
    let best = null;
    for (const a of cells) if (connected.has(a.id)) {
      for (const b of cells) if (!connected.has(b.id)) {
        const distance = distanceSquared(a, b);
        if (!best || distance < best.distance || (distance === best.distance && (a.id < best.a.id || (a.id === best.a.id && b.id < best.b.id)))) best = { a, b, distance };
      }
    }
    connected.add(best.b.id); add(best.a.id, best.b.id, kind);
  }
}

function balancedGroups(cells, hubs, capacities) {
  const groups = hubs.map((hub, index) => ({ hub, cells: [hub], capacity: capacities[index] }));
  const hubIds = new Set(hubs.map(hub => hub.id));
  const candidates = cells.filter(c => !hubIds.has(c.id)).map(c => {
    const choices = groups.map((group, index) => ({ index, distance: distanceSquared(c, group.hub) }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index);
    // Assign clear spatial preferences first, leaving ambiguous boundary cells
    // to fill the balanced capacities instead of displacing a distant branch.
    return { c, choices, preference: choices.length > 1 ? choices[1].distance - choices[0].distance : 0 };
  }).sort((a, b) => b.preference - a.preference || a.choices[0].distance - b.choices[0].distance || a.c.id - b.c.id);
  for (const { c, choices } of candidates) {
    // Coincident split starts have no spatial preference. Distribute those
    // ties proportionally instead of filling a whole core from consecutive IDs.
    const destination = choices.filter(({ index }) => groups[index].cells.length < groups[index].capacity)
      .sort((a, b) => a.distance - b.distance || groups[a.index].cells.length / groups[a.index].capacity -
        groups[b.index].cells.length / groups[b.index].capacity || a.index - b.index)[0];
    groups[destination.index].cells.push(c);
  }
  return groups;
}

/** Stable holder-owned topology, rebuilt only when live cell IDs change. */
export function updateClusterNetwork(holder) {
  const cells = liveCells(holder), signature = cells.map(c => c.id).join(',');
  const previous = networks.get(holder);
  if (previous?.signature === signature) return previous.network;
  const seed = previous?.seed ?? holderSeed(holder, cells);
  const network = { groups: [], links: [], hubByCell: new Map() };
  const pairs = new Set();
  const add = (a, b, kind, details = {}) => {
    if (a === b) return;
    const aId = Math.min(a, b), bId = Math.max(a, b), pair = `${aId}:${bId}`;
    if (pairs.has(pair)) return;
    pairs.add(pair); network.links.push({ aId, bId, kind, ...details });
  };
  if (cells.length < 4) spanningTree(cells, add, 'neighbor');
  else {
    const byId = new Map(cells.map(c => [c.id, c]));
    const layout = groupCapacities(cells.length, seed), count = layout.sizes.length;
    const oldGroups = (previous?.network.groups || []).map(group => ({
      ...group, survivors: group.memberIds.filter(id => byId.has(id)),
    })).sort((a, b) => b.survivors.length - a.survivors.length || a.hubId - b.hubId);
    const hubs = [], preserved = new Set();
    for (const group of oldGroups) if (hubs.length < count && byId.has(group.hubId)) {
      const hub = byId.get(group.hubId);hubs.push(hub);preserved.add(hub.id);
    }
    // Replace a lost hub from its surviving neighborhood before creating a
    // completely new branch for additional split cells.
    for (const group of oldGroups) if (hubs.length < count && !byId.has(group.hubId)) {
      const candidates = group.survivors.map(id => byId.get(id)).filter(c => !hubs.some(hub => hub.id === c.id));
      if (candidates.length) hubs.push(centralCell(candidates));
    }
    if (!hubs.length) hubs.push(centralCell(cells));
    while (hubs.length < count) {
      const candidates = cells.filter(c => !hubs.some(hub => hub.id === c.id));
      hubs.push(candidates.reduce((best, c) => {
        const distance = Math.min(...hubs.map(hub => distanceSquared(c, hub)));
        const previousDistance = Math.min(...hubs.map(hub => distanceSquared(best, hub)));
        return distance > previousDistance || (distance === previousDistance && (c.mass > best.mass || (c.mass === best.mass && c.id < best.id))) ? c : best;
      }));
    }
    const oldBranch = oldGroups.find(group => group.offshoot && hubs.some(hub => hub.id === group.hubId));
    if (layout.offshoot && oldBranch) {
      const index = hubs.findIndex(hub => hub.id === oldBranch.hubId);
      hubs.push(...hubs.splice(index, 1));
    }
    let groups = balancedGroups(cells, hubs, layout.sizes);
    // Initial seeds provide spatial separation; only new hubs can move to a
    // more central member. Existing live hubs retain their role as mass grows.
    const centered = groups.map(group => preserved.has(group.hub.id) ? group.hub : centralCell(group.cells));
    groups = balancedGroups(cells, centered, layout.sizes);
    for (const [index, group] of groups.entries()) {
      const hub = preserved.has(group.hub.id) ? group.hub : centralCell(group.cells);
      const memberIds = group.cells.map(c => c.id).sort((a, b) => a - b);
      const offshoot = layout.offshoot && index === count - 1;
      network.groups.push({ hubId: hub.id, memberIds, ...(offshoot ? { offshoot: true } : {}) });
      for (const id of memberIds) {
        network.hubByCell.set(id, hub.id);
        if (id !== hub.id) add(hub.id, id, 'spoke', offshoot ? { offshoot: true } : {});
      }
      const neighbors = group.cells.filter(c => c.id !== hub.id).sort((a, b) =>
        Math.atan2(a.y - hub.y, a.x - hub.x) - Math.atan2(b.y - hub.y, b.x - hub.x) || a.id - b.id);
      for (let i = 0; i < neighbors.length; i++) add(neighbors[i].id, neighbors[(i + 1) % neighbors.length].id, 'neighbor');
    }
    spanningTree(network.groups.map(group => byId.get(group.hubId)).sort((a, b) => a.id - b.id), add, 'bridge');
    // A minority of three-group networks retain the sparse tree; the others
    // have one extra inter-group connection. This choice never changes per frame.
    if (count === 3 && seededFraction(seed, 0x31e9a46b) < .6) {
      for (let i = 0; i < network.groups.length; i++) for (let j = i + 1; j < network.groups.length; j++) {
        add(network.groups[i].hubId, network.groups[j].hubId, 'bridge');
      }
    }
    // One secondary route per group beyond the first is enough to read as a
    // network, not a web. These satellite links do not apply hub forces.
    const routes = [];
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      routes.push({ a: network.groups[i], b: network.groups[j], salt: 0x21b7429d + i * 101 + j * 977,
        order: seededFraction(seed, 0x7a391efb + i * 101 + j * 977) });
    }
    routes.sort((a, b) => a.order - b.order || a.salt - b.salt);
    for (const route of routes.slice(0, count - 1)) {
      const edge = secondaryBridge(route.a, route.b, byId, cells, seed, route.salt);
      if (edge) add(edge.aId, edge.bId, 'bridge', { secondary: true });
    }
  }
  networks.set(holder, { signature, seed, network });
  return network;
}

/** Quote how one new dot reward is shared; never move existing cell mass. */
export function quoteHubFeed(holder, collector, total, network = updateClusterNetwork(holder)) {
  const reward = finiteMass(total), collectorId = typeof collector === 'number' ? collector : collector?.id;
  const cells = new Map(liveCells(holder).map(c => [c.id, c]));
  const cell = cells.get(collectorId), hubId = network.hubByCell.get(collectorId), hub = cells.get(hubId);
  if (!cell || !hub) return { hubId: null, transferred: 0, retained: reward };
  if (hubId === collectorId) return { hubId, transferred: 0, retained: reward };
  const group = network.groups.find(group => group.hubId === hubId && group.memberIds.includes(collectorId));
  if (!group) return { hubId: null, transferred: 0, retained: reward };
  // A remote launched member keeps its pickup until it is close enough to
  // rejoin its hub. This is independent of the topology's persistent role.
  const reach = 2.1 * (Math.sqrt(finiteMass(cell.mass)) + Math.sqrt(finiteMass(hub.mass))) + 160;
  if (distanceSquared(cell, hub) > reach ** 2) return { hubId, transferred: 0, retained: reward };
  const groupMass = group.memberIds.reduce((sum, id) => sum + finiteMass(cells.get(id)?.mass), 0);
  const room = Math.max(0, (groupMass + reward) * HUB_MASS_CAP - finiteMass(hub.mass));
  const transferred = Math.min(reward * HUB_FEED_SHARE, room);
  return { hubId, transferred, retained: reward - transferred };
}
