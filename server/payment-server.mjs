import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WalletAuth, AuthError } from './wallet-auth.mjs';
import { PaymentLab } from './payment-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cookieName = 'holder_payment_session';
const staticFiles = new Map([
  ['/', ['payment-lab/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['payment-lab/app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['payment-lab/style.css', 'text/css; charset=utf-8']],
  ['/contract.json', ['payment-lab/contract.json', 'application/json']],
  ['/vendor/ethers.js', ['node_modules/ethers/dist/ethers.min.js', 'text/javascript; charset=utf-8']],
]);
const cookie = request => request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://rpc.testnet.chain.robinhood.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function json(response, status, value, extra = {}) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new AuthError('Use JSON for API requests.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 16384) throw new AuthError('Request too large.', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError('Invalid JSON.', 400); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new AuthError('A JSON object is required.', 400);
  return value;
}

export function createPaymentServer({ lab, origin = 'http://127.0.0.1:4175', auth = new WalletAuth() }) {
  const requests = new Map();
  return http.createServer({ requestTimeout: 15000, headersTimeout: 15000 }, async (request, response) => {
    try {
      const currentOrigin = typeof origin === 'function' ? origin() : origin;
      const expected = new URL(currentOrigin);
      if (request.headers.host !== expected.host) throw new AuthError('Open the payment lab using its configured local URL.', 403);
      const url = new URL(request.url, currentOrigin);
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [path, type] = staticFiles.get(url.pathname);
        const content = await readFile(resolve(root, path));
        response.writeHead(200, { ...headers, 'Content-Type': type }); response.end(content); return;
      }
      if (!url.pathname.startsWith('/api/')) { json(response, 404, { error: 'Not found.' }); return; }
      const now = Date.now(), ip = request.socket.remoteAddress;
      if (requests.size > 100) requests.clear();
      const window = requests.get(ip);
      if (!window || now - window.start >= 60000) requests.set(ip, { start: now, count: 1 });
      else if (++window.count > 160) throw new AuthError('Too many requests. Wait a minute and retry.', 429);
      const method = request.method, path = url.pathname;
      if (!['GET', 'POST'].includes(method)) throw new AuthError('Method not supported.', 405);
      if (method === 'POST' && request.headers.origin !== currentOrigin) throw new AuthError('Cross-origin payment requests are rejected.', 403);
      const input = method === 'POST' ? await body(request) : null;
      if (method === 'GET' && path === '/api/status') {
        let session = null; try { session = auth.session(cookie(request), currentOrigin); } catch { /* No wallet is signed in yet. */ }
        json(response, 200, { ...await lab.status(), session: session && { wallet: session.wallet } }); return;
      }
      if (method === 'POST' && path === '/api/auth/challenge') { json(response, 200, auth.challenge(input.wallet, currentOrigin)); return; }
      if (method === 'POST' && path === '/api/auth/verify') {
        const result = auth.verify(input.id, input.signature, currentOrigin);
        json(response, 200, { wallet: result.wallet, csrfToken: result.csrfToken }, { 'Set-Cookie': `${cookieName}=${result.token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=1800` }); return;
      }
      const session = auth.session(cookie(request), currentOrigin, method === 'POST' ? request.headers['x-csrf-token'] || '' : undefined);
      if (method === 'GET' && path === '/api/session') { json(response, 200, session); return; }
      if (method === 'POST' && path === '/api/logout') {
        auth.logout(cookie(request)); json(response, 200, { loggedOut: true }, { 'Set-Cookie': `${cookieName}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0` }); return;
      }
      if (method === 'GET' && path === '/api/wallet') { json(response, 200, await lab.walletStatus(session.wallet)); return; }
      if (method === 'GET' && path === '/api/intents') { json(response, 200, { intents: lab.listIntents(session.wallet) }); return; }
      if (method === 'POST' && path === '/api/intents') { json(response, 200, await lab.createIntent(session.wallet, input)); return; }
      const action = /^\/api\/intents\/([\w-]{1,100})\/(hash|reconcile|retry-check)$/.exec(path);
      if (method === 'POST' && action) {
        const result = action[2] === 'hash' ? await lab.attachHash(session.wallet, action[1], input.hash)
          : action[2] === 'retry-check' ? await lab.checkDeploymentRetry(session.wallet, action[1])
            : await lab.reconcile(session.wallet, action[1]);
        json(response, 200, result); return;
      }
      json(response, 404, { error: 'API route not found.' });
    } catch (error) {
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
      json(response, status, { error: status === 502 ? 'The testnet request could not complete. Check its status before retrying a payment.' : String(error.message).slice(0, 240), code: error.code || 'REQUEST_FAILED' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PAYMENT_LAB_PORT || 4175);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PAYMENT_LAB_PORT must be between 1024 and 65535.');
  const dbPath = resolve(root, '.payment-lab/ledger.sqlite'); await mkdir(dirname(dbPath), { recursive: true });
  const lab = new PaymentLab({ dbPath });
  const server = createPaymentServer({ lab, origin: `http://127.0.0.1:${port}` });
  server.listen(port, '127.0.0.1', () => console.log(`HOLDER payment test: http://127.0.0.1:${port}/ (Robinhood Chain Testnet only; no private keys)`));
  const stop = () => server.close(() => { lab.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
