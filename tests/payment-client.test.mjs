import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getAddress, parseEther, formatEther, hexlify, toUtf8Bytes } from 'ethers';

// Execute the actual browser client with a small DOM and wallet/API boundary doubles.
// No extension, network request, signature, or transaction reaches a real chain.
const html = readFileSync(new URL('../payment-lab/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../payment-lab/app.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '')
  .replace('void boot();', 'globalThis.bootFinished = boot();');
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const VAULT = '0x9999999999999999999999999999999999999999';
const RECIPIENTS = ['3', '4', '5'].map(digit => `0x${digit.repeat(40)}`);
const HASH = `0x${'a'.repeat(64)}`;
const FUNDING = `0x${'b'.repeat(64)}`;

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName; this.children = []; this.listeners = {}; this.dataset = {};
    this.value = ''; this._text = ''; this.disabled = false;
  }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text; }
  append(...elements) {
    this.children.push(...elements);
    if (this.tagName === 'select' && !this.value) this.value = elements[0]?.value ?? '';
  }
  replaceChildren(...elements) {
    this.children = []; if (this.tagName === 'select') this.value = ''; this.append(...elements);
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeAttribute(name) { delete this[name]; }
  focus() {} scrollIntoView() {}
}

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
const copy = value => JSON.parse(JSON.stringify(value));
function confirmedDeposit() {
  return { id: 'confirmed-deposit', kind: 'fund', status: 'confirmed', fundingId: FUNDING,
    amountWei: '10000000000000000', createdAt: 1000 };
}

function savedDeployment(status = 'submitted') {
  return { id: 'saved-deployment', kind: 'deploy', wallet: OWNER, status, hash: status === 'submitted' ? HASH : null,
    createdAt: 1000, expectedContractAddress: VAULT, transaction: { from: OWNER, data: '0x1234', value: '0x0', chainId: '0xb626', nonce: '0x0' } };
}

