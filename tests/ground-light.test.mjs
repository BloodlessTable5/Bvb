import test from 'node:test';
import assert from 'node:assert/strict';
import {drawGroundLight} from '../dist/neon.mjs';
import {WORLD} from '../dist/engine.mjs';

const cell=(x=1000,y=1000,isPlayer=false)=>({h:{color:'#73a7ed',isPlayer},c:{x,y,mass:900}});

function recordingContext(){
  const stack=[];
  return {
    globalAlpha:.8,globalCompositeOperation:'source-over',lineWidth:3,
    gradients:[],strokes:[],fills:[],clips:[],path:[],
    save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation,lineWidth:this.lineWidth,strokeStyle:this.strokeStyle,fillStyle:this.fillStyle});},
    restore(){Object.assign(this,stack.pop());},
    beginPath(){this.path=[];},
    rect(x,y,width,height){this.path.push({rect:[x,y,width,height]});},
    clip(){this.clips.push(structuredClone(this.path));},
    moveTo(x,y){this.path.push({move:[x,y]});},
    lineTo(x,y){this.path.push({line:[x,y]});},
    createRadialGradient(...radii){
      const gradient={radii,stops:[],addColorStop(offset,color){this.stops.push({offset,color});}};
      this.gradients.push(gradient);return gradient;
    },
    fillRect(...rect){this.fills.push({rect,alpha:this.globalAlpha,gradient:this.fillStyle});},
    stroke(){this.strokes.push({path:structuredClone(this.path),alpha:this.globalAlpha,gradient:this.strokeStyle,width:this.lineWidth});},
  };
}

function gridCoordinates(ctx){
  return ctx.strokes.flatMap(({path})=>{
    const result=[];
    for(let i=0;i<path.length;i+=2){
      const [x1,y1]=path[i].move,[x2,y2]=path[i+1].line;
      assert.ok(x1===x2||y1===y2,'illumination must follow the existing axis-aligned grid');
      result.push(x1===x2?x1:y1);
    }
    return result;
  });
}

test('offscreen cells are culled, but a halo entering the viewport still lights its edge',()=>{
  const ctx=recordingContext();
  drawGroundLight(ctx,[cell(100,600),cell(300,600),cell(1000,600)],1,{minX:400,maxX:800,minY:400,maxY:800});
  assert.equal(ctx.gradients.length,1);
  assert.equal(ctx.gradients[0].radii[0],300,'keep the true offscreen light source rather than moving it onto the viewport');
  assert.ok(ctx.fills.every(({rect:[x,y,w,h]})=>x>=400&&y>=400&&x+w<=800&&y+h<=800));
  assert.equal(ctx.globalAlpha,.8,'the next renderer must retain its original opacity');
  assert.equal(ctx.globalCompositeOperation,'source-over');
  assert.equal(ctx.lineWidth,3);
});

test('colored lines stay on the same world lattice when the viewport pans',()=>{
  for(const bounds of [{minX:901,maxX:1179,minY:916,maxY:1117},{minX:947,maxX:1203,minY:889,maxY:1151}]){
    const ctx=recordingContext();drawGroundLight(ctx,[cell(1013,1009)],.85,bounds);
    const coordinates=gridCoordinates(ctx);
    assert.ok(coordinates.length>0);
    assert.ok(coordinates.every(value=>value%40===0),'panning must not translate the lit grid or add new line positions');
  }
});

test('distant illumination does not bring back the hidden minor grid',()=>{
  const far=recordingContext(),near=recordingContext();
  drawGroundLight(far,[cell()],.2);drawGroundLight(near,[cell()],.8);
  assert.ok(gridCoordinates(far).every(value=>value%200===0));
  assert.ok(gridCoordinates(near).some(value=>value%200!==0));
});

test('player and bot floor light share identical geometry and brightness',()=>{
  const player=recordingContext(),bot=recordingContext();
  drawGroundLight(player,[cell(1000,1000,true)],1);
  drawGroundLight(bot,[cell(1000,1000,false)],1);
  const snapshot=ctx=>({
    gradients:ctx.gradients.map(({radii,stops})=>({radii,stops})),
    strokes:ctx.strokes.map(({path,alpha,width})=>({path,alpha,width})),
    fills:ctx.fills.map(({rect,alpha})=>({rect,alpha})),
  });
  assert.deepEqual(snapshot(player),snapshot(bot));
  assert.equal(player.gradients.length,1,'reuse one falloff for the wash and every lit grid line');
  assert.ok(player.fills.every(fill=>fill.gradient===player.gradients[0]));
  assert.ok(player.strokes.every(stroke=>stroke.gradient===player.gradients[0]));
  const stops=player.gradients[0].stops;
  assert.equal(stops.at(-1).color.slice(-2),'00','light must reach transparency at its outer boundary');
  assert.ok(stops.every((stop,i)=>!i||parseInt(stop.color.slice(-2),16)<=parseInt(stops[i-1].color.slice(-2),16)));
});

test('light is clipped at world edges even when optional bounds are omitted',()=>{
  const ctx=recordingContext();drawGroundLight(ctx,[cell(10,10)],1);
  assert.deepEqual(ctx.clips[0],[{rect:[0,0,WORLD.width,WORLD.height]}]);
  assert.ok(ctx.fills.every(({rect:[x,y,w,h]})=>x>=0&&y>=0&&x+w<=WORLD.width&&y+h<=WORLD.height));
});
