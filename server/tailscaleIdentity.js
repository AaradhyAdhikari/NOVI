import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findTailscale } from './tailscale.js';

// "Who is this?" for a request that came in over Tailscale. Tailscale knows which device and
// which account sent it (every device has its own key), so a phone signed in to the laptop
// owner's Tailscale account can be let in without pairing. Anything else → null.

const defaultRun = promisify(execFile);
const strip = (ip) => String(ip || '').replace(/^::ffff:/, '');

export function isTailscaleAddress(ip) {
  const a = strip(ip);
  if (/^fd7a:115c:a1e0:/i.test(a)) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(a);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127); // 100.64.0.0/10
}

export function createTailscaleIdentity({ run = (file, args) => defaultRun(file, args, { windowsHide: true, timeout: 10_000 }), exe = findTailscale() } = {}) {
  let owner = null;
  const json = async (args) => JSON.parse((await run(exe, args)).stdout);
  async function ownerLogin() {
    if (!owner) {
      const status = await json(['status', '--json']);
      owner = status?.User?.[status?.Self?.UserID]?.LoginName || null;
    }
    return owner;
  }
  return {
    // { name } when the device at `ip` belongs to the same Tailscale account as this laptop.
    async ownerDevice(ip) {
      if (!exe || !isTailscaleAddress(ip)) return null;
      try {
        const [me, who] = await Promise.all([ownerLogin(), json(['whois', '--json', strip(ip)])]);
        const login = who?.UserProfile?.LoginName;
        if (!me || !login || login !== me) return null;
        return { name: String(who.Node?.Hostinfo?.Hostname || who.Node?.ComputedName || 'Phone').slice(0, 60) };
      } catch {
        return null;
      }
    },
  };
}
