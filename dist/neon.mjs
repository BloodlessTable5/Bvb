import { radius, WORLD } from './engine.mjs';

export const DEATH_EFFECT_DURATION = .72;
const TAU = Math.PI * 2;
const glowCache = new Map();
const beadCache = new Map();

// Six small reusable light textures keep food rendering cheap at high dot counts.
function glowSprite(color) {
  if (!glowCache.has(color)) {
    const sprite = document.createElement('canvas');sprite.width = sprite.height = 64;
    const ctx = sprite.getContext('2d'), gradient = ctx.createRadialGradient(32,32,0,32,32,32);
    gradient.addColorStop(0,color+'a0');gradient.addColorStop(.18,color+'55');
    gradient.addColorStop(.48,color+'16');gradient.addColorStop(1,color+'00');
    ctx.fillStyle = gradient;ctx.fillRect(0,0,64,64);glowCache.set(color,sprite);
    if (glowCache.size > 24) glowCache.delete(glowCache.keys().next().value);
  }
  return glowCache.get(color);
}

function light(ctx,x,y,size,color,alpha=1) {
  ctx.save();ctx.globalAlpha *= alpha;
  ctx.drawImage(glowSprite(color),x-size,y-size,size*2,size*2);ctx.restore();
}

export function drawGroundLight(ctx,cells,zoom,bounds) {
  if(!Number.isFinite(zoom)||zoom<=0)return;
  const left=Math.max(0,bounds?.minX??0),right=Math.min(WORLD.width,bounds?.maxX??WORLD.width);
  const top=Math.max(0,bounds?.minY??0),bottom=Math.min(WORLD.height,bounds?.maxY??WORLD.height);
  if(right<=left||bottom<=top)return;
  const minorStep=40,majorStep=200,minorFade=Math.max(0,Math.min(1,(zoom-.28)/.36));
  ctx.save();
  ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
  // Screen blending lights the existing floor without the unbounded additive
  // brightness that many overlapping split-cell pools would create.
  ctx.globalCompositeOperation='screen';
  const opacity=ctx.globalAlpha;
  ctx.lineWidth=1/zoom;
  for (const {h,c} of cells) {
    const r=radius(c.mass),outer=r+100/zoom;
    if(c.x+outer<left||c.x-outer>right||c.y+outer<top||c.y-outer>bottom)continue;
    const minX=Math.max(left,c.x-outer),maxX=Math.min(right,c.x+outer);
    const minY=Math.max(top,c.y-outer),maxY=Math.min(bottom,c.y+outer);
    // The falloff starts at the bubble edge and reaches transparent before the
    // rectangular draw bounds; no circular clipping boundary is introduced.
    const glow=ctx.createRadialGradient(c.x,c.y,r,c.x,c.y,outer);
    glow.addColorStop(0,h.color+'78');glow.addColorStop(.18,h.color+'3c');
    glow.addColorStop(.44,h.color+'14');glow.addColorStop(.72,h.color+'04');
    glow.addColorStop(1,h.color+'00');
    ctx.fillStyle=glow;ctx.globalAlpha=opacity*.06;
    ctx.fillRect(minX,minY,maxX-minX,maxY-minY);
    ctx.strokeStyle=glow;
    for(const step of [minorStep,majorStep]) {
      const minor=step===minorStep;
      if(minor&&minorFade===0)continue;
      ctx.beginPath();
      for(let x=Math.ceil(minX/step)*step;x<=maxX;x+=step) {
        if(minor&&x%majorStep===0)continue;
        ctx.moveTo(x,minY);ctx.lineTo(x,maxY);
      }
      for(let y=Math.ceil(minY/step)*step;y<=maxY;y+=step) {
        if(minor&&y%majorStep===0)continue;
        ctx.moveTo(minX,y);ctx.lineTo(maxX,y);
      }
      ctx.globalAlpha=opacity*(minor?.28*minorFade:.4);ctx.stroke();
    }
  }
  ctx.restore();
}

function beadSprite(color) {
  if(!beadCache.has(color)) {
    const sprite=document.createElement('canvas');sprite.width=sprite.height=32;
    const ctx=sprite.getContext('2d');
    ctx.beginPath();ctx.ellipse(17,20,9,6,0,0,TAU);ctx.fillStyle='#010409b0';ctx.fill();
    const gradient=ctx.createRadialGradient(13,12,0,16,16,9);
    gradient.addColorStop(0,'#f0fcff');gradient.addColorStop(.23,color);
    gradient.addColorStop(.68,color);gradient.addColorStop(1,'#152336');
    ctx.beginPath();ctx.arc(16,16,8,0,TAU);ctx.fillStyle=gradient;ctx.fill();
    ctx.beginPath();ctx.arc(13.5,12.5,1.7,0,TAU);ctx.fillStyle='#ffffffb0';ctx.fill();
    beadCache.set(color,sprite);
    if(beadCache.size>24)beadCache.delete(beadCache.keys().next().value);
  }
  return beadCache.get(color);
}

