import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';

const digest = value => createHash('sha256').update(value).digest('hex');
export class AuthError extends Error {
  constructor(message, statusCode = 401) { super(message); this.statusCode = statusCode; }
}

/** Short-lived, origin/chain-bound wallet proof. No private keys or transaction authority. */
export class WalletAuth {
  constructor({ now = Date.now } = {}) { this.now = now; this.challenges = new Map(); this.sessions = new Map(); }

  prune() {
    const now = this.now();
    for (const [id, item] of this.challenges) if (item.expires <= now) this.challenges.delete(id);
    for (const [id, item] of this.sessions) if (item.expires <= now) this.sessions.delete(id);
  }

  challenge(wallet, origin) {
    this.prune();
    if (this.challenges.size >= 200) throw new AuthError('Too many pending sign-in requests. Try again shortly.', 429);
    let address; try { address = getAddress(wallet); } catch { throw new AuthError('Enter a valid Ethereum wallet address.', 400); }
    const id = randomBytes(24).toString('hex'), nonce = randomBytes(16).toString('hex');
    const now = this.now(), expires = now + 5 * 60000;
    const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to the HOLDER payment test lab. This does not authorize a transfer.\n\nURI: ${origin}\nVersion: 1\nChain ID: 46630\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
    this.challenges.set(id, { wallet: address, message, origin, expires });
    return { id, message };
  }

  verify(id, signature, origin) {
    const challenge = this.challenges.get(id);
    this.challenges.delete(id);
    if (!challenge || challenge.expires <= this.now() || challenge.origin !== origin) throw new AuthError('Sign-in request expired or already used. Request a new signature.');
    let recovered;
    try { recovered = getAddress(verifyMessage(challenge.message, signature)); } catch { throw new AuthError('Wallet signature could not be verified.'); }
    if (recovered !== challenge.wallet) throw new AuthError('The signature came from a different wallet.');
    this.prune();
    if (this.sessions.size >= 200) throw new AuthError('Too many active sessions. Try again shortly.', 429);
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
    const session = { wallet: recovered, csrfToken, origin, expires: this.now() + 30 * 60000 };
    this.sessions.set(digest(token), session);
    return { token, wallet: recovered, csrfToken };
  }

  session(token, origin, csrfToken) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new AuthError('Connect and verify your wallet first.');
    const session = this.sessions.get(digest(token));
    if (!session || session.expires <= this.now() || session.origin !== origin) throw new AuthError('Your sign-in expired. Verify your wallet again.');
    if (csrfToken !== undefined) {
      if (typeof csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(csrfToken) || !timingSafeEqual(Buffer.from(csrfToken), Buffer.from(session.csrfToken))) throw new AuthError('Request token did not match this session.', 403);
    }
    return { wallet: session.wallet, csrfToken: session.csrfToken };
  }

  logout(token) { if (typeof token === 'string') this.sessions.delete(digest(token)); }
}
