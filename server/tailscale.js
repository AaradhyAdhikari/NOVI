import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Real HTTPS certificate for the laptop's Tailscale name (<machine>.<tailnet>.ts.net), so the phone
// trusts Novi from anywhere (needed for push notifications and passkeys). Needs MagicDNS + HTTPS
// certificates turned on in the Tailscale admin console. Any problem → null, and Novi keeps its
// self-signed certificate. Never `tailscale serve`: proxied requests would look like localhost.

const PROGRAM_FILES_EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
const defaultRun = promisify(execFile);

export function findTailscale({ exists = fs.existsSync, onPath = true } = {}) {
  if (exists(PROGRAM_FILES_EXE)) return PROGRAM_FILES_EXE;
  return onPath ? 'tailscale' : null;
}

export async function tailscaleCert({ run = (file, args) => defaultRun(file, args, { windowsHide: true, timeout: 60_000 }), exe = findTailscale(), dir } = {}) {
  if (!exe) return null;
  try {
    const status = JSON.parse((await run(exe, ['status', '--json'])).stdout);
    const name = String(status?.Self?.DNSName || '').replace(/\.$/, '');
    if (status?.BackendState !== 'Running' || !name) return null;
    fs.mkdirSync(dir, { recursive: true });
    const certFile = path.join(dir, 'ts.crt');
    const keyFile = path.join(dir, 'ts.key');
    await run(exe, ['cert', '--cert-file', certFile, '--key-file', keyFile, name]);
    return { name, cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[tailscale] no certificate (${String(err.message).split('\n')[0]}); using the self-signed one`);
    return null;
  }
}
