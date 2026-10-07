import crypto from 'node:crypto';

// "Ask the laptop": a phone asks to connect, the laptop shows Allow / Deny, and the phone picks
// up its token once (with the secret only it holds). Requests last 2 minutes; one per address,
// at most 3 waiting, so nobody can flood the laptop.
export class PairRequests {
  constructor({ issue, now = () => Date.now(), ttlMs = 2 * 60_000, max = 3 }) {
    this.issue = issue;
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
    this.items = new Map();
  }

  _sweep() {
    for (const [id, r] of this.items) if (this.now() > r.expires) this.items.delete(id);
  }

  create({ name, ip }) {
    this._sweep();
    const waiting = [...this.items.values()].filter((r) => r.status === 'pending');
    if (waiting.some((r) => r.ip === ip)) throw new Error('This device already asked. Check the laptop.');
    if (waiting.length >= this.max) throw new Error('Too many devices are asking right now. Try again in a couple of minutes.');
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(24).toString('hex');
    const clean = String(name || 'Phone').replace(/[<>]/g, '').trim().slice(0, 40) || 'Phone';
    this.items.set(id, { id, secret, name: clean, ip, status: 'pending', expires: this.now() + this.ttlMs, createdAt: this.now() });
    return { id, secret };
  }

  pending() {
    this._sweep();
    return [...this.items.values()].filter((r) => r.status === 'pending').map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  decide(id, allow) {
    this._sweep();
    const r = this.items.get(id);
    if (!r || r.status !== 'pending') return false;
    if (allow) {
      r.result = this.issue(r.name);
      r.status = 'allowed';
    } else {
      r.status = 'denied';
    }
    return true;
  }

  // The phone polls this. The token is handed over once.
  check(id, secret) {
    this._sweep();
    const r = this.items.get(id);
    if (!r || typeof secret !== 'string' || secret.length !== r.secret.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(r.secret))) return { status: 'expired' };
    if (r.status === 'allowed') {
      this.items.delete(id);
      return { status: 'allowed', ...r.result };
    }
    return { status: r.status };
  }
}
