export const SUPPLY = 50000;
export const WORLD = { width: 3200, height: 2400 };
export const COLORS = ['#c3f774', '#61cbb4', '#73a7ed', '#aa8be8', '#e992b2', '#edb66f'];
export const COLOR_NAMES = ['Acid green', 'Seafoam', 'Blue', 'Lilac', 'Rose', 'Amber'];
export const MERGE_TIME = 10;
export const OBSTACLES = [
  {shape:'square',points:[{x:930,y:960},{x:1110,y:960},{x:1110,y:1140},{x:930,y:1140}]},
  {shape:'square',points:[{x:2020,y:1660},{x:2200,y:1660},{x:2200,y:1840},{x:2020,y:1840}]},
  {shape:'triangle',points:[{x:1900,y:570},{x:2050,y:830},{x:1750,y:830}]},
  {shape:'triangle',points:[{x:1050,y:1670},{x:1190,y:1910},{x:910,y:1910}]}
];
export const radius = mass => Math.sqrt(mass) * 2.1;
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
export function wallet(random = Math.random) { return '0x'+Array.from({length:40},()=>Math.floor(random()*16).toString(16)).join(''); }
export function shortWallet(address) { return address.slice(0,6)+'…'+address.slice(-4); }

export class Arena {
  constructor(random = Math.random) { this.random=random; this.reset(); }
  reset() {
    this.time=0; this.holders=[]; this.food=[]; this.events=[]; this.particles=[]; this.reserve=SUPPLY; this.nextId=1; this.eaten=0; this.peak=0; this.player=null; this.merging=false; this.dead=false; this.ejectAt=0;
    const names=['whale.eth','diamondhands','notyourkeys','0xBigBag','pepe.enjoyer','hodl_me','moonwalker','degen.exe','pumpkin','based.satoshi','paperhands','mint.condition','shrimp.king','wen.moon','sol.survivor','bagholder','tiny.whale','0xnoodle','just.vibing','dust.collector','green.candle','fomo.frog','lil.holder','fresh.wallet'];
    const masses=[5600,4250,3400,2900,2400,1900,1500,1200,1000,950,800,700,600,500,440,400,350,300,280,250,220,200,180,160];
    const positions=[[1260,580],[2310,1530],[2590,610],[630,1690],[640,620],[1770,1950],[2780,1990],[1580,360],[3090,1170],[480,1190],[2100,410],[1170,1520],[830,2090],[1850,1170],[1540,1600],[2280,2130],[180,1880],[2180,1040],[1520,1070],[2800,350],[560,2250],[1230,2200],[3000,1680],[1600,1290]];
    names.forEach((name,i)=>this.addHolder(name,COLORS[i%COLORS.length],masses[i],positions[i][0],positions[i][1]));
    for(let i=0;i<450;i++) this.addFood();
  }
  makeCell(mass,x,y) { return {id:this.nextId++,mass,x,y,vx:0,vy:0,readyAt:0,target:null,thinkAt:0}; }
  addHolder(name,color,mass,x,y,isPlayer=false,address=wallet(this.random)) {
    if(this.reserve<mass) return null;
    const holder={id:this.nextId++,name,color,wallet:address,isPlayer,cells:[this.makeCell(mass,x,y)],shieldUntil:0,respawnAt:0};
    resolveWalls(holder.cells[0]);this.reserve-=mass; this.holders.push(holder); return holder;
  }
  addFood(mass=12+this.random()*16,x=this.random()*WORLD.width,y=this.random()*WORLD.height,color=COLORS[Math.floor(this.random()*COLORS.length)]) {
    if(this.reserve<mass) return false;
    for(let attempt=0;attempt<20;attempt++) {
      if(!OBSTACLES.some(o=>{const h=polygonContact({x,y},o.points);return h.inside||h.distance<8;}))break;
      x=this.random()*WORLD.width;y=this.random()*WORLD.height;
      if(attempt===19)return false;
    }
    this.reserve-=mass;this.food.push({id:this.nextId++,x,y,mass,color,vx:0,vy:0});return true;
  }
  join(name,color,address) {
    this.reset();this.player=this.addHolder(name,color,900,1580,1330,true,address);this.player.shieldUntil=6;this.peak=900;return this.player;
  }
  mass(holder) { return holder.cells.reduce((sum,c)=>sum+c.mass,0); }
  center(holder=this.player) { const mass=this.mass(holder);return holder.cells.reduce((p,c)=>({x:p.x+c.x*c.mass/mass,y:p.y+c.y*c.mass/mass}),{x:0,y:0}); }
  ranking() { return this.holders.filter(h=>h.cells.length).map(h=>({holder:h,mass:this.mass(h)})).sort((a,b)=>b.mass-a.mass||a.holder.id-b.holder.id); }
  totalMass() { return this.reserve+this.food.reduce((sum,f)=>sum+f.mass,0)+this.holders.reduce((sum,h)=>sum+this.mass(h),0); }
  cooldown() { return this.player?.cells.length>1 ? Math.max(0,...this.player.cells.map(c=>c.readyAt-this.time)) : 0; }
  split(target) {
    if(!this.player||this.dead) return {ok:false,message:'Join the arena first.'};
    let count=0;
    for(const cell of [...this.player.cells]) {
      if(this.player.cells.length>=16) break;
      if(cell.mass<160) continue;
      const angle=Math.atan2(target.y-cell.y,target.x-cell.x);
      cell.mass/=2;cell.readyAt=this.time+MERGE_TIME;
      const r=radius(cell.mass),child=this.makeCell(cell.mass,cell.x+Math.cos(angle)*r*.65,cell.y+Math.sin(angle)*r*.65);
      child.vx=Math.cos(angle)*820;child.vy=Math.sin(angle)*820;child.readyAt=cell.readyAt;
      cell.x-=Math.cos(angle)*r*.2;cell.y-=Math.sin(angle)*r*.2;
      resolveWalls(cell);resolveWalls(child);this.player.cells.push(child);count++;
    }
    this.merging=false;
    return {ok:count>0,message:count?'Split complete. Consolidate in 10s.':this.player.cells.length>=16?'16 bubbles is the limit.':'Grow a little more before splitting.'};
  }
  consolidate() {
    if(!this.player||this.dead) return {ok:false,message:'Join the arena first.'};
    if(this.player.cells.length<2) return {ok:false,message:'Your holding is already consolidated.'};
    if(this.cooldown()>.05) return {ok:false,message:`Consolidation ready in ${Math.ceil(this.cooldown())}s.`};
    this.merging=true;return {ok:true,message:'Bringing your bubbles together…'};
  }
  eject(target) {
    if(!this.player||this.dead||this.time<this.ejectAt) return false;
    let didEject=false;
    for(const cell of this.player.cells) {
      if(cell.mass<100)continue;
      const angle=Math.atan2(target.y-cell.y,target.x-cell.x);cell.mass-=14;
      const r=radius(cell.mass)+12;
      this.food.push({id:this.nextId++,x:cell.x+Math.cos(angle)*r,y:cell.y+Math.sin(angle)*r,mass:14,color:this.player.color,vx:Math.cos(angle)*400,vy:Math.sin(angle)*400,ownerId:this.player.id,unlockAt:this.time+1.5});didEject=true;
    }
    this.ejectAt=this.time+.2;return didEject;
  }
  botTarget(holder,cell) {
    let threat=null,prey=null,preyDistance=Infinity,threatDistance=Infinity;
    for(const h of this.holders) {
      if(h===holder||h.shieldUntil>this.time)continue;
      for(const other of h.cells) {
        const d=distance(cell,other);
        if(other.mass>cell.mass*1.16&&d<radius(other.mass)+radius(cell.mass)+210&&d<threatDistance) {threat=other;threatDistance=d;}
        else if(cell.mass>other.mass*1.22&&d<480&&d<preyDistance){prey=other;preyDistance=d;}
      }
    }
    if(threat) return {x:clamp(cell.x+(cell.x-threat.x)*3,40,WORLD.width-40),y:clamp(cell.y+(cell.y-threat.y)*3,40,WORLD.height-40)};
    if(prey)return {x:prey.x,y:prey.y};
    let nearest=null,best=Infinity;
    for(const f of this.food) {const d=(f.x-cell.x)**2+(f.y-cell.y)**2;if(d<best){nearest=f;best=d;}}
    return nearest||{x:WORLD.width/2,y:WORLD.height/2};
  }
  update(dt,input={target:{x:1600,y:1200}}) {
    if(this.dead)return;dt=Math.min(dt,.04);this.time+=dt;
    for(const holder of this.holders) {
      if(!holder.cells.length&&!holder.isPlayer&&this.time>holder.respawnAt&&this.reserve>260){this.reserve-=250;holder.cells.push(this.makeCell(250,120+this.random()*(WORLD.width-240),120+this.random()*(WORLD.height-240)));holder.shieldUntil=this.time+3;}
      for(const c of holder.cells) {
        let target;
        if(holder.isPlayer)target=this.merging?this.center(holder):input.target;
        else {if(this.time>=c.thinkAt){c.target=this.botTarget(holder,c);c.thinkAt=this.time+.25+this.random()*.2;}target=c.target;}
        const dx=target.x-c.x,dy=target.y-c.y,d=Math.hypot(dx,dy);
        let speed=115+165/(1+radius(c.mass)/38);
        if(holder.isPlayer&&this.merging)speed=430;
        const amount=Math.min(d,speed*dt);
        if(d>1){c.x+=dx/d*amount;c.y+=dy/d*amount;}
        c.x+=c.vx*dt;c.y+=c.vy*dt;c.vx*=Math.exp(-5*dt);c.vy*=Math.exp(-5*dt);
        resolveWalls(c);
      }
      for(const cell of holder.cells)resolveWalls(cell);
      for(let i=0;i<holder.cells.length;i++)for(let j=i+1;j<holder.cells.length;j++) {
        const a=holder.cells[i],b=holder.cells[j],d=distance(a,b),ra=radius(a.mass),rb=radius(b.mass),ready=this.time>=Math.max(a.readyAt,b.readyAt);
        if(ready&&d<(this.merging&&holder.isPlayer?ra+rb:Math.max(ra,rb)*.75)) {
          const total=a.mass+b.mass;a.x=(a.x*a.mass+b.x*b.mass)/total;a.y=(a.y*a.mass+b.y*b.mass)/total;a.mass=total;holder.cells.splice(j--,1);
        } else if(!ready&&d<ra+rb){const n=d||1,dx=d?(a.x-b.x)/n:1,dy=d?(a.y-b.y)/n:0,force=Math.min((ra+rb-d)*.5,90*dt);a.x+=dx*force;a.y+=dy*force;b.x-=dx*force;b.y-=dy*force;}
      }
    }
    if(this.player?.cells.length===1)this.merging=false;
    for(const f of this.food){f.x=clamp(f.x+f.vx*dt,4,WORLD.width-4);f.y=clamp(f.y+f.vy*dt,4,WORLD.height-4);f.vx*=Math.exp(-3*dt);f.vy*=Math.exp(-3*dt);resolveWalls(f);}
    const cells=this.holders.flatMap(h=>h.cells.map(c=>({h,c}))).sort((a,b)=>b.c.mass-a.c.mass);
    for(const {h,c} of cells) {
      if(!h.cells.includes(c))continue;
      for(let i=this.food.length-1;i>=0;i--){const f=this.food[i];if(f.ownerId===h.id&&this.time<f.unlockAt)continue;if(distance(c,f)<radius(c.mass)){c.mass+=f.mass;this.food.splice(i,1);}}
      for(const {h:other,c:victim} of cells) {
        if(h===other||!other.cells.includes(victim)||this.time<h.shieldUntil||this.time<other.shieldUntil)continue;
        if(c.mass>victim.mass*1.16&&distance(c,victim)<radius(c.mass)-radius(victim.mass)*.4){
          const gained=victim.mass;c.mass+=gained;other.cells.splice(other.cells.indexOf(victim),1);other.respawnAt=this.time+5;
          this.particles.push({x:victim.x,y:victim.y,color:other.color,radius:radius(gained),life:1});
          if(h.isPlayer){if(!other.cells.length)this.eaten++;this.events.push({type:'eat',name:other.name,mass:gained});}
          if(other.isPlayer&&!other.cells.length){this.dead=true;this.events.push({type:'death',name:h.name});}
        }
      }
    }
    if(this.food.length<450&&this.reserve>30)for(let i=0;i<3;i++)this.addFood();
    if(this.player)this.peak=Math.max(this.peak,this.mass(this.player));
    for(const h of this.holders)for(const c of h.cells)resolveWalls(c);
    for(const p of this.particles)p.life-=dt*2;
    this.particles=this.particles.filter(p=>p.life>0);
  }
}
