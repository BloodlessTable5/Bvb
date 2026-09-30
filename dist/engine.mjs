import { ArenaNavigator } from './pathfinding.mjs';
import { movementSpeed, foodReward, NATURAL_DOT_MASS_SCALE } from './balance.mjs';
import { updateClusterNetwork, quoteHubFeed } from './clusters.mjs';
export const SUPPLY = 50000;
export const WORLD = { width: 3200, height: 2400 };
export const COLORS = ['#c3f774', '#61cbb4', '#73a7ed', '#aa8be8', '#e992b2', '#edb66f'];
export const COLOR_NAMES = ['Acid green', 'Seafoam', 'Blue', 'Lilac', 'Rose', 'Amber'];
export const MERGE_TIME = 5;
const PLAYER_START_MASS = 900;
export const OBSTACLES = [];
export const radius = mass => Math.sqrt(mass) * 2.1;
export const CLUSTER_GAP_MIN = 18;
export const CLUSTER_GAP_MAX = 28;
export const CLUSTER_COHESION_SLACK = 8;
export const CLUSTER_GATHER_SPEED = 240;
export const CLUSTER_GROUP_GAP = 34;
export const clusterGap = (a, b) => Math.max(CLUSTER_GAP_MIN, Math.min(CLUSTER_GAP_MAX, (radius(a.mass) + radius(b.mass)) * .1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(a.x-b.x, a.y-b.y);
export function polygonContact(point,polygon) {
  let inside=false,nearest={x:0,y:0},minimum=Infinity;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[j],b=polygon[i];
    if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    const dx=b.x-a.x,dy=b.y-a.y,t=clamp(((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy),0,1);
    const q={x:a.x+t*dx,y:a.y+t*dy},d=distance(point,q);
    if(d<minimum){minimum=d;nearest=q;}
  }
  return {inside,distance:minimum,nearest};
}
export function resolveWalls(cell) {
  const r=radius(cell.mass);
  for(let pass=0;pass<3;pass++) {
    cell.x=clamp(cell.x,r,WORLD.width-r);cell.y=clamp(cell.y,r,WORLD.height-r);
    for(const obstacle of OBSTACLES) {
      const hit=polygonContact(cell,obstacle.points);
      if(hit.inside||hit.distance<r) {
        let dx=cell.x-hit.nearest.x,dy=cell.y-hit.nearest.y,d=hit.distance,sign=hit.inside?-1:1;
        if(d<.001){const center=obstacle.points.reduce((p,v)=>({x:p.x+v.x/obstacle.points.length,y:p.y+v.y/obstacle.points.length}),{x:0,y:0});dx=cell.x-center.x;dy=cell.y-center.y;d=Math.hypot(dx,dy)||1;sign=1;}
        const amount=hit.inside?r+hit.distance+.1:r-hit.distance+.1;
        cell.x+=dx/d*amount*sign;cell.y+=dy/d*amount*sign;
        // Remove inward impulse while allowing movement along the wall.
        const nx=dx/d*sign,ny=dy/d*sign,dot=cell.vx*nx+cell.vy*ny;
        if(dot<0){cell.vx-=dot*nx;cell.vy-=dot*ny;}
      }
    }
  }
}
// A small position solver gives each holder its own readable, connected cluster.
// Corrections preserve mass-weighted centers except where the world walls constrain them.
export function resolveClusterSpacing(cells, dt = 0, network = null) {
  if (cells.length < 2) return;
  const movePair = (a, b, dx, dy, amount) => {
    const share = b.mass / (a.mass + b.mass);
    a.x -= dx * amount * share; a.y -= dy * amount * share;
    b.x += dx * amount * (1 - share); b.y += dy * amount * (1 - share);
    resolveWalls(a); resolveWalls(b);
  };
  // Many cells gather around stable local hubs; whole groups share mild bridges.
  // Group separation eases in through forces, never snapping cells into slots.
  if (dt > 0 && network?.groups.length) {
    const byId = new Map(cells.map(cell => [cell.id, cell]));
    const groups = network.groups.map(group => {
      const members = [...new Set([group.hubId, ...group.memberIds])].map(id => byId.get(id)).filter(Boolean);
      const hub = byId.get(group.hubId);
      if (!hub) return null;
      const largestLeaf = Math.max(0, ...members.filter(cell => cell !== hub).map(cell => radius(cell.mass)));
      // This envelope is soft; actual pair spacing remains authoritative.
      return { hub, members, mass: members.reduce((total, cell) => total + cell.mass, 0), extent: (radius(hub.mass) + largestLeaf * 2 + CLUSTER_GAP_MAX) * .85 };
    }).filter(Boolean);
    const groupByHub = new Map(groups.map(group => [group.hub.id, group]));
    const moveGroups = (a, b, amount) => {
      const d = distance(a.hub, b.hub), angle = (a.hub.id * 2.399963 + b.hub.id * 1.618034) % (Math.PI * 2);
      const dx = d > .001 ? (b.hub.x - a.hub.x) / d : Math.cos(angle), dy = d > .001 ? (b.hub.y - a.hub.y) / d : Math.sin(angle);
      const share = b.mass / (a.mass + b.mass);
      for (const cell of a.members) { cell.x -= dx * amount * share; cell.y -= dy * amount * share; resolveWalls(cell); }
      for (const cell of b.members) { cell.x += dx * amount * (1 - share); cell.y += dy * amount * (1 - share); resolveWalls(cell); }
    };
    for (const link of network.links) {
      const a = byId.get(link.aId), b = byId.get(link.bId);
      if (!a || !b) continue;
      if (link.kind === 'spoke') {
        const d = distance(a, b), excess = d - radius(a.mass) - radius(b.mass) - clusterGap(a, b) - CLUSTER_COHESION_SLACK;
        if (excess > 0 && d > .001) {
          const hub = network.hubByCell.get(a.id) === a.id ? a : b, leaf = hub === a ? b : a;
          let dx = (hub.x - leaf.x) / d, dy = (hub.y - leaf.y) / d, blocker = null;
          for (const cell of cells) {
            if (cell === leaf || cell === hub) continue;
            const ownGroup = network.hubByCell.get(cell.id) === hub.id;
            if (ownGroup && excess <= 20) continue;
            const x = cell.x - leaf.x, y = cell.y - leaf.y, along = x * dx + y * dy;
            const side = dx * y - dy * x, clearance = radius(leaf.mass) + radius(cell.mass) + clusterGap(leaf, cell);
            if (along > 0 && along < d && Math.abs(side) < clearance && (!blocker || along < blocker.along)) blocker = { along, side, ownGroup };
          }
          // A returning branch can slide around neighbors instead of becoming
          // pinned behind another group by a straight-line spring.
          if (blocker) {
            if (!(leaf.clusterAvoidFor > 0)) leaf.clusterAvoidSide = Math.abs(blocker.side) > .01 ? Math.sign(blocker.side) : leaf.id % 2 ? 1 : -1;
            leaf.clusterAvoidFor = .4;
            const side = leaf.clusterAvoidSide;
            const strength = blocker.ownGroup ? .6 : 2.4;
            const x = dx + dy * side * strength, y = dy - dx * side * strength, length = Math.hypot(x, y);
            dx = x / length; dy = y / length;
          } else leaf.clusterAvoidFor = Math.max(0, (leaf.clusterAvoidFor || 0) - dt);
          const group = groupByHub.get(hub.id), pull = Math.min(excess * (1 - Math.exp(-10 * dt)), CLUSTER_GATHER_SPEED * dt);
          const share = leaf.mass / group.mass;
          // Spread the return force across its local group so a far satellite
          // cannot drag the hub into a neighboring group and cancel its return.
          for (const cell of group.members) {
            const amount = cell === leaf ? pull * (1 - share) : -pull * share;
            cell.x += dx * amount; cell.y += dy * amount; resolveWalls(cell);
          }
        }
      } else if (link.kind === 'bridge') {
        const groupA = groupByHub.get(a.id), groupB = groupByHub.get(b.id);
        if (!groupA || !groupB) continue;
        const excess = distance(a, b) - groupA.extent - groupB.extent - CLUSTER_GROUP_GAP - 12;
        if (excess > 0) moveGroups(groupA, groupB, -Math.min(excess * (1 - Math.exp(-4 * dt)), 110 * dt));
      }
    }
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j], overlap = a.extent + b.extent + CLUSTER_GROUP_GAP - distance(a.hub, b.hub);
      if (overlap > 0) moveGroups(a, b, Math.min(overlap * (1 - Math.exp(-8 * dt)), 280 * dt));
    }
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      if (network.hubByCell.get(a.id) === network.hubByCell.get(b.id)) continue;
      const d = distance(a, b), overlap = radius(a.mass) + radius(b.mass) + CLUSTER_GROUP_GAP - d;
      if (overlap > 0 && d > .001) movePair(a, b, (b.x - a.x) / d, (b.y - a.y) / d, Math.min(overlap * (1 - Math.exp(-8 * dt)), 100 * dt));
    }
  } else if (dt > 0) {
    // Two or three bubbles keep their short, slack connection tree.
    const connected = new Set([cells.reduce((a, b) => a.mass >= b.mass ? a : b)]);
    while (connected.size < cells.length) {
      let best = null;
      for (const a of connected) for (const b of cells) {
        if (connected.has(b)) continue;
        const d = distance(a, b), gap = d - radius(a.mass) - radius(b.mass);
        if (!best || gap < best.gap) best = { a, b, d, gap };
      }
      const { a, b, d, gap } = best;
      connected.add(b);
      const excess = gap - clusterGap(a, b) - CLUSTER_COHESION_SLACK;
      if (excess > 0 && d > .001) movePair(a, b, (b.x - a.x) / d, (b.y - a.y) / d, -Math.min(excess * (1 - Math.exp(-10 * dt)), CLUSTER_GATHER_SPEED * dt));
    }
  }
  for (let pass = 0; pass < 24; pass++) {
    let largestOverlap = 0;
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j], d = distance(a, b);
      const overlap = radius(a.mass) + radius(b.mass) + clusterGap(a, b) - d;
      if (overlap <= .025) continue;
      largestOverlap = Math.max(largestOverlap, overlap);
      // Stable pair-specific directions also untangle exactly coincident spawns.
      const angle = (a.id * 2.399963 + b.id * 1.618034) % (Math.PI * 2);
      const dx = d > .001 ? (b.x - a.x) / d : Math.cos(angle);
      const dy = d > .001 ? (b.y - a.y) / d : Math.sin(angle);
      movePair(a, b, dx, dy, overlap);
    }
    if (largestOverlap < .05) break;
  }
}
function flowCluster(cells, dt, time, turn, moving, network) {
  if (dt <= 0) return;
  const local = new Map();
  for (const cell of cells) {
    const key = network?.hubByCell.get(cell.id) ?? null;
    if (!local.has(key)) local.set(key, { mass: 0, x: 0, y: 0, meanX: 0, meanY: 0 });
    const group = local.get(key); group.mass += cell.mass; group.x += cell.x * cell.mass; group.y += cell.y * cell.mass;
  }
  for (const group of local.values()) { group.x /= group.mass; group.y /= group.mass; }
  const displacements = cells.map(cell => {
    const group = local.get(network?.hubByCell.get(cell.id) ?? null);
    const x = cell.x - group.x, y = cell.y - group.y, d = Math.hypot(x, y);
    const phase = cell.id * 2.399963 + time * .9;
    // Each branch drifts at its own gentle pace; this is not a rigid rotation.
    const drift = (moving ? 5 : 4) + 2 * Math.sin(phase) + turn * 12 * (.6 + .4 * Math.cos(phase));
    const amount = drift * dt * Math.min(1, d / 40);
    const dx = d > .001 ? -y / d * amount : 0, dy = d > .001 ? x / d * amount : 0;
    group.meanX += dx * cell.mass / group.mass; group.meanY += dy * cell.mass / group.mass;
    return { dx, dy, group };
  });
  // Internal motion cannot steer the holder or move an idle camera centroid.
  cells.forEach((cell, i) => { const { dx, dy, group } = displacements[i]; cell.x += dx - group.meanX; cell.y += dy - group.meanY; });
}
export function wallet(random = Math.random) { return '0x'+Array.from({length:40},()=>Math.floor(random()*16).toString(16)).join(''); }
export function shortWallet(address) { return address.slice(0,6)+'…'+address.slice(-4); }

