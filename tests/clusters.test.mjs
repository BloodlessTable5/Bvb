import test from 'node:test';
import assert from 'node:assert/strict';
import {updateClusterNetwork,quoteHubFeed,HUB_FEED_SHARE,HUB_MASS_CAP} from '../dist/clusters.mjs';
import {Arena,SUPPLY} from '../dist/engine.mjs';

const holder = count => ({cells:Array.from({length:count},(_,i)=>({
  id:i+1,x:1000+(i%4)*100,y:1000+Math.floor(i/4)*100,mass:225,
}))});
const snapshot = network => ({groups:network.groups,links:network.links,hubByCell:[...network.hubByCell]});

function verifyTopology(h,network){
  const ids=new Set(h.cells.map(c=>c.id)),pairs=new Set(),neighbors=new Map([...ids].map(id=>[id,new Set()]));
  for(const edge of network.links){
    assert.ok(ids.has(edge.aId)&&ids.has(edge.bId),'links must stay within this holder');
    assert.ok(edge.aId<edge.bId,'edges must have distinct canonical endpoints');
    assert.ok(['spoke','neighbor','bridge'].includes(edge.kind));
    const pair=`${edge.aId}:${edge.bId}`;assert.ok(!pairs.has(pair),'no duplicate connections');pairs.add(pair);
    neighbors.get(edge.aId).add(edge.bId);neighbors.get(edge.bId).add(edge.aId);
  }
  if(ids.size){
    const connected=new Set([h.cells[0].id]),queue=[h.cells[0].id];
    for(const id of queue)for(const next of neighbors.get(id))if(!connected.has(next)){connected.add(next);queue.push(next);}
    assert.equal(connected.size,ids.size,'every live cell remains connected');
  }
  return neighbors;
}

test('every 8+ cell holding has a small offshoot and sparse satellite bridges',()=>{
  for(const count of [4,7,8,9,10,11,12,13,16]){
    const h=holder(count),network=updateClusterNetwork(h),neighbors=verifyTopology(h,network);
    assert.equal(network.groups.length,count>=11?3:Math.ceil(count/6));
    const bridges=network.links.filter(edge=>edge.kind==='bridge'&&!edge.secondary).length;
    assert.ok(bridges===network.groups.length-1||(network.groups.length===3&&bridges===3));
    const secondary=network.links.filter(edge=>edge.secondary);
    assert.equal(secondary.length,network.groups.length-1);
    for(const edge of secondary){
      assert.equal(edge.kind,'bridge');
      assert.notEqual(network.hubByCell.get(edge.aId),network.hubByCell.get(edge.bId));
      assert.notEqual(network.hubByCell.get(edge.aId),edge.aId,'secondary routes should reach satellites');
      assert.notEqual(network.hubByCell.get(edge.bId),edge.bId);
    }
    for(const [id,adjacent] of neighbors){
      const group=network.groups.find(group=>group.memberIds.includes(id));
      assert.ok(adjacent.size>=(group.offshoot&&group.memberIds.length===2?1:2));
    }
    assert.ok(network.links.length>count-1,'hub clusters should not be a single chain');
    assert.ok(network.links.length<=count*2,'connections stay sparse enough to read');
    const members=network.groups.flatMap(group=>group.memberIds);
    assert.deepEqual([...members].sort((a,b)=>a-b),h.cells.map(c=>c.id));
    const sizes=network.groups.map(group=>group.memberIds.length);
    const offshoots=network.groups.filter(group=>group.offshoot);
    assert.equal(offshoots.length,count>=8?1:0);
    if(offshoots.length){
      assert.ok([2,3].includes(offshoots[0].memberIds.length));
      assert.ok(sizes.every(size=>size>=2&&size<=7));
    }else{
      assert.ok(Math.max(...sizes)-Math.min(...sizes)<=1);
      assert.ok(sizes.every(size=>size>=3&&size<=6));
    }
    for(const group of network.groups){
      assert.ok(group.memberIds.includes(group.hubId));
      for(const id of group.memberIds)assert.equal(network.hubByCell.get(id),group.hubId);
    }
  }
});

test('small holdings keep a simple connected graph without routing food to a hub',()=>{
  for(let count=0;count<4;count++){
    const h=holder(count),network=updateClusterNetwork(h);
    verifyTopology(h,network);assert.deepEqual(network.groups,[]);assert.equal(network.hubByCell.size,0);
    assert.equal(network.links.length,Math.max(0,count-1));
    assert.deepEqual(quoteHubFeed(h,h.cells[0],20),{hubId:null,transferred:0,retained:20});
  }
});

