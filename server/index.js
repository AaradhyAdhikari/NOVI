import https from 'node:https';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createNovi } from './app.js';
import { loadOrCreateCert, lanAddresses } from './certs.js';
import { checkClaude } from './claude/check.js';
import { startWakeWordService } from './voice/wakeword/service.js';
import { createLocalSpeaker } from './voice/localSpeaker.js';

const config = loadConfig();
if (!config.providers.length) console.warn('⚠  No AI provider keys found. Add GROQ_API_KEYS / GEMINI_API_KEYS to .env');

const lanUrls = lanAddresses().map((ip) => `https://${ip}:${config.port}`);
const novi = createNovi(config, { lanUrls, localSpeaker: createLocalSpeaker() });
await novi.plugins.loadDirectory(path.resolve('plugins'));
await novi.plugins.startServices();
const server = https.createServer(loadOrCreateCert(path.join(config.dataDir, 'certs')), novi.app);
novi.attachWebSocket(server);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`\nNovi is running`);
  console.log(`  Laptop: https://localhost:${config.port}`);
  for (const url of lanUrls) console.log(`  Phone:  ${url}`);
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

if (config.coder === 'claude') checkClaude(config.claudeCommand).then((warning) => warning && console.warn(`⚠  ${warning}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  wake?.stop();
  await novi.tasks.shutdown();
  await novi.plugins.stopServices();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
