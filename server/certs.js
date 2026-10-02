import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// Self-signed HTTPS cert so phone browsers allow the microphone on the LAN.
// Regenerated when the laptop's LAN IPs change.
export function loadOrCreateCert(dir) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const ipsFile = path.join(dir, 'ips.json');
  const ips = lanAddresses();
  try {
    const known = JSON.parse(fs.readFileSync(ipsFile, 'utf8'));
    if (ips.every((ip) => known.includes(ip))) return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch { /* generate below */ }
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Novi (local)' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(ipsFile, JSON.stringify(ips));
  return { key: pems.private, cert: pems.cert };
}
