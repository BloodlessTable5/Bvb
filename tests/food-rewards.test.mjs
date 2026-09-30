import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, SUPPLY } from '../dist/engine.mjs';
import { foodReward } from '../dist/balance.mjs';

function scene(mass=80,isPlayer=true){
  const arena=new Arena(()=>.5);
  arena.holders=[];arena.food=[];arena.reserve=SUPPLY;arena.addFood=()=>false;
  const holder=arena.addHolder('collector','#73a7ed',mass,1000,1000,isPlayer,'collector');
  const cell=holder.cells[0];cell.target={x:cell.x,y:cell.y};cell.thinkAt=Infinity;
  if(isPlayer)arena.player=holder;
  return {arena,holder,cell};
}
function dot(arena,cell,mass=20,extra={}){
  const bonusMass=extra.bonusMass??(extra.ownerId!=null?0:mass);
  arena.reserve-=mass+bonusMass;
  const food={id:arena.nextId++,mass,bonusMass,x:cell.x,y:cell.y,color:'#73a7ed',vx:0,vy:0,...extra};
  arena.food.push(food);return food;
}
function step(arena,holder){arena.update(0,{target:arena.center(holder)});}
function conserved(arena){
  assert(Math.abs(arena.totalMass()-SUPPLY)<1e-7);
  assert(arena.reserve>=0);
}
function leaveReserve(arena,amount){
  const bank=arena.addHolder('distant holder','#edb66f',arena.reserve-amount,2600,1800,false,'bank');
  bank.cells[0].target={x:2600,y:1800};bank.cells[0].thinkAt=Infinity;
}

test('natural fields remain dense and visible while each dot carries less than ten base mass',()=>{
  for(const random of [()=>0,()=>.5,()=>.9999]){
    const arena=new Arena(random);
    assert.equal(arena.food.length,450,'initial field density must not fall with reward size');
    for(const food of arena.food){
      assert(food.mass>=4.2-1e-9&&food.mass<10);
      assert(food.visualMass>=12-1e-9&&food.visualMass<=28+1e-9,'glowing beads keep their old visual range');
      assert.equal(food.bonusMass,food.mass,'the entire small-cell bonus is funded at spawn');
      assert(foodReward(80,food.mass,food.bonusMass).total<20);
    }
    conserved(arena);
  }
  const arena=new Arena(()=>.5);
  arena.holders=[];arena.food=[];arena.reserve=SUPPLY;
  arena.update(0);
  assert.equal(arena.food.length,3,'refill still adds up to three dots each simulation step');
  for(let i=0;i<160;i++)arena.update(0);
  assert.equal(arena.food.length,450,'refill must stop at the same field target');
  conserved(arena);
});

test('repeated natural pickups slow farming while the split-size incentive remains useful',()=>{
  const farm=(start,legacy=false)=>{
    const {arena,holder,cell}=scene(start);
    const spawn=Arena.prototype.addFood.bind(arena);
    for(let i=0;i<40;i++){
      assert(spawn(legacy?20:undefined,cell.x,cell.y,'#73a7ed'));
      step(arena,holder);
      conserved(arena);
    }
    return cell.mass-start;
  };
  const small=farm(80),oldSmall=farm(80,true),large=farm(1200);
  assert(small<oldSmall*.5,'the same number of pickups should take much longer to build size');
  assert(small>large*1.5,'small split collectors should still gain substantially more per dot');
  assert(Math.abs(large-280)<1e-7,'forty average dots give only 280 mass to a large collector');
});

test('small players and bots receive the same funded bonus; large cells return unused allowance',()=>{
  for(const isPlayer of [true,false])for(const mass of [80,450,1200]){
    const {arena,holder,cell}=scene(mass,isPlayer);
    dot(arena,cell);
    const reserve=arena.reserve,reward=foodReward(mass,20,20);
    step(arena,holder);
    assert.equal(cell.mass,mass+reward.total);
    assert.equal(arena.reserve,reserve+20-reward.bonus);
    assert.equal(arena.food.length,0);
    if(isPlayer)assert.equal(arena.peak,cell.mass);
    conserved(arena);
  }
});

