import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ganache from 'ganache';
import { getAddress, parseEther } from 'ethers';
import { PaymentLab, PAYMENT_NETWORK } from '../server/payment-core.mjs';

const artifact = JSON.parse(readFileSync(new URL('../payment-lab/contract.json', import.meta.url), 'utf8'));
const fakeHash = `0x${'12'.repeat(32)}`;
const copy = value => JSON.parse(JSON.stringify(value));

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holder-payment-core-'));
  const rpc = ganache.provider({ logging: { quiet: true },
    chain: { chainId: 46630, hardfork: 'shanghai', vmErrorsOnRPCResponse: false },
    wallet: { totalAccounts: 8, defaultBalance: 100 } });
  const calls = [];
  const provider = { send: async (method, params) => {
    calls.push(method); return rpc.request({ method, params });
  } };
  const accounts = (await provider.send('eth_accounts', [])).map(getAddress);
  const ctx = { dir, rpc, provider, calls, accounts, dbPath: join(dir, 'ledger.sqlite') };
  ctx.lab = new PaymentLab({ provider, artifact, dbPath: ctx.dbPath });
  ctx.reopen = () => { ctx.lab.close(); ctx.lab = new PaymentLab({ provider, artifact, dbPath: ctx.dbPath }); return ctx.lab; };
  ctx.mine = async () => provider.send('evm_mine', []);
  ctx.send = async (intent, gas = '0x500000') => provider.send('eth_sendTransaction', [{ ...intent.transaction, gas }]);
  ctx.confirm = async intent => {
    const hash = await ctx.send(intent); await ctx.mine();
    return ctx.lab.attachHash(accounts[0], intent.id, hash);
  };
  ctx.deploy = async () => ctx.confirm(await ctx.lab.createIntent(accounts[0], { kind: 'deploy' }));
  t.after(async () => {
    ctx.lab.close(); await rpc.disconnect();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

test('wrong-chain RPC blocks all preparation without creating ledger intents', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const send = c.provider.send;
  c.provider.send = async (method, params) => method === 'eth_chainId' ? '0x1' : send(method, params);
  assert.equal((await c.lab.status()).healthy, false);
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'deploy' }), error => error.code === 'WRONG_CHAIN');
  assert.deepEqual(c.lab.listIntents(wallet), []);
  await assert.rejects(c.lab.walletStatus(wallet), error => error.code === 'WRONG_CHAIN');
});

test('prepared nonce and deployment survive restart; same request replays and other requests stay locked', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const pending = await c.lab.createIntent(wallet, { kind: 'deploy' });
  assert.equal(pending.transaction.chainId, '0xb626');
  assert.equal(pending.transaction.nonce, '0x0');
  assert.equal(pending.transaction.to, undefined);
  assert.equal(c.calls.includes('eth_sendTransaction'), false);
  c.reopen();
  assert.deepEqual(await c.lab.createIntent(wallet, { kind: 'deploy' }), pending);
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' }), error => error.code === 'UNRESOLVED_INTENT');
  assert.equal((await c.lab.reconcile(wallet, pending.id)).status, 'prepared');
  assert.deepEqual(c.lab.listIntents(c.accounts[1]), []);
  await assert.rejects(c.lab.reconcile(c.accounts[1], pending.id), error => error.statusCode === 404);
});

test('lost deployment hash is recovered by reserved nonce, then code and owner are verified', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const pending = await c.lab.createIntent(wallet, { kind: 'deploy' });
  const hash = await c.send(pending);
  c.reopen();
  const first = await c.lab.reconcile(wallet, pending.id);
  assert.equal(first.hash, hash); assert.equal(first.status, 'submitted');
  await c.mine();
  const confirmed = await c.lab.reconcile(wallet, pending.id);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.result.vault, pending.expectedContractAddress);
  assert.equal((await c.lab.walletStatus(wallet)).vault.address, confirmed.result.vault);
  assert.equal((await c.lab.walletStatus(c.accounts[1])).vault, null);
  assert.equal((await c.lab.createIntent(wallet, { kind: 'deploy' })).id, pending.id);
});

