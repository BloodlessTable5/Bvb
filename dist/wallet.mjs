// Address selection for local cosmetic profiles. Authentication and payouts
// require a server-verified sign-in; a connected address alone is neither.
const addressOf = key => {
  const value = typeof key === 'string' ? key : key?.toBase58?.() ?? key?.toString?.();
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
};

export class PhantomIdentity {
  constructor({ getProvider = () => typeof window === 'undefined' ? null : window.phantom?.solana, onChange = () => {} } = {}) {
    this.getProvider = getProvider;this.onChange = onChange;this.generation = 0;this.listeners = [];
    this.state = { status: 'disconnected', address: null, message: 'Guest profile · saved on this browser' };
  }
  emit(status, address, message) {
    this.state = { status, address, message };this.onChange({ ...this.state });return this.state;
  }
  unlisten() {
    for (const [provider, event, listener] of this.listeners) provider.removeListener?.(event, listener);
    this.listeners = [];
  }
  listen(provider) {
    const changed = key => {
      this.generation++;
      const address = addressOf(key);
      if (!address) { this.unlisten();this.provider = null;this.emit('disconnected', null, 'Guest profile · saved on this browser'); }
      else this.emit('connected', address, 'Address connected · progress saved on this browser');
    };
    const disconnected = () => changed(null);
    for (const [event, listener] of [['accountChanged', changed], ['disconnect', disconnected]]) {
      provider.on?.(event, listener);this.listeners.push([provider, event, listener]);
    }
  }
  async connect() {
    if (this.state.status === 'connecting') return this.state;
    if (this.state.address) return this.state;
    const generation = ++this.generation, provider = this.getProvider();
    if (!provider?.isPhantom || typeof provider.connect !== 'function') {
      return this.emit('unavailable', null, 'Open this site in a browser with Phantom installed, or keep playing as a guest.');
    }
    this.emit('connecting', null, 'Approve the address connection in Phantom.');
    try {
      const result = await provider.connect();
      if (generation !== this.generation) return this.state;
      const address = addressOf(result?.publicKey ?? provider.publicKey);
      if (!address) throw new Error('No valid Solana address was returned.');
      this.unlisten();this.provider = provider;this.listen(provider);
      return this.emit('connected', address, 'Address connected · progress saved on this browser');
    } catch (error) {
      if (generation !== this.generation) return this.state;
      return this.emit('error', null, error?.code === 4001 ? 'Connection cancelled. Your guest progress is still here.' : 'Phantom could not connect. Your guest profile is still available.');
    }
  }
  async disconnect() {
    this.generation++;const provider = this.provider;this.unlisten();this.provider = null;
    this.emit('disconnected', null, 'Guest profile · saved on this browser');
    try { await provider?.disconnect?.(); } catch { /* The local profile is already disconnected. */ }
    return this.state;
  }
}