test('spatial groups keep clearly separated neighborhoods together and are deterministic',()=>{
  const h=holder(8);h.wallet='fixture-layout-13';
  h.cells.forEach((c,i)=>{c.x=(i<6?700:2200)+(i%2)*70;c.y=1000+(Math.floor(i/2)%3)*70;});
  const network=updateClusterNetwork(h),replica=updateClusterNetwork({wallet:h.wallet,cells:structuredClone(h.cells).reverse()});
  assert.deepEqual(snapshot(network),snapshot(replica));
  assert.ok(network.groups.some(group=>group.memberIds.length===6&&group.memberIds.every(id=>id<=6)));
  assert.ok(network.groups.some(group=>group.offshoot&&group.memberIds.every(id=>id>6)));
});

test('membership caching preserves roles while cells move, grow, or reorder',()=>{
  const h=holder(8),network=updateClusterNetwork(h),roles=snapshot(network);
  h.cells.reverse();h.cells.forEach((c,i)=>{c.x+=i*300;c.y-=i*40;c.mass=i===0?15000:80;});
  assert.equal(updateClusterNetwork(h),network);
  assert.deepEqual(snapshot(updateClusterNetwork(h)),roles);
  assert.notEqual(updateClusterNetwork(holder(8)),network,'holders have independent caches even when IDs match');
});

test('split, loss, and merge rebuild topology while keeping every surviving hub possible',()=>{
  const h=holder(6),first=updateClusterNetwork(h),firstHub=first.groups[0].hubId;
  h.cells.push({id:7,x:1450,y:1150,mass:112.5});
  const split=updateClusterNetwork(h);assert.notEqual(split,first);verifyTopology(h,split);
  assert.equal(split.groups.length,2);assert.ok(split.groups.some(group=>group.hubId===firstHub));
  const secondHub=split.groups.find(group=>group.hubId!==firstHub).hubId;
  h.cells.push({id:8,x:1450,y:1250,mass:112.5});
  const grown=updateClusterNetwork(h);
  assert.ok(grown.groups.some(group=>group.hubId===firstHub));assert.ok(grown.groups.some(group=>group.hubId===secondHub));
  h.cells=h.cells.filter(c=>c.id!==secondHub);
  const lost=updateClusterNetwork(h);verifyTopology(h,lost);
  assert.ok(lost.groups.some(group=>group.hubId===firstHub));
  assert.ok(!lost.groups.some(group=>group.hubId===secondHub));
  const remove=h.cells.find(c=>!lost.groups.some(group=>group.hubId===c.id));
  h.cells=h.cells.filter(c=>c!==remove);
  const merged=updateClusterNetwork(h);verifyTopology(h,merged);assert.equal(merged.groups.length,1);
  assert.ok(lost.groups.some(group=>group.hubId===merged.groups[0].hubId));
});

test('coincident cell positions still produce finite deterministic connected groups',()=>{
  const h=holder(16);h.cells.forEach(c=>{c.x=1600;c.y=1200;});
  const network=updateClusterNetwork(h);verifyTopology(h,network);
  assert.deepEqual(snapshot(network),snapshot(updateClusterNetwork({cells:structuredClone(h.cells)})));
  assert.ok(network.links.every(edge=>Number.isFinite(edge.aId)&&Number.isFinite(edge.bId)));
});

test('holder seeds vary branch size and satellite routes without hiding offshoots behind chance',()=>{
  let twoMember=0,threeMember=0,triangles=0;
  const routes=new Set();
  for(let seed=0;seed<128;seed++){
    const h=holder(16);h.id=seed+1;h.wallet=`fixture-layout-${seed}`;
    const network=updateClusterNetwork(h);verifyTopology(h,network);
    assert.equal(network.groups.length,3,'variation must never add a fourth group');
    const branch=network.groups.find(group=>group.offshoot);
    assert.ok(branch,'every representative seed must expose an offshoot');
    if(branch.memberIds.length===2)twoMember++;else if(branch.memberIds.length===3)threeMember++;
    assert.ok(network.groups.every(group=>group.memberIds.length<=7));
    assert.equal(network.groups.indexOf(branch),2,'the third group is the small branch');
    const bridges=network.links.filter(edge=>edge.kind==='bridge'&&!edge.secondary).length;
    assert.ok(bridges===2||bridges===3);if(bridges===3)triangles++;
    const secondary=network.links.filter(edge=>edge.secondary);
    assert.equal(secondary.length,2);routes.add(JSON.stringify(secondary));
    const early={...holder(8),wallet:h.wallet};
    assert.equal(updateClusterNetwork(early).groups.find(group=>group.offshoot).memberIds.length,branch.memberIds.length);
  }
  assert.ok(twoMember>30&&threeMember>30,'both two- and three-member branches should occur');
  assert.ok(triangles>=60&&triangles<=95,'both bridge trees and occasional extra connections should occur');
  assert.ok(routes.size>=12,'satellite routes should visibly vary across holder seeds');
});