test('fund and payout recover lost responses, pay exact fixed-score shares, and do not reallocate after restart', async t => {
  const c = await fixture(t), wallet = c.accounts[0], recipients = c.accounts.slice(1, 4);
  await c.deploy();
  const funding = await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' });
  const fundingHash = await c.send(funding); await c.mine(); c.reopen();
  const recovered = await c.lab.reconcile(wallet, funding.id);
  assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.hash, fundingHash);
  const payout = await c.lab.createIntent(wallet, { kind: 'payout', fundingId: funding.fundingId, recipients });
  assert.deepEqual(payout.allocations.map(row => row.score), [216, 50, 486]);
  const pool = parseEther('0.002');
  assert.equal(payout.poolWei, pool.toString());
  assert.deepEqual(payout.allocations.map(row => row.amountWei), [216n, 50n, 486n].map(score => (pool * score / 752n).toString()));
  const before = await Promise.all(recipients.map(to => c.provider.send('eth_getBalance', [to, 'latest'])));
  const hash = await c.send(payout); await c.mine(); c.reopen();
  const paid = await c.lab.reconcile(wallet, payout.id);
  assert.equal(paid.hash, hash); assert.equal(paid.status, 'confirmed');
  const after = await Promise.all(recipients.map(to => c.provider.send('eth_getBalance', [to, 'latest'])));
  assert.deepEqual(after.map((balance, i) => (BigInt(balance) - BigInt(before[i])).toString()), payout.allocations.map(row => row.amountWei));
  assert.equal((await c.lab.createIntent(wallet, { kind: 'payout', fundingId: funding.fundingId, recipients })).id, paid.id);
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'payout', fundingId: funding.fundingId, recipients: c.accounts.slice(2, 5) }), error => error.code === 'PAYOUT_IMMUTABLE');
  const state = await c.lab.walletStatus(wallet);
  assert.equal(BigInt(state.vault.retainedWei), parseEther('0.008'));
  assert.equal(BigInt(state.vault.balanceWei) + BigInt(payout.paidWei), parseEther('0.01'));
  assert.equal(BigInt(state.vault.carryWei), pool - BigInt(payout.paidWei));
  assert.ok(BigInt(paid.result.networkFeeWei) > 0n);
  assert.equal((await c.lab.reconcile(wallet, paid.id)).result.networkFeeWei, paid.result.networkFeeWei);
});

test('refund recovers an unspent deposit and retained withdrawal is separately bounded', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  await c.deploy();
  const funding = await c.confirm(await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' }));
  const refund = await c.lab.createIntent(wallet, { kind: 'refund', fundingId: funding.fundingId });
  const refundHash = await c.send(refund); await c.mine();
  assert.equal((await c.lab.reconcile(wallet, refund.id)).hash, refundHash);
  assert.equal((await c.lab.walletStatus(wallet)).vault.balanceWei, '0');
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'refund', fundingId: funding.fundingId }), error => error.code === 'FUNDING_UNAVAILABLE');
  const funding2 = await c.confirm(await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' }));
  await c.confirm(await c.lab.createIntent(wallet, { kind: 'payout', fundingId: funding2.fundingId, recipients: c.accounts.slice(1, 4) }));
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'withdraw', to: wallet, amountEth: '0.009' }));
  const withdrawal = await c.lab.createIntent(wallet, { kind: 'withdraw', to: wallet, amountEth: '0.008' });
  await c.send(withdrawal); await c.mine();
  assert.equal((await c.lab.reconcile(wallet, withdrawal.id)).status, 'confirmed');
  assert.equal((await c.lab.walletStatus(wallet)).vault.retainedWei, '0');
});

test('altered from, to, calldata, value, nonce, and chain fail exact matching without attaching a hash', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  await c.deploy();
  const fund = await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' });
  const hash = await c.send(fund), original = c.provider.send;
  const changes = [
    tx => { tx.from = c.accounts[1]; }, tx => { tx.to = c.accounts[1]; },
    tx => { tx.input = '0x1234'; }, tx => { tx.value = '0x1'; },
    tx => { tx.nonce = '0x5'; }, tx => { tx.chainId = '0x1'; },
  ];
  for (const change of changes) {
    c.provider.send = async (method, params) => {
      const result = await original(method, params);
      if (method !== 'eth_getTransactionByHash') return result;
      const changed = copy(result); change(changed); return changed;
    };
    await assert.rejects(c.lab.attachHash(wallet, fund.id, hash), error => error.code === 'TRANSACTION_MISMATCH');
    assert.equal(c.lab.listIntents(wallet).find(row => row.id === fund.id).hash, null);
  }
  c.provider.send = original; await c.mine();
  assert.equal((await c.lab.attachHash(wallet, fund.id, hash)).status, 'confirmed');
});

test('unseen hash and pending receipt never unlock the intent, and one hash cannot confirm two intents', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const deployment = await c.lab.createIntent(wallet, { kind: 'deploy' });
  await assert.rejects(c.lab.attachHash(wallet, deployment.id, fakeHash), error => error.code === 'TRANSACTION_NOT_FOUND');
  assert.equal(c.lab.listIntents(wallet)[0].status, 'prepared');
  const hash = await c.send(deployment);
  assert.equal((await c.lab.attachHash(wallet, deployment.id, hash)).status, 'submitted');
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' }), error => error.code === 'UNRESOLVED_INTENT');
  await c.mine(); await c.lab.reconcile(wallet, deployment.id);
  const fund = await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' });
  await assert.rejects(c.lab.attachHash(wallet, fund.id, hash), error => error.code === 'HASH_REUSED');
  assert.equal(c.lab.listIntents(wallet).find(row => row.id === fund.id).hash, null);
});

test('concurrent preparation resolves to one durable intent and immutable caller-independent copies', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const same = await Promise.all(Array.from({ length: 5 }, () => c.lab.createIntent(wallet, { kind: 'deploy' })));
  assert.equal(new Set(same.map(row => row.id)).size, 1);
  same[0].transaction.data = '0xdead';
  assert.equal(c.lab.listIntents(wallet).length, 1);
  assert.equal(c.lab.listIntents(wallet)[0].transaction.data, artifact.bytecode);
  assert.equal(c.calls.filter(method => method === 'eth_sendTransaction').length, 0);
});

test('invalid client inputs leave state unchanged and cannot supply chain, vault, nonce, or fixture weights', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  for (const input of [
    { kind: 'deploy', chainId: 1 }, { kind: 'deploy', nonce: 5 },
    { kind: 'fund', amountEth: 0.01 }, { kind: 'fund', amountEth: '0.051' },
    { kind: 'fund', amountEth: '1e-2' }, { kind: 'fund', amountEth: '-1' },
    { kind: 'fund', amountEth: '0.0000000000000000001' },
    { kind: 'payout', fundingId: fakeHash, recipients: c.accounts.slice(1, 4), scores: [1, 2, 3] },
    { kind: 'payout', fundingId: fakeHash, recipients: [wallet, ...c.accounts.slice(1, 3)] },
    { kind: 'payout', fundingId: fakeHash, recipients: [c.accounts[1], c.accounts[1], c.accounts[2]] },
  ]) await assert.rejects(c.lab.createIntent(wallet, input));
  assert.deepEqual(c.lab.listIntents(wallet), []);
});

test('failed mined deployment is audited as failed only after confirmations and never registers a vault', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const deploy = await c.lab.createIntent(wallet, { kind: 'deploy' });
  const hash = await c.send(deploy, '0x30000');
  const receipt = await c.provider.send('eth_getTransactionReceipt', [hash]);
  assert.equal(BigInt(receipt.status), 0n);
  assert.equal((await c.lab.attachHash(wallet, deploy.id, hash)).status, 'submitted');
  await c.mine();
  const failed = await c.lab.reconcile(wallet, deploy.id);
  assert.equal(failed.status, 'failed'); assert.ok(BigInt(failed.result.networkFeeWei) > 0n);
  assert.equal((await c.lab.walletStatus(wallet)).vault, null);
});

test('ledger binding rejects a different artifact and returned network config cannot change the chain', async t => {
  const c = await fixture(t);
  const changed = { ...artifact, bytecode: artifact.bytecode + '00' };
  assert.throws(() => new PaymentLab({ provider: c.provider, artifact: changed, dbPath: c.dbPath }), error => error.code === 'LEDGER_BINDING');
  const status = await c.lab.status(); status.chainId = 1; status.limits.distributionBps = 10000;
  assert.equal((await c.lab.status()).chainId, PAYMENT_NETWORK.chainId);
  assert.equal((await c.lab.status()).limits.distributionBps, 2000);
});

test('RPC chain change during preparation leaves no durable intent', async t => {
  const c = await fixture(t), send = c.provider.send; let checks = 0;
  c.provider.send = async (method, params) => method === 'eth_chainId' && ++checks > 1 ? '0x1' : send(method, params);
  await assert.rejects(c.lab.createIntent(c.accounts[0], { kind: 'deploy' }), error => error.code === 'WRONG_CHAIN');
  assert.deepEqual(c.lab.listIntents(c.accounts[0]), []);
});

test('missing or corrupted mined receipts cannot unlock, falsely confirm, or fail a submitted intent', async t => {
  const c = await fixture(t), wallet = c.accounts[0]; await c.deploy();
  const fund = await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' });
  const hash = await c.send(fund); await c.mine();
  const original = c.provider.send;
  for (const change of [
    () => null, receipt => ({ ...receipt, status: null }),
    receipt => ({ ...receipt, status: '0x2' }),
    receipt => ({ ...receipt, logs: [] }),
  ]) {
    c.provider.send = async (method, params) => {
      const result = await original(method, params);
      return method === 'eth_getTransactionReceipt' ? change(copy(result)) : result;
    };
    try { await c.lab.attachHash(wallet, fund.id, hash); }
    catch (error) { assert.ok(['RPC_INVALID', 'RECEIPT_MISMATCH'].includes(error.code)); }
    assert.equal(c.lab.listIntents(wallet).find(row => row.id === fund.id).status, 'submitted');
  }
  c.provider.send = original;
  assert.equal((await c.lab.reconcile(wallet, fund.id)).status, 'confirmed');
});

