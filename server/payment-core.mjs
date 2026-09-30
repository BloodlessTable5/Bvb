import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AbiCoder, FetchRequest, Interface, JsonRpcProvider, ZeroAddress, getAddress, getCreateAddress,
  isHexString, keccak256, parseEther, toQuantity, toUtf8Bytes,
} from 'ethers';

export const PAYMENT_NETWORK = Object.freeze({
  network: 'Robinhood Chain Testnet', chainId: 46630, chainHex: '0xb626',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
});
const MAX_FUNDING = parseEther('0.05');
const WEIGHTS = [216, 50, 486];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL = new Set(['confirmed', 'failed']);
const LOG_WINDOW = 2000;
const BLOCK_SCAN_PAGE = 24;

export class PaymentLabError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_REQUEST') {
    super(message); this.name = 'PaymentLabError'; this.statusCode = statusCode; this.code = code;
  }
}
const fail = (message, status = 400, code) => { throw new PaymentLabError(message, status, code); };
function address(value) {
  try { if (typeof value !== 'string') throw new Error(); return getAddress(value); }
  catch { return fail('A valid checksummed or single-case EVM address is required.'); }
}
function bytes32(value, name) {
  if (typeof value !== 'string' || !isHexString(value, 32) || BigInt(value) === 0n) fail(`Invalid ${name}.`);
  return value.toLowerCase();
}
function amount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value)) fail('ETH amounts must be decimal strings with at most 18 decimal places.');
  const wei = parseEther(value);
  if (wei <= 0n) fail('The amount must be positive.');
  return wei;
}
function blockNumber(value) {
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) fail('RPC returned an invalid block number.', 503, 'RPC_INVALID');
  return number;
}
const quantity = value => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);

