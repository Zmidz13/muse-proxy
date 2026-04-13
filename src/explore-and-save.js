const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LEGACY_HOME_PROFILE = path.join(os.homedir(), '.pw-brave-profile');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (fs.existsSync(LEGACY_HOME_PROFILE) ? LEGACY_HOME_PROFILE : path.join(MUSE_HOME, '.pw-brave-profile'));
const BROWSER_PATH = process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const META_URL = 'https://www.meta.ai/';

async function exploreAndSave() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📋 EXPLORAR META AI E GUARDAR SELETORES');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('O browser vai abrir NO Meta AI.');
  console.log('Faz o que precisares: clica em conversas, envia mensagens, etc.');
  console.log('Depois escreve "done" aqui no terminal.\n');

  const launchOptions = {
    headless: false,
    viewport: null,
    args: ['--start-maximized']
  };
  if (fs.existsSync(BROWSER_PATH)) {
    launchOptions.executablePath = BROWSER_PATH;
  }

  console.log('A abrir Brave com o teu perfil...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);

  // Use existing tab (don't try to create new one - fails when Brave already uses this profile)
  const page = context.pages()[0];
  if (!page || page.isClosed()) {
    throw new Error('No tabs available. Close Brave and try again.');
  }
  
  console.log(`A navegar para ${META_URL}...`);
  await page.goto(META_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('✅ Meta AI carregado!');

  // Wait for page to be interactive
  await page.waitForSelector('textarea, [data-lexical-editor="true"], [contenteditable="true"]', { timeout: 30000 }).catch(() => {});
  console.log('✅ Página pronta para interagir!\n');

  // Aguardar input do utilizador
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  await new Promise((resolve) => {
    rl.question('Escreve "done" quando terminares: ', (answer) => {
      rl.close();
      resolve();
    });
  });

  console.log('\n🔍 A extrair estrutura...\n');

  const structure = await page.evaluate(() => {
    const result = {
      url: location.href,
      timestamp: new Date().toISOString()
    };

    // === INPUT ===
    result.input = null;
    const inputs = document.querySelectorAll('textarea, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"]');
    if (inputs.length) {
      const inp = inputs[inputs.length - 1];
      result.input = {
        tag: inp.tagName,
        selector: generateSelector(inp),
        isLexical: inp.hasAttribute('data-lexical-editor'),
        isContentEditable: inp.isContentEditable,
        placeholder: inp.getAttribute('placeholder'),
        dataAttrs: Object.fromEntries(Array.from(inp.attributes).filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value]))
      };
    }

    // === SEND BUTTON ===
    result.sendButton = null;
    const allButtons = Array.from(document.querySelectorAll('button'));
    const sendBtn = allButtons.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return (aria.includes('enviar') || aria.includes('send')) && b.offsetWidth < 80;
    });
    if (sendBtn) {
      result.sendButton = {
        ariaLabel: sendBtn.getAttribute('aria-label'),
        selector: generateSelector(sendBtn)
      };
    }

    // === MESSAGES ===
    result.messages = [];
    
    // Try data attribute
    const byRole = document.querySelectorAll('[data-message-author-role]');
    if (byRole.length) {
      result.messages.push({
        count: byRole.length,
        lastRole: byRole[byRole.length - 1].getAttribute('data-message-author-role'),
        selector: generateSelector(byRole[byRole.length - 1])
      });
    }
    
    // Try main content area
    const main = document.querySelector('main');
    if (main) {
      const text = (main.innerText || '').trim().slice(0, 500);
      result.mainText = text;
      result.mainChildren = Array.from(main.children).map(c => ({
        tag: c.tagName,
        classPreview: typeof c.className === 'string' ? c.className.slice(0, 60) : '',
        childCount: c.children.length
      }));
    }

    // Full body text for debugging
    const bodyText = document.body.innerText;
    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 20);
    result.bodyLines = lines.slice(-30);

    return result;

    function generateSelector(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
      if (el.id) return `#${el.id}`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.body) {
        const tag = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        const sameTag = Array.from(parent.children).filter(n => n.tagName === cur.tagName);
        const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(cur) + 1})` : '';
        parts.unshift(`${tag}${nth}`);
        cur = parent;
      }
      return parts.join(' > ');
    }
  });

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(JSON.stringify(structure, null, 2));
  console.log('═══════════════════════════════════════════════════════\n');

  // Guardar
  let selectors = '';
  if (structure.input?.selector) selectors += `input_selector=${structure.input.selector}\n`;
  if (structure.sendButton?.selector) selectors += `send_button=${structure.sendButton.selector}\n`;

  const outFile = path.join(process.cwd(), 'meta_inspector', 'selectors.txt');
  fs.writeFileSync(outFile, selectors, 'utf8');
  console.log(`💾 Guardado: ${outFile}`);
  console.log(`\n${selectors}`);

  await context.close();
}

exploreAndSave().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