async function createClient({ ready = false, vault = false, noProvider = false,
  intents = [], storage = new Map(), send, nonce = '0x0', healthy = true,
  onStatus, hangStatus = false, walletFailure = false, confirmOnReconcile = false,
  fastTimeout = false, latestNonce = nonce, code = '0x', onRetry, onRead } = {}) {
  const elements = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)]
    .map(match => [match[2], new Element(match[1])]));
  const calls = [], providerListeners = {};
  const backend = {
    accounts: ready ? [OWNER] : [], chain: '0xb626', nonce, latestNonce, code, healthy, hangStatus, walletFailure, confirmOnReconcile,
    session: ready ? { wallet: OWNER, csrfToken: 'synthetic-csrf' } : null,
    wallet: { wallet: OWNER, balanceWei: '50000000000000000', vault: vault
      ? { address: VAULT, retainedWei: '8000000000000000', carryWei: '1' } : null },
    intents: copy(intents),
  };
  const provider = {
    on(name, listener) { providerListeners[name] = listener; },
    async request(request) {
      calls.push({ type: 'wallet', ...copy(request) });
      if (onRead && request.method !== 'eth_sendTransaction') await onRead(request, { backend, emit });
      switch (request.method) {
        case 'eth_accounts': return [...backend.accounts];
        case 'eth_chainId': return backend.chain;
        case 'eth_requestAccounts': backend.accounts = [OWNER]; return [OWNER];
        case 'personal_sign': return '0xsynthetic-signature';
        case 'eth_getTransactionCount': return request.params[1] === 'latest' ? backend.latestNonce : backend.nonce;
        case 'eth_getCode': return backend.code;
        case 'eth_sendTransaction':
          if (send) await send({ backend, emit, calls });
          return HASH;
        default: throw new Error(`Unexpected wallet request: ${request.method}`);
      }
    },
  };
  function emit(name, value) { providerListeners[name]?.(value); }
  async function fetch(path, options = {}) {
    const input = options.body ? JSON.parse(options.body) : {};
    calls.push({ type: 'api', path, method: options.method, body: input, headers: options.headers });
    let value, status = 200;
    if (path === '/api/status') {
      if (onStatus) await onStatus({ backend, emit });
      if (backend.hangStatus) return new Promise(() => {});
      value = { chainId: 46630, healthy: backend.healthy };
    }
    else if (path === '/api/session') {
      value = backend.session;
      if (!value) { status = 401; value = { error: 'No session' }; }
    } else if (path === '/api/auth/challenge') value = { id: 'challenge', message: 'Synthetic ownership verification' };
    else if (path === '/api/auth/verify') value = backend.session = { wallet: OWNER, csrfToken: 'synthetic-csrf' };
    else if (path === '/api/logout') { backend.session = null; value = { loggedOut: true }; }
    else if (path === '/api/wallet') {
      if (backend.walletFailure) {
        status = backend.walletFailure === 'expired' ? 401 : 502;
        value = { error: status === 401 ? 'Session expired' : 'Wallet RPC unavailable' };
        if (status === 401) backend.session = null;
      } else value = backend.wallet;
    }
    else if (path === '/api/intents' && options.method === 'POST') {
      const existing = backend.intents.find(intent => ['prepared', 'submitted'].includes(intent.status));
      if (existing) value = existing;
      else {
        value = { id: `intent-${backend.intents.length + 1}`, kind: input.kind, status: 'prepared', wallet: OWNER,
          hash: null, createdAt: 2000, request: copy(input),
          transaction: { from: OWNER, data: '0x1234', value: '0x0', chainId: backend.chain, nonce: '0x0' } };
        if (input.kind !== 'deploy') { value.vault = VAULT; value.transaction.to = VAULT; }
        else value.expectedContractAddress = VAULT;
        if (['fund', 'withdraw'].includes(input.kind)) value.amountWei = parseEther(input.amountEth).toString();
        if (input.kind === 'fund') value.fundingId = FUNDING;
        if (input.kind === 'refund') { value.fundingId = input.fundingId; value.amountWei = '10000000000000000'; }
        if (input.kind === 'payout') Object.assign(value, {
          fundingId: input.fundingId, batchId: `0x${'c'.repeat(64)}`, poolWei: '2000', paidWei: '1999', nextCarryWei: '1',
          allocations: input.recipients.map((wallet, index) => ({ wallet, score: [216, 50, 486][index], amountWei: ['574', '133', '1292'][index] })),
        });
        backend.intents.push(value);
      }
    } else if (path === '/api/intents') value = { intents: backend.intents };
    else if (/\/reconcile$/.test(path)) {
      value = backend.intents.find(intent => path.includes(`/${intent.id}/`));
      if (backend.confirmOnReconcile && value.kind === 'deploy') {
        value.status = 'confirmed'; value.result = { vault: VAULT, confirmations: 2, blockNumber: 100, networkFeeWei: '1' };
        backend.wallet.vault = { address: VAULT, retainedWei: '0', carryWei: '0' };
      }
    }
    else if (/\/hash$/.test(path)) {
      value = backend.intents.find(intent => path.includes(`/${intent.id}/`));
      value.hash = input.hash; value.status = 'submitted';
    } else if (/\/retry-check$/.test(path)) {
      value = { ...copy(backend.intents.find(intent => path.includes(`/${intent.id}/`))), retryAllowed: true };
      if (onRetry) await onRetry(value, { backend, emit });
    } else throw new Error(`Unexpected API request: ${path}`);
    assert.ok(value, `Fixture response exists for ${path}`);
    return { ok: status === 200, status, json: async () => copy(value) };
  }
  const context = vm.createContext({
    window: noProvider ? {} : { ethereum: provider },
    document: {
      getElementById(id) { assert.ok(elements.has(id), `HTML contains #${id}`); return elements.get(id); },
      createElement: tag => new Element(tag),
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch, getAddress, parseEther, formatEther, hexlify, toUtf8Bytes, console,
    setTimeout: fastTimeout ? (callback, delay) => setTimeout(callback, Math.min(delay, 10)) : setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'payment-lab/app.mjs' });
  await context.bootFinished;
  async function settled() {
    for (let i = 0; i < 100; i++) {
      if (!vm.runInContext('state.busy || state.connectionBusy', context)) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Client action did not settle');
  }
  async function click(target) {
    const element = typeof target === 'string' ? elements.get(target) : target;
    assert.ok(element, 'Button exists'); assert.equal(element.disabled, false, 'Button is enabled');
    await element.listeners.click(); await settled();
  }
  async function submit(id) {
    elements.get(id).listeners.submit({ preventDefault() {} }); await settled();
  }
  function historyButton(label) {
    return descendants(elements.get('history-list')).find(element => element.tagName === 'button' && element.textContent === label);
  }
  return { elements, calls, backend, storage, emit, click, submit, historyButton,
    walletSends: () => calls.filter(call => call.type === 'wallet' && call.method === 'eth_sendTransaction'),
    requests: path => calls.filter(call => call.type === 'api' && call.path === path) };
}

test('client without a wallet stays honest and cannot prepare or send a payment', async () => {
  const client = await createClient({ noProvider: true });
  assert.equal(client.elements.get('connect-wallet').disabled, true);
  assert.equal(client.elements.get('deploy-vault').disabled, true);
  assert.equal(client.elements.get('fund-vault').disabled, true);
  assert.match(client.elements.get('provider-note').textContent, /No wallet was detected/);
  assert.equal(client.requests('/api/intents').length, 0);
  assert.equal(client.walletSends().length, 0);
});

test('connect and ownership proof stay separate; deployment persists before the wallet send', async () => {
  const client = await createClient();
  await client.click('connect-wallet');
  assert.equal(client.elements.get('verify-wallet').disabled, false);
  assert.equal(client.elements.get('deploy-vault').disabled, true);
  assert.equal(client.calls.some(call => call.method === 'personal_sign'), false);
  await client.click('verify-wallet');
  assert.equal(client.walletSends().length, 0);
  await client.click('deploy-vault');
  const savedAt = client.calls.findIndex(call => call.path === '/api/intents' && call.method === 'POST');
  const sentAt = client.calls.findIndex(call => call.method === 'eth_sendTransaction');
  assert.ok(savedAt >= 0 && sentAt > savedAt);
  assert.equal(client.calls[savedAt].headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.equal(client.backend.intents[0].status, 'submitted');
  assert.equal(client.elements.get('fund-vault').disabled, true);
  assert.match(client.elements.get('status').textContent, /not yet a confirmed payment/);
});

test('saving a payout locks exact recipients without sending, then approval uses the saved plan', async () => {
  const client = await createClient({ ready: true, vault: true, intents: [confirmedDeposit()] });
  ['alice', 'bob', 'cara'].forEach((name, index) => { client.elements.get(`recipient-${name}`).value = RECIPIENTS[index]; });
  await client.submit('preview-form');
  assert.equal(client.walletSends().length, 0);
  assert.equal(client.elements.get('payout-review').hidden, false);
  assert.equal(client.elements.get('recipient-alice').disabled, true);
  const plan = client.backend.intents.find(intent => intent.kind === 'payout');
  assert.deepEqual(plan.allocations.map(entry => entry.wallet), RECIPIENTS);
  const displayed = descendants(client.elements.get('review-allocations')).filter(element => element.tagName === 'code').map(element => element.textContent);
  assert.deepEqual(displayed, RECIPIENTS);
  await client.click('approve-payout');
  assert.equal(client.walletSends().length, 1);
  assert.deepEqual(client.walletSends()[0].params[0], plan.transaction);
  assert.equal(client.elements.get('approve-payout').disabled, true);
});

test('account or chain changes during wallet approval clear old intent UI and block stale hash posts', async t => {
  for (const event of ['accountsChanged', 'chainChanged']) await t.test(event, async () => {
    const client = await createClient({ ready: true, send({ backend, emit }) {
      if (event === 'accountsChanged') { backend.accounts = [OTHER]; emit(event, [OTHER]); }
      else { backend.chain = '0x1'; emit(event, '0x1'); }
    } });
    await client.click('deploy-vault');
    assert.equal(client.walletSends().length, 1);
    assert.equal(client.calls.some(call => call.path?.endsWith('/hash')), false);
    assert.equal(client.elements.get('fund-vault').disabled, true);
    assert.equal(client.elements.get('payout-review').hidden, true);
    assert.match(client.elements.get('status').textContent, /changed/);
    const saved = [...client.storage.values()].map(value => JSON.parse(value));
    assert.ok(saved.some(value => value.attempted && value.hash === HASH), 'Original wallet hash is retained for recovery');
  });
});

test('an uncertain non-deployment result survives reload and only permits checking or hash recovery', async () => {
  const client = await createClient({ ready: true, vault: true, send() { throw new Error('Connection dropped'); } });
  client.elements.get('fund-amount').value = '0.001';
  await client.submit('fund-form');
  assert.equal(client.walletSends().length, 1);
  assert.equal(client.historyButton('Approve saved action ↗'), undefined);
  await client.click(client.historyButton('Check result'));
  assert.equal(client.walletSends().length, 1);
  const restored = await createClient({ ready: true, vault: true, intents: client.backend.intents, storage: client.storage });
  assert.equal(restored.historyButton('Approve saved action ↗'), undefined);
  assert.ok(restored.historyButton('Check result'));
  assert.equal(restored.elements.get('deploy-vault').disabled, true);
  assert.equal(restored.walletSends().length, 0);
});

test('an explicit wallet rejection permits manual approval of the same intent, without preparing another', async () => {
  let attempts = 0;
  const client = await createClient({ ready: true, send() {
    if (attempts++ === 0) { const error = new Error('User rejected'); error.code = 4001; throw error; }
  } });
  await client.click('deploy-vault');
  assert.equal(client.backend.intents.length, 1);
  await client.click(client.historyButton('Resume saved deployment ↗'));
  assert.equal(client.backend.intents.length, 1);
  assert.equal(client.requests('/api/intents').filter(call => call.method === 'POST').length, 1);
  assert.equal(client.walletSends().length, 2);
  assert.deepEqual(client.walletSends()[0].params, client.walletSends()[1].params);
  assert.equal(client.backend.intents[0].status, 'submitted');
});

test('a changed pending nonce prevents opening the wallet for the saved transaction', async () => {
  const client = await createClient({ ready: true, nonce: '0x1' });
  await client.click('deploy-vault');
  assert.equal(client.backend.intents.length, 1);
  assert.equal(client.walletSends().length, 0);
  assert.match(client.elements.get('status').textContent, /nonce changed/);
});

test('refund and retained withdrawal send explicit recovery intents to the original owner flow', async () => {
  const refund = await createClient({ ready: true, vault: true, intents: [confirmedDeposit()] });
  await refund.click('refund-deposit');
  assert.deepEqual(refund.requests('/api/intents').find(call => call.method === 'POST').body, { kind: 'refund', fundingId: FUNDING });
  assert.equal(refund.walletSends().length, 1);
  const withdrawal = await createClient({ ready: true, vault: true });
  await withdrawal.click('withdraw-retained');
  assert.deepEqual(withdrawal.requests('/api/intents').find(call => call.method === 'POST').body,
    { kind: 'withdraw', to: OWNER, amountEth: '0.008' });
  assert.equal(withdrawal.walletSends().length, 1);
});

test('a transient unhealthy RPC can recover without disconnecting or reloading the wallet', async () => {
  const client = await createClient({ ready: true, vault: true, healthy: false });
  assert.equal(client.elements.get('wallet-address').textContent, OWNER);
  assert.equal(client.elements.get('fund-vault').disabled, true);
  assert.equal(client.elements.get('refresh-connection').disabled, false);
  assert.match(client.elements.get('funding-note').textContent, /Refresh connection/);
  client.backend.healthy = true;
  await client.click('refresh-connection');
  assert.equal(client.elements.get('fund-vault').disabled, false);
  assert.notEqual(client.elements.get('wallet-balance').textContent, '—');
  assert.equal(client.calls.some(call => call.method === 'personal_sign'), false);
  assert.equal(client.walletSends().length, 0);
});

test('a stalled health probe times out without losing the wallet identity or the retry control', async () => {
  const client = await createClient({ ready: true, vault: true, hangStatus: true, fastTimeout: true });
  assert.equal(client.elements.get('wallet-address').textContent, OWNER);
  assert.equal(client.elements.get('refresh-connection').disabled, false);
  assert.match(client.elements.get('status').textContent, /timed out/);
  client.backend.hangStatus = false;
  await client.click('refresh-connection');
  assert.equal(client.elements.get('fund-vault').disabled, false);
  assert.equal(client.walletSends().length, 0);
});

test('initial provider identity events cannot discard the successful health result during restore', async () => {
  const client = await createClient({ ready: true, vault: true, onStatus({ emit }) {
    emit('accountsChanged', [OWNER]); emit('chainChanged', '0xb626');
  } });
  assert.equal(client.elements.get('wallet-address').textContent, OWNER);
  assert.equal(client.elements.get('rpc-indicator').dataset.healthy, 'true');
  assert.equal(client.elements.get('wallet-badge').textContent, 'VERIFIED');
  assert.equal(client.elements.get('fund-vault').disabled, false);
  assert.equal(client.walletSends().length, 0);
});

test('an expired server session preserves the connected account and re-enables ownership verification', async () => {
  const client = await createClient({ ready: true, vault: true });
  client.backend.walletFailure = 'expired';
  await client.click('refresh-vault');
  assert.equal(client.elements.get('wallet-address').textContent, OWNER);
  assert.equal(client.elements.get('verify-wallet').disabled, false);
  assert.equal(client.elements.get('fund-vault').disabled, true);
  assert.match(client.elements.get('status').textContent, /verification expired/);
  client.backend.walletFailure = false;
  await client.click('verify-wallet');
  assert.equal(client.elements.get('fund-vault').disabled, false);
  assert.equal(client.walletSends().length, 0);
});

test('wallet RPC failure does not hide saved deployment recovery from independently loaded history', async () => {
  const client = await createClient({ ready: true, walletFailure: true, intents: [savedDeployment('prepared')] });
  assert.ok(client.historyButton('Resume saved deployment ↗'));
  assert.equal(client.historyButton('Resume saved deployment ↗').disabled, false);
  assert.equal(client.elements.get('refresh-vault').disabled, false);
  assert.match(client.elements.get('funding-note').textContent, /recovery button in step 2/);
  assert.equal(client.elements.get('wallet-balance').textContent, '—');
  assert.equal(client.elements.get('deploy-vault').disabled, true);
  assert.equal(client.walletSends().length, 0);
});

test('restore reconciles a mined deployment and loads its vault without opening the wallet', async () => {
  const client = await createClient({ ready: true, intents: [savedDeployment()], confirmOnReconcile: true });
  assert.equal(client.requests('/api/intents/saved-deployment/reconcile').length, 1);
  assert.equal(client.elements.get('vault-address').textContent, VAULT);
  assert.equal(client.elements.get('fund-vault').disabled, false);
  assert.equal(client.walletSends().length, 0);
  assert.equal(client.calls.some(call => call.method === 'personal_sign'), false);
});

test('Check vault reconciles a formerly pending deployment instead of merely rereading stale ledger data', async () => {
  const client = await createClient({ ready: true, intents: [savedDeployment()] });
  assert.equal(client.elements.get('fund-vault').disabled, true);
  client.backend.confirmOnReconcile = true;
  await client.click('refresh-vault');
  assert.equal(client.requests('/api/intents/saved-deployment/reconcile').length, 2);
  assert.equal(client.elements.get('fund-vault').disabled, false);
  assert.equal(client.walletSends().length, 0);
});

test('saved-action approval stays disabled while the connection is being restored', async () => {
  const client = await createClient({ ready: true, intents: [savedDeployment('prepared')], fastTimeout: true });
  client.backend.hangStatus = true;
  const refresh = client.click('refresh-connection');
  assert.equal(client.historyButton('Resume saved deployment ↗').disabled, true);
  await refresh;
  assert.equal(client.walletSends().length, 0);
});

test('an uncertain deployment has visible vault recovery and retries only its exact saved transaction', async () => {
  const first = await createClient({ ready: true, send() { throw new Error('Phantom connection dropped'); } });
  await first.click('deploy-vault');
  const original = copy(first.backend.intents[0]);
  const restored = await createClient({ ready: true, intents: first.backend.intents, storage: first.storage });
  assert.equal(restored.elements.get('resume-deployment').hidden, false);
  assert.match(restored.elements.get('resume-deployment').textContent, /Check and retry/);
  assert.match(restored.elements.get('vault-recovery-note').textContent, /Phantom connection dropped/);
  assert.equal(restored.walletSends().length, 0, 'Restoration never opens the wallet automatically');
  await restored.click('resume-deployment');
  assert.equal(restored.requests(`/api/intents/${original.id}/retry-check`).length, 1);
  assert.equal(restored.requests('/api/intents').filter(call => call.method === 'POST').length, 0);
  assert.deepEqual(restored.walletSends()[0].params[0], original.transaction);
  assert.equal(restored.backend.intents.length, 1);
  assert.equal(restored.backend.intents[0].id, original.id);
  assert.ok(restored.calls.some(call => call.method === 'eth_getTransactionCount' && call.params[1] === 'latest'));
  assert.ok(restored.calls.some(call => call.method === 'eth_getTransactionCount' && call.params[1] === 'pending'));
  assert.ok(restored.calls.some(call => call.method === 'eth_getCode' && call.params[0] === original.expectedContractAddress));
});

test('deployment recovery only reconciles when a local or newly discovered server hash is known', async t => {
  for (const knownAt of ['local', 'server']) await t.test(knownAt, async () => {
    const storage = new Map([['holder-payment-attempt:saved-deployment', JSON.stringify({ attempted: true, ...(knownAt === 'local' ? { hash: HASH } : {}) })]]);
    const client = await createClient({ ready: true, intents: [savedDeployment('prepared')], storage });
    if (knownAt === 'server') { client.backend.intents[0].hash = HASH; client.backend.intents[0].status = 'submitted'; }
    await client.click('resume-deployment');
    assert.equal(client.walletSends().length, 0);
    assert.equal(client.requests('/api/intents/saved-deployment/retry-check').length, 0);
    assert.equal(client.backend.intents[0].hash, HASH);
  });
});

test('deployment retry blocks consumed or pending nonces, existing code, and failed reads without clearing uncertainty', async t => {
  const cases = [
    { name: 'latest nonce advanced', latestNonce: '0x1' },
    { name: 'pending nonce advanced', nonce: '0x1', latestNonce: '0x0' },
    { name: 'contract already exists', code: '0x6000' },
    { name: 'provider read failed', onRead(request) { if (request.method === 'eth_getCode') throw new Error('Code read unavailable'); } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const storage = new Map([['holder-payment-attempt:saved-deployment', JSON.stringify({ attempted: true, lastError: 'Original wallet error' })]]);
    const client = await createClient({ ready: true, intents: [savedDeployment('prepared')], storage, ...scenario });
    await client.click('resume-deployment');
    assert.equal(client.walletSends().length, 0);
    assert.equal(client.backend.intents.length, 1);
    const marker = JSON.parse(storage.get('holder-payment-attempt:saved-deployment'));
    assert.equal(marker.attempted, true);
    assert.equal(marker.lastError, 'Original wallet error');
  });
});

test('retry preflight must approve the unchanged deployment before any wallet send', async t => {
  const cases = [
    { name: 'changed intent ID', mutate(value) { value.id = 'another-intent'; } },
    { name: 'changed bytecode', mutate(value) { value.transaction.data = '0x6000'; } },
    { name: 'changed nonce', mutate(value) { value.transaction.nonce = '0x1'; } },
    { name: 'changed destination', mutate(value) { value.transaction.to = OTHER; } },
    { name: 'retry not allowed', mutate(value) { value.retryAllowed = false; } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const client = await createClient({ ready: true, intents: [savedDeployment('prepared')], onRetry: scenario.mutate });
    await client.click('resume-deployment');
    assert.equal(client.walletSends().length, 0);
    assert.equal(client.requests('/api/intents').filter(call => call.method === 'POST').length, 0);
  });
});

test('account or chain changes during deployment preflight prevent retry prompts', async t => {
  for (const event of ['accountsChanged', 'chainChanged']) await t.test(event, async () => {
    const client = await createClient({ ready: true, intents: [savedDeployment('prepared')], onRetry(_value, { backend, emit }) {
      if (event === 'accountsChanged') { backend.accounts = [OTHER]; emit(event, [OTHER]); }
      else { backend.chain = '0x1'; emit(event, '0x1'); }
    } });
    await client.click('resume-deployment');
    assert.equal(client.walletSends().length, 0);
    assert.equal(client.elements.get('fund-vault').disabled, true);
  });
});
