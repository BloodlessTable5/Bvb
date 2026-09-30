import { Arena, COLORS, COLOR_NAMES, WORLD, SUPPLY, MERGE_TIME, OBSTACLES, radius, wallet, shortWallet } from './engine.mjs';
import { MovementControls, MOVEMENT_KEYS, edgeIndicator } from './navigation.mjs';
import { ABSORPTION_DURATION, BubbleVisuals, paintBubble, paintBubbleShadow, traceBubble } from './bubbles.mjs';
import { normalizeHighlight, setupHighlightPicker } from './appearance.mjs';
import { drawArenaBackground } from './arena-background.mjs';
import { DEATH_EFFECT_DURATION, NeonEffects, drawGroundLight, drawNeonFood } from './neon.mjs';
import { foodMultiplier } from './balance.mjs';
import { updateClusterNetwork } from './clusters.mjs';
import { drawClusterLinks, ClusterTransfers } from './cluster-links.mjs';
import { RoundTracker, ProgressionStore, ROUND_SECONDS } from './progression.mjs';
import { PhantomIdentity } from './wallet.mjs';
import { LobbyView } from './lobby.mjs';
const $=selector=>document.querySelector(selector);
const canvas=$('#arena'),ctx=canvas.getContext('2d'),mini=$('#mini'),mctx=mini.getContext('2d');
const game=new Arena();
const controls=new MovementControls();
let playerWallet=wallet(),color=COLORS[0],mode='lobby',paused=false,helpPaused=false;
let width=0,height=0,dpr=1,lastTime=0,hudAt=0,toastUntil=0,touchActive=false;
let camera={x:1600,y:1200,zoom:.6};
let pointer={x:0,y:0,active:false},keys={},aim={x:1780,y:1330};
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
const bubbles=new BubbleVisuals({reducedMotion});
const neon=new NeonEffects({reducedMotion});
const transfers=new ClusterTransfers({reducedMotion});
let pendingDeath=null;
let lobby=null,round=null,roundId=null,roundProfileKey='guest',roundSaved=true;
const profileStorage=(()=>{try{return localStorage}catch{return null}})();
const progression=new ProgressionStore(profileStorage);
let profileKey='guest',profile=progression.load(profileKey);
const identity=new PhantomIdentity({onChange:walletChanged});
const safePrefs=(()=>{try{const value=JSON.parse(localStorage.getItem('holder.preferences')||'{}');return value&&typeof value==='object'?value:{}}catch{return {}}})();
if(typeof safePrefs.name==='string')$('#username').value=safePrefs.name.slice(0,18);
if(COLORS.includes(safePrefs.color))color=safePrefs.color;
let playerHighlight=normalizeHighlight(safePrefs.highlight);
const highlightPicker=setupHighlightPicker({initialColor:playerHighlight,onChange(value){playerHighlight=value;savePreferences();lobby?.setAppearance({name:$('#username').value.trim()||'anon',color,highlight:playerHighlight});}});
function savePreferences(name=$('#username').value.trim().slice(0,18)||'anon'){try{localStorage.setItem('holder.preferences',JSON.stringify({name,color,highlight:playerHighlight}))}catch{}}
$('#preview-wallet').textContent=shortWallet(playerWallet);
$('#swatches').replaceChildren(...COLORS.map((c,i)=>{const swatch=document.createElement('input');swatch.className='swatch';swatch.type='radio';swatch.name='color';swatch.value=c;swatch.setAttribute('aria-label',COLOR_NAMES[i]);swatch.style.setProperty('--swatch',c);swatch.checked=c===color;swatch.addEventListener('change',()=>{color=c;updateIdentity()});return swatch}));
function updateIdentity(){document.documentElement.style.setProperty('--player',color);$('#preview-name').textContent=$('#username').value.trim()||'anon';$('#color-name').textContent=COLOR_NAMES[COLORS.indexOf(color)];lobby?.setAppearance({name:$('#username').value.trim()||'anon',color,highlight:playerHighlight});}
$('#username').addEventListener('input',updateIdentity);updateIdentity();
lobby=new LobbyView({canvas:$('#lobby-canvas'),reducedMotion,onConnect:()=>identity.connect(),onDisconnect:()=>identity.disconnect()});
function updateLobby(){
  const sessionOnly=!profileStorage||progression.unsaved.has(progression.key(profileKey));
  lobby?.update(profile,{name:$('#username').value.trim()||'anon',color,highlight:playerHighlight,identityLabel:identity.state.address?shortWallet(identity.state.address):'Guest profile',connected:!!identity.state.address,walletStatus:sessionOnly?'Browser storage is unavailable. Progress lasts for this session.':identity.state.message,seed:profileKey});
  $('#profile-save-note').textContent=sessionOnly?'Session-only cosmetic progression':'Saved on this browser · cosmetic progression';
}
function walletChanged(state){
  const nextKey=state.address||'guest';
  if(nextKey!==profileKey){
    // A run belongs to the profile that started it, even if Phantom changes accounts.
    if(mode==='playing')toLobby();
    profileKey=nextKey;profile=progression.load(profileKey);
    playerWallet=state.address||wallet();$('#preview-wallet').textContent=shortWallet(playerWallet);
    lobby?.showCurrent();
  }
  updateLobby();$('#wallet-connect').disabled=state.status==='connecting';
  if(state.status==='error'||state.status==='unavailable'){toast(state.message);toastUntil=performance.now()+6500;}
}
function runStats(){return round?.standings().find(entry=>entry.id===game.player?.id)||{points:0,activeSeconds:0,meanRank:null};}
function saveRun(){
  if(!round||roundSaved)return 0;
  const stats=runStats(),before=progression.load(roundProfileKey);
  const after=progression.record(roundProfileKey,{id:roundId,activeSeconds:stats.activeSeconds,points:stats.points,peakShare:game.peak/SUPPLY*100});
  roundSaved=true;
  if(roundProfileKey===profileKey){profile=after;updateLobby();}
  return after.xp-before.xp;
}
function showRunResult(event=null){
  const earned=saveRun(),stats=runStats();paused=true;keys={};controls.clear();
  $('#death-heading').textContent=event?'Your bag got eaten.':'Round complete.';
  $('#death-description').textContent=event?`${event.name} absorbed your last bubble. Your cosmetic growth stays with you.`:'Six minutes, a fresh start. Your arena size resets; your constellation keeps growing.';
  $('#peak-result').textContent=(game.peak/SUPPLY*100).toFixed(2)+'%';$('#eaten-result').textContent=game.eaten;
  $('#run-xp').textContent=`+${earned.toFixed(1)} XP`;
  $('#round-summary').textContent=`${stats.points.toFixed(1)} round points · ${Math.floor(stats.activeSeconds/60)}m ${Math.floor(stats.activeSeconds%60)}s played · practice only`;
  $('#death-dialog').showModal();
}
function resize(){const box=canvas.getBoundingClientRect();width=box.width;height=box.height;dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(mode==='lobby')camera.zoom=Math.min(width/2700,height/1800);lobby?.resize();}
addEventListener('resize',resize);resize();
updateLobby();
function toast(text){$('#feed').textContent=text;$('#feed').classList.add('visible');toastUntil=performance.now()+2600;}
function join(name=$('#username').value.trim(),selectedColor=color,selectedHighlight=playerHighlight){
  saveRun();
  name=name.trim().slice(0,18)||'anon';color=selectedColor;playerHighlight=normalizeHighlight(selectedHighlight);highlightPicker.setColor(playerHighlight);updateIdentity();
  game.join(name,color,playerWallet);bubbles.reset();neon.reset();transfers.reset();pendingDeath=null;mode='playing';paused=false;keys={};controls.reset();pointer.active=false;touchActive=false;camera={x:1580,y:1330,zoom:.78};aim={x:1760,y:1330};
  round=new RoundTracker({duration:ROUND_SECONDS});roundId=crypto.randomUUID();roundProfileKey=profileKey;roundSaved=false;
  document.body.classList.add('playing');$('#join-panel').hidden=true;$('#player-panel').hidden=false;$('#action-controls').hidden=false;$('#pause-button').hidden=false;$('.footer-note').hidden=true;
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
  savePreferences(name);
  toast('Six-minute practice round. Hold a top-ten spot to build points.');lastTime=performance.now();resize();updateHud();canvas.focus();return {name,wallet:playerWallet,share:1.8};
}
$('#join-form').addEventListener('submit',e=>{e.preventDefault();join()});
function toLobby(){saveRun();mode='lobby';paused=false;keys={};round=null;game.reset();bubbles.reset();neon.reset();transfers.reset();pendingDeath=null;document.body.classList.remove('playing');$('#join-panel').hidden=false;$('#player-panel').hidden=true;$('#action-controls').hidden=true;$('#pause-button').hidden=true;$('.footer-note').hidden=false;for(const d of document.querySelectorAll('dialog[open]'))d.close();camera={x:1600,y:1200,zoom:Math.min(width/2700,height/1800)};$('#feed').classList.remove('visible');$('#feed').textContent='';resize();updateLobby();lobby.showCurrent();updateHud();}
function split(){if(mode==='playing'&&!paused){const result=game.split(controls.actionTarget(pointer,camera,game.center(),width,height));toast(result.message);updateHud();}}
function consolidate(){if(mode==='playing'&&!paused){toast(game.consolidate().message);updateHud();}}
$('#split-button').addEventListener('click',split);
$('#merge-button').addEventListener('click',consolidate);
function pause(){if(mode!=='playing'||game.dead||round?.done||document.querySelector('dialog[open]'))return;paused=true;keys={};controls.clear();$('#pause-dialog').showModal();}
function resume(){paused=false;keys={};controls.clear();$('#pause-dialog').close();canvas.focus();lastTime=performance.now();}
$('#pause-button').addEventListener('click',pause);$('#resume-button').addEventListener('click',resume);$('#leave-button').addEventListener('click',toLobby);
$('#pause-dialog').addEventListener('cancel',e=>{e.preventDefault();resume()});
$('#again-button').addEventListener('click',()=>join());$('#edit-button').addEventListener('click',toLobby);
$('#death-dialog').addEventListener('cancel',e=>{e.preventDefault();toLobby()});
$('#help-button').addEventListener('click',()=>{helpPaused=paused;paused=true;keys={};controls.clear();$('#help-dialog').showModal()});
$('#help-dialog').addEventListener('close',()=>{paused=helpPaused;lastTime=performance.now()});
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$('#'+b.dataset.close).close());
function inputPoint(e){const box=canvas.getBoundingClientRect();pointer={x:Math.max(0,Math.min(width,e.clientX-box.left)),y:Math.max(0,Math.min(height,e.clientY-box.top)),active:true};}
addEventListener('pointermove',e=>{if(mode==='playing'&&!paused&&(e.pointerType==='mouse'||touchActive))inputPoint(e)});
canvas.addEventListener('pointerdown',e=>{controls.usePointer();keys={};inputPoint(e);touchActive=true;canvas.setPointerCapture(e.pointerId);canvas.focus()});
canvas.addEventListener('pointerup',e=>{touchActive=false;if(e.pointerType!=='mouse')pointer.active=false;});
canvas.addEventListener('pointercancel',()=>{touchActive=false;pointer.active=false});
// Retain mouse direction when leaving the play surface or reaching a window edge.
addEventListener('keydown',e=>{
  if(e.target instanceof HTMLInputElement)return;
  if(e.code==='Escape'&&mode==='playing'&&!document.querySelector('dialog[open]')){e.preventDefault();pause();return;}
  if(mode!=='playing'||paused||game.dead)return;
  if(['Space','KeyC','KeyE',...MOVEMENT_KEYS].includes(e.code))e.preventDefault();
  keys[e.code]=true;controls.press(e.code);if(e.repeat)return;if(e.code==='Space')split();if(e.code==='KeyC')consolidate();if(e.code==='KeyE')game.eject(controls.actionTarget(pointer,camera,game.center(),width,height));
});
addEventListener('keyup',e=>{keys[e.code]=false;controls.release(e.code)});
addEventListener('blur',()=>{keys={};controls.clear();pointer.active=false;if(mode==='playing'&&!paused&&!game.dead)pause()});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&mode==='playing'&&!paused&&!game.dead)pause()});
function die(event){showRunResult(event);}
addEventListener('pagehide',saveRun);
addEventListener('pageshow',event=>{if(event.persisted&&mode==='playing'&&roundSaved)toLobby();});
function updateHud(){
  const ranking=game.ranking();$('#leader-list').replaceChildren(...ranking.slice(0,8).map(({holder:h,mass},i)=>{const li=document.createElement('li');li.className='leader-row'+(h.isPlayer?' is-you':'');const rank=document.createElement('span');rank.className='leader-rank';rank.textContent=String(i+1).padStart(2,'0');const dot=document.createElement('span');dot.className='leader-dot';dot.style.setProperty('--holder-color',h.color);const name=document.createElement('span');name.className='leader-name';name.textContent=h.name;const percent=document.createElement('span');percent.className='leader-percent';percent.textContent=(mass/SUPPLY*100).toFixed(2)+'%';li.append(rank,dot,name);if(h.isPlayer){const tag=document.createElement('span');tag.className='you-tag';tag.textContent='YOU';li.append(tag)}li.append(percent);return li}));
  $('#holder-count').textContent=ranking.length;
  if(mode==='playing'&&game.player){
    const remaining=Math.ceil(round?.remaining??ROUND_SECONDS);
    $('#round-clock').textContent=`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
    $('#round-points').textContent=runStats().points.toFixed(1);
    const mass=game.mass(game.player),rank=ranking.findIndex(r=>r.holder.isPlayer)+1,count=game.player.cells.length,cool=game.cooldown();
    $('#player-share').innerHTML=(mass/SUPPLY*100).toFixed(2)+'<span>%</span>';$('#player-rank').textContent=rank?'#'+rank:'—';$('#cell-count').textContent=count;$('#cell-word').textContent=count===1?'bubble':'bubbles';$('#eaten-count').textContent=game.eaten;
    const yields=game.player.cells.map(c=>foodMultiplier(c.mass));
    const low=yields.length?Math.min(...yields):1,high=yields.length?Math.max(...yields):1;
    const yieldLabel=$('#dot-yield');
    yieldLabel.textContent=low.toFixed(1)===high.toFixed(1)?`${high.toFixed(1)}×`:`${low.toFixed(1)}–${high.toFixed(1)}×`;
    yieldLabel.parentElement.title='Dot yield for your current bubble sizes. Smaller bubbles earn more from arena dots. Ejected orbs give normal mass.';
    const groupCount=updateClusterNetwork(game.player).groups.length;
    const clusterLabel=groupCount>1?`${groupCount} hub clusters`:groupCount?'Hub cluster':'Cluster ready';
    $('#merge-progress').style.width=(100-cool/MERGE_TIME*100)+'%';$('#merge-status').textContent=count<2?'One wallet. Make it count.':cool>0?`Merge ready in ${Math.ceil(cool)}s`:game.merging?'Consolidating…':`${clusterLabel} · C to consolidate`;
    $('#merge-button').disabled=count<2||cool>0||game.merging;
    $('#merge-label').textContent=game.merging?'Consolidating…':cool>0?`Consolidate · ${Math.ceil(cool)}s`:'Consolidate';
    $('#merge-button').title=count<2?'You need at least two bubbles.':cool>0?`Wait ${Math.ceil(cool)} seconds since your latest split.`:'Press C to bring your bubbles together.';
    $('#movement-hint').textContent=controls.mode==='keyboard'?'WASD active · click arena for mouse':'Mouse steering · WASD to take over';
    $('#split-button').disabled=count>=16||!game.player.cells.some(c=>c.mass>=160);
    $('#your-ranking').replaceChildren();const label=document.createElement('span');label.textContent=`${rank?'#'+rank:'—'}  ${game.player.name} · You`;const share=document.createElement('span');share.textContent=(mass/SUPPLY*100).toFixed(2)+'%';$('#your-ranking').append(label,share);
    $('#arena-status').lastElementChild.textContent=game.player.shieldUntil>game.time?`Protected for ${Math.ceil(game.player.shieldUntil-game.time)}s · You can eat`:'Absorb smaller holders. Avoid the whales.';
  }else{$('#your-ranking').innerHTML='<span>You’re next.</span><span>Join the arena ↗</span>';$('#arena-status').lastElementChild.textContent='Absorb. Split. Consolidate.';$('#movement-hint').textContent='Mouse or WASD to steer';}
}
function circle(x,y,r){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);}
function draw(cells){
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#02040a';ctx.fillRect(0,0,width,height);
  const z=camera.zoom,ox=width/2-camera.x*z,oy=height/2-camera.y*z;
  ctx.save();ctx.translate(ox,oy);ctx.scale(z,z);
  ctx.fillStyle='#040810';ctx.fillRect(0,0,WORLD.width,WORLD.height);
  const minX=Math.max(0,-ox/z),maxX=Math.min(WORLD.width,(width-ox)/z),minY=Math.max(0,-oy/z),maxY=Math.min(WORLD.height,(height-oy)/z);
  drawArenaBackground(ctx,{zoom:z,minX,maxX,minY,maxY,width:WORLD.width,height:WORLD.height});
  drawGroundLight(ctx,cells,z,{minX,maxX,minY,maxY});
  ctx.strokeStyle='#51c6e58a';ctx.lineWidth=2/z;ctx.strokeRect(0,0,WORLD.width,WORLD.height);
  ctx.strokeStyle='#41d8e91b';ctx.lineWidth=10/z;ctx.strokeRect(-7/z,-7/z,WORLD.width+14/z,WORLD.height+14/z);
  ctx.strokeStyle='#51c6e54a';ctx.lineWidth=1/z;
  for(let x=0;x<=WORLD.width;x+=160){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,12/z);ctx.moveTo(x,WORLD.height);ctx.lineTo(x,WORLD.height-12/z);ctx.stroke()}
  for(let y=0;y<=WORLD.height;y+=160){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(12/z,y);ctx.moveTo(WORLD.width,y);ctx.lineTo(WORLD.width-12/z,y);ctx.stroke()}
  drawClusterLinks(ctx,game.holders,bubbles,z,{minX,maxX,minY,maxY});
  drawNeonFood(ctx,game.food,z,{minX,maxX,minY,maxY});
  neon.drawBehind(ctx,z);
  transfers.draw(ctx,z);
  const hubIds=new Set(game.holders.flatMap(h=>updateClusterNetwork(h).groups.map(group=>group.hubId)));
  for(const obstacle of OBSTACLES){
    ctx.beginPath();obstacle.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();
    ctx.fillStyle='#151e20';ctx.fill();ctx.strokeStyle='#52605c';ctx.lineWidth=1.5/z;ctx.stroke();
    ctx.save();ctx.clip();ctx.strokeStyle='#52605c16';ctx.lineWidth=1/z;
    const min=Math.min(...obstacle.points.map(p=>p.x)),max=Math.max(...obstacle.points.map(p=>p.x)),top=Math.min(...obstacle.points.map(p=>p.y)),bottom=Math.max(...obstacle.points.map(p=>p.y));
    for(let x=min-300;x<max+300;x+=20){ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x+bottom-top,bottom);ctx.stroke()}
    ctx.restore();
    for(const p of obstacle.points){ctx.fillStyle='#82948a';ctx.fillRect(p.x-2/z,p.y-2/z,4/z,4/z)}
  }
  // Floor shadows are a separate pass so no disk casts darkness over another.
  for(const {c} of cells){
    const body=bubbles.get(c.id),bounds=body.r*1.4+20/z;
    if(c.x+bounds<minX||c.x-bounds>maxX||c.y+bounds<minY||c.y-bounds>maxY)continue;
    paintBubbleShadow(ctx,body,z);
  }
  for(const {h,c} of cells){
    const body=bubbles.get(c.id),r=body.r,sx=c.x*z+ox,sy=c.y*z+oy,sr=r*z,bounds=sr*1.4+32;if(sx+bounds<0||sx-bounds>width||sy+bounds<0||sy-bounds>height)continue;
    paintBubble(ctx,body,h.color,z,{player:h.isPlayer,highlight:h.isPlayer?playerHighlight:h.color});
    if(h.shieldUntil>game.time&&mode==='playing'){ctx.setLineDash([3/z,7/z]);traceBubble(ctx,body,10/z);ctx.strokeStyle=(h.isPlayer?playerHighlight:h.color)+'80';ctx.lineWidth=1/z;ctx.stroke();ctx.setLineDash([]);}
    ctx.save();ctx.translate(c.x,c.y);ctx.scale(1/z,1/z);ctx.textAlign='center';ctx.textBaseline='middle';
    const size=Math.min(h.isPlayer?16:15,Math.max(10,sr*.19)),room=sr*1.65;
    ctx.font=`600 ${size}px "DM Sans", sans-serif`;ctx.fillStyle='#10180e';
    let name=h.name;while(ctx.measureText(name).width>room&&name.length>3)name=name.slice(0,-2)+'…';
    if(sr>17){ctx.fillText(name,0,sr>34?-14:-5);ctx.font=`${Math.max(7,Math.min(10,sr*.12))}px monospace`;ctx.fillStyle='#10180ea6';ctx.fillText(shortWallet(h.wallet),0,sr>34?4:8);}
    else {ctx.font=`${Math.max(3,Math.min(7,sr*.3))}px monospace`;ctx.fillStyle='#10180ecc';ctx.fillText(shortWallet(h.wallet),0,0,room);}
    if(sr>34){ctx.font=`500 ${Math.min(12,sr*.14)}px "Space Grotesk", sans-serif`;ctx.fillStyle='#10180ecc';ctx.fillText((c.mass/SUPPLY*100).toFixed(2)+'%',0,22);}
    if(sr>34&&(h.isPlayer||hubIds.has(c.id))){ctx.font='600 8px "DM Sans", sans-serif';ctx.fillStyle='#10180ea6';ctx.fillText(hubIds.has(c.id)?(h.isPlayer?'YOU · HUB':'HUB'):'YOU',0,-33)}ctx.restore();
  }
  bubbles.drawAbsorptions(ctx,z);
  neon.drawForeground(ctx,z);
  ctx.restore();drawEdgeIndicators();drawMini();
}
function drawEdgeIndicators(){
  if(mode!=='playing'||game.dead)return;
  for(const holder of game.holders){
    if(holder.isPlayer||!holder.cells.length)continue;
    const indicators=holder.cells.map(c=>edgeIndicator({...c,radius:radius(c.mass)},camera,width,height));
    if(indicators.some(indicator=>indicator===null))continue;
    const nearest=holder.cells.reduce((a,b)=>Math.hypot(a.x-camera.x,a.y-camera.y)<Math.hypot(b.x-camera.x,b.y-camera.y)?a:b);
    const marker=indicators[holder.cells.indexOf(nearest)];
    ctx.save();ctx.translate(marker.x,marker.y);ctx.rotate(marker.angle);
    ctx.beginPath();ctx.moveTo(6,0);ctx.lineTo(-4,-4);ctx.lineTo(-2,0);ctx.lineTo(-4,4);ctx.closePath();
    ctx.fillStyle=holder.color+'ba';ctx.fill();ctx.restore();
  }
}
function drawMini(){mctx.clearRect(0,0,160,108);mctx.strokeStyle='#596f4b';mctx.strokeRect(.5,.5,159,107);for(const o of OBSTACLES){mctx.beginPath();o.points.forEach((p,i)=>i?mctx.lineTo(p.x/WORLD.width*160,p.y/WORLD.height*108):mctx.moveTo(p.x/WORLD.width*160,p.y/WORLD.height*108));mctx.closePath();mctx.fillStyle='#44514b';mctx.fill()}for(const h of game.holders)for(const c of h.cells){mctx.beginPath();mctx.arc(c.x/WORLD.width*160,c.y/WORLD.height*108,h.isPlayer?3.2:Math.max(1.1,radius(c.mass)/45),0,7);mctx.fillStyle=h.color+(h.isPlayer?'ff':'60');mctx.fill()}mctx.strokeStyle='#c3f77445';const w=width/camera.zoom/WORLD.width*160,h=height/camera.zoom/WORLD.height*108;mctx.strokeRect(camera.x/WORLD.width*160-w/2,camera.y/WORLD.height*108-h/2,w,h);}
function frame(now){
  const elapsed=Math.max(0,(now-lastTime)/1000||.016),dt=Math.min(elapsed,.04);lastTime=now;
  if(mode==='playing'&&!paused&&!game.dead){
    const center=game.center();
    aim=controls.target(pointer,camera,center,width,height);
    if(keys.KeyE)game.eject(controls.actionTarget(pointer,camera,center,width,height));
    // Practice progression advances only with the visible, unpaused simulation.
    // Future ranked clocks and score samples must come from the game server.
    const played=Math.min(elapsed,.1,round?.remaining??0),startedAt=game.time;
    game.advance(played,{target:aim});
    round?.update(Math.min(played,Math.max(0,game.time-startedAt)),game.ranking().map(({holder:h,mass})=>({id:h.id,name:h.name,isPlayer:h.isPlayer,mass})));
    if(game.player.cells.length){const target=game.center();camera.x+=(target.x-camera.x)*Math.min(1,dt*6);camera.y+=(target.y-camera.y)*Math.min(1,dt*6);const total=game.mass(game.player),spread=Math.max(...game.player.cells.map(c=>Math.hypot(c.x-target.x,c.y-target.y)+radius(c.mass)));const zoom=Math.min(width<760?.86:1,.92/(Math.pow(total/900,.12)),Math.min(width,height)/(spread*2+220));camera.zoom+=(zoom-camera.zoom)*Math.min(1,dt*2);}
    for(const event of game.events.splice(0)){
      neon.add(event,playerHighlight);
      transfers.add(event,playerHighlight);
      if(event.type==='absorb')bubbles.absorb({...event,isPlayer:event.wallet===playerWallet,highlight:event.wallet===playerWallet?playerHighlight:event.color});
      if(event.type==='eat')toast(`Absorbed ${event.name} · +${(event.mass/SUPPLY*100).toFixed(2)}%`);
      if(event.type==='bot-eat'&&now>toastUntil)toast(`${event.name} absorbed ${event.victim}`);
      if(event.type==='death'){if(reducedMotion)die(event);else pendingDeath={event,remaining:Math.max(ABSORPTION_DURATION,DEATH_EFFECT_DURATION)+.04};}
    }
    if(round?.done&&!game.dead)showRunResult();
  }
  const cells=game.holders.flatMap(h=>h.cells.map(c=>({h,c}))).sort((a,b)=>a.c.mass-b.c.mass);
  const visualDt=paused?0:dt;
  bubbles.update(cells,visualDt);
  neon.update(cells,visualDt);
  transfers.update(cells,visualDt);
  if(pendingDeath&&!paused){pendingDeath.remaining-=visualDt;if(pendingDeath.remaining<=0){die(pendingDeath.event);pendingDeath=null;}}
  if(mode==='lobby')lobby.draw(document.hidden||paused?0:dt);else draw(cells);
  if(now-hudAt>150){updateHud();hudAt=now;}if(now>toastUntil)$('#feed').classList.remove('visible');requestAnimationFrame(frame);
}
updateHud();requestAnimationFrame(frame);

if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  const agentTools=[
    {name:'join_holder_arena',title:'Join the Holder arena',description:'Start a fresh practice match with the selected alias and bubble color. Restarts any current match.',inputSchema:{type:'object',properties:{username:{type:'string',minLength:1,maxLength:18},color:{type:'string',enum:COLORS}},required:['username','color'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input.username!=='string'||!input.username.trim()||input.username.length>18||!COLORS.includes(input.color))throw new Error('Use an alias of 1–18 characters and an available color.');$('#username').value=input.username;document.querySelector(`input[name="color"][value="${input.color}"]`).checked=true;return join(input.username,input.color);}},
    {name:'read_holder_standings',title:'Read holder standings',description:'Read the current practice arena leaderboard and your combined holding across all bubbles.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(){return {mode,paused,supply:SUPPLY,holders:game.ranking().slice(0,8).map(({holder:h,mass})=>({name:h.name,share:Number((mass/SUPPLY*100).toFixed(2)),isYou:h.isPlayer})),you:game.player?{share:Number((game.mass(game.player)/SUPPLY*100).toFixed(2)),bubbles:game.player.cells.length,holdersEaten:game.eaten}:null};}}
  ];
  for(const tool of agentTools){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{})}catch{}}
  addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
