import test from 'node:test';
import assert from 'node:assert/strict';
import { PhantomIdentity } from '../dist/wallet.mjs';

const A='11111111111111111111111111111111',B='22222222222222222222222222222222';
function provider(){
  const events=new Map();let connects=0,disconnects=0;
  return {isPhantom:true,connect:async()=>{connects++;return {publicKey:{toBase58:()=>A}};},disconnect:async()=>{disconnects++;},
    on:(event,fn)=>events.set(event,fn),removeListener:(event,fn)=>{if(events.get(event)===fn)events.delete(event);},
    emit:(event,value)=>events.get(event)?.(value),get connects(){return connects;},get disconnects(){return disconnects;},events};
}
test('wallet discovery never prompts until the player chooses to connect',async()=>{
  const p=provider(),identity=new PhantomIdentity({getProvider:()=>p});
  assert.equal(p.connects,0);assert.equal(identity.state.address,null);
  await identity.connect();assert.equal(identity.state.address,A);assert.equal(p.connects,1);
  await identity.connect();assert.equal(p.connects,1);
  await identity.disconnect();assert.equal(identity.state.address,null);assert.equal(p.disconnects,1);assert.equal(p.events.size,0);
});
test('account changes switch only to valid public addresses and null returns to guest',async()=>{
  const p=provider(),updates=[],identity=new PhantomIdentity({getProvider:()=>p,onChange:s=>updates.push(s)});
  await identity.connect();p.emit('accountChanged',{toString:()=>B});assert.equal(identity.state.address,B);
  p.emit('accountChanged',null);assert.equal(identity.state.address,null);assert.equal(p.events.size,0);
  assert.equal(updates.filter(s=>s.status==='connected').length,2);
});
test('missing extension, rejected approval, and invalid addresses leave the guest profile usable',async()=>{
  const missing=new PhantomIdentity();await missing.connect();assert.equal(missing.state.status,'unavailable');
  for(const connect of [async()=>{throw {code:4001};},async()=>({publicKey:'<script>bad</script>'})]){
    const identity=new PhantomIdentity({getProvider:()=>({isPhantom:true,connect})});
    await identity.connect();assert.equal(identity.state.status,'error');assert.equal(identity.state.address,null);
  }
});
test('a late connection response cannot undo a local disconnect',async()=>{
  let resolve;const p=provider();p.connect=()=>new Promise(done=>resolve=done);
  const identity=new PhantomIdentity({getProvider:()=>p}),pending=identity.connect();
  await identity.disconnect();resolve({publicKey:A});await pending;
  assert.equal(identity.state.address,null);assert.equal(p.events.size,0);
});
