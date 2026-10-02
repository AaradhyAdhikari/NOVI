import https from 'node:https';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createNovi } from './app.js';
import { loadOrCreateCert, lanAddresses } from './certs.js';
import { checkClaude } from './claude/check.js';

const config = loadConfig();
if (!config.providers.length) console.warn('⚠  No AI provider keys found. Add GROQ_API_KEYS / GEMINI_API_KEYS to .env');

const lanUrls = lanAddresses().map((ip) => `https://${ip}:${config.port}`);
const novi = createNovi(config, { lanUrls });
const server = https.createServer(loadOrCreateCert(path.join(config.dataDir, 'certs')), novi.app);
novi.attachWebSocket(server);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`\nNovi is running`);
  console.log(`  Laptop: https://localhost:${config.port}`);
  for (const url of lanUrls) console.log(`  Phone:  ${url}`);
  console.log(`  Coding agent: ${config.coder === 'claude' ? 'Claude Code (uses your Claude plan)' : 'Novi Coder (free Groq/Gemini)'}`);
  console.log(`  Providers: ${config.providers.map((p) => `${p.name} (${p.keys.length} key${p.keys.length === 1 ? '' : 's'})`).join(', ') || 'none'}`);
  console.log(`  Pairing code: ${novi.pairing.currentCode().code} (also shown in the app)\n`);
});

if (config.coder === 'claude') checkClaude(config.claudeCommand).then((warning) => warning && console.warn(`⚠  ${warning}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await novi.tasks.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