/** Testnet-only, read-only RPC coordinator. It never signs or broadcasts a transaction. */
export class PaymentLab {
  constructor({ dbPath = resolve(ROOT, '.payment-lab', 'ledger.sqlite'), provider, artifact,
    confirmations = 2 } = {}) {
    if (!Number.isInteger(confirmations) || confirmations < 2) fail('At least two testnet confirmations are required.');
    this.confirmations = confirmations;
    const rpcRequest = new FetchRequest(PAYMENT_NETWORK.rpcUrl);
    rpcRequest.timeout = 12000;
    this.provider = provider ?? new JsonRpcProvider(rpcRequest, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    this.ownsProvider = !provider;
    this.artifact = artifact ?? JSON.parse(readFileSync(resolve(ROOT, 'payment-lab', 'contract.json'), 'utf8'));
    if (!Array.isArray(this.artifact.abi) || !isHexString(this.artifact.bytecode) || !isHexString(this.artifact.deployedBytecode)
      || this.artifact.bytecode.length < 10 || this.artifact.deployedBytecode.length < 10) fail('Invalid payment contract artifact.');
    this.interface = new Interface(this.artifact.abi);
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wallets (wallet TEXT PRIMARY KEY, vault TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES wallets(wallet), kind TEXT NOT NULL,
        request_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','submitted','confirmed','failed')),
        tx_hash TEXT UNIQUE, funding_id TEXT, created_at INTEGER NOT NULL, created_block INTEGER NOT NULL,
        recovery_cursor INTEGER NOT NULL, payload TEXT NOT NULL, result TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_wallet ON intents(wallet) WHERE status IN ('prepared','submitted');
      CREATE UNIQUE INDEX IF NOT EXISTS one_payout_funding ON intents(wallet,funding_id) WHERE kind='payout';
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(id),
        at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL);`);
    const config = JSON.stringify({ chainId: PAYMENT_NETWORK.chainId, rpcUrl: PAYMENT_NETWORK.rpcUrl,
      runtimeHash: keccak256(this.artifact.deployedBytecode), bytecodeHash: keccak256(this.artifact.bytecode) });
    const stored = this.db.prepare('SELECT value FROM config WHERE key=?').get('binding');
    if (stored && stored.value !== config) { this.db.close(); fail('This ledger belongs to a different network or contract artifact.', 409, 'LEDGER_BINDING'); }
    if (!stored) this.db.prepare('INSERT INTO config(key,value) VALUES (?,?)').run('binding', config);
  }

  close() { this.db.close(); if (this.ownsProvider) this.provider.destroy(); }

  async checkChain() {
    const chain = await this.provider.send('eth_chainId', []);
    if (BigInt(chain) !== BigInt(PAYMENT_NETWORK.chainId)) fail('RPC is not Robinhood Chain Testnet. No operation was prepared or accepted.', 503, 'WRONG_CHAIN');
  }

  async status() {
    let healthy = false;
    try { await this.checkChain(); healthy = true; } catch { /* Read-only health reporting. */ }
    return { ...PAYMENT_NETWORK, healthy, confirmations: this.confirmations,
      limits: { maxFundingEth: '0.05', distributionBps: 2000 } };
  }

  row(wallet, id) {
    const row = this.db.prepare('SELECT * FROM intents WHERE id=? AND wallet=?').get(id, wallet);
    if (!row) fail('Intent not found for this wallet.', 404, 'NOT_FOUND');
    return row;
  }

  view(row) {
    return { ...JSON.parse(row.payload), id: row.id, wallet: row.wallet, kind: row.kind,
      status: row.status, hash: row.tx_hash ?? null, createdAt: row.created_at,
      createdBlock: row.created_block, ...(row.result ? { result: JSON.parse(row.result) } : {}) };
  }

  listIntents(wallet) {
    wallet = address(wallet);
    return this.db.prepare('SELECT * FROM intents WHERE wallet=? ORDER BY created_at,id').all(wallet).map(row => this.view(row));
  }

  async call(vault, method, args = [], tag = 'latest') {
    const data = this.interface.encodeFunctionData(method, args);
    const result = await this.provider.send('eth_call', [{ to: vault, data }, tag]);
    return this.interface.decodeFunctionResult(method, result);
  }

  async verifyVault(wallet, vault, tag = 'latest') {
    const code = await this.provider.send('eth_getCode', [vault, tag]);
    if (code.toLowerCase() !== this.artifact.deployedBytecode.toLowerCase()) fail('Vault code does not match this lab artifact.', 409, 'VAULT_MISMATCH');
    const [owner] = await this.call(vault, 'owner', [], tag);
    if (address(owner) !== wallet) fail('The connected wallet does not own this vault.', 403, 'VAULT_OWNER');
  }

  async availableNonce(wallet, expected) {
    const [pending, latest] = await Promise.all([
      this.provider.send('eth_getTransactionCount', [wallet, 'pending']),
      this.provider.send('eth_getTransactionCount', [wallet, 'latest']),
    ]);
    // An earlier owner transaction can change carry after a latest-state quote.
    // Wait for it to mine instead of reserving a subsequent nonce against stale state.
    if (BigInt(pending) !== BigInt(latest) || (expected !== undefined && BigInt(pending) !== BigInt(expected))) {
      fail('The wallet has pending transactions or its nonce changed. Wait for confirmation, then prepare again.', 409, 'WALLET_NONCE_BUSY');
    }
    return toQuantity(BigInt(pending));
  }

  async walletStatus(wallet) {
    wallet = address(wallet); await this.checkChain();
    const balanceWei = BigInt(await this.provider.send('eth_getBalance', [wallet, 'latest'])).toString();
    const record = this.db.prepare('SELECT vault FROM wallets WHERE wallet=?').get(wallet);
    let vault = null;
    if (record?.vault) {
      await this.verifyVault(wallet, record.vault);
      const [balance, retained, carry] = await Promise.all([
        this.provider.send('eth_getBalance', [record.vault, 'latest']),
        this.call(record.vault, 'retainedBalance'), this.call(record.vault, 'carry'),
      ]);
      vault = { address: record.vault, balanceWei: BigInt(balance).toString(),
        retainedWei: retained[0].toString(), carryWei: carry[0].toString() };
    }
    await this.checkChain();
    return { wallet, balanceWei, vault };
  }

  normalize(input, wallet) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('An intent object is required.');
    const fields = { deploy: [], fund: ['amountEth'], payout: ['fundingId', 'recipients'], refund: ['fundingId'], withdraw: ['to', 'amountEth'] };
    if (!Object.hasOwn(fields, input.kind)) fail('Unknown intent kind.');
    if (Object.keys(input).some(key => key !== 'kind' && !fields[input.kind].includes(key))) fail('Unexpected intent field.');
    const request = { kind: input.kind };
    if (input.kind === 'fund' || input.kind === 'withdraw') {
      const wei = amount(input.amountEth);
      if (input.kind === 'fund' && wei > MAX_FUNDING) fail('Funding is capped at 0.05 test ETH per deposit.');
      request.amountWei = wei.toString();
    }
    if (input.kind === 'payout' || input.kind === 'refund') request.fundingId = bytes32(input.fundingId, 'funding ID');
    if (input.kind === 'payout') {
      if (!Array.isArray(input.recipients) || input.recipients.length !== 3) fail('Exactly three recipient addresses are required.');
      request.recipients = input.recipients.map(address);
      if (new Set(request.recipients).size !== 3 || request.recipients.some(to => to === wallet || to === ZeroAddress)) fail('Recipients must be distinct and cannot be the owner or zero address.');
    }
    if (input.kind === 'withdraw') { request.to = address(input.to); if (request.to === ZeroAddress) fail('Zero-address withdrawals are not allowed.'); }
    return request;
  }

  existing(wallet, request, key) {
    const pending = this.db.prepare("SELECT * FROM intents WHERE wallet=? AND status IN ('prepared','submitted')").get(wallet);
    if (pending) {
      if (pending.request_key === key) return this.view(pending);
      fail('This wallet already has an unresolved intent. Reconcile it before preparing another.', 409, 'UNRESOLVED_INTENT');
    }
    if (request.kind === 'payout') {
      const prior = this.db.prepare("SELECT * FROM intents WHERE wallet=? AND kind='payout' AND funding_id=?").get(wallet, request.fundingId);
      if (prior) {
        if (prior.request_key === key) return this.view(prior);
        fail('This funding already has an immutable payout intent with different recipients.', 409, 'PAYOUT_IMMUTABLE');
      }
    }
    if (request.kind === 'deploy') {
      const prior = this.db.prepare("SELECT * FROM intents WHERE wallet=? AND kind='deploy' AND status='confirmed'").get(wallet);
      if (prior) return this.view(prior);
    }
    return null;
  }

  async createIntent(wallet, input) {
    wallet = address(wallet);
    if (wallet === ZeroAddress) fail('The zero address cannot own a vault.');
    const request = this.normalize(input, wallet);
    const key = keccak256(toUtf8Bytes(JSON.stringify(request)));
    await this.checkChain();
    const existing = this.existing(wallet, request, key);
    if (existing) return existing;
    if (await this.provider.send('eth_getCode', [wallet, 'latest']) !== '0x') fail('This test lab currently supports externally owned wallets only.');
    const nonce = await this.availableNonce(wallet);
    const createdBlock = blockNumber(await this.provider.send('eth_blockNumber', []));
    const tx = { from: wallet, data: '0x', value: '0x0', chainId: PAYMENT_NETWORK.chainHex, nonce };
    const payload = { transaction: tx, request };
    const vault = this.db.prepare('SELECT vault FROM wallets WHERE wallet=?').get(wallet)?.vault;
    if (request.kind === 'deploy') {
      tx.data = this.artifact.bytecode;
      payload.expectedContractAddress = getCreateAddress({ from: wallet, nonce });
    } else {
      if (!vault) fail('Deploy and confirm this wallet’s test vault first.', 409, 'VAULT_REQUIRED');
      await this.verifyVault(wallet, vault); tx.to = vault; payload.vault = vault;
      if (request.kind === 'fund') {
        payload.fundingId = `0x${randomBytes(32).toString('hex')}`;
        payload.amountWei = request.amountWei;
        tx.value = toQuantity(BigInt(request.amountWei));
        tx.data = this.interface.encodeFunctionData('fund', [payload.fundingId]);
      } else if (request.kind === 'payout') {
        if (request.recipients.includes(vault)) fail('The vault cannot be a payout recipient.');
        const [funded, spent] = await this.call(vault, 'fundings', [request.fundingId]);
        if (funded === 0n || spent) fail('Funding is absent or already spent.', 409, 'FUNDING_UNAVAILABLE');
        const [pool, amounts, paid, nextCarry] = await this.call(vault, 'quoteDistribution', [request.fundingId]);
        payload.fundingId = request.fundingId;
        payload.batchId = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [vault, request.fundingId]));
        payload.poolWei = pool.toString(); payload.paidWei = paid.toString(); payload.nextCarryWei = nextCarry.toString();
        payload.allocations = request.recipients.map((to, i) => ({ wallet: to, score: WEIGHTS[i], amountWei: amounts[i].toString() }));
        tx.data = this.interface.encodeFunctionData('distribute', [payload.batchId, payload.fundingId, request.recipients]);
      } else if (request.kind === 'refund') {
        const [funded, spent] = await this.call(vault, 'fundings', [request.fundingId]);
        if (funded === 0n || spent) fail('Only unspent funding can be refunded.', 409, 'FUNDING_UNAVAILABLE');
        payload.fundingId = request.fundingId; payload.amountWei = funded.toString();
        tx.data = this.interface.encodeFunctionData('refundUndistributed', [request.fundingId]);
      } else if (request.kind === 'withdraw') {
        if (request.to === vault) fail('The vault cannot withdraw to itself.');
        const [retained] = await this.call(vault, 'retainedBalance');
        if (BigInt(request.amountWei) > retained) fail('Withdrawal exceeds the retained test ETH balance.');
        payload.amountWei = request.amountWei; payload.to = request.to;
        tx.data = this.interface.encodeFunctionData('withdrawRetained', [request.to, request.amountWei]);
      }
    }
    await this.availableNonce(wallet, nonce);
    await this.checkChain();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.existing(wallet, request, key);
      if (duplicate) { this.db.exec('COMMIT'); return duplicate; }
      this.db.prepare('INSERT OR IGNORE INTO wallets(wallet) VALUES (?)').run(wallet);
      const id = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO intents(id,wallet,kind,request_key,status,funding_id,created_at,created_block,recovery_cursor,payload) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, wallet, request.kind, key, 'prepared', payload.fundingId ?? null, now, createdBlock, createdBlock, JSON.stringify(payload));
      this.audit(id, 'prepared', { chainId: PAYMENT_NETWORK.chainId, transactionHash: keccak256(toUtf8Bytes(JSON.stringify(tx))) });
      this.db.exec('COMMIT'); return this.view(this.row(wallet, id));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  audit(id, event, detail) {
    this.db.prepare('INSERT INTO audit(intent_id,at,event,detail) VALUES (?,?,?,?)').run(id, Date.now(), event, JSON.stringify(detail));
  }

  verifyTransaction(intent, hash, tx) {
    if (!tx) fail('Transaction is not visible to the testnet RPC yet. Keep this intent reserved and try reconciliation later.', 409, 'TRANSACTION_NOT_FOUND');
    const expected = intent.transaction;
    if (!quantity(tx.value) || !quantity(tx.nonce) || !quantity(tx.chainId)
      || String(tx.hash).toLowerCase() !== hash || address(tx.from) !== expected.from
      || (tx.to ? address(tx.to) : null) !== (expected.to ?? null)
      || String(tx.input ?? tx.data).toLowerCase() !== expected.data.toLowerCase()
      || BigInt(tx.value) !== BigInt(expected.value) || BigInt(tx.nonce) !== BigInt(expected.nonce)
      || tx.chainId == null || BigInt(tx.chainId) !== BigInt(PAYMENT_NETWORK.chainId)) {
      fail('The chain transaction does not exactly match the prepared intent.', 409, 'TRANSACTION_MISMATCH');
    }
  }

  /** Read-only permission check for a user-requested retry of the same deployment. */
  async checkDeploymentRetry(wallet, id) {
    wallet = address(wallet);
    const row = this.row(wallet, id), intent = this.view(row);
    const eligible = current => current.kind === 'deploy' && current.status === 'prepared' && !current.tx_hash;
    if (!eligible(row)) fail('Only an unresolved deployment without a known hash can be checked for retry.', 409, 'RETRY_UNAVAILABLE');
    await this.checkChain();
    const [latest, pending, code] = await Promise.all([
      this.provider.send('eth_getTransactionCount', [wallet, 'latest']),
      this.provider.send('eth_getTransactionCount', [wallet, 'pending']),
      this.provider.send('eth_getCode', [intent.expectedContractAddress, 'latest']),
    ]);
    const nonce = BigInt(intent.transaction.nonce);
    if (!quantity(latest) || !quantity(pending) || BigInt(latest) !== nonce || BigInt(pending) !== nonce || code !== '0x') {
      fail('The saved deployment nonce or address has changed. Reconcile this action instead of retrying.', 409, 'RETRY_UNAVAILABLE');
    }
    await this.checkChain();
    const current = this.row(wallet, id);
    if (!eligible(current) || current.payload !== row.payload) {
      fail('This saved deployment changed while checking it. Reconcile its current state.', 409, 'RETRY_UNAVAILABLE');
    }
    return { ...this.view(current), retryAllowed: true };
  }

  async attachHash(wallet, id, hash) {
    wallet = address(wallet); hash = bytes32(hash, 'transaction hash');
    const row = this.row(wallet, id), intent = this.view(row);
    await this.checkChain();
    if (row.tx_hash && row.tx_hash !== hash) fail('This intent already has a different transaction hash.', 409, 'HASH_IMMUTABLE');
    const other = this.db.prepare('SELECT id FROM intents WHERE tx_hash=?').get(hash);
    if (other && other.id !== id) fail('This transaction hash belongs to another intent.', 409, 'HASH_REUSED');
    this.verifyTransaction(intent, hash, await this.provider.send('eth_getTransactionByHash', [hash]));
    await this.checkChain();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.row(wallet, id);
      if (current.tx_hash && current.tx_hash !== hash) fail('This intent already has a different transaction hash.', 409, 'HASH_IMMUTABLE');
      if (!current.tx_hash) {
        this.db.prepare("UPDATE intents SET tx_hash=?,status='submitted' WHERE id=?").run(hash, id);
        this.audit(id, 'hash_attached', { hash });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.reconcile(wallet, id);
  }

  async recoverHash(row, head) {
    const intent = this.view(row);
    if (row.kind === 'deploy') {
      const latestNonce = await this.provider.send('eth_getTransactionCount', [row.wallet, 'latest']);
      // An unconsumed nonce cannot have a mined deployment. Keep the reservation,
      // but avoid scanning old blocks when the wallet has not sent the action yet.
      if (BigInt(latestNonce) <= BigInt(intent.transaction.nonce)) return null;
      // A bounded page per request; a missing hash never unlocks or resends deployment.
      const last = Math.min(head, row.recovery_cursor + BLOCK_SCAN_PAGE - 1);
      for (let n = row.recovery_cursor; n <= last; n++) {
        const block = await this.provider.send('eth_getBlockByNumber', [toQuantity(n), true]);
        if (!block?.transactions) return null;
        for (const tx of block.transactions) {
          if (typeof tx === 'object' && tx.from && address(tx.from) === row.wallet && BigInt(tx.nonce) === BigInt(intent.transaction.nonce)) {
            this.verifyTransaction(intent, tx.hash.toLowerCase(), tx); return tx.hash.toLowerCase();
          }
        }
      }
      this.db.prepare('UPDATE intents SET recovery_cursor=? WHERE id=?').run(Math.max(row.created_block, last - this.confirmations + 1), row.id);
      return null;
    }
    if (head - row.created_block > LOG_WINDOW) fail('This unresolved intent needs manual transaction-hash recovery; the automatic log window has passed.', 409, 'RECOVERY_WINDOW');
    const event = row.kind === 'fund' ? 'Funded' : row.kind === 'payout' ? 'Distributed' : row.kind === 'refund' ? 'Refunded' : 'RetainedWithdrawn';
    const args = row.kind === 'payout' ? [intent.batchId, intent.fundingId]
      : row.kind === 'withdraw' ? [intent.to] : [intent.fundingId];
    const topics = this.interface.encodeFilterTopics(event, args);
    const logs = await this.provider.send('eth_getLogs', [{ address: intent.vault, topics,
      fromBlock: toQuantity(row.created_block), toBlock: toQuantity(head) }]);
    for (const log of logs) {
      if (log.removed) continue;
      const hash = bytes32(log.transactionHash, 'transaction hash');
      const tx = await this.provider.send('eth_getTransactionByHash', [hash]);
      try { this.verifyTransaction(intent, hash, tx); return hash; }
      catch (error) { if (!(error instanceof PaymentLabError)) throw error; }
    }
    return null;
  }

  validateEvents(intent, receipt) {
    const events = (receipt.logs ?? []).filter(log => address(log.address) === intent.vault).map(log => {
      try { return this.interface.parseLog(log); } catch { return null; }
    }).filter(Boolean);
    const matching = name => events.filter(event => event.name === name);
    const assert = value => { if (!value) fail('Confirmed receipt events differ from the prepared intent. Keep the intent reserved for inspection.', 409, 'RECEIPT_MISMATCH'); };
    if (intent.kind === 'fund') {
      const [event] = matching('Funded'); assert(matching('Funded').length === 1 && event.args.fundingId.toLowerCase() === intent.fundingId && event.args.amount.toString() === intent.amountWei);
    } else if (intent.kind === 'payout') {
      const paid = matching('Paid'), [event] = matching('Distributed');
      assert(paid.length === 3 && matching('Distributed').length === 1 && event.args.batchId.toLowerCase() === intent.batchId
        && event.args.fundingId.toLowerCase() === intent.fundingId && event.args.paid.toString() === intent.paidWei && event.args.carry.toString() === intent.nextCarryWei);
      paid.forEach((item, i) => assert(item.args.batchId.toLowerCase() === intent.batchId && address(item.args.recipient) === intent.allocations[i].wallet
        && item.args.amount.toString() === intent.allocations[i].amountWei));
    } else if (intent.kind === 'refund') {
      const [event] = matching('Refunded'); assert(matching('Refunded').length === 1 && event.args.fundingId.toLowerCase() === intent.fundingId && event.args.amount.toString() === intent.amountWei);
    } else if (intent.kind === 'withdraw') {
      const [event] = matching('RetainedWithdrawn'); assert(matching('RetainedWithdrawn').length === 1 && address(event.args.recipient) === intent.to && event.args.amount.toString() === intent.amountWei);
    }
  }

  async reconcile(wallet, id) {
    wallet = address(wallet); let row = this.row(wallet, id);
    await this.checkChain();
    if (TERMINAL.has(row.status)) return this.view(row);
    const head = blockNumber(await this.provider.send('eth_blockNumber', []));
    if (!row.tx_hash) {
      const recovered = await this.recoverHash(row, head);
      if (!recovered) return this.view(this.row(wallet, id));
      return this.attachHash(wallet, id, recovered);
    }
    const intent = this.view(row);
    const tx = await this.provider.send('eth_getTransactionByHash', [row.tx_hash]);
    this.verifyTransaction(intent, row.tx_hash, tx);
    const receipt = await this.provider.send('eth_getTransactionReceipt', [row.tx_hash]);
    if (!receipt) return intent;
    if (String(receipt.transactionHash).toLowerCase() !== row.tx_hash || address(receipt.from) !== wallet
      || (receipt.to ? address(receipt.to) : null) !== (intent.transaction.to ?? null)) fail('Receipt identity does not match the intent.', 409, 'RECEIPT_MISMATCH');
    const mined = blockNumber(receipt.blockNumber);
    if (head - mined + 1 < this.confirmations) return intent;
    const block = await this.provider.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!block || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return intent;
    if (!quantity(receipt.status) || ![0n, 1n].includes(BigInt(receipt.status))
      || !quantity(receipt.gasUsed) || !quantity(receipt.effectiveGasPrice ?? tx.gasPrice)) {
      fail('RPC receipt is incomplete or malformed. The intent remains reserved.', 503, 'RPC_INVALID');
    }
    const success = BigInt(receipt.status) === 1n;
    let vault = null;
    if (success && intent.kind === 'deploy') {
      vault = address(receipt.contractAddress);
      if (vault !== intent.expectedContractAddress) fail('Deployment address differs from the reserved nonce.', 409, 'VAULT_MISMATCH');
      await this.verifyVault(wallet, vault, receipt.blockNumber);
    } else if (success) {
      await this.verifyVault(wallet, intent.vault, receipt.blockNumber);
      this.validateEvents(intent, receipt);
      if (intent.kind === 'payout') {
        const [batch] = await this.call(intent.vault, 'batches', [intent.batchId], receipt.blockNumber);
        const [, spent] = await this.call(intent.vault, 'fundings', [intent.fundingId], receipt.blockNumber);
        if (!batch || !spent) fail('Payout state does not match its confirmed events.', 409, 'RECEIPT_MISMATCH');
      }
    }
    await this.checkChain();
    const result = { blockNumber: mined, blockHash: receipt.blockHash,
      confirmations: head - mined + 1, networkFeeWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? tx.gasPrice)).toString(),
      ...(vault ? { vault } : {}) };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      row = this.row(wallet, id);
      if (!TERMINAL.has(row.status)) {
        if (vault) this.db.prepare('UPDATE wallets SET vault=? WHERE wallet=?').run(vault, wallet);
        this.db.prepare('UPDATE intents SET status=?,result=? WHERE id=?').run(success ? 'confirmed' : 'failed', JSON.stringify(result), id);
        this.audit(id, success ? 'confirmed' : 'failed', { hash: row.tx_hash, ...result });
      }
      this.db.exec('COMMIT'); return this.view(this.row(wallet, id));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
