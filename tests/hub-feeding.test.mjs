import test from 'node:test';
import assert from 'node:assert/strict';
import {Arena,SUPPLY} from '../dist/engine.mjs';
import {foodReward} from '../dist/balance.mjs';
import {updateClusterNetwork,HUB_MASS_CAP} from '../dist/clusters.mjs';

const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-8,message||`${actual} should equal ${expected}`);

function scene({masses=[400,200,200,200],isPlayer=true}={}){
  const arena=new Arena(()=>.5);
  arena.holders=[];arena.food=[];arena.events=[];arena.particles=[];arena.reserve=SUPPLY;
  const h=arena.addHolder('fixture','#73a7ed',masses.reduce((sum,mass)=>sum+mass,0),1000,1000,isPlayer,'fixture');
  h.cells=masses.map((mass,i)=>{
    const angle=(i-1)/Math.max(1,masses.length-1)*Math.PI*2;
    const cell=arena.makeCell(mass,i?1000+Math.cos(angle)*150:1000,i?1000+Math.sin(angle)*150:1000);
    cell.readyAt=1e6;return cell;
  });
  if(isPlayer)arena.player=h;
  const addFood=arena.addFood.bind(arena);arena.addFood=()=>false;
  const tick=()=>arena.update(0,{target:arena.center(h)});
  const dot=(c,mass=20)=>assert.equal(addFood(mass,c.x,c.y,h.color),true);
  const network=updateClusterNetwork(h);
  const hub=h.cells.find(c=>c.id===network.groups[0]?.hubId);
  return {arena,h,hub,collector:h.cells.find(c=>c!==hub)||h.cells[0],tick,dot};
}

test('natural-dot bonus is computed once, shared 70/30, and conserves total supply for players and bots',()=>{
  const results=[];
  for(const isPlayer of [true,false]){
    const {arena,h,hub,collector,tick,dot}=scene({isPlayer});
    const hubBefore=hub.mass,collectorBefore=collector.mass,totalBefore=arena.mass(h);
    const reward=foodReward(collector.mass,20,20);
    dot(collector);close(arena.totalMass(),SUPPLY);tick();
    close(collector.mass-collectorBefore,reward.total*.7);
    close(hub.mass-hubBefore,reward.total*.3);
    close(arena.mass(h)-totalBefore,reward.total,'the hub must not multiply the incoming transfer again');
    close(arena.totalMass(),SUPPLY);
    const events=arena.events.filter(event=>event.type==='hub-feed');assert.equal(events.length,1);
    const event=events[0];assert.equal(event.fromId,collector.id);assert.equal(event.toId,hub.id);
    close(event.mass,reward.total*.3);assert.equal(event.color,h.color);assert.equal(event.isPlayer,isPlayer);
    for(const key of ['x','y','toX','toY'])assert.ok(Number.isFinite(event[key]));
    assert.equal(arena.food.length,0);
    results.push({collector:collector.mass,hub:hub.mass,total:arena.mass(h),reserve:arena.reserve});
  }
  assert.deepEqual(results[0],results[1]);
});

test('passive hub transfer respects the post-pickup group cap and leaves the remainder with the collector',()=>{
  const {arena,h,hub,collector,tick,dot}=scene({masses:[480,170,170,170]});
  const before=arena.mass(h),hubBefore=hub.mass,collectorBefore=collector.mass;
  const reward=foodReward(collector.mass,100,100),room=(before+reward.total)*HUB_MASS_CAP-hubBefore;
  assert.ok(room>0&&room<reward.total*.3);
  dot(collector,100);tick();
  close(hub.mass,(before+reward.total)*HUB_MASS_CAP);
  close(collector.mass-collectorBefore,reward.total-room);
  assert.ok(collector.mass-collectorBefore>=reward.total*.7);
  close(arena.totalMass(),SUPPLY);
});

test('hub pickups, small holdings, remote members, and active player consolidation retain the whole pickup',()=>{
  for(const variant of ['hub','small','remote','consolidating']){
    const fixture=scene(variant==='small'?{masses:[400,200,200]}:{});
    const {arena,h,hub,tick,dot}=fixture;
    const collector=variant==='hub'?hub:fixture.collector;
    if(variant==='remote')collector.x+=1000;
    if(variant==='consolidating')arena.merging=true;
    const before=collector.mass,expected=foodReward(before,20,20).total;
    const otherMasses=h.cells.filter(c=>c!==collector).map(c=>[c.id,c.mass]);
    dot(collector);tick();
    close(collector.mass-before,expected,variant);
    assert.deepEqual(h.cells.filter(c=>c!==collector).map(c=>[c.id,c.mass]),otherMasses,variant);
    assert.equal(arena.events.filter(event=>event.type==='hub-feed').length,0,variant);
    close(arena.totalMass(),SUPPLY);
  }
});

test('a missing hub is replaced before the next pickup and no event targets the removed cell',()=>{
  const {arena,h,hub:oldHub,tick,dot}=scene({masses:[400,200,200,200,200,200]});
  h.cells=h.cells.filter(c=>c!==oldHub);arena.reserve+=oldHub.mass;
  const network=updateClusterNetwork(h),hub=h.cells.find(c=>c.id===network.groups[0].hubId);
  const collector=h.cells.filter(c=>c!==hub).sort((a,b)=>Math.hypot(a.x-hub.x,a.y-hub.y)-Math.hypot(b.x-hub.x,b.y-hub.y))[0];
  const before=arena.mass(h),expected=foodReward(collector.mass,20,20).total;
  dot(collector);tick();
  close(arena.mass(h)-before,expected);close(arena.totalMass(),SUPPLY);
  const events=arena.events.filter(event=>event.type==='hub-feed');assert.equal(events.length,1);
  assert.equal(events[0].toId,hub.id);assert.notEqual(events[0].toId,oldHub.id);
});

test('ejected pellets stay direct for either owner and never feed the hub',()=>{
  for(const ownPellet of [true,false]){
    const {arena,h,hub,collector,tick}=scene();
    assert.equal(arena.eject({x:2000,y:1000}),true);
    const pellet=arena.food[1];
    arena.food.forEach((f,i)=>{f.x=300+i*50;f.y=300;f.vx=0;f.vy=0;});
    pellet.x=collector.x;pellet.y=collector.y;pellet.unlockAt=0;
    if(!ownPellet)pellet.ownerId=999999;
    const before=collector.mass,hubBefore=hub.mass,totalBefore=arena.mass(h);
    tick();
    close(collector.mass-before,14);close(hub.mass,hubBefore);close(arena.mass(h)-totalBefore,14);
    assert.equal(arena.events.filter(event=>event.type==='hub-feed').length,0);
    close(arena.totalMass(),SUPPLY);
  }
});

test('absorbed opponent mass remains entirely on the consuming cell',()=>{
  const {arena,h,hub,collector,tick}=scene();
  const prey=arena.addHolder('prey','#e992b2',40,collector.x,collector.y,false,'prey');
  const before=collector.mass,hubBefore=hub.mass,totalBefore=arena.mass(h);
  tick();
  assert.equal(prey.cells.length,0);close(collector.mass-before,40);close(hub.mass,hubBefore);
  close(arena.mass(h)-totalBefore,40);close(arena.totalMass(),SUPPLY);
  assert.equal(arena.events.filter(event=>event.type==='hub-feed').length,0);
  assert.equal(arena.events.filter(event=>event.type==='absorb').length,1);
});
