import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createNovi } from './app.js';
import { loadOrCreateCert, lanAddresses } from './certs.js';
import { tailscaleCert } from './tailscale.js';
import { startKeepAwake } from './laptop/keepAwake.js';
import { checkClaude } from './claude/check.js';
import { startWakeWordService } from './voice/wakeword/service.js';
import { createLocalSpeaker } from './voice/localSpeaker.js';
import { createEdgeTts, DEFAULT_VOICES } from './voice/edgeTts.js';
import { createLogBuffer } from './logBuffer.js';

const logBuffer = createLogBuffer();
logBuffer.capture(console);
let version = 'dev';
try { version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { /* not a git checkout */ }
const system = { version, supervised: process.env.NOVI_SUPERVISED === '1', restarts: Number(process.env.NOVI_RESTARTS || 0) };

const config = loadConfig();
if (!config.providers.length) console.warn('⚠  No AI provider keys found. Add GROQ_API_KEYS / GEMINI_API_KEYS to .env');

const lanUrls = lanAddresses().map((ip) => `https://${ip}:${config.port}`);
// Tailscale name + real certificate when available: the phone can reach Novi from anywhere.
const certDir = path.join(config.dataDir, 'certs');
const ts = await tailscaleCert({ dir: certDir });
if (ts) lanUrls.unshift(`https://${ts.name}:${config.port}`);
// Laptop speakers: natural Edge voices, falling back to the built-in Windows voice.
const edgeVoices = { en: process.env.NOVI_TTS_VOICE_EN || DEFAULT_VOICES.en, hi: process.env.NOVI_TTS_VOICE_HI || DEFAULT_VOICES.hi, mr: process.env.NOVI_TTS_VOICE_MR || DEFAULT_VOICES.mr };
const localSpeaker = createLocalSpeaker({ synth: createEdgeTts({ voices: edgeVoices }) });
localSpeaker?.(''); // warm up the Windows voice now so the first reply isn't 2.5 s late
const novi = createNovi(config, { lanUrls, localSpeaker, logBuffer, system, tsName: ts?.name || null });
await novi.plugins.loadDirectory(path.resolve('plugins'));
await novi.plugins.startServices();
// Self-signed for localhost / LAN IPs; the real Tailscale certificate when the phone asks for the ts.net name (SNI).
let tsContext = ts && tls.createSecureContext({ key: ts.key, cert: ts.cert });
const server = https.createServer({
  ...loadOrCreateCert(certDir),
  SNICallback: (servername, cb) => cb(null, ts && servername === ts.name ? tsContext : undefined),
}, novi.app);
// Tailscale certificates last 90 days; `tailscale cert` renews only when needed.
if (ts) setInterval(async () => {
  const fresh = await tailscaleCert({ dir: certDir });
  if (fresh) tsContext = tls.createSecureContext({ key: fresh.key, cert: fresh.cert });
}, 7 * 24 * 3600_000).unref();

// Another Novi already owns the port (e.g. the autostarted one): exit cleanly (code 0) so the
// supervisor stops instead of restarting into the same error forever.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Novi is already running on port ${config.port} (https://localhost:${config.port}). This copy will close.`);
  process.exit(0);
});
novi.attachWebSocket(server); // after the handler above: the WebSocket server re-emits listen errors
server.listen(config.port, '0.0.0.0', () => {
  console.log(`\nNovi is running`);
  console.log(`  Laptop: https://localhost:${config.port}`);
  for (const url of lanUrls) console.log(`  Phone:  ${url}${ts && url.includes(ts.name) ? '  (from anywhere, via Tailscale)' : ''}`);
  console.log(`  Coding agent: ${config.coder === 'claude' ? 'Claude Code (uses your Claude plan)' : 'Novi Coder (free Groq/Gemini)'}`);
  console.log(`  Providers: ${config.providers.map((p) => `${p.name} (${p.keys.length} key${p.keys.length === 1 ? '' : 's'})`).join(', ') || 'none'}`);
  console.log(`  Plugins: ${novi.plugins.plugins.map((p) => p.id).join(', ')}`);
  console.log(`  Pairing code: ${novi.pairing.currentCode().code} (also shown in the app)`);
  // Always-on "Hey Novi" on the laptop microphone (works with the browser closed).
  startWakeWordService({ novi })
    .then((service) => { wake = service; console.log(''); })
    .catch((err) => console.warn(`⚠  Wake word unavailable: ${err.message}\n`));
});
let wake = null;
// Always reachable from the phone: Windows won't idle-sleep while Novi runs.
const keepAwake = process.platform === 'win32' ? startKeepAwake() : null;

if (config.coder === 'claude') checkClaude(config.claudeCommand).then((warning) => warning && console.warn(`⚠  ${warning}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  wake?.stop();
  keepAwake?.stop();
  await novi.tasks.shutdown();
  await novi.plugins.stopServices();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