export class Arena {
  constructor(random = Math.random) { this.random=random;this.navigator=new ArenaNavigator(OBSTACLES,WORLD); this.reset(); }
  reset() {
    this.time=0; this.holders=[]; this.food=[]; this.events=[]; this.particles=[]; this.reserve=SUPPLY; this.nextId=1; this.eaten=0; this.peak=0; this.player=null; this.dead=false; this.ejectAt=0;this.merging=false;this.botEaten=0;
    const names=['whale.eth','diamondhands','notyourkeys','0xBigBag','pepe.enjoyer','hodl_me','moonwalker','degen.exe','pumpkin','based.satoshi','paperhands','mint.condition','shrimp.king','wen.moon','sol.survivor','bagholder','tiny.whale','0xnoodle','just.vibing','dust.collector','green.candle','fomo.frog','lil.holder','fresh.wallet'];
    const masses=[5600,4250,3400,2900,2400,1900,1500,1200,1000,950,800,700,600,500,440,400,350,300,280,250,220,200,180,160];
    const positions=[[1260,580],[2310,1530],[2590,610],[630,1690],[640,620],[1770,1950],[2780,1990],[1580,360],[3090,1170],[480,1190],[2100,410],[1170,1520],[830,2090],[1850,1170],[1540,1600],[2280,2130],[180,1880],[2180,1040],[1520,1070],[2800,350],[560,2250],[1230,2200],[3000,1680],[1600,1290]];
    names.forEach((name,i)=>this.addHolder(name,COLORS[i%COLORS.length],masses[i],positions[i][0],positions[i][1]));
    // Hold the player's starting share aside while funding the initial dots.
    this.reserve-=PLAYER_START_MASS;
    for(let i=0;i<450;i++) this.addFood();
    this.reserve+=PLAYER_START_MASS;
  }
  makeCell(mass,x,y) { return {id:this.nextId++,mass,x,y,vx:0,vy:0,readyAt:0,target:null,thinkAt:0}; }
  addHolder(name,color,mass,x,y,isPlayer=false,address=wallet(this.random)) {
    if(this.reserve<mass) return null;
    const holder={id:this.nextId++,name,color,wallet:address,isPlayer,cells:[this.makeCell(mass,x,y)],shieldUntil:0,respawnAt:0,splitAt:0};
    resolveWalls(holder.cells[0]);this.reserve-=mass; this.holders.push(holder); return holder;
  }
  addFood(mass=(12+this.random()*16)*NATURAL_DOT_MASS_SCALE,x=this.random()*WORLD.width,y=this.random()*WORLD.height,color=COLORS[Math.floor(this.random()*COLORS.length)]) {
    if(this.reserve<mass*2) return false;
    for(let attempt=0;attempt<20;attempt++) {
      if(!OBSTACLES.some(o=>{const h=polygonContact({x,y},o.points);return h.inside||h.distance<8;}))break;
      x=this.random()*WORLD.width;y=this.random()*WORLD.height;
      if(attempt===19)return false;
    }
    // Each natural dot carries its maximum bonus, even after the free pool runs out.
    this.reserve-=mass*2;this.food.push({id:this.nextId++,x,y,mass,bonusMass:mass,visualMass:mass/NATURAL_DOT_MASS_SCALE,color,vx:0,vy:0});return true;
  }
  join(name,color,address) {
    this.reset();this.player=this.addHolder(name,color,PLAYER_START_MASS,1580,1330,true,address);this.player.shieldUntil=6;this.peak=PLAYER_START_MASS;return this.player;
  }
  mass(holder) { return holder.cells.reduce((sum,c)=>sum+c.mass,0); }
  center(holder=this.player) { const mass=this.mass(holder);return holder.cells.reduce((p,c)=>({x:p.x+c.x*c.mass/mass,y:p.y+c.y*c.mass/mass}),{x:0,y:0}); }
  ranking() { return this.holders.filter(h=>h.cells.length).map(h=>({holder:h,mass:this.mass(h)})).sort((a,b)=>b.mass-a.mass||a.holder.id-b.holder.id); }
  totalMass() { return this.reserve+this.food.reduce((sum,f)=>sum+f.mass+(f.bonusMass||0),0)+this.holders.reduce((sum,h)=>sum+this.mass(h),0); }
  cooldown() { return this.player?.cells.length>1 ? Math.max(0,...this.player.cells.map(c=>c.readyAt-this.time)) : 0; }
  split(target) {
    if(!this.player||this.dead) return {ok:false,message:'Join the arena first.'};
    this.merging=false;
    const count=this.splitHolder(this.player,target);
    return {ok:count>0,message:count?`Split complete. Consolidate with C after ${MERGE_TIME}s.`:this.player.cells.length>=16?'16 bubbles is the limit.':'Grow a little more before splitting.'};
  }
  splitHolder(holder,target,limit=16,selected=null){
    let count=0;
    for(const cell of [...holder.cells]) {
      if(selected&&cell!==selected)continue;
      if(holder.cells.length>=limit) break;
      if(cell.mass<160) continue;
      const angle=Math.atan2(target.y-cell.y,target.x-cell.x);
      cell.mass/=2;cell.readyAt=this.time+MERGE_TIME;
      const r=radius(cell.mass),child=this.makeCell(cell.mass,cell.x+Math.cos(angle)*r*.65,cell.y+Math.sin(angle)*r*.65);
      child.vx=Math.cos(angle)*820;child.vy=Math.sin(angle)*820;child.readyAt=cell.readyAt;
      cell.x-=Math.cos(angle)*r*.2;cell.y-=Math.sin(angle)*r*.2;
      resolveWalls(cell);resolveWalls(child);holder.cells.push(child);count++;
      this.events.push({type:'split',cellId:child.id,sourceId:cell.id,x:child.x,y:child.y,mass:child.mass,dx:Math.cos(angle),dy:Math.sin(angle),color:holder.color,isPlayer:holder.isPlayer});
    }
    if(count)updateClusterNetwork(holder);
    return count;
  }
  consolidate(){
    if(!this.player||this.dead)return {ok:false,message:'Join the arena first.'};
    if(this.player.cells.length<2)return {ok:false,message:'Your holding is already consolidated.'};
    if(this.cooldown()>0)return {ok:false,message:`Consolidation ready in ${Math.ceil(this.cooldown())}s.`};
    if(!this.merging){const largest=this.player.cells.reduce((a,b)=>a.mass>=b.mass?a:b);this.events.push({type:'consolidate',cellId:largest.id,x:largest.x,y:largest.y,mass:this.mass(this.player),color:this.player.color,isPlayer:true});}
    this.merging=true;return {ok:true,message:'Consolidating your bubbles…'};
  }
  eject(target) {
    if(!this.player||this.dead||this.time<this.ejectAt) return false;
    let didEject=false;
    for(const cell of this.player.cells) {
      if(cell.mass<100)continue;
      const angle=Math.atan2(target.y-cell.y,target.x-cell.x);cell.mass-=14;
      const r=radius(cell.mass)+12;
      const dx=Math.cos(angle),dy=Math.sin(angle);
      this.food.push({id:this.nextId++,x:cell.x-dx*r,y:cell.y-dy*r,mass:14,color:this.player.color,vx:-dx*260,vy:-dy*260,ownerId:this.player.id,unlockAt:this.time+1.5});
      if(Math.hypot(cell.vx,cell.vy)<240){cell.vx+=dx*80;cell.vy+=dy*80;}
      didEject=true;
    }
    this.ejectAt=this.time+.2;return didEject;
  }
  botTarget(holder,cell) {
    let threat=null,prey=null,preyDistance=Infinity,threatDistance=Infinity;
    for(const h of this.holders) {
      if(h===holder)continue;
      for(const other of h.cells) {
        const d=distance(cell,other);
        if(other.mass>cell.mass*1.16&&d<radius(other.mass)+radius(cell.mass)+(cell.fleeUntil>this.time?280:120)&&d<threatDistance) {threat=other;threatDistance=d;}
        else if(h.shieldUntil<=this.time&&cell.mass>other.mass*1.22&&d<850){const score=d*(cell.preyId===other.id?.65:1);if(score<preyDistance){prey=other;preyDistance=score;}}
      }
    }
    const r=radius(cell.mass);
    if(threat){
      cell.fleeUntil=this.time+1.8;cell.preyId=null;
      const angle=Math.atan2(cell.y-threat.y,cell.x-threat.x);let best=null,bestScore=-Infinity;
      // Pick open escape space instead of continually pushing into a wall.
      for(const turn of [0,.65,-.65,1.3,-1.3,1.9,-1.9,Math.PI]){
        const goal={x:clamp(cell.x+Math.cos(angle+turn)*330,r+2,WORLD.width-r-2),y:clamp(cell.y+Math.sin(angle+turn)*330,r+2,WORLD.height-r-2)};
        const score=distance(goal,threat)+distance(goal,cell)*.25-Math.abs(turn)*18+(this.navigator.clear(cell,goal,r)?180:0);
        if(score>bestScore){best=goal;bestScore=score;}
      }
      return best;
    }
    if(prey){
      cell.preyId=prey.id;
      const d=distance(cell,prey),canSplit=holder.cells.length<4&&this.time>=holder.splitAt&&this.time>=cell.readyAt&&cell.mass/2>prey.mass*1.35&&d<radius(cell.mass)+190&&d>radius(cell.mass)*.65;
      if(canSplit&&this.navigator.clear(cell,prey,radius(cell.mass/2))){this.splitHolder(holder,prey,4,cell);holder.splitAt=this.time+12;}
      return {x:prey.x,y:prey.y};
    }
    let nearest=null,best=Infinity;
    for(const f of this.food) {const d=distance(f,cell)*(cell.foodId===f.id?.6:1);if(d<best){nearest=f;best=d;}}
    cell.foodId=nearest?.id;
    return nearest||{x:WORLD.width/2,y:WORLD.height/2};
  }
  advance(elapsed,input={target:{x:1600,y:1200}}){
    if(this.dead||!Number.isFinite(elapsed)||elapsed<=0)return;
    // Keep cooldowns in real active seconds even when a frame arrives late.
    let remaining=Math.min(elapsed,1);
    this.time+=Math.max(0,elapsed-remaining);
    while(remaining>1e-8&&!this.dead){const step=Math.min(remaining,.04);this.update(step,input);remaining-=step;}
  }
  update(dt,input={target:{x:1600,y:1200}}) {
    if(this.dead)return;dt=Math.min(dt,.04);this.time+=dt;
    for(const holder of this.holders) {
      if(!holder.cells.length&&!holder.isPlayer&&this.time>holder.respawnAt&&this.reserve>260){this.reserve-=250;holder.cells.push(this.makeCell(250,120+this.random()*(WORLD.width-240),120+this.random()*(WORLD.height-240)));holder.shieldUntil=this.time+3;}
      let network=updateClusterNetwork(holder);
      const regroup=holder.cells.length>1&&(holder.isPlayer?this.merging:holder.cells.every(c=>this.time>=c.readyAt));
      const mergeAnchor=regroup?holder.cells.reduce((a,b)=>a.mass>=b.mass?a:b):null;
      const formation=holder.isPlayer&&!regroup&&holder.cells.length>1?this.center(holder):null;
      if(formation&&dt>0){
        const dx=input.target.x-formation.x,dy=input.target.y-formation.y,moving=Math.hypot(dx,dy)>1;
        holder.turnFlow=(holder.turnFlow||0)*Math.exp(-dt*5);
        if(moving){const heading=Math.atan2(dy,dx),delta=holder.flowHeading===undefined?0:Math.atan2(Math.sin(heading-holder.flowHeading),Math.cos(heading-holder.flowHeading));holder.turnFlow=clamp(holder.turnFlow+delta*.6,-1,1);holder.flowHeading=heading;}
        flowCluster(holder.cells,dt,this.time,moving?holder.turnFlow:0,moving,network);
      }
      for(const c of [...holder.cells]) {
        let target;
        if(mergeAnchor)target=mergeAnchor;
        else if(holder.isPlayer)target=formation?{x:input.target.x+c.x-formation.x,y:input.target.y+c.y-formation.y}:input.target;
        else {if(this.time>=c.thinkAt){c.target=this.botTarget(holder,c);c.thinkAt=this.time+.25+this.random()*.2;}target=c.target;}
        if(!holder.isPlayer||this.merging){const safe={...target,mass:c.mass,vx:0,vy:0};resolveWalls(safe);target=this.navigator.waypoint(c,safe,radius(c.mass),this.time);}
        const dx=target.x-c.x,dy=target.y-c.y,d=Math.hypot(dx,dy);
        let speed=movementSpeed(c.mass);
        if(mergeAnchor)speed=holder.isPlayer?650:280;
        const amount=Math.min(d,speed*dt);
        if(d>1){c.x+=dx/d*amount;c.y+=dy/d*amount;}
        c.x+=c.vx*dt;c.y+=c.vy*dt;c.vx*=Math.exp(-5*dt);c.vy*=Math.exp(-5*dt);
        resolveWalls(c);
      }
      for(const cell of holder.cells)resolveWalls(cell);
      for(let i=0;i<holder.cells.length;i++)for(let j=i+1;j<holder.cells.length;j++) {
        const a=holder.cells[i],b=holder.cells[j],d=distance(a,b),ra=radius(a.mass),rb=radius(b.mass),ready=this.time>=Math.max(a.readyAt,b.readyAt);
        if(mergeAnchor&&ready&&d<(holder.isPlayer?ra+rb:Math.max(ra,rb)*.75)) {
          const total=a.mass+b.mass;a.x=(a.x*a.mass+b.x*b.mass)/total;a.y=(a.y*a.mass+b.y*b.mass)/total;a.mass=total;
          this.events.push({type:'merge',cellId:a.id,fromId:b.id,x:a.x,y:a.y,fromX:b.x,fromY:b.y,mass:total,color:holder.color,isPlayer:holder.isPlayer});
          holder.cells.splice(j--,1);
        }
      }
      network=updateClusterNetwork(holder);
      if(!mergeAnchor)resolveClusterSpacing(holder.cells,dt,network);
    }
    if(this.player?.cells.length<2)this.merging=false;
    for(const f of this.food){f.x=clamp(f.x+f.vx*dt,4,WORLD.width-4);f.y=clamp(f.y+f.vy*dt,4,WORLD.height-4);f.vx*=Math.exp(-3*dt);f.vy*=Math.exp(-3*dt);resolveWalls(f);}
    const cells=this.holders.flatMap(h=>h.cells.map(c=>({h,c}))).sort((a,b)=>b.c.mass-a.c.mass);
    for(const {h,c} of cells) {
      if(!h.cells.includes(c))continue;
      for(let i=this.food.length-1;i>=0;i--){
        const f=this.food[i];if(f.ownerId===h.id&&this.time<f.unlockAt)continue;
        if(distance(c,f)<radius(c.mass)){
          const allowance=f.bonusMass||0;
          const reward=foodReward(c.mass,f.mass,allowance,{ejected:f.ownerId!=null});
          // Only this new natural-dot reward can flow inward. Existing holdings,
          // ejected mass, and captured opponents always stay with the collector.
          const feed=f.ownerId==null&&!(h.isPlayer&&this.merging)?quoteHubFeed(h,c,reward.total):null;
          const hub=feed?.transferred>0?h.cells.find(cell=>cell.id===feed.hubId):null;
          if(hub){
            c.mass+=feed.retained;hub.mass+=feed.transferred;
            this.events.push({type:'hub-feed',fromId:c.id,toId:hub.id,x:c.x,y:c.y,toX:hub.x,toY:hub.y,mass:feed.transferred,color:h.color,isPlayer:h.isPlayer});
          }else c.mass+=reward.total;
          this.reserve+=allowance-reward.bonus;this.food.splice(i,1);
        }
      }
      for(const {h:other,c:victim} of cells) {
        if(h===other||!other.cells.includes(victim)||this.time<other.shieldUntil)continue;
        if(c.mass>victim.mass*1.16&&distance(c,victim)<radius(c.mass)-radius(victim.mass)*.4){
          this.events.push({type:'absorb',eaterId:c.id,preyId:victim.id,x:victim.x,y:victim.y,mass:victim.mass,color:other.color,name:other.name,wallet:other.wallet,eaterX:c.x,eaterY:c.y,eaterMass:c.mass});
          const gained=victim.mass;c.mass+=gained;other.cells.splice(other.cells.indexOf(victim),1);other.respawnAt=this.time+5;
          this.particles.push({x:victim.x,y:victim.y,color:other.color,radius:radius(gained),life:1});
          if(h.isPlayer){if(!other.cells.length)this.eaten++;this.events.push({type:'eat',name:other.name,mass:gained});}
          else if(!other.isPlayer&&!other.cells.length){this.botEaten++;this.events.push({type:'bot-eat',name:h.name,victim:other.name,mass:gained});}
          if(other.isPlayer&&!other.cells.length){this.dead=true;this.events.push({type:'death',name:h.name,x:victim.x,y:victim.y,mass:gained,color:other.color,isPlayer:true});}
        }
      }
    }
    if(this.reserve>0)for(let i=0;i<3&&this.food.length<450;i++)this.addFood();
    if(this.player)this.peak=Math.max(this.peak,this.mass(this.player));
    for(const h of this.holders){
      for(const c of h.cells)resolveWalls(c);
      const network=updateClusterNetwork(h);
      if(h.isPlayer?!this.merging:!h.cells.every(c=>this.time>=c.readyAt))resolveClusterSpacing(h.cells,0,network);
    }
    for(const p of this.particles)p.life-=dt*2;
    this.particles=this.particles.filter(p=>p.life>0);
  }
}
