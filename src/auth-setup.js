const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const META_URL = process.env.META_URL || 'https://www.meta.ai/';
const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LEGACY_HOME_PROFILE = path.join(os.homedir(), '.pw-brave-profile');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (fs.existsSync(LEGACY_HOME_PROFILE) ? LEGACY_HOME_PROFILE : path.join(MUSE_HOME, '.pw-brave-profile'));

/**
 * Finds the Brave browser executable path by checking common installation locations.
 * Returns the first path that exists, or null if none found.
 */
function findBravePath() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const BROWSER_PATH = process.env.BROWSER_PATH || findBravePath();

async function runAuthSetup() {
  fs.mkdirSync(MUSE_HOME, { recursive: true });
  const launchOptions = {
    headless: false,
    viewport: null,
    args: ['--start-maximized']
  };
  if (fs.existsSync(BROWSER_PATH)) {
    launchOptions.executablePath = BROWSER_PATH;
  }
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  await page.goto(META_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // eslint-disable-next-line no-console
  console.log('Login setup aberto.');
  // eslint-disable-next-line no-console
  console.log(`Perfil usado: ${USER_DATA_DIR}`);
  // eslint-disable-next-line no-console
  console.log('Faz login/consentimento no Meta AI nesta janela e depois fecha-a.');

  await new Promise((resolve) => {
    context.on('close', resolve);
  });
}

if (require.main === module) {
  runAuthSetup().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Auth setup error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { runAuthSetup };
