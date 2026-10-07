// Pairing helpers for a phone (no typed codes): QR link, automatic Tailscale pairing, "Ask the laptop".

export function pairCodeFromHash(hash = '') {
  const m = /^#pair=(\d{6})$/.exec(hash);
  return m ? m[1] : null;
}

export function deviceName(ua = '') {
  const samsung = /;\s*(SM-[A-Z0-9]+)/.exec(ua);
  if (samsung) return `Samsung ${samsung[1]}`;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Browser';
}

const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// A phone on the laptop owner's own Tailscale account: get a token without asking. null if not.
export async function tryAutoPair() {
  try {
    const res = await postJson('/api/pair/auto');
    return res.ok ? (await res.json()).token : null;
  } catch {
    return null;
  }
}

// "Ask the laptop": resolves to a token once the laptop allows, or throws with the reason.
export async function askLaptop(name, { onWaiting = () => {}, signal } = {}) {
  const res = await postJson('/api/pair/request', { name });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not reach the laptop.');
  onWaiting();
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled.');
    await new Promise((r) => setTimeout(r, 2000));
    const state = await (await fetch(`/api/pair/request/${body.id}?secret=${body.secret}`)).json();
    if (state.status === 'allowed') return state.token;
    if (state.status === 'denied') throw new Error('The laptop said no.');
    if (state.status === 'expired') throw new Error('Nobody answered on the laptop. Try again.');
  }
}
