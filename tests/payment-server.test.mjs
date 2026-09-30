import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Wallet } from 'ethers';
import { createPaymentServer } from '../server/payment-server.mjs';

async function fixture(t) {
  const calls = [];
  const lab = {
    status: async () => ({ healthy: true, chainId: 46630, network: 'Robinhood Chain Testnet' }),
    walletStatus: async wallet => ({ wallet, balanceWei: '100000' }),
    listIntents: wallet => [{ id: 'saved-intent', wallet }],
    createIntent: async (wallet, input) => { calls.push({ wallet, input }); return { id: 'test-intent', wallet, kind: input.kind }; },
    attachHash: async (wallet, id, hash) => ({ wallet, id, hash }),
    reconcile: async (wallet, id) => ({ wallet, id, status: 'confirmed' }),
    checkDeploymentRetry: async (wallet, id) => ({ wallet, id, retryAllowed: true }),
  };
  let server; const origin = () => `http://127.0.0.1:${server.address().port}`;
  server = createPaymentServer({ lab, origin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = origin();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  const signin = async wallet => {
    const challenge = await (await post('/api/auth/challenge', { wallet: wallet.address })).json();
    const verified = await post('/api/auth/verify', { id: challenge.id, signature: await wallet.signMessage(challenge.message) });
    const cookie = verified.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
    return { ...(await verified.json()), cookie: cookie.split(';')[0] };
  };
  return { base, post, signin, calls };
}

test('payment API requires origin-bound wallet proof and CSRF for any intent', async t => {
  const { base, post, signin, calls } = await fixture(t), wallet = Wallet.createRandom();
  assert.equal((await post('/api/intents', { kind: 'fund' })).status, 401);
  assert.equal((await post('/api/auth/challenge', { wallet: wallet.address }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(base + '/api/auth/challenge', { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 415);
  const session = await signin(wallet);
  assert.equal((await post('/api/intents', { kind: 'fund' }, { Cookie: session.cookie })).status, 403);
  const result = await post('/api/intents', { kind: 'fund', wallet: Wallet.createRandom().address }, { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken });
  assert.equal(result.status, 200); assert.equal((await result.json()).wallet, wallet.address);
  assert.equal(calls.length, 1); assert.equal(calls[0].wallet, wallet.address, 'client-provided wallet cannot change treasury ownership');
  const restored = await (await fetch(base + '/api/session', { headers: { Cookie: session.cookie } })).json();
  assert.equal(restored.csrfToken, session.csrfToken);
  assert.equal((await post('/api/logout', {}, { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken })).status, 200);
  assert.equal((await fetch(base + '/api/intents', { headers: { Cookie: session.cookie } })).status, 401);
});

test('the local lab serves only explicit public assets and bounds request bodies', async t => {
  const { base, post } = await fixture(t);
  const status = await fetch(base + '/api/status'); assert.equal(status.status, 200);
  assert.equal((await status.json()).chainId, 46630);
  assert.match(status.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/.payment-lab/ledger.sqlite', '/package.json', '/server/payment-core.mjs', '/.env', '/node_modules/ethers/package.json']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await post('/api/auth/challenge', { wallet: 'x'.repeat(20000) })).status, 413);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = request(base + '/api/status', { headers: { Host: 'evil.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHostStatus, 403);
});

test('hash attachment and reconciliation always act on the authenticated wallet', async t => {
  const { base, post, signin } = await fixture(t), wallet = Wallet.createRandom(), session = await signin(wallet);
  const headers = { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  const attached = await (await post('/api/intents/test-intent/hash', { hash: '0x123' }, headers)).json();
  assert.equal(attached.wallet, wallet.address); assert.equal(attached.hash, '0x123');
  const reconciled = await (await post('/api/intents/test-intent/reconcile', {}, headers)).json();
  assert.equal(reconciled.status, 'confirmed'); assert.equal(reconciled.wallet, wallet.address);
  const list = await (await fetch(base + '/api/intents', { headers })).json();
  assert.equal(list.intents[0].wallet, wallet.address);
  assert.equal((await post('/api/intents/test-intent/retry-check', {})).status, 401);
  assert.equal((await post('/api/intents/test-intent/retry-check', {}, { Cookie: session.cookie })).status, 403);
  const retry = await (await post('/api/intents/test-intent/retry-check', { wallet: Wallet.createRandom().address }, headers)).json();
  assert.equal(retry.wallet, wallet.address); assert.equal(retry.id, 'test-intent'); assert.equal(retry.retryAllowed, true);
});