export function drawNeonFood(ctx,food,zoom,{minX,maxX,minY,maxY}) {
  ctx.save();
  for (const f of food) {
    const r=Math.max(2.3,Math.sqrt(f.visualMass??f.mass)*.65),halo=Math.max(r*4,9/zoom);
    if(f.x+halo<minX||f.x-halo>maxX||f.y+halo<minY||f.y-halo>maxY)continue;
    ctx.globalCompositeOperation='lighter';light(ctx,f.x,f.y,halo,f.color,.85);
    ctx.globalCompositeOperation='source-over';
    ctx.drawImage(beadSprite(f.color),f.x-r*2,f.y-r*2,r*4,r*4);
  }
  ctx.restore();
}

function line(ctx,points,color,width,zoom,alpha) {
  if(points.length<2)return;
  ctx.globalAlpha=alpha;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);
  for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);
  for(const [scale,a] of [[3.5,'12'],[1.7,'38'],[1,'d0']]) {
    ctx.strokeStyle=color+a;ctx.lineWidth=width*scale/zoom;ctx.stroke();
  }
}

export class NeonEffects {
  constructor({reducedMotion=false}={}) {this.reducedMotion=reducedMotion;this.reset();}
  reset() {this.trails=[];this.bursts=[];}

  add(event,highlight) {
    if(this.reducedMotion)return;
    const color=event.isPlayer?highlight:event.color;
    if(event.type==='split') {
      this.trails.push({...event,color,age:0,duration:.58,points:[{x:event.x,y:event.y}]});
      if(this.trails.length>48)this.trails.splice(0,this.trails.length-48);
    } else if(['consolidate','merge','death'].includes(event.type)) {
      this.bursts.push({...event,color,age:0,duration:event.type==='death'?DEATH_EFFECT_DURATION:event.type==='merge'?.48:.6});
      if(this.bursts.length>40)this.bursts.splice(0,this.bursts.length-40);
    }
  }

  update(cells,elapsed) {
    const dt=Math.max(0,Math.min(elapsed,.05));
    if(!dt)return;
    const live=new Map(cells.map(({c})=>[c.id,c]));
    for(const trail of this.trails) {
      trail.age+=dt;
      const c=live.get(trail.cellId);
      if(c&&trail.age<.34) {
        const last=trail.points[trail.points.length-1];
        if(Math.hypot(c.x-last.x,c.y-last.y)>1)trail.points.push({x:c.x,y:c.y});
        if(trail.points.length>24)trail.points.splice(0,trail.points.length-24);
      }
    }
    for(const burst of this.bursts) {
      burst.age+=dt;
      const c=live.get(burst.cellId);
      if(c&&burst.type!=='death'){burst.x=c.x;burst.y=c.y;}
    }
    this.trails=this.trails.filter(trail=>trail.age<trail.duration);
    this.bursts=this.bursts.filter(burst=>burst.age<burst.duration);
  }

  drawBehind(ctx,zoom) {
    ctx.save();ctx.globalCompositeOperation='lighter';
    for(const trail of this.trails) {
      const fade=(1-trail.age/trail.duration)**1.5;
      // Three narrow rails follow the actual launched cell, then fade in place.
      const nx=-trail.dy,ny=trail.dx,spread=radius(trail.mass)*.48;
      for(const side of [-1,0,1]) {
        const points=trail.points.map(p=>({x:p.x+nx*spread*side,y:p.y+ny*spread*side}));
        line(ctx,points,trail.color,side===0?2:1,zoom,fade*(side===0?.8:.42));
      }
    }
    ctx.restore();
  }

  drawForeground(ctx,zoom) {
    ctx.save();ctx.globalCompositeOperation='lighter';
    for(const burst of this.bursts) {
      const p=burst.age/burst.duration,fade=(1-p)**1.6;
      const r=radius(burst.mass),death=burst.type==='death',gather=burst.type==='consolidate';
      const ring=death?r*(.8+p*.95):gather?r*(1.6-p*.55):r*(1.05+p*.3);
      // Localized light, never a full-screen flash or camera shake.
      ctx.globalAlpha=1;light(ctx,burst.x,burst.y,ring+45/zoom,burst.color,fade*(death?.46:.25));
      ctx.globalAlpha=fade;ctx.beginPath();ctx.arc(burst.x,burst.y,ring,0,TAU);
      for(const [width,alpha] of [[12,'0e'],[5,'30'],[1.4,'c0']]) {
        ctx.lineWidth=width/zoom;ctx.strokeStyle=burst.color+alpha;ctx.stroke();
      }
      const count=death?16:gather?8:10;
      for(let i=0;i<count;i++) {
        const angle=i/count*TAU+(gather?p*.3:0)+(burst.cellId||0)*.13;
        const distance=death?r*(.8+p*(.7+(i%3)*.23)):gather?r*(1.7-p*.8):r*(1.12+p*.25);
        const length=(death?14:8)/zoom*(1-p);
        const x=burst.x+Math.cos(angle)*distance,y=burst.y+Math.sin(angle)*distance;
        const tail=death?-length:length;
        line(ctx,[{x:x+Math.cos(angle)*tail,y:y+Math.sin(angle)*tail},{x,y}],burst.color,death?1.5:1.1,zoom,fade*.8);
      }
    }
    ctx.restore();
  }
}
