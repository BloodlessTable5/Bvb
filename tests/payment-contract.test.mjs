import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, Contract, ContractFactory, ZeroAddress, ZeroHash, id, parseEther } from 'ethers';
import { compilePaymentContract } from '../scripts/compile-payment-contract.mjs';

const artifact = compilePaymentContract();
const vaultSource = readFileSync(new URL('../contracts/HolderTestPayoutVault.sol', import.meta.url), 'utf8');
const helperSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "contracts/HolderTestPayoutVault.sol";
contract RejectingRecipient { receive() external payable { revert("reject test payment"); } }
contract ReenteringOwner {
  HolderTestPayoutVault public vault;
  bool public callbackAttempted;
  bool public callbackBlocked;
  bool private attacking;
  bytes32 private reserved;
  constructor() { vault = new HolderTestPayoutVault(); }
  function fund(bytes32 fundingId) external payable { vault.fund{value: msg.value}(fundingId); }
  function distribute(bytes32 batchId, bytes32 fundingId, address[] calldata recipients) external { vault.distribute(batchId, fundingId, recipients); }
  function attackWithdrawal(bytes32 fundingId, uint256 amount) external {
    reserved = fundingId; attacking = true;
    vault.withdrawRetained(payable(address(this)), amount);
    attacking = false;
  }
  receive() external payable {
    if (attacking) {
      callbackAttempted = true;
      (bool success,) = address(vault).call(abi.encodeCall(vault.refundUndistributed, (reserved)));
      callbackBlocked = !success;
    }
  }
}`;
const helperOutput = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
  'contracts/HolderTestPayoutVault.sol': { content: vaultSource }, 'TestHelpers.sol': { content: helperSource },
}, settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const compileErrors = (helperOutput.errors || []).filter(error => error.severity === 'error');
assert.deepEqual(compileErrors, [], compileErrors.map(error => error.formattedMessage).join('\n'));

async function setup(t, chainId = 31337, deploy = true) {
  const chain = ganache.provider({ chain: { chainId, hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 8, defaultBalance: 100 }, logging: { quiet: true } });
  const provider = new BrowserProvider(chain, 'any', { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await chain.disconnect(); });
  const owner = await provider.getSigner(0), other = await provider.getSigner(4);
  const recipients = await Promise.all([1, 2, 3].map(async index => (await provider.getSigner(index)).getAddress()));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
  const vault = deploy ? await factory.deploy() : null;
  if (vault) await vault.waitForDeployment();
  const balance = async address => BigInt(await chain.request({ method: 'eth_getBalance', params: [address, 'latest'] }));
  return { chain, provider, owner, other, recipients, factory, vault, balance };
}

const mined = async pending => (await pending).wait();
const expectRevert = async action => assert.rejects(async () => { await mined(action()); });
const expected = (amount, carry = 0n) => {
  const newPool = amount * 2000n / 10000n, pool = newPool + carry;
  const amounts = [216n, 50n, 486n].map(score => pool * score / 752n);
  const paid = amounts.reduce((sum, value) => sum + value, 0n);
  return { pool, amounts, paid, carry: pool - paid, retained: amount - newPool };
};

async function deployHelper(name, signer) {
  const compiled = helperOutput.contracts['TestHelpers.sol'][name];
  const contract = await new ContractFactory(compiled.abi, `0x${compiled.evm.bytecode.object}`, signer).deploy();
  await contract.waitForDeployment(); return contract;
}

test('artifact is deterministic Paris bytecode with fixed scores and no constructor arguments', () => {
  assert.deepEqual(compilePaymentContract(), artifact);
  assert.equal(artifact.testOnly, true); assert.equal(artifact.evmVersion, 'paris');
  assert.deepEqual(artifact.allowedChainIds, [46630, 31337]);
  assert.equal(artifact.abi.find(item => item.type === 'constructor').inputs.length, 0);
  assert.deepEqual(artifact.abi.find(item => item.name === 'distribute').inputs.map(input => input.type), ['bytes32', 'bytes32', 'address[]']);
  for (const checksum of Object.values(artifact.checksums)) assert.match(checksum, /^[a-f0-9]{64}$/);
});

test('funded distribution pays exact hardcoded shares and conserves the 20/80 split with reserved carry', async t => {
  const { vault, owner, recipients, balance, provider } = await setup(t);
  const vaultAddress = await vault.getAddress(), amount = parseEther('0.01') + 1n, quote = expected(amount);
  assert.equal(await vault.owner(), await owner.getAddress());
  assert.equal(await provider.getCode(vaultAddress), artifact.deployedBytecode);
  await mined(vault.fund(id('funding-1'), { value: amount }));
  const before = await Promise.all(recipients.map(balance));
  const preview = await vault.quoteDistribution(id('funding-1'));
  assert.equal(preview.pool, quote.pool); assert.deepEqual([...preview.amounts], quote.amounts);
  const receipt = await mined(vault.distribute(id('batch-1'), id('funding-1'), recipients));
  const after = await Promise.all(recipients.map(balance));
  assert.deepEqual(after.map((value, index) => value - before[index]), quote.amounts);
  const events = receipt.logs.map(log => vault.interface.parseLog(log)).filter(Boolean);
  assert.equal(events.filter(event => event.name === 'Paid').length, 3);
  assert.equal(events.find(event => event.name === 'Distributed').args.paid, quote.paid);
  assert.equal((await vault.fundings(id('funding-1'))).spent, true);
  assert.equal(await vault.batches(id('batch-1')), true);
  assert.equal(await vault.retainedBalance(), quote.retained); assert.equal(await vault.carry(), quote.carry);
  assert.equal(await balance(vaultAddress), quote.retained + quote.carry);
  assert.equal(quote.paid + quote.retained + quote.carry, amount);
});

test('carry is reused once without another percentage haircut, and funding or batch replays cannot pay twice', async t => {
  const { vault, recipients } = await setup(t);
  await mined(vault.fund(id('first'), { value: 1001n }));
  await mined(vault.distribute(id('batch-first'), id('first'), recipients));
  assert.equal(await vault.carry(), 1n);
  await mined(vault.fund(id('second'), { value: 1000n }));
  assert.equal((await vault.quoteDistribution(id('second'))).pool, 201n);
  await expectRevert(() => vault.fund(id('first'), { value: 1000n }));
  await expectRevert(() => vault.distribute(id('new-batch'), id('first'), recipients));
  await expectRevert(() => vault.distribute(id('batch-first'), id('second'), recipients));
  assert.equal((await vault.fundings(id('second'))).spent, false);
  await mined(vault.distribute(id('batch-second'), id('second'), recipients));
  assert.equal(await vault.carry(), 2n); assert.equal(await vault.retainedBalance(), 1601n);
});

test('a rejected recipient rolls back all transfers and every funding, batch, retained and carry change', async t => {
  const { vault, owner, recipients, balance } = await setup(t);
  const rejector = await deployHelper('RejectingRecipient', owner), receiver = await rejector.getAddress();
  await mined(vault.fund(id('atomic'), { value: 10000n }));
  const before = await Promise.all(recipients.map(balance));
  await expectRevert(() => vault.distribute(id('reverted-batch'), id('atomic'), [recipients[0], receiver, recipients[2]], { gasLimit: 1_000_000 }));
  assert.deepEqual(await Promise.all(recipients.map(balance)), before);
  assert.equal((await vault.fundings(id('atomic'))).spent, false); assert.equal(await vault.batches(id('reverted-batch')), false);
  assert.equal(await vault.retainedBalance(), 0n); assert.equal(await vault.carry(), 0n);
  await mined(vault.distribute(id('reverted-batch'), id('atomic'), recipients));
  assert.equal(await vault.batches(id('reverted-batch')), true);
});

test('non-owner calls cannot fund, distribute, refund or withdraw', async t => {
  const { vault, other, recipients } = await setup(t);
  await mined(vault.fund(id('authorized'), { value: 1000n }));
  const stranger = vault.connect(other);
  await expectRevert(() => stranger.fund(id('unauthorized'), { value: 1000n }));
  await expectRevert(() => stranger.distribute(id('batch'), id('authorized'), recipients));
  await expectRevert(() => stranger.refundUndistributed(id('authorized')));
  await expectRevert(() => stranger.withdrawRetained(recipients[0], 1n));
  assert.equal((await vault.fundings(id('authorized'))).spent, false);
});

test('retained withdrawals and refunds cannot drain another funding or reserved carry', async t => {
  const { vault, recipients, balance } = await setup(t);
  const address = await vault.getAddress();
  await mined(vault.fund(id('paid'), { value: 1001n }));
  await mined(vault.distribute(id('paid-batch'), id('paid'), recipients));
  await mined(vault.fund(id('reserved'), { value: 5000n }));
  await expectRevert(() => vault.withdrawRetained(recipients[0], 802n));
  await mined(vault.withdrawRetained(recipients[0], 801n));
  assert.equal(await balance(address), 5001n); assert.equal(await vault.retainedBalance(), 0n);
  await expectRevert(() => vault.withdrawRetained(recipients[0], 1n));
  await expectRevert(() => vault.refundUndistributed(id('paid')));
  await mined(vault.refundUndistributed(id('reserved')));
  assert.equal(await balance(address), 1n); assert.equal(await vault.carry(), 1n);
  assert.equal((await vault.fundings(id('reserved'))).spent, true);
  await expectRevert(() => vault.refundUndistributed(id('reserved')));
  await expectRevert(() => vault.fund(id('reserved'), { value: 5n }));
});

test('even an owner contract cannot reenter a withdrawal to refund reserved funding', async t => {
  const { owner, recipients } = await setup(t, 31337, false);
  const attacker = await deployHelper('ReenteringOwner', owner);
  const vault = new Contract(await attacker.vault(), artifact.abi, owner);
  await mined(attacker.fund(id('spent'), { value: 1000n }));
  await mined(attacker.distribute(id('batch'), id('spent'), recipients));
  await mined(attacker.fund(id('reserved'), { value: 5000n }));
  await mined(attacker.attackWithdrawal(id('reserved'), 1n));
  assert.equal(await attacker.callbackAttempted(), true); assert.equal(await attacker.callbackBlocked(), true);
  assert.equal((await vault.fundings(id('reserved'))).spent, false); assert.equal(await vault.retainedBalance(), 799n);
});

test('invalid identifiers, caps and recipient sets revert without consuming a funding', async t => {
  const { vault, owner, recipients } = await setup(t);
  const address = await vault.getAddress();
  await expectRevert(() => vault.fund(ZeroHash, { value: 1n }));
  await expectRevert(() => vault.fund(id('zero'), { value: 0n }));
  await expectRevert(() => vault.fund(id('too-large'), { value: parseEther('0.05') + 1n }));
  await mined(vault.fund(id('cap'), { value: parseEther('0.05') }));
  for (const invalid of [[], recipients.slice(0, 2), [...recipients, recipients[0]],
    [ZeroAddress, recipients[1], recipients[2]], [recipients[0], recipients[0], recipients[2]],
    [await owner.getAddress(), recipients[1], recipients[2]], [address, recipients[1], recipients[2]]]) {
    await expectRevert(() => vault.distribute(id('invalid-batch'), id('cap'), invalid));
  }
  await expectRevert(() => vault.distribute(ZeroHash, id('cap'), recipients));
  assert.equal((await vault.fundings(id('cap'))).spent, false);
});

test('ordinary direct ETH and unknown payable calls are rejected', async t => {
  const { vault, owner, balance } = await setup(t);
  const to = await vault.getAddress();
  await expectRevert(() => owner.sendTransaction({ to, value: 1n, gasLimit: 100000 }));
  await expectRevert(() => owner.sendTransaction({ to, value: 1n, data: '0x12345678', gasLimit: 100000 }));
  assert.equal(await balance(to), 0n);
});

test('deployment succeeds on Robinhood testnet but rejects Robinhood mainnet and other chains', async t => {
  const allowed = await setup(t, 46630);
  assert.equal(await allowed.vault.owner(), await allowed.owner.getAddress());
  for (const chainId of [4663, 1]) {
    const { factory } = await setup(t, chainId, false);
    await assert.rejects(async () => { const vault = await factory.deploy({ gasLimit: 3_000_000 }); await vault.waitForDeployment(); });
  }
});
