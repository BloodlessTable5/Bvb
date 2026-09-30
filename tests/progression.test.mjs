import test from 'node:test';
import assert from 'node:assert/strict';
import {ROUND_SECONDS,rankWeight,RoundTracker,ProgressionStore,progressionFor,previewProfile} from '../dist/progression.mjs';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} should equal ${expected}`);
const roster=()=>[{id:1,name:'leader',isPlayer:true,mass:1000},{id:2,name:'second',isPlayer:false,mass:700},{id:3,name:'third',isPlayer:false,mass:400}];
const memoryStorage=()=>{
  const values=new Map();
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
};

test('fixed top-ten weights have the documented rates and reject invalid ranks',()=>{
  for(const [rank,points] of [[1,100],[2,81],[5,36],[10,1],[11,0]])close(rankWeight(rank,20)*100,points);
  for(const [rank,population] of [[1,1],[1,0],[0,20],[-1,20],[21,20],[NaN,20],[1,Infinity],[1,2.5]])assert.equal(rankWeight(rank,population),0);
  assert.equal(ROUND_SECONDS,360);
});

test('padding the roster with lower-ranked entries cannot raise existing scores',()=>{
  for(const rank of [1,2,3,5,10]){
    close(rankWeight(rank,10),rankWeight(rank,100));close(rankWeight(rank,10),rankWeight(rank,1000));
  }
  const plain=new RoundTracker(),padded=new RoundTracker();
  plain.update(60,roster());
  padded.update(60,[...roster(),...Array.from({length:30},(_,i)=>({id:i+10,name:'padding',mass:50+i}))]);
  for(const original of plain.standings())close(padded.standings().find(row=>row.id===original.id).points,original.points);
});

test('equal masses receive deterministic midranks independent of roster order',()=>{
  const tied=[{id:2,name:'B',mass:100},{id:1,name:'A',mass:100},{id:3,name:'C',mass:50}];
  const a=new RoundTracker(),b=new RoundTracker();a.update(60,tied);b.update(60,[...tied].reverse());
  assert.deepEqual(a.standings(),b.standings());
  const rows=a.standings();
  for(const id of [1,2]){const row=rows.find(row=>row.id===id);close(row.points,90.25);close(row.meanRank,1.5);close(row.rankSeconds,90);}
  close(rows.find(row=>row.id===3).points,64);
});

test('scoring is timestep independent and cannot extend beyond the round interval',()=>{
  const large=new RoundTracker(),small=new RoundTracker();large.update(ROUND_SECONDS,roster());
  for(let i=0;i<ROUND_SECONDS*60;i++)small.update(1/60,roster());
  assert.equal(large.done,true);assert.equal(small.done,true);assert.equal(small.remaining,0);
  for(const row of large.standings()){
    const other=small.standings().find(entry=>entry.id===row.id);
    for(const key of ['points','rankSeconds','activeSeconds','meanRank'])close(other[key],row[key]);
  }
  const clamped=new RoundTracker({duration:10});clamped.update(8,roster());clamped.update(100,roster());
  close(clamped.standings()[0].points,100/6);assert.equal(clamped.elapsed,10);
  const before=clamped.snapshot();clamped.update(500,roster());assert.deepEqual(clamped.snapshot(),before);
});

test('late arrivals and dead or absent entries earn only their active intervals',()=>{
  const tracker=new RoundTracker();tracker.update(30,roster().slice(0,2));
  tracker.update(30,[roster()[0],{id:2,name:'dead',mass:0},{id:4,name:'late',mass:600}]);
  const rows=tracker.standings();
  close(rows.find(row=>row.id===1).activeSeconds,60);close(rows.find(row=>row.id===1).points,100);
  for(const id of [2,4]){const row=rows.find(row=>row.id===id);close(row.activeSeconds,30);close(row.points,40.5);}
  tracker.update(20,[]);
  assert.deepEqual(tracker.standings(),rows,'empty or dead rosters cannot earn activity XP or points');
  assert.equal(tracker.elapsed,80);
});

test('invalid elapsed time and entries cannot create negative or nonfinite scores',()=>{
  const tracker=new RoundTracker({duration:NaN});assert.equal(tracker.duration,ROUND_SECONDS);
  for(const dt of [0,-1,NaN,Infinity])tracker.update(dt,roster());
  assert.equal(tracker.elapsed,0);assert.deepEqual(tracker.standings(),[]);
  tracker.update(10,[...roster(),{id:4,mass:Infinity},{id:5,mass:-1},{id:NaN,mass:100},null]);
  assert.equal(tracker.standings().length,3);
  tracker.standings()[0].points=-1;assert.ok(tracker.standings()[0].points>0,'UI snapshots must not mutate scoring state');
});

test('local records earn XP only from supplied active time and points and persist idempotently',()=>{
  const storage=memoryStorage(),store=new ProgressionStore(storage);
  const record={id:'round-1',activeSeconds:60,points:100,peakShare:8.45};
  const profile=store.record('guest',record);
  assert.equal(profile.xp,35);assert.equal(profile.activeSeconds,60);assert.equal(profile.rounds,1);assert.equal(profile.bestShare,8.45);
  assert.deepEqual(store.record('guest',record),profile);
  const reopened=new ProgressionStore(storage);
  assert.deepEqual(reopened.record('guest',record),profile);
  for(let i=0;i<20;i++)assert.deepEqual(reopened.load('guest'),profile,'loading never awards wall-clock or offline progress');
  profile.history[0].points=-1;assert.equal(reopened.load('guest').history[0].points,100);
});

test('profile keys isolate progress and a zero or invalid active interval earns nothing',()=>{
  const store=new ProgressionStore(memoryStorage());
  store.record('wallet-A',{id:'same-session',activeSeconds:60,points:50,peakShare:20});
  assert.equal(store.load('wallet-B').xp,0);assert.equal(store.load('guest').xp,0);
  assert.equal(store.record('wallet-B',{id:'same-session',activeSeconds:60,points:0,peakShare:2}).xp,10);
  for(const activeSeconds of [0,-10,NaN,Infinity]){
    assert.equal(store.record('guest',{id:'invalid',activeSeconds,points:9999,peakShare:999}).xp,0);
  }
  const capped=store.record('guest',{id:'valid',activeSeconds:60,points:9999,peakShare:999});
  assert.equal(capped.points,100);assert.equal(capped.xp,35);assert.equal(capped.bestShare,100);
  const negative=store.record('guest',{id:'negative',activeSeconds:60,points:-10,peakShare:-1});
  assert.equal(negative.xp,45);assert.equal(negative.points,100);assert.equal(negative.bestShare,100);
});

test('recent history stays bounded while older saved session IDs still prevent duplicates',()=>{
  const storage=memoryStorage(),store=new ProgressionStore(storage);
  for(let i=0;i<130;i++)store.record('guest',{id:`session-${i}`,activeSeconds:1,points:1,peakShare:i/10});
  const profile=store.load('guest');assert.equal(profile.rounds,130);assert.equal(profile.history.length,20);
  assert.equal(profile.history[0].id,'session-129');assert.equal(profile.history.at(-1).id,'session-110');
  assert.deepEqual(new ProgressionStore(storage).record('guest',{id:'session-0',activeSeconds:1,points:1}),profile);
});

test('corrupt, unsupported, and invalid saves fall back safely without breaking another key',()=>{
  const storage=memoryStorage(),store=new ProgressionStore(storage);
  const good=store.record('wallet-good',{id:'safe',activeSeconds:60,points:30,peakShare:4});
  const validRaw=[...storage.values.values()][0];
  const wrongVersion=JSON.parse(validRaw);wrongVersion.version=99;
  const negative=JSON.parse(validRaw);negative.profile.xp=-1;
  for(const raw of ['{broken','{}','null',JSON.stringify(wrongVersion),JSON.stringify(negative)]){
    storage.values.set(store.key('broken'),raw);
    assert.equal(store.load('broken').xp,0);assert.deepEqual(store.load('wallet-good'),good);
  }
});

test('unavailable and quota-limited storage retain in-memory progress without throwing',()=>{
  const unavailable={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  for(const storage of [undefined,unavailable,{getItem:()=>null,setItem(){throw new Error('quota');}}]){
    const store=new ProgressionStore(storage),record={id:'one',activeSeconds:60,points:40,peakShare:5};
    const first=store.record('guest',record);assert.equal(first.xp,20);assert.deepEqual(store.load('guest'),first);
    assert.deepEqual(store.record('guest',record),first);
    assert.equal(store.record('guest',{...record,id:'two'}).xp,40);
  }
});

test('cosmetic levels and nodes grow monotonically, start at one, and cap at 180',()=>{
  assert.deepEqual(progressionFor({xp:0}),{level:1,nodes:1,clusters:1,levelProgress:0,xpToNext:100,xpIntoLevel:0,xpForLevel:100});
  assert.equal(progressionFor({xp:100}).level,2);assert.equal(progressionFor({xp:250}).level,3);
  let nodes=1,level=1;
  for(const xp of [1,50,100,250,600,1200,3000,10000,30000,100000,1e12]){
    const state=progressionFor({xp});assert.ok(state.nodes>=nodes&&state.level>=level);nodes=state.nodes;level=state.level;
    assert.ok(state.nodes<=180&&state.clusters<=10);assert.ok(state.levelProgress>=0&&state.levelProgress<=1);
    assert.ok(state.xpToNext>=0&&Number.isFinite(state.xpToNext));
  }
  assert.equal(progressionFor({xp:30000}).nodes,180);assert.equal(progressionFor({xp:30000}).clusters,10);
  for(const xp of [-1,NaN,Infinity])assert.equal(progressionFor({xp}).nodes,1);
});

test('illustrative previews use active time without persisting or modifying a real profile',()=>{
  const hour=previewProfile(3600),long=previewProfile(25*3600);
  assert.equal(hour.xp,1200);assert.equal(hour.points,2400);assert.equal(progressionFor(hour).nodes,23);
  assert.equal(long.xp,30000);assert.equal(progressionFor(long).nodes,180);
  assert.deepEqual(hour.history,[]);assert.deepEqual(hour.bubbleBirths,[]);assert.deepEqual(long.bubbleBirths,[]);
  assert.equal(previewProfile(-1).xp,0);
});

test('the first bubble gets one persisted birth date and returned birth records are detached',()=>{
  const storage=memoryStorage();let now=1_800_000_000_000;
  const store=new ProgressionStore(storage,{now:()=>now});
  const first=store.load('guest');
  assert.deepEqual(first.bubbleBirths,[{id:1,createdAt:now}]);
  assert.equal(JSON.parse(storage.values.get(store.key('guest'))).profile.bubbleBirths[0].createdAt,now);
  now+=86400000;
  const reopened=new ProgressionStore(storage,{now:()=>now});
  assert.deepEqual(reopened.load('guest'),first);
  first.bubbleBirths[0].createdAt=0;first.bubbleBirths.push({id:2,createdAt:0});
  assert.deepEqual(reopened.load('guest').bubbleBirths,[{id:1,createdAt:now-86400000}]);
});

test('v1 profiles migrate existing bubbles as unknown without losing progress or session deduplication',()=>{
  const storage=memoryStorage(),oldStore=new ProgressionStore(storage,{now:()=>1000});
  const entry={id:'legacy-round',activeSeconds:3600,points:2400,peakShare:8};
  const earned=oldStore.record('wallet-old',entry),key=oldStore.key('wallet-old');
  const legacy=JSON.parse(storage.values.get(key));delete legacy.profile.bubbleBirths;
  storage.values.set(key,JSON.stringify(legacy));
  const store=new ProgressionStore(storage,{now:()=>5000}),migrated=store.load('wallet-old');
  const expectedBirths=Array.from({length:progressionFor(earned).nodes},(_,i)=>({id:i+1,createdAt:null}));
  assert.deepEqual(migrated,{...earned,bubbleBirths:expectedBirths});
  assert.deepEqual(store.record('wallet-old',entry),migrated);
  assert.deepEqual(JSON.parse(storage.values.get(key)).profile.bubbleBirths,expectedBirths);
  const grown=store.record('wallet-old',{id:'new-round',activeSeconds:3600,points:2400});
  assert.deepEqual(grown.bubbleBirths.slice(0,expectedBirths.length),expectedBirths);
  assert.ok(grown.bubbleBirths.slice(expectedBirths.length).every(birth=>birth.createdAt===5000));
});

test('each growth award dates only its new ordinals and duplicate rounds never restamp births',()=>{
  const storage=memoryStorage();let now=1000;
  const store=new ProgressionStore(storage,{now:()=>now});store.load('guest');
  now=2000;
  const firstEntry={id:'growth-one',activeSeconds:3600,points:2400};
  const first=store.record('guest',firstEntry);
  assert.equal(first.bubbleBirths.length,23);assert.equal(first.bubbleBirths[0].createdAt,1000);
  assert.ok(first.bubbleBirths.slice(1).every(birth=>birth.createdAt===2000));
  now=3000;
  const second=store.record('guest',{id:'growth-two',activeSeconds:5400,points:3600});
  assert.ok(second.bubbleBirths.length>first.bubbleBirths.length);
  assert.deepEqual(second.bubbleBirths.slice(0,first.bubbleBirths.length),first.bubbleBirths);
  assert.ok(second.bubbleBirths.slice(first.bubbleBirths.length).every(birth=>birth.createdAt===3000));
  now=4000;
  assert.deepEqual(store.record('guest',firstEntry),second);
  assert.deepEqual(new ProgressionStore(storage,{now:()=>now}).record('guest',firstEntry),second);
  const capped=store.record('guest',{id:'maximum-growth',activeSeconds:900000,points:1500000});
  assert.equal(capped.bubbleBirths.length,180);
  assert.deepEqual(capped.bubbleBirths.map(birth=>birth.id),Array.from({length:180},(_,i)=>i+1));
});

test('birth histories remain independent by wallet and survive unavailable storage in memory',()=>{
  const storage=memoryStorage();let now=1000;
  const store=new ProgressionStore(storage,{now:()=>now}),a=store.load('wallet-A');
  now=2000;const b=store.load('wallet-B');
  assert.equal(a.bubbleBirths[0].createdAt,1000);assert.equal(b.bubbleBirths[0].createdAt,2000);
  store.record('wallet-B',{id:'shared-id',activeSeconds:3600,points:2400});
  assert.deepEqual(store.load('wallet-A'),a);
  for(const unavailable of [undefined,{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}]){
    now=3000;const memory=new ProgressionStore(unavailable,{now:()=>now}),initial=memory.load('guest');
    now=4000;assert.deepEqual(memory.load('guest'),initial);
    const grown=memory.record('guest',{id:'new',activeSeconds:3600,points:2400});
    assert.equal(grown.bubbleBirths[0].createdAt,3000);
    assert.ok(grown.bubbleBirths.slice(1).every(birth=>birth.createdAt===4000));
  }
});

test('malformed optional birth dates normalize independently of valid XP and history',()=>{
  const storage=memoryStorage(),store=new ProgressionStore(storage,{now:()=>9999});
  const original=store.record('guest',{id:'valid-history',activeSeconds:3600,points:2400,peakShare:7});
  const saved=JSON.parse(storage.values.get(store.key('guest')));
  saved.profile.bubbleBirths=[{id:1,createdAt:800},{id:1,createdAt:600},{id:1,createdAt:-1},
    {id:2,createdAt:0},{id:3,createdAt:'1000'},{id:4,createdAt:1000.9},{id:5,createdAt:8.64e15+1},
    {id:0,createdAt:1000},{id:181,createdAt:1000},null,{id:6,createdAt:Infinity}];
  storage.values.set(store.key('guest'),JSON.stringify(saved));
  const loaded=store.load('guest');
  assert.deepEqual(loaded.history,original.history);assert.equal(loaded.xp,original.xp);
  assert.deepEqual(loaded.bubbleBirths.slice(0,6),[
    {id:1,createdAt:600},{id:2,createdAt:0},{id:3,createdAt:null},
    {id:4,createdAt:1000},{id:5,createdAt:null},{id:6,createdAt:null},
  ]);
  assert.equal(loaded.bubbleBirths.length,23);
  saved.profile.bubbleBirths={bad:'shape'};storage.values.set(store.key('guest'),JSON.stringify(saved));
  const unknown=store.load('guest');assert.equal(unknown.xp,original.xp);
  assert.ok(unknown.bubbleBirths.every(birth=>birth.createdAt===null));
});

test('loading unsupported or corrupt saves preserves their raw bytes and a stable session fallback',()=>{
  const seedStorage=memoryStorage(),seedStore=new ProgressionStore(seedStorage,{now:()=>1000});
  seedStore.record('future',{id:'existing-progress',activeSeconds:3600,points:2400});
  const future=JSON.parse(seedStorage.values.get(seedStore.key('future')));
  future.version=2;future.profile.version=2;
  assert.equal(future.profile.xp,1200);
  for(const raw of [JSON.stringify(future),'{broken','{}','',JSON.stringify({...future,version:1})]){
    const storage=memoryStorage();let now=2000,writes=0;
    const key=seedStore.key('future');storage.values.set(key,raw);
    const write=storage.setItem;storage.setItem=(...args)=>{writes++;write(...args);};
    const store=new ProgressionStore(storage,{now:()=>now}),first=store.load('future');
    now=3000;assert.deepEqual(store.load('future'),first);
    assert.equal(storage.values.get(key),raw,'Unrecognized data must remain recoverable');
    assert.equal(writes,0);assert.equal(store.unsaved.has(key),false);
    assert.deepEqual(first.bubbleBirths,[{id:1,createdAt:2000}]);
  }
});

test('an unreadable storage backend cannot be overwritten by loading a fallback profile',()=>{
  for(const hasGetter of [true,false]){
    let now=4000,writes=0;
    const storage={setItem(){writes++;}};
    if(hasGetter)storage.getItem=()=>{throw Error('read denied');};
    const store=new ProgressionStore(storage,{now:()=>now}),first=store.load('guest');
    now=5000;assert.deepEqual(store.load('guest'),first);
    assert.equal(first.bubbleBirths[0].createdAt,4000);assert.equal(writes,0);
    assert.equal(store.unsaved.has(store.key('guest')),false);
  }
});