test('every pickup uses the current cell size and conserves supply through fractional growth',()=>{
  const {arena,holder,cell}=scene(80);
  let previousBonus=Infinity;
  for(let i=0;i<80;i++){
    dot(arena,cell,12.25);
    const before=cell.mass,reward=foodReward(before,12.25,12.25);
    step(arena,holder);
    assert(Math.abs(cell.mass-before-reward.total)<1e-9);
    assert(reward.bonus<=previousBonus);
    previousBonus=reward.bonus;
    conserved(arena);
  }
  assert.equal(previousBonus,0,'the bonus should taper out as the collector grows');
});

test('legacy partial or empty dot allowances cap bonuses without changing the base pickup',()=>{
  for(const remaining of [3,0]){
    const {arena,holder,cell}=scene();dot(arena,cell,20,{bonusMass:remaining});leaveReserve(arena,0);
    step(arena,holder);
    assert.equal(cell.mass,100+remaining);
    assert.equal(arena.reserve,0);
    conserved(arena);
  }
});

test('split cells collect their funded dots without double-crediting or drawing on free reserve',()=>{
  const {arena,holder,cell}=scene(240);
  cell.mass=80;
  const other=arena.makeCell(160,1400,1000);holder.cells.push(other);
  dot(arena,cell);dot(arena,other);leaveReserve(arena,0);
  step(arena,holder);
  const second=foodReward(160,20,20);
  assert.equal(arena.mass(holder),280+second.total);
  assert.equal(arena.food.length,0);
  assert.equal(arena.reserve,20-second.bonus);
  conserved(arena);
});

test('a funded arena dot gives the full small-cell bonus after free reserve runs out',()=>{
  const {arena,holder,cell}=scene();
  dot(arena,cell);leaveReserve(arena,0);
  step(arena,holder);
  assert.equal(cell.mass,120);
  assert.equal(arena.reserve,0);
  conserved(arena);
});

test('spawning funds a dot atomically and reserves the player start even with expensive dots',()=>{
  const arena=new Arena(()=>.9999);
  const player=arena.join('player','#73a7ed','player');
  assert.equal(player.cells[0].mass,900);
  assert(arena.food.length>0);
  assert(arena.food.every(f=>f.bonusMass===f.mass));
  conserved(arena);
  const previous=arena.food.length;
  const reserve=arena.reserve;
  assert.equal(arena.addFood(reserve/2+1,1000,1000),false);
  assert.equal(arena.food.length,previous);
  assert.equal(arena.reserve,reserve);
  conserved(arena);
});

test('ejecting and recollecting cannot generate bonus mass after the unlock',()=>{
  const {arena,holder,cell}=scene(160);
  assert.equal(arena.eject({x:1200,y:1000}),true);
  const pellet=arena.food[0];pellet.x=cell.x;pellet.y=cell.y;pellet.vx=pellet.vy=0;
  const reserve=arena.reserve;cell.vx=cell.vy=0;
  step(arena,holder);
  assert.equal(cell.mass,146,'the original owner must still wait for the pellet unlock');
  arena.time=pellet.unlockAt;
  step(arena,holder);
  assert.equal(cell.mass,160);
  assert.equal(arena.reserve,reserve);
  assert.equal(arena.food.length,0);
  conserved(arena);
});

test('enemy ejected pellets give base mass even while still locked to their original owner',()=>{
  const {arena,holder,cell}=scene();
  dot(arena,cell,14,{ownerId:999,unlockAt:100});
  const reserve=arena.reserve;
  step(arena,holder);
  assert.equal(cell.mass,94);
  assert.equal(arena.reserve,reserve);
  conserved(arena);
});
