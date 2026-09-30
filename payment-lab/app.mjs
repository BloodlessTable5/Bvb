import { getAddress, parseEther, formatEther, hexlify, toUtf8Bytes } from '/vendor/ethers.js';

const CHAIN_ID = 46630;
const CHAIN_HEX = '0xb626';
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const RPC_URL = 'https://rpc.testnet.chain.robinhood.com';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const NAMES = ['Alice', 'Bob', 'Cara'];
const TERMINAL = new Set(['confirmed', 'failed']);
const READ_TIMEOUT_MS = 8000;
const $ = id => document.getElementById(id);
const state = {
  provider: window.ethereum ?? window.phantom?.ethereum ?? null,
  generation: 0, busy: false, account: null, chainId: null, session: null,
  server: null, wallet: null, intents: [], review: null,
  logoutPromise: Promise.resolve(),
  connectionBusy: false, refreshing: false, accountsRevision: 0, chainRevision: 0,
  walletError: '', historyError: '',
};
const attempts = new Map();

function setStatus(message, tone = '', focus = false) {
  $('status').textContent = message;
  $('status').dataset.tone = tone;
  if (focus) $('status').focus({ preventScroll: true });
}

function errorMessage(error) {
  if (Number(error?.code) === 4001 || Number(error?.info?.error?.code) === 4001) return 'Wallet request declined. Nothing further was sent by the lab.';
  return String(error?.shortMessage ?? error?.message ?? 'The request could not complete. Check the saved action before trying again.').slice(0, 400);
}

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function sameAddress(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function normalizedAddress(value) { try { return getAddress(value); } catch { return null; } }
function isReady() { return !!(state.session && sameAddress(state.account, state.session.wallet) && state.chainId === CHAIN_ID && state.server?.healthy); }
function unresolved() { return state.intents.find(intent => !TERMINAL.has(intent.status)); }
function ether(value) { try { return formatEther(BigInt(value)); } catch { return '—'; } }
function shortId(value) { return typeof value === 'string' ? `${value.slice(0, 10)}…${value.slice(-6)}` : '—'; }
function validHash(value) { return /^0x[0-9a-f]{64}$/i.test(value ?? ''); }

function boundedRead(promise, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out. Use Refresh connection to try again.`)), READ_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readProvider(method, params) {
  return boundedRead(state.provider.request({ method, ...(params ? { params } : {}) }), 'Reading the wallet');
}

function expireSession(expectedSession) {
  if (!expectedSession || state.session !== expectedSession) return;
  state.generation += 1;
  state.session = null; state.wallet = null; state.intents = []; state.review = null;
  state.walletError = ''; state.historyError = '';
  render();
  setStatus('Wallet verification expired. Your wallet is still connected; verify ownership again to restore its saved actions.', 'error');
}

async function api(path, { method = 'GET', body, csrf = state.session?.csrfToken } = {}) {
  const requestSession = state.session;
  const headers = { Accept: 'application/json' };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const request = (async () => {
    const response = await fetch(path, { method, headers, credentials: 'same-origin', ...(body ? { body: JSON.stringify(body) } : {}) });
    let value;
    try { value = await response.json(); } catch { throw new Error('The local payment server returned an unreadable response.'); }
    return { response, value };
  })();
  const { response, value } = await (method === 'GET' || path.endsWith('/reconcile') || path.endsWith('/retry-check')
    ? boundedRead(request, 'Reading the payment lab') : request);
  if (!response.ok) {
    if (response.status === 401) expireSession(requestSession);
    const error = new Error(response.status === 401 && requestSession
      ? 'Wallet verification expired. Verify ownership again; your connected account and saved actions are preserved.'
      : value.error ?? `Request failed (${response.status}).`);
    error.code = value.code; error.status = response.status;
    throw error;
  }
  return value;
}

function snapshot() {
  if (!isReady()) throw new Error('Connect and verify your wallet on Robinhood Chain testnet first.');
  return { generation: state.generation, wallet: state.account, csrfToken: state.session.csrfToken };
}

function ensureCurrent(context) {
  if (!state.session && sameAddress(context.wallet, state.account) && state.chainId === CHAIN_ID) {
    throw new Error('Wallet verification expired. Verify ownership again to restore the saved actions for your connected account.');
  }
  if (context.generation !== state.generation || !sameAddress(context.wallet, state.account)
    || !sameAddress(context.wallet, state.session?.wallet) || state.chainId !== CHAIN_ID) {
    throw new Error('Wallet or network changed. The old action is saved; reconnect its original wallet to check its result.');
  }
}

async function checkProvider(context) {
  ensureCurrent(context);
  const [accounts, chain] = await Promise.all([
    readProvider('eth_accounts'), readProvider('eth_chainId'),
  ]);
  ensureCurrent(context);
  if (!sameAddress(accounts?.[0], context.wallet) || Number(BigInt(chain)) !== CHAIN_ID) {
    invalidate('Wallet or network changed. Verify the current wallet before continuing.');
    throw new Error('The wallet no longer matches this saved action. No transaction was requested.');
  }
}

function getAttempt(id) {
  if (attempts.has(id)) return attempts.get(id);
  try {
    const value = JSON.parse(localStorage.getItem(`holder-payment-attempt:${id}`));
    if (value && typeof value === 'object') { attempts.set(id, value); return value; }
  } catch { /* The in-memory guard remains available if browser storage is blocked. */ }
  return null;
}

function saveAttempt(id, value) {
  attempts.set(id, value);
  try { localStorage.setItem(`holder-payment-attempt:${id}`, JSON.stringify(value)); } catch { /* No private data is required for this guard. */ }
}

function upsert(intent) {
  const index = state.intents.findIndex(item => item.id === intent.id);
  if (index >= 0) state.intents[index] = intent;
  else state.intents.push(intent);
  if (state.review?.id === intent.id) state.review = intent;
}

function invalidate(message) {
  const oldSession = state.session;
  state.generation += 1;
  state.session = null; state.wallet = null; state.intents = []; state.review = null;
  state.walletError = ''; state.historyError = '';
  for (const name of NAMES) $(`recipient-${name.toLowerCase()}`).value = '';
  render();
  if (message) setStatus(message, '', true);
  // Invalidate the old browser session without requesting any new wallet permission.
  if (oldSession) state.logoutPromise = api('/api/logout', { method: 'POST', body: {}, csrf: oldSession.csrfToken }).catch(() => {});
}

async function action(task) {
  if (state.busy) return;
  state.busy = true; render();
  try { await task(); }
  catch (error) { setStatus(errorMessage(error), 'error', true); }
  finally { state.busy = false; render(); }
}

async function refresh(context = snapshot(), { reconcile = false } = {}) {
  state.refreshing = true; render();
  try {
    const [wallet, history] = await Promise.allSettled([api('/api/wallet'), api('/api/intents')]);
    ensureCurrent(context);
    state.walletError = wallet.status === 'rejected' ? errorMessage(wallet.reason) : '';
    state.historyError = history.status === 'rejected' ? errorMessage(history.reason) : '';
    if (wallet.status === 'fulfilled') {
      if (!sameAddress(wallet.value.wallet, context.wallet)) throw new Error('Server session changed. Reconnect before continuing.');
      state.wallet = wallet.value;
    }
    if (history.status === 'fulfilled') {
      state.intents = history.value.intents;
      if (state.review) state.review = state.intents.find(intent => intent.id === state.review.id) ?? null;
    }
    render();
    const pending = unresolved();
    if (reconcile && history.status === 'fulfilled' && pending) {
      try {
        const updated = await api(`/api/intents/${encodeURIComponent(pending.id)}/reconcile`, { method: 'POST', body: {} });
        ensureCurrent(context); upsert(updated); render();
        if (TERMINAL.has(updated.status)) {
          const nextWallet = await api('/api/wallet');
          ensureCurrent(context);
          if (!sameAddress(nextWallet.wallet, context.wallet)) throw new Error('Server session changed.');
          state.wallet = nextWallet; state.walletError = '';
        }
      } catch (error) {
        ensureCurrent(context);
        state.walletError = `The saved action still needs an onchain check. ${errorMessage(error)}`;
      }
    }
  } finally { state.refreshing = false; render(); }
}

function showRefreshMessage(message) {
  const warning = state.walletError || state.historyError;
  setStatus(warning ? `Saved history remains available. ${warning}` : message, warning ? 'error' : '');
}

function spentFunding() {
  return new Set(state.intents.filter(intent => ['payout', 'refund'].includes(intent.kind) && intent.status === 'confirmed').map(intent => intent.fundingId));
}

function fundingOptions(selectId = 'funding-select') {
  const select = $(selectId);
  const previous = select.value;
  const spent = spentFunding();
  const funds = state.intents.filter(intent => intent.kind === 'fund' && intent.status === 'confirmed' && !spent.has(intent.fundingId));
  select.replaceChildren();
  if (!funds.length) {
    const option = make('option', 'No confirmed deposits yet'); option.value = ''; select.append(option);
  } else for (const fund of funds) {
    const option = make('option', `${ether(fund.amountWei)} test ETH · ${shortId(fund.fundingId)}`);
    option.value = fund.fundingId; select.append(option);
  }
  if (funds.some(fund => fund.fundingId === previous)) select.value = previous;
  select.disabled = state.busy || !isReady() || !funds.length || !!unresolved();
  return funds;
}

function renderReview() {
  const intent = state.review;
  $('payout-review').hidden = !intent;
  if (!intent) return;
  $('review-allocations').replaceChildren();
  for (const [i, allocation] of (intent.allocations ?? []).entries()) {
    const item = make('div', null, 'allocation');
    const top = make('div', null, 'allocation-top');
    top.append(make('span', `${NAMES[i]} · ${allocation.score} points`), make('strong', ether(allocation.amountWei)));
    item.append(top, make('code', allocation.wallet)); $('review-allocations').append(item);
  }
  $('review-pool').textContent = `${ether(intent.poolWei)} test ETH`;
  $('review-carry').textContent = `${ether(intent.nextCarryWei)} test ETH`;
  $('review-fee').textContent = 'Additional · shown in wallet';
  $('review-vault').textContent = intent.vault ?? intent.transaction?.to ?? '—';
  $('review-batch').textContent = intent.batchId ?? '—';
  $('review-data').textContent = intent.transaction?.data ?? '—';
  const attempted = getAttempt(intent.id)?.attempted;
  $('approve-payout').disabled = state.busy || state.connectionBusy || state.refreshing || !isReady() || intent.status !== 'prepared' || !!attempted;
  $('approve-payout').textContent = intent.status === 'confirmed' ? 'Payout confirmed'
    : intent.status === 'failed' ? 'Transaction failed onchain'
      : intent.hash || attempted ? 'Check this action in history' : 'Approve testnet payout ↗';
}

function historyButton(label, callback, className = 'quiet') {
  const button = make('button', label, className); button.type = 'button';
  button.disabled = state.busy || state.connectionBusy || state.refreshing || !isReady();
  button.addEventListener('click', () => action(callback));
  return button;
}

function deploymentRecoveryLabel(intent) {
  const local = getAttempt(intent.id);
  return intent.hash || local?.hash ? 'Check saved deployment'
    : local?.attempted ? 'Check and retry saved deployment ↗' : 'Resume saved deployment ↗';
}

function renderHistory() {
  const list = $('history-list'); list.replaceChildren();
  if (!state.intents.length) {
    list.append(make('p', 'Verified transactions and saved intents will appear here.', 'empty-history')); return;
  }
  for (const intent of [...state.intents].reverse()) {
    const item = make('article', null, 'history-item');
    const top = make('div', null, 'history-top');
    const titles = { deploy: 'Vault deployment', fund: 'Test deposit', payout: 'Test distribution', refund: 'Deposit refund', withdraw: 'Retained funds withdrawal' };
    const labels = { prepared: 'SAVED · NOT CONFIRMED', submitted: 'AWAITING 2 CONFIRMATIONS', confirmed: 'CONFIRMED', failed: 'FAILED ONCHAIN' };
    top.append(make('strong', titles[intent.kind] ?? intent.kind), make('span', labels[intent.status] ?? intent.status, 'history-status'));
    item.append(top, make('p', `Saved ${new Date(intent.createdAt).toLocaleString()} · ${intent.id}`));
    if (intent.amountWei != null) item.append(make('p', `${ether(intent.amountWei)} test ETH`));
    if (intent.kind === 'payout') item.append(make('p', `${ether(intent.paidWei)} test ETH to Alice, Bob, and Cara`));
    if (intent.result) item.append(make('p', `Block ${intent.result.blockNumber} · ${intent.result.confirmations} confirmations · fee ${ether(intent.result.networkFeeWei)} test ETH`));
    const controls = make('div', null, 'history-actions');
    const local = getAttempt(intent.id);
    const hash = intent.hash ?? local?.hash;
    if (validHash(hash)) {
      const link = make('a', 'View transaction ↗'); link.href = `${EXPLORER}/tx/${hash}`;
      link.target = '_blank'; link.rel = 'noreferrer'; controls.append(link);
      item.append(make('code', hash));
    }
    if (!TERMINAL.has(intent.status)) controls.append(historyButton('Check result', () => reconcileIntent(intent.id)));
    if (intent.kind === 'payout') controls.append(historyButton('Review recipients', async () => {
      state.review = intent; renderReview(); $('payout-review').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    if (intent.status === 'prepared' && intent.kind === 'deploy') {
      controls.append(historyButton(deploymentRecoveryLabel(intent), () => resumeDeployment(intent)));
    } else if (intent.status === 'prepared' && !local?.attempted && intent.kind !== 'payout') {
      controls.append(historyButton('Approve saved action ↗', () => sendIntent(intent)));
    }
    item.append(controls);
    if (intent.status === 'prepared') {
      item.append(make('p', local?.attempted
        ? intent.kind === 'deploy' ? 'Wallet response uncertain. The vault recovery button checks whether the same saved deployment can be retried. A known transaction hash is checked without sending again.'
          : 'Wallet response uncertain. Check the result or attach its transaction hash; do not send a new action.'
        : 'Saved intent. If you already approved it elsewhere, check its result or attach its hash before opening the wallet.'));
      if (local?.lastError) item.append(make('p', `Last wallet response: ${local.lastError}`));
    }
    if (!TERMINAL.has(intent.status) && !intent.hash) {
      const details = make('details', null, 'hash-recovery'); details.append(make('summary', 'Recover with a transaction hash'));
      const form = make('form'); const label = make('label', 'Transaction hash from your wallet');
      const input = make('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = '0x… transaction hash'; input.maxLength = 66; input.required = true;
      input.id = `recover-${intent.id}`; label.htmlFor = input.id; input.value = validHash(local?.hash) ? local.hash : '';
      const button = make('button', 'Attach hash and check', 'secondary'); button.type = 'submit'; button.disabled = state.busy || state.connectionBusy || state.refreshing || !isReady();
      form.append(label, input, button);
      form.addEventListener('submit', event => {
        event.preventDefault(); const hash = input.value.trim();
        action(async () => {
          if (!validHash(hash)) throw new Error('Enter the full 0x transaction hash from the original wallet action.');
          const context = snapshot(); await checkProvider(context);
          const updated = await api(`/api/intents/${encodeURIComponent(intent.id)}/hash`, { method: 'POST', body: { hash } });
          ensureCurrent(context); upsert(updated); saveAttempt(intent.id, { attempted: true, hash });
          await refresh(context); describeResult(updated);
        });
      });
      details.append(form); item.append(details);
    }
    list.append(item);
  }
}

function render() {
  const ready = isReady(), pending = unresolved(), hasVault = !!state.wallet?.vault?.address;
  const checking = state.connectionBusy || state.refreshing;
  const locked = state.busy || checking || !!state.walletError || !!state.historyError;
  const authenticated = !!(state.session && sameAddress(state.account, state.session.wallet) && state.chainId === CHAIN_ID);
  $('provider-note').textContent = !state.provider
    ? 'Open this local URL in a browser with an EVM wallet extension, such as MetaMask or Phantom. No wallet was detected here.'
    : !state.account ? 'Connect an EVM wallet to begin. The game and your lab session are separate.'
      : state.chainId !== CHAIN_ID ? 'Your wallet is on another network. Switch to Robinhood Chain testnet before verifying.'
        : !state.session ? 'Connected to testnet. Verify ownership with a message signature to unlock your saved lab actions.'
          : 'Address verified for this browser session. Every transaction still requires wallet approval.';
  $('connect-wallet').disabled = state.busy || !state.provider || !!state.account;
  $('switch-network').hidden = !state.account || state.chainId === CHAIN_ID;
  $('switch-network').disabled = state.busy;
  $('verify-wallet').disabled = state.busy || state.connectionBusy || !state.account || state.chainId !== CHAIN_ID || !!state.session || !state.server?.healthy;
  $('refresh-connection').disabled = state.connectionBusy;
  $('refresh-connection').textContent = state.connectionBusy ? 'Checking connection…' : 'Refresh connection';
  $('disconnect-wallet').hidden = !state.account && !state.session;
  $('disconnect-wallet').disabled = state.busy;
  $('wallet-address').textContent = state.account ?? '—';
  $('wallet-balance').textContent = state.wallet ? `${ether(state.wallet.balanceWei)} ETH` : '—';
  $('wallet-badge').textContent = ready ? 'VERIFIED' : state.account ? 'CONNECTED' : 'NOT CONNECTED';
  $('wallet-badge').dataset.ready = String(ready);
  $('vault-badge').textContent = hasVault ? 'CONFIRMED' : pending?.kind === 'deploy' ? 'SAVED / PENDING' : 'NOT DEPLOYED';
  $('vault-badge').dataset.ready = String(hasVault);
  $('vault-address-row').hidden = !hasVault;
  $('vault-address').textContent = state.wallet?.vault?.address ?? '';
  if (hasVault) $('vault-address').href = `${EXPLORER}/address/${state.wallet.vault.address}`;
  else $('vault-address').removeAttribute('href');
  $('deploy-vault').disabled = locked || !ready || hasVault || !!pending;
  const recoverDeployment = pending?.kind === 'deploy' && pending.status === 'prepared';
  $('resume-deployment').hidden = !recoverDeployment;
  $('resume-deployment').disabled = state.busy || checking || !ready;
  $('vault-recovery-note').hidden = !recoverDeployment;
  if (recoverDeployment) {
    const local = getAttempt(pending.id);
    $('resume-deployment').textContent = deploymentRecoveryLabel(pending);
    $('vault-recovery-note').textContent = `${local?.attempted
      ? 'The earlier wallet response was uncertain. This button checks the saved transaction and only reopens your wallet if its original nonce is unused and no vault exists.'
      : 'Your original deployment is saved. Resume it here; this uses the same transaction and does not create another deployment intent.'}${local?.lastError ? ` Last wallet response: ${local.lastError}` : ''}`;
  }
  $('refresh-vault').disabled = state.busy || checking || !authenticated;
  $('fund-vault').disabled = locked || !ready || !hasVault || !!pending;
  $('fund-amount').disabled = state.busy || !!pending;
  $('funding-note').textContent = !state.account ? 'Connect a wallet before funding a test deposit.'
    : state.chainId !== CHAIN_ID ? 'Switch your wallet to Robinhood Chain testnet before funding.'
      : checking ? 'Checking the connection and saved actions. Funding unlocks when your vault is confirmed.'
        : !state.server?.healthy ? 'The testnet connection is unavailable. Use Refresh connection above to retry.'
          : !authenticated ? 'Verify ownership above to restore your vault and enable funding.'
            : pending?.kind === 'deploy' && pending.status === 'prepared'
              ? 'Resume your saved deployment using the recovery button in step 2. Funding unlocks after the vault confirms.'
            : pending?.kind === 'deploy' ? 'Your saved deployment needs confirmation. Use Check vault or Check result in history; do not deploy again.'
              : pending ? 'Finish the saved action in Onchain history before preparing another. Each wallet has one active intent.'
                : state.walletError || state.historyError ? 'Wallet details could not be refreshed. Use Check vault or Refresh connection to retry; saved history remains available.'
                  : !hasVault ? 'Deploy and confirm your test vault before funding a deposit.'
                    : 'Funding and payout each require a separate wallet approval. Network fees are additional.';
  const funds = fundingOptions();
  fundingOptions('refund-funding');
  $('preview-payout').disabled = locked || !ready || !hasVault || !funds.length || !!pending;
  for (const name of NAMES) $(`recipient-${name.toLowerCase()}`).disabled = state.busy || !!pending;
  $('refresh-history').disabled = state.busy || checking || !authenticated;
  $('refund-deposit').disabled = locked || !ready || !hasVault || !funds.length || !!pending;
  const retained = state.wallet?.vault?.retainedWei ?? '0';
  $('retained-balance').textContent = `${ether(retained)} test ETH`;
  $('withdraw-retained').disabled = locked || !ready || !hasVault || BigInt(retained) <= 0n || !!pending;
  $('rpc-indicator').dataset.healthy = String(!!state.server?.healthy);
  $('rpc-status').textContent = state.server?.healthy ? 'Testnet RPC verified · 46630' : 'Testnet RPC unavailable';
  renderReview(); renderHistory();
}

async function reconcileIntent(id) {
  const context = snapshot();
  setStatus('Checking the saved transaction and its onchain events…');
  const local = getAttempt(id);
  let updated;
  if (validHash(local?.hash) && !state.intents.find(intent => intent.id === id)?.hash) {
    updated = await api(`/api/intents/${encodeURIComponent(id)}/hash`, { method: 'POST', body: { hash: local.hash } });
  } else updated = await api(`/api/intents/${encodeURIComponent(id)}/reconcile`, { method: 'POST', body: {} });
  ensureCurrent(context); upsert(updated); await refresh(context); describeResult(updated);
}

function describeResult(intent) {
  if (intent.status === 'confirmed') setStatus(`${intent.kind === 'payout' ? 'Distribution' : intent.kind === 'deploy' ? 'Vault deployment' : 'Transaction'} confirmed on Robinhood Chain testnet with at least two block confirmations.`, '', true);
  else if (intent.status === 'failed') setStatus('The transaction failed onchain. The wallet may have paid a network fee. Inspect the transaction before preparing another action.', 'error', true);
  else if (intent.status === 'submitted') setStatus('Transaction submitted. Use Check result after two block confirmations; this is not yet a confirmed payment.', '', true);
  else setStatus('No confirmed transaction found yet. The saved intent remains reserved. If your wallet already sent it, attach its hash or check again.', '', true);
}

async function sendIntent(original) {
  const context = snapshot();
  ensureCurrent(context);
  if (getAttempt(original.id)?.attempted) throw new Error('This action already opened the wallet and its result is uncertain. Use Check result or attach its original transaction hash.');
  // Reconcile before every manual prompt, including a saved action restored after reload.
  setStatus('Checking the saved action before opening your wallet…');
  const intent = await api(`/api/intents/${encodeURIComponent(original.id)}/reconcile`, { method: 'POST', body: {} });
  ensureCurrent(context); upsert(intent);
  if (intent.status !== 'prepared') { await refresh(context); describeResult(intent); return; }
  await checkProvider(context);
  const tx = intent.transaction;
  if (!sameAddress(tx.from, context.wallet) || Number(BigInt(tx.chainId)) !== CHAIN_ID) throw new Error('The prepared transaction has an unexpected wallet or network.');
  const nonce = await readProvider('eth_getTransactionCount', [context.wallet, 'pending']);
  ensureCurrent(context);
  if (BigInt(nonce) !== BigInt(tx.nonce)) throw new Error('The wallet nonce changed. Check this saved action or attach its hash; do not send it again.');
  await checkProvider(context);
  await promptForIntent(intent, context);
}

function sameDeployment(original, checked) {
  if (original.id !== checked.id || original.kind !== 'deploy' || checked.kind !== 'deploy'
    || !normalizedAddress(original.expectedContractAddress)
    || original.expectedContractAddress !== checked.expectedContractAddress) return false;
  const first = original.transaction, second = checked.transaction;
  if (!first || !second) return false;
  const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])];
  return keys.every(key => first[key] === second[key]);
}

async function resumeDeployment(original) {
  const context = snapshot();
  if (original.kind !== 'deploy' || original.status !== 'prepared') throw new Error('Only a prepared deployment can use this recovery action.');
  const local = getAttempt(original.id);
  if (original.hash || local?.hash) { await reconcileIntent(original.id); return; }
  setStatus('Checking whether the original saved deployment can be resumed. No wallet transaction has been requested.');
  const reconciled = await api(`/api/intents/${encodeURIComponent(original.id)}/reconcile`, { method: 'POST', body: {} });
  ensureCurrent(context);
  if (!sameDeployment(original, reconciled)) throw new Error('The saved deployment changed. Recovery stopped without opening the wallet.');
  upsert(reconciled);
  if (reconciled.hash || reconciled.status !== 'prepared') { await refresh(context); describeResult(reconciled); return; }
  const checked = await api(`/api/intents/${encodeURIComponent(original.id)}/retry-check`, { method: 'POST', body: {} });
  ensureCurrent(context);
  if (!sameDeployment(original, checked) || checked.retryAllowed !== true || checked.status !== 'prepared' || checked.hash) {
    throw new Error('The server did not approve retrying this exact saved deployment. Check its result in history.');
  }
  await checkProvider(context);
  const tx = checked.transaction;
  if (!sameAddress(tx.from, context.wallet) || Number(BigInt(tx.chainId)) !== CHAIN_ID || tx.to != null) throw new Error('The deployment wallet, chain, or transaction type changed.');
  const [latest, pending, code] = await Promise.all([
    readProvider('eth_getTransactionCount', [context.wallet, 'latest']),
    readProvider('eth_getTransactionCount', [context.wallet, 'pending']),
    readProvider('eth_getCode', [checked.expectedContractAddress, 'latest']),
  ]);
  ensureCurrent(context);
  if (BigInt(latest) !== BigInt(tx.nonce) || BigInt(pending) !== BigInt(tx.nonce)) throw new Error('The saved deployment nonce is already used or pending. Check its result; no retry was sent.');
  if (code !== '0x') throw new Error('A contract already exists at the saved deployment address. Check its result; no retry was sent.');
  await checkProvider(context);
  if (getAttempt(original.id)?.hash) { await reconcileIntent(original.id); return; }
  // This is one explicit retry of the identical transaction; the uncertainty marker stays set.
  await promptForIntent(checked, context);
}

async function promptForIntent(intent, context) {
  ensureCurrent(context);
  const tx = intent.transaction;
  saveAttempt(intent.id, { attempted: true }); render();
  const approvalNames = { deploy: 'the test vault deployment', payout: 'the reviewed test distribution', fund: 'the test deposit', refund: 'the deposit refund to your wallet', withdraw: 'the retained test ETH withdrawal to your wallet' };
  setStatus(`Open your wallet to approve ${approvalNames[intent.kind] ?? 'the saved test action'}. Verify Robinhood Chain testnet and the network fee.`, 'approval', true);
  let hash;
  try { hash = await state.provider.request({ method: 'eth_sendTransaction', params: [{ ...tx }] }); }
  catch (error) {
    const rejected = Number(error?.code) === 4001 || Number(error?.info?.error?.code) === 4001;
    saveAttempt(intent.id, { attempted: !rejected, lastError: errorMessage(error) });
    if (context.generation !== state.generation) throw new Error('Wallet context changed while approval was open. Reconnect the original wallet and check its saved action.');
    if (rejected) throw new Error('Wallet approval declined. The same intent is saved in history; you can approve it when ready.');
    throw new Error(`Wallet response uncertain: ${errorMessage(error)} Check the saved action or recover its hash before doing anything else.`);
  }
  if (!validHash(hash)) throw new Error('The wallet returned no recognizable transaction hash. The saved action remains reserved; check its result in history.');
  saveAttempt(intent.id, { attempted: true, hash });
  ensureCurrent(context);
  setStatus('Wallet returned a transaction hash. Recording it and checking the testnet confirmations…');
  let updated;
  try { updated = await api(`/api/intents/${encodeURIComponent(intent.id)}/hash`, { method: 'POST', body: { hash } }); }
  catch (error) { throw new Error(`The wallet returned ${hash}, but its confirmation could not be recorded yet. Use Check result in history. ${errorMessage(error)}`); }
  ensureCurrent(context); upsert(updated); await refresh(context); describeResult(updated);
}

async function createAndSend(input) {
  const context = snapshot(); await checkProvider(context);
  setStatus('Saving the test action before requesting wallet approval…');
  const intent = await api('/api/intents', { method: 'POST', body: input });
  ensureCurrent(context); upsert(intent); render();
  await sendIntent(intent);
}

$('connect-wallet').addEventListener('click', () => action(async () => {
  setStatus('Open your wallet to choose the account to connect.', 'approval');
  const accounts = await state.provider.request({ method: 'eth_requestAccounts' });
  const account = normalizedAddress(accounts?.[0]);
  if (!account) throw new Error('The wallet did not provide an EVM account.');
  invalidate(); state.accountsRevision += 1; state.account = account;
  state.chainRevision += 1; state.chainId = Number(BigInt(await readProvider('eth_chainId')));
  setStatus(state.chainId === CHAIN_ID ? 'Wallet connected. Verify ownership with the separate message-signing button.' : 'Wallet connected. Switch to Robinhood Chain testnet using the button below.');
}));

$('switch-network').addEventListener('click', () => action(async () => {
  setStatus('Open your wallet to switch to Robinhood Chain testnet.', 'approval');
  try { await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }); }
  catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await state.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN_HEX, chainName: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER] }] });
  }
  state.chainRevision += 1; state.chainId = Number(BigInt(await readProvider('eth_chainId')));
  setStatus(state.chainId === CHAIN_ID ? 'Testnet selected. Verify ownership to continue.' : 'The wallet is still on another network. Switch to testnet before continuing.');
}));

$('verify-wallet').addEventListener('click', () => action(async () => {
  const generation = state.generation, wallet = state.account;
  if (!wallet || state.chainId !== CHAIN_ID) throw new Error('Connect on Robinhood Chain testnet first.');
  await state.logoutPromise;
  if (generation !== state.generation || !sameAddress(wallet, state.account)) throw new Error('Wallet changed before verification. Try again with the current account.');
  const challenge = await api('/api/auth/challenge', { method: 'POST', body: { wallet }, csrf: null });
  if (generation !== state.generation || !sameAddress(wallet, state.account)) throw new Error('Wallet changed before verification. Try again with the current account.');
  setStatus('Open your wallet to sign the ownership message. This does not send a transaction or spend test ETH.', 'approval');
  const signature = await state.provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(challenge.message)), wallet] });
  if (generation !== state.generation || !sameAddress(wallet, state.account) || state.chainId !== CHAIN_ID) throw new Error('Wallet or network changed during verification. Start verification again.');
  const session = await api('/api/auth/verify', { method: 'POST', body: { id: challenge.id, signature }, csrf: null });
  if (generation !== state.generation || !sameAddress(wallet, state.account)) throw new Error('Wallet changed while the server verified the signature. Start verification again.');
  if (!sameAddress(wallet, session.wallet)) throw new Error('The verified wallet did not match the connected address.');
  state.session = session; await refresh(snapshot(), { reconcile: true });
  showRefreshMessage('Wallet ownership verified. Deploy your test vault or continue a saved action in history.');
}));

$('disconnect-wallet').addEventListener('click', () => action(async () => {
  const old = state.session;
  state.generation += 1; state.session = null; state.account = null; state.wallet = null; state.intents = []; state.review = null;
  for (const name of NAMES) $(`recipient-${name.toLowerCase()}`).value = '';
  if (old) await api('/api/logout', { method: 'POST', body: {}, csrf: old.csrfToken });
  setStatus('Lab session disconnected. Your wallet extension manages its own site permissions.');
}));

$('deploy-vault').addEventListener('click', () => action(() => createAndSend({ kind: 'deploy' })));
$('resume-deployment').addEventListener('click', () => action(async () => {
  const intent = unresolved();
  if (!intent || intent.kind !== 'deploy') throw new Error('No saved deployment needs recovery.');
  await resumeDeployment(intent);
}));
for (const id of ['refresh-vault', 'refresh-history']) $(id).addEventListener('click', () => action(async () => {
  if (!state.server?.healthy) await refreshConnection();
  else {
    await refresh(snapshot(), { reconcile: true });
    showRefreshMessage(unresolved() ? 'The saved action remains pending. Check its result in history; no wallet transaction was sent.' : 'Wallet and onchain history refreshed. Confirmed actions are ready for the next step.');
  }
}));
$('refresh-connection').addEventListener('click', () => refreshConnection());

$('fund-form').addEventListener('submit', event => {
  event.preventDefault(); const amountEth = $('fund-amount').value.trim();
  action(async () => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amountEth)) throw new Error('Enter a decimal ETH amount with at most 18 decimal places.');
    const value = parseEther(amountEth);
    if (value <= 0n || value > parseEther('0.05')) throw new Error('Test deposits must be greater than zero and at most 0.05 ETH.');
    await createAndSend({ kind: 'fund', amountEth });
  });
});

$('preview-form').addEventListener('submit', event => {
  event.preventDefault();
  const fundingId = $('funding-select').value;
  const raw = NAMES.map(name => $(`recipient-${name.toLowerCase()}`).value.trim());
  action(async () => {
    const context = snapshot();
    const recipients = raw.map((value, i) => {
      const address = normalizedAddress(value);
      if (!address) throw new Error(`Enter a valid EVM recipient address for ${NAMES[i]}.`);
      return address;
    });
    if (new Set(recipients.map(value => value.toLowerCase())).size !== 3) throw new Error('Alice, Bob, and Cara must use three different recipient addresses.');
    if (recipients.some(address => address === ZERO_ADDRESS || sameAddress(address, context.wallet) || sameAddress(address, state.wallet?.vault?.address))) throw new Error('Recipients must differ from your wallet, your vault, and the zero address.');
    if (!fundingId) throw new Error('Choose a confirmed test deposit first.');
    await checkProvider(context); setStatus('Saving a fixed recipient plan and calculating its exact testnet distribution…');
    const intent = await api('/api/intents', { method: 'POST', body: { kind: 'payout', fundingId, recipients } });
    ensureCurrent(context); upsert(intent); state.review = intent; renderReview();
    setStatus('Preview saved. Check the exact recipients and amounts below before approving in your wallet.', '', true);
    $('payout-review').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});
$('approve-payout').addEventListener('click', () => action(async () => {
  if (!state.review) throw new Error('Choose and review a saved distribution first.');
  await sendIntent(state.review);
}));
$('refund-deposit').addEventListener('click', () => action(async () => {
  const fundingId = $('refund-funding').value;
  if (!fundingId) throw new Error('Choose an unspent confirmed deposit to refund.');
  await createAndSend({ kind: 'refund', fundingId });
}));
$('withdraw-retained').addEventListener('click', () => action(async () => {
  const context = snapshot();
  const amountEth = ether(state.wallet?.vault?.retainedWei ?? '0');
  if (parseEther(amountEth) <= 0n) throw new Error('There is no retained test ETH available to withdraw.');
  await createAndSend({ kind: 'withdraw', to: context.wallet, amountEth });
}));

if (state.provider?.on) {
  state.provider.on('accountsChanged', accounts => {
    state.accountsRevision += 1;
    const next = normalizedAddress(accounts?.[0]);
    if (sameAddress(next, state.account)) return;
    invalidate('Wallet account changed. The previous actions remain saved for their original wallet.');
    state.account = next; render();
  });
  state.provider.on('chainChanged', chain => {
    state.chainRevision += 1;
    let next = null; try { next = Number(BigInt(chain)); } catch { /* Unknown network locks transactions. */ }
    if (next === state.chainId) return;
    invalidate('Wallet network changed. Verify ownership again on Robinhood Chain testnet to continue.');
    state.chainId = next; render();
  });
  state.provider.on('disconnect', () => {
    state.accountsRevision += 1; state.chainRevision += 1;
    invalidate('Wallet disconnected. Saved actions are retained by the lab.'); state.account = null; state.chainId = null; render();
  });
}

async function refreshConnection() {
  if (state.connectionBusy) return;
  state.connectionBusy = true; render();
  setStatus('Checking the testnet connection and restoring saved wallet actions…');
  try {
    const accountsRevision = state.accountsRevision, chainRevision = state.chainRevision;
    const healthTask = (async () => {
      try {
        const server = await api('/api/status');
        if (server.chainId !== CHAIN_ID) throw new Error('The server is not configured for Robinhood Chain testnet.');
        state.server = server; render();
      } catch (error) { state.server = { healthy: false }; render(); throw error; }
    })();
    const identityTask = (async () => {
      const [session, accounts, chain] = await Promise.allSettled([
        api('/api/session'),
        state.provider ? readProvider('eth_accounts') : Promise.resolve([]),
        state.provider ? readProvider('eth_chainId') : Promise.resolve(null),
      ]);
      const nextAccount = accounts.status === 'fulfilled' && accountsRevision === state.accountsRevision
        ? normalizedAddress(accounts.value?.[0]) : state.account;
      let nextChain = state.chainId;
      if (chain.status === 'fulfilled' && chainRevision === state.chainRevision) {
        try { nextChain = chain.value == null ? null : Number(BigInt(chain.value)); } catch { nextChain = null; }
      }
      if (state.session && (!sameAddress(nextAccount, state.session.wallet) || nextChain !== CHAIN_ID)) invalidate();
      state.account = nextAccount; state.chainId = nextChain;
      if (session.status === 'fulfilled' && sameAddress(session.value.wallet, state.account) && state.chainId === CHAIN_ID) state.session = session.value;
      render();
      const problem = [accounts, chain].find(result => result.status === 'rejected');
      if (problem) throw problem.reason;
      if (session.status === 'rejected' && session.reason.status !== 401) throw session.reason;
    })();
    const results = await Promise.allSettled([healthTask, identityTask]);
    const problem = results.find(result => result.status === 'rejected');
    if (isReady()) await refresh(snapshot(), { reconcile: true });
    if (problem) setStatus(errorMessage(problem.reason), 'error');
    else if (!state.server?.healthy) setStatus('The testnet RPC is unavailable. Use Refresh connection to retry; your wallet can stay connected.', 'error');
    else if (!state.provider) setStatus('Testnet lab is ready. Open this URL in a browser with an EVM wallet extension to connect.');
    else if (isReady()) showRefreshMessage(unresolved() ? 'Session restored. Your saved action is still pending; check its result in history.' : 'Verified session restored. Your confirmed vault and saved actions are ready.');
    else if (state.account) setStatus('Wallet connected. Verify ownership to restore your saved vault and actions.');
    else setStatus('Robinhood Chain testnet verified. Connect your EVM wallet to begin.');
  } catch (error) { setStatus(errorMessage(error), 'error'); }
  finally { state.connectionBusy = false; render(); }
}

async function boot() { await refreshConnection(); }

void boot();
