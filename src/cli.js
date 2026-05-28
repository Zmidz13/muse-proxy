#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { version } = require('../package.json');
const { startBridgeGateway } = require('./bridge-gateway');
const { createKey, listKeys, deleteKey } = require('./key-store');
const { runAuthSetup } = require('./auth-setup');

function printHelp() {
  // eslint-disable-next-line no-console
  console.log([
    '',
    '  MuseProxy — AI Gateway',
    '',
    '  Usage:',
    '    museproxy                  Start gateway (opens app window)',
    '    museproxy start            Start gateway (opens app window)',
    '    museproxy start --headless Start gateway (no window, CLI only)',
    '    museproxy authsetup        Login to Meta AI (one-time)',
    '    museproxy apicreate -n X   Create an API key',
    '    museproxy apilist          List all API keys',
    '    museproxy apidelete <id>   Delete an API key',
    '    museproxy help             Show this help',
    ''
  ].join('\n'));
}

function parsePort(argv) {
  const idx = argv.findIndex((a) => a === '--port' || a === '-p');
  if (idx === -1) return undefined;
  const port = Number(argv[idx + 1]);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return port;
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

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  if (cmd === 'apicreate') {
    const name = parseName(args);
    const created = createKey(name);
    // eslint-disable-next-line no-console
    console.log(`\n  API Key: ${created.apiKey}\n  Name: ${created.record.name}\n`);
    process.exit(0);
  }

  if (cmd === 'apilist') {
    const keys = listKeys();
    if (!keys.length) {
      // eslint-disable-next-line no-console
      console.log('\n  No API keys yet. Create one: musespark apicreate\n');
    } else {
      // eslint-disable-next-line no-console
      console.log('\n  API Keys:\n');
      for (const k of keys) {
        // eslint-disable-next-line no-console
        console.log(`  ${k.name}  (${k.prefix}****)  ${k.createdAt.slice(0, 10)}`);
      }
      // eslint-disable-next-line no-console
      console.log('');
    }
    process.exit(0);
  }

  if (cmd === 'apidelete') {
    const idOrPrefix = String(args[1] || '').trim();
    if (!idOrPrefix) { /* eslint-disable-next-line no-console */ console.error('  Usage: musespark apidelete <id-or-prefix>'); process.exit(1); }
    const removed = deleteKey(idOrPrefix);
    // eslint-disable-next-line no-console
    console.log(removed > 0 ? `\n  Deleted ${removed} key(s).\n` : '\n  No key matched.\n');
    process.exit(removed > 0 ? 0 : 1);
  }

  if (cmd === 'authsetup') {
    // eslint-disable-next-line no-console
    console.log('\n  Opening browser for Meta AI login...\n');
    await runAuthSetup();
    process.exit(0);
  }

  if (!cmd || cmd === 'start' || cmd === 'start1' || cmd === 'start2' || cmd === 'bridge' || cmd === 'startvoid') {
    if (!process.env.META_HEADLESS) process.env.META_HEADLESS = 'true';
    if (!process.env.META_USE_BRAVE) process.env.META_USE_BRAVE = 'true';
    if (!process.env.META_SPOOF_BRAVE) process.env.META_SPOOF_BRAVE = 'true';

    const headless = args.includes('--headless');
    const ui = !headless;

    const port = parsePort(args) || Number(process.env.PORT || 8787);
    await startBridgeGateway({ port, ui });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`  Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error:', error && error.message ? error.message : error);
  process.exit(1);
});