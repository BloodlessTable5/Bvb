import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { WalletAuth } from '../server/wallet-auth.mjs';

const origin = 'http://127.0.0.1:4175';
test('wallet sign-in binds the challenge to a wallet, origin, test chain and expiry', async () => {
  const now = Date.UTC(2026, 8, 30), auth = new WalletAuth({ now: () => now }), wallet = Wallet.createRandom();
  const challenge = auth.challenge(wallet.address, origin);
  assert.match(challenge.message, /Chain ID: 46630/); assert.ok(challenge.message.includes(origin));
  assert.ok(challenge.message.includes(wallet.address)); assert.match(challenge.message, /Expiration Time:/);
  const result = auth.verify(challenge.id, await wallet.signMessage(challenge.message), origin);
  assert.equal(result.wallet, wallet.address);
  assert.deepEqual(auth.session(result.token, origin, result.csrfToken), { wallet: wallet.address, csrfToken: result.csrfToken });
  assert.throws(() => auth.verify(challenge.id, '0x', origin), /already used/);
  assert.throws(() => auth.session(result.token, 'http://evil.example', result.csrfToken), /expired/);
  for (const csrf of ['', '0'.repeat(64), 'é'.repeat(64)]) assert.throws(() => auth.session(result.token, origin, csrf), /token did not match/);
  auth.logout(result.token); assert.throws(() => auth.session(result.token, origin), /expired/);
});

test('a different signer, modified message, cross-origin challenge or expired request cannot create a session', async () => {
  let now = 1000000; const auth = new WalletAuth({ now: () => now }), wallet = Wallet.createRandom(), other = Wallet.createRandom();
  const wrong = auth.challenge(wallet.address, origin);
  assert.throws(() => auth.verify(wrong.id, other.signingKey.sign('0x' + '00'.repeat(32)).serialized, origin));
  const changed = auth.challenge(wallet.address, origin);
  const changedSignature = await wallet.signMessage(changed.message.replace('46630', '4663'));
  assert.throws(() => auth.verify(changed.id, changedSignature, origin), /different wallet/);
  const crossOrigin = auth.challenge(wallet.address, origin);
  assert.throws(() => auth.verify(crossOrigin.id, '0x', 'http://evil.example'), /expired or already used/);
  const expired = auth.challenge(wallet.address, origin), signature = await wallet.signMessage(expired.message);
  now += 5 * 60000;
  assert.throws(() => auth.verify(expired.id, signature, origin), /expired/);
  assert.equal(auth.sessions.size, 0);
});

test('sessions expire and local sign-in requests have a bounded memory footprint', async () => {
  let now = 0; const auth = new WalletAuth({ now: () => now }), wallet = Wallet.createRandom();
  const challenge = auth.challenge(wallet.address, origin), result = auth.verify(challenge.id, await wallet.signMessage(challenge.message), origin);
  now = 30 * 60000;
  assert.throws(() => auth.session(result.token, origin), /expired/);
  for (let i = 0; i < 200; i++) auth.challenge(wallet.address, origin);
  assert.throws(() => auth.challenge(wallet.address, origin), /Too many pending/);
  now += 5 * 60000; auth.challenge(wallet.address, origin);
  assert.equal(auth.challenges.size, 1); assert.equal(auth.sessions.size, 0);
});