test('wallet and ID variants reproduce their choices without rerolling on motion or membership changes',()=>{
  const fingerprints=new Set();
  for(let seed=0;seed<20;seed++){
    const h=holder(16);h.id=seed;
    const network=updateClusterNetwork(h);
    const replica={id:seed,cells:structuredClone(h.cells).reverse()};
    assert.deepEqual(snapshot(network),snapshot(updateClusterNetwork(replica)));
    fingerprints.add(JSON.stringify([network.groups.map(group=>group.memberIds.length),network.links.filter(link=>link.kind==='bridge').length]));
    h.cells.reverse();h.cells.forEach((cell,i)=>{cell.x+=i*30;cell.mass+=i*10;});
    assert.equal(updateClusterNetwork(h),network);
  }
  assert.ok(fingerprints.size>=3,'distinct stable holder IDs should produce noticeable but restrained variety');
  const a={...holder(16),id:1,wallet:'shared-layout'},b={...holder(16),id:99,wallet:'shared-layout'};
  assert.deepEqual(snapshot(updateClusterNetwork(a)),snapshot(updateClusterNetwork(b)),'wallet identity takes precedence over cell or holder ordering');
});

test('live growth to three groups and later losses preserve surviving hubs and stable offshoot style',()=>{
  for(const seed of [1,3,13]){
    const h=holder(8);h.wallet=`fixture-layout-${seed}`;
    let network=updateClusterNetwork(h),priorHubs=network.groups.map(group=>group.hubId);
    const branchHub=network.groups.find(group=>group.offshoot).hubId;
    const branchSize=network.groups.find(group=>group.offshoot).memberIds.length;
    assert.equal(network.links.filter(link=>link.kind==='bridge').length,2);
    for(const cell of holder(16).cells.slice(8)){
      h.cells.push(cell);network=updateClusterNetwork(h);verifyTopology(h,network);
      assert.equal(network.groups.length,h.cells.length>=11?3:2);
      for(const id of priorHubs)assert.ok(network.groups.some(group=>group.hubId===id));
      const branch=network.groups.find(group=>group.offshoot);
      assert.equal(branch.hubId,branchHub,'growth keeps the existing offshoot hub');
      assert.equal(branch.memberIds.length,h.cells.length===10?3:branchSize);
      priorHubs=network.groups.map(group=>group.hubId);
    }
    const removedHub=priorHubs[1];h.cells=h.cells.filter(cell=>cell.id!==removedHub);
    network=updateClusterNetwork(h);verifyTopology(h,network);
    for(const id of priorHubs.filter(id=>id!==removedHub))assert.ok(network.groups.some(group=>group.hubId===id));
    assert.ok(!network.groups.some(group=>group.hubId===removedHub));
    while(h.cells.length>7){
      const nonHub=h.cells.find(cell=>!network.groups.some(group=>group.hubId===cell.id));
      h.cells=h.cells.filter(cell=>cell!==nonHub);network=updateClusterNetwork(h);verifyTopology(h,network);
    }
    assert.equal(network.groups.length,2);assert.ok(network.groups.every(group=>!group.offshoot));
    assert.equal(network.links.filter(link=>link.kind==='bridge').length,2);
  }
});

test('ordinary player splits reach visible offshoots at the starting mass and keep exact supply',()=>{
  for(const mass of [900,3200])for(const address of ['fixture-layout-3','fixture-layout-13']){
    const arena=new Arena(()=>.5);
    arena.holders=[];arena.food=[];arena.reserve=SUPPLY;arena.addFood=()=>false;
    const h=arena.addHolder('split fixture','#73a7ed',mass,1600,1200,true,address);arena.player=h;
    const limit=mass===900?8:16;
    for(let count=2;count<=limit;count*=2){
      const target={x:2200,y:1200};assert.equal(arena.split(target).ok,true);
      assert.equal(h.cells.length,count);assert.equal(arena.totalMass(),SUPPLY);
      const network=updateClusterNetwork(h);verifyTopology(h,network);
      if(count>=8){
        const branch=network.groups.find(group=>group.offshoot);
        assert.ok(branch);assert.ok([2,3].includes(branch.memberIds.length));
        assert.ok(network.links.some(link=>link.secondary&&
          (branch.memberIds.includes(link.aId)||branch.memberIds.includes(link.bId))));
      }
      for(let i=0;i<90;i++)arena.update(1/60,{target:arena.center(h)});
      assert.equal(updateClusterNetwork(h),network,'launch and movement keep the chosen topology');
      assert.equal(arena.totalMass(),SUPPLY);
    }
    assert.equal(arena.mass(h),mass);
  }
});