test('pending external owner transactions and nonce changes during a quote cannot reserve stale payout amounts', async t => {
  const c = await fixture(t), wallet = c.accounts[0]; await c.deploy();
  const funding = await c.confirm(await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' }));
  const input = { kind: 'payout', fundingId: funding.fundingId, recipients: c.accounts.slice(1, 4) };
  const before = c.lab.listIntents(wallet), original = c.provider.send;
  for (const startsBusy of [true, false]) {
    let pendingReads = 0, quotes = 0;
    c.provider.send = async (method, params) => {
      const result = await original(method, params);
      if (method === 'eth_call' && params[0].data.startsWith(c.lab.interface.getFunction('quoteDistribution').selector)) quotes++;
      if (method === 'eth_getTransactionCount' && params[1] === 'pending') {
        pendingReads++;
        if (startsBusy || pendingReads > 1) return `0x${(BigInt(result) + 1n).toString(16)}`;
      }
      return result;
    };
    await assert.rejects(c.lab.createIntent(wallet, input), error => error.code === 'WALLET_NONCE_BUSY');
    assert.equal(quotes, startsBusy ? 0 : 1, 'reject an existing pending transaction before quoting; recheck after a quote too');
    assert.deepEqual(c.lab.listIntents(wallet), before, 'no stale intent is persisted');
  }
  c.provider.send = original;
  assert.equal((await c.lab.createIntent(wallet, input)).status, 'prepared');
});

test('old unsent deployment reconciles without scanning blocks and keeps its nonce reserved', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const prepared = await c.lab.createIntent(wallet, { kind: 'deploy' });
  const original = c.provider.send; let blockScans = 0, nonceReads = 0;
  c.provider.send = async (method, params) => {
    if (method === 'eth_blockNumber') return `0x${(prepared.createdBlock + 10000).toString(16)}`;
    if (method === 'eth_getBlockByNumber') { blockScans++; throw new Error('An unsent deployment must not scan historical blocks.'); }
    if (method === 'eth_getTransactionCount' && params[1] === 'latest') nonceReads++;
    return original(method, params);
  };
  const reconciled = await c.lab.reconcile(wallet, prepared.id);
  assert.deepEqual(reconciled, prepared);
  assert.equal(nonceReads, 1);
  assert.equal(blockScans, 0);
  await assert.rejects(c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' }), error => error.code === 'UNRESOLVED_INTENT');
  assert.equal(c.calls.includes('eth_sendTransaction'), false);
});

test('manual deployment retry check returns the unchanged saved intent without writing or sending', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const prepared = await c.lab.createIntent(wallet, { kind: 'deploy' });
  const before = c.lab.listIntents(wallet);
  const auditCount = c.lab.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  assert.deepEqual(await c.lab.checkDeploymentRetry(wallet, prepared.id), { ...prepared, retryAllowed: true });
  assert.deepEqual(c.lab.listIntents(wallet), before);
  assert.equal(c.lab.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count, auditCount);
  assert.equal(c.calls.includes('eth_sendTransaction'), false);
  await assert.rejects(c.lab.checkDeploymentRetry(c.accounts[1], prepared.id), error => error.statusCode === 404);
  await c.confirm(prepared);
  await assert.rejects(c.lab.checkDeploymentRetry(wallet, prepared.id), error => error.code === 'RETRY_UNAVAILABLE');
  const fund = await c.lab.createIntent(wallet, { kind: 'fund', amountEth: '0.01' });
  await assert.rejects(c.lab.checkDeploymentRetry(wallet, fund.id), error => error.code === 'RETRY_UNAVAILABLE');
});

test('deployment retry is unavailable when either nonce advanced, code exists, or the chain changed', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const prepared = await c.lab.createIntent(wallet, { kind: 'deploy' }), original = c.provider.send;
  for (const scenario of ['latest', 'pending', 'code', 'chain']) {
    c.provider.send = async (method, params) => {
      if (method === 'eth_getTransactionCount' && params[1] === scenario) return '0x1';
      if (method === 'eth_getCode' && scenario === 'code') return '0x01';
      if (method === 'eth_chainId' && scenario === 'chain') return '0x1';
      return original(method, params);
    };
    await assert.rejects(c.lab.checkDeploymentRetry(wallet, prepared.id), error => error.code === (scenario === 'chain' ? 'WRONG_CHAIN' : 'RETRY_UNAVAILABLE'));
    assert.deepEqual(c.lab.listIntents(wallet), [prepared]);
  }
});

test('deployment retry rechecks the row after RPC reads and rejects a concurrently attached hash', async t => {
  const c = await fixture(t), wallet = c.accounts[0];
  const prepared = await c.lab.createIntent(wallet, { kind: 'deploy' }), original = c.provider.send;
  let checks = 0;
  c.provider.send = async (method, params) => {
    const result = await original(method, params);
    if (method === 'eth_chainId' && ++checks === 2) {
      // Represent a second request attaching a hash while these read-only RPCs finish.
      c.lab.db.prepare("UPDATE intents SET tx_hash=?,status='submitted' WHERE id=?").run(fakeHash, prepared.id);
    }
    return result;
  };
  await assert.rejects(c.lab.checkDeploymentRetry(wallet, prepared.id), error => error.code === 'RETRY_UNAVAILABLE');
  const current = c.lab.listIntents(wallet)[0];
  assert.equal(current.status, 'submitted'); assert.equal(current.hash, fakeHash);
  assert.equal(c.calls.includes('eth_sendTransaction'), false);
});
