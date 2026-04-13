#!/usr/bin/env node
const { version } = require('../package.json');
const { startBridgeGateway } = require('./bridge-gateway');
const { startGateway } = require('./openai-api');
const { createKey, listKeys, deleteKey, getStoreFilePath } = require('./key-store');
const { runAuthSetup } = require('./auth-setup');

function printHelp() {
  // eslint-disable-next-line no-console
  console.log([
    'musespark CLI',
    '',
    'Usage:',
    '  musespark start  [--port 8787]   # Agentic OpenAI-like gateway (recommended for Void)',
    '  musespark start1 [--port 8787]   # Alias for start',
    '  musespark startvoid [--port 8787] # Void-native tool bridge (Void executes the tools)',
    '  musespark start2 [--port 8787]   # Bridge/pass-through gateway (Void/OpenClaude -> Meta.ai)',
    '  musespark bridge [--port 8787]   # Alias for start2',
    '  musespark apicreate [--name "my-key"]',
    '  musespark apilist',
    '  musespark apidelete <id-or-prefix>',
    '  musespark authsetup',
    '',
    'start/start1 run the local agentic gateway. startvoid forces IDE tool mode for real Void execution. start2/bridge run the pass-through bridge gateway.'
  ].join('\n'));
}

function parsePort(argv) {
  const idx = argv.findIndex((a) => a === '--port' || a === '-p');
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return port;
}

function setTerminalTitle(title) {
  try {
    process.stdout.write(`\u001b]0;${title}\u0007`);
  } catch {
    // ignore terminal title failures
  }
}

function parseName(argv) {
  const idx = argv.findIndex((a) => a === '--name' || a === '-n');
  if (idx === -1) return 'default';
  return String(argv[idx + 1] || 'default');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    // eslint-disable-next-line no-console
    console.log(version);
    process.exit(0);
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  if (cmd !== 'start' && cmd !== 'start1' && cmd !== 'startvoid' && cmd !== 'start2' && cmd !== 'bridge') {
    if (cmd === 'apicreate') {
      const name = parseName(args);
      const created = createKey(name);
      // eslint-disable-next-line no-console
      console.log('API key created successfully:');
      // eslint-disable-next-line no-console
      console.log(`id: ${created.record.id}`);
      // eslint-disable-next-line no-console
      console.log(`name: ${created.record.name}`);
      // eslint-disable-next-line no-console
      console.log(`prefix: ${created.record.prefix}`);
      // eslint-disable-next-line no-console
      console.log(`store: ${getStoreFilePath()}`);
      // eslint-disable-next-line no-console
      console.log(`api_key: ${created.apiKey}`);
      process.exit(0);
    }

    if (cmd === 'apilist') {
      const keys = listKeys();
      if (!keys.length) {
        // eslint-disable-next-line no-console
        console.log('No API keys yet. Create one with: musespark apicreate');
        process.exit(0);
      }
      // eslint-disable-next-line no-console
      console.log('API keys:');
      for (const k of keys) {
        // eslint-disable-next-line no-console
        console.log(
          `- id=${k.id} name=${k.name} prefix=${k.prefix} createdAt=${k.createdAt} lastUsedAt=${k.lastUsedAt || '-'}`
        );
      }
      process.exit(0);
    }

    if (cmd === 'apidelete') {
      const idOrPrefix = String(args[1] || '').trim();
      if (!idOrPrefix) {
        // eslint-disable-next-line no-console
        console.error('Usage: musespark apidelete <id-or-prefix>');
        process.exit(1);
      }
      const removed = deleteKey(idOrPrefix);
      // eslint-disable-next-line no-console
      console.log(removed > 0 ? `Deleted ${removed} key(s).` : 'No key matched that id/prefix.');
      process.exit(removed > 0 ? 0 : 1);
    }

    if (cmd === 'authsetup') {
      await runAuthSetup();
      process.exit(0);
    }

    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }

  if (!process.env.META_HEADLESS) {
    process.env.META_HEADLESS = 'true';
  }
  if (!process.env.META_USE_BRAVE) {
    process.env.META_USE_BRAVE = 'true';
  }
  if (!process.env.META_SPOOF_BRAVE) {
    process.env.META_SPOOF_BRAVE = 'true';
  }

  const port = parsePort(args) || Number(process.env.PORT || 8787);
  const url = `http://localhost:${port}/v1`;
  if (cmd === 'start2' || cmd === 'bridge') {
    setTerminalTitle(`MUSESPARK Unified Bridge - ${url}`);
    await startBridgeGateway({ port });
    return;
  }
  if (cmd === 'startvoid') {
    process.env.MUSE_TOOL_EXECUTION_MODE = 'void';
    setTerminalTitle(`MUSESPARK Void Bridge - ${url}`);
    // eslint-disable-next-line no-console
    console.log('[CLI] Starting Void Bridge mode — gateway acts as bridge between Meta AI and Void IDE');
    // eslint-disable-next-line no-console
    console.log('[CLI] Void IDE will execute tools natively, gateway only translates XML ↔ OpenAI tool_calls');
    await startGateway({ port });
    return;
  }
  setTerminalTitle(`MUSESPARK Gateway - ${url}`);
  await startGateway({ port });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error:', error && error.message ? error.message : error);
  process.exit(1);
});