function feedingHolder(hubMass=400,memberMass=200){
  return {cells:[{id:1,x:1000,y:1000,mass:hubMass},{id:2,x:930,y:1000,mass:memberMass},
    {id:3,x:1035,y:1060,mass:memberMass},{id:4,x:1035,y:940,mass:memberMass}]};
}

test('hub feeding quotes only the new reward and conserves it without mutating cells',()=>{
  const h=feedingHolder(),network=updateClusterNetwork(h),before=structuredClone(h);
  assert.equal(network.groups[0].hubId,1);
  const quote=quoteHubFeed(h,h.cells[1],100,network);
  assert.deepEqual(quote,{hubId:1,transferred:30,retained:70});assert.deepEqual(h,before);
  assert.equal(quote.transferred+quote.retained,100);assert.ok(quote.retained>=100*(1-HUB_FEED_SHARE));
  const massBefore=h.cells.reduce((sum,c)=>sum+c.mass,0);
  h.cells[0].mass+=quote.transferred;h.cells[1].mass+=quote.retained;
  assert.equal(h.cells.reduce((sum,c)=>sum+c.mass,0),massBefore+100);
  assert.deepEqual(quoteHubFeed(h,h.cells[0],25),{hubId:1,transferred:0,retained:25});
});

test('passive hub growth stops at 45 percent of the group after the full pickup',()=>{
  const h=feedingHolder(480,170),quote=quoteHubFeed(h,h.cells[1],100);
  assert.equal(quote.transferred,10.5);assert.equal(quote.retained,89.5);
  const postGroup=h.cells.reduce((sum,c)=>sum+c.mass,0)+100;
  assert.equal(h.cells[0].mass+quote.transferred,postGroup*HUB_MASS_CAP);
  h.cells[0].mass=800;
  assert.equal(quoteHubFeed(h,h.cells[1],100).transferred,0,'existing mass is never drained to enforce the passive-growth cap');
});

test('a two-cell offshoot keeps pickups with its leaf until its initially 50-percent hub has cap room',()=>{
  const h=holder(16);h.wallet='fixture-layout-13';
  const network=updateClusterNetwork(h),branch=network.groups.find(group=>group.offshoot);
  assert.equal(branch.memberIds.length,2);
  const hub=h.cells.find(cell=>cell.id===branch.hubId),leaf=h.cells.find(cell=>branch.memberIds.includes(cell.id)&&cell!==hub);
  leaf.x=hub.x+80;leaf.y=hub.y;
  const before=h.cells.reduce((sum,cell)=>sum+cell.mass,0);
  assert.equal(hub.mass,leaf.mass);
  for(let i=0;i<2;i++){
    const quote=quoteHubFeed(h,leaf,20,network);
    assert.deepEqual(quote,{hubId:hub.id,transferred:0,retained:20});
    leaf.mass+=quote.retained;
  }
  const quote=quoteHubFeed(h,leaf,20,network);
  assert.equal(quote.transferred,4.5);assert.equal(quote.retained,15.5);
  hub.mass+=quote.transferred;leaf.mass+=quote.retained;
  assert.equal(hub.mass,(hub.mass+leaf.mass)*HUB_MASS_CAP);
  assert.equal(h.cells.reduce((sum,cell)=>sum+cell.mass,0),before+60);
});

test('remote or missing hubs and invalid rewards leave all available reward with the collector',()=>{
  const h=feedingHolder(),network=updateClusterNetwork(h);
  h.cells[1].x+=1000;
  assert.deepEqual(quoteHubFeed(h,h.cells[1],20,network),{hubId:1,transferred:0,retained:20});
  h.cells=h.cells.filter(c=>c.id!==1);
  assert.deepEqual(quoteHubFeed(h,h.cells[0],20,network),{hubId:null,transferred:0,retained:20});
  const clean=feedingHolder();
  for(const reward of [0,-1,NaN,Infinity]){
    const quote=quoteHubFeed(clean,clean.cells[1],reward);
    assert.equal(quote.transferred,0);assert.equal(quote.retained,0);
  }
});
