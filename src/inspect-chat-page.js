const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LEGACY_HOME_PROFILE = path.join(os.homedir(), '.pw-brave-profile');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (fs.existsSync(LEGACY_HOME_PROFILE) ? LEGACY_HOME_PROFILE : path.join(MUSE_HOME, '.pw-brave-profile'));
const BROWSER_PATH = process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const META_URL = process.env.META_URL || 'https://www.meta.ai/';

async function inspectChatPage() {
  console.log('A abrir browser...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: fs.existsSync(BROWSER_PATH) ? BROWSER_PATH : undefined,
    viewport: null,
    args: ['--start-maximized']
  });
  const page = context.pages()[0] || await context.newPage();
  
  console.log(`A navegar para ${META_URL}...`);
  await page.goto(META_URL, { waitUntil: 'networkidle', timeout: 90000 });
  console.log('  Página carregada!');
  
  // Esperar sidebar carregar
  await page.waitForSelector('nav a[href*="/prompt/"]').catch(() => {});
  await new Promise(r => setTimeout(r, 5000));
  
  // Clicar na primeira conversa
  console.log('\nA clicar na primeira conversa...');
  const firstChat = await page.locator('nav a[href*="/prompt/"]').first();
  const count = await firstChat.count();
  if (count > 0) {
    await firstChat.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 8000));
    console.log(`  URL atual: ${page.url()}`);
  } else {
    console.log('  Nenhuma conversa encontrada. A criar uma nova...');
    const textarea = page.locator('textarea[data-testid="composer-input"]').first();
    if (await textarea.count()) {
      await textarea.fill('diz ola');
      await textarea.press('Enter');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  
  console.log('\n📊 A extrair estrutura da página de CHAT...\n');
  
  const structure = await page.evaluate(() => {
    const result = {
      url: location.href,
      title: document.title
    };
    
    // 1. TODAS as mensagens visíveis (user + assistant)
    result.messages = [];
    
    // Strategy A: data-message-author-role (se existir)
    const byRole = document.querySelectorAll('[data-message-author-role]');
    byRole.forEach(el => {
      result.messages.push({
        role: el.getAttribute('data-message-author-role'),
        text: (el.innerText || '').trim().slice(0, 200),
        tag: el.tagName,
        id: el.id,
        classes: el.className,
        selector: generateSelector(el)
      });
    });
    
    // Strategy B: article elements
    if (result.messages.length === 0) {
      const articles = document.querySelectorAll('article');
      articles.forEach(el => {
        const text = (el.innerText || '').trim();
        if (text.length > 10) {
          result.messages.push({
            role: 'unknown',
            text: text.slice(0, 200),
            tag: el.tagName,
            id: el.id,
            classes: el.className,
            selector: generateSelector(el)
          });
        }
      });
    }
    
    // Strategy C: divs com texto longo no main
    if (result.messages.length === 0) {
      const main = document.querySelector('main');
      if (main) {
        const allDivs = Array.from(main.querySelectorAll('div'));
        const textDivs = allDivs.filter(d => {
          const t = (d.innerText || '').trim();
          return t.length > 100 && t.length < 5000 && d.children.length > 2 && d.children.length < 80;
        });
        // Remove nested divs (keep only parents)
        const unique = textDivs.filter((d, i) => {
          return !textDivs.some((other, j) => j !== i && other.contains(d));
        });
        unique.slice(-10).forEach(d => {
          result.messages.push({
            role: 'unknown',
            text: (d.innerText || '').trim().slice(0, 300),
            tag: d.tagName,
            classes: d.className,
            selector: generateSelector(d)
          });
        });
      }
    }
    
    // Strategy D: body text dump
    if (result.messages.length === 0) {
      const bodyText = document.body.innerText;
      const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
      const contentLines = lines.filter(l => 
        l.length > 30 && 
        l.length < 1000 &&
        !l.includes('Nova conversa') &&
        !l.includes('Meta AI') &&
        !l.includes('Command Palette') &&
        !l.includes('Pesquisar')
      );
      result.bodyContentDump = contentLines.slice(-30);
    }
    
    // 2. Input
    result.input = {
      selector: null,
      type: null,
      dataAttrs: {},
      placeholder: null
    };
    const inputs = document.querySelectorAll('textarea, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"]');
    if (inputs.length) {
      const inp = inputs[inputs.length - 1];
      result.input = {
        tag: inp.tagName,
        selector: generateSelector(inp),
        placeholder: inp.getAttribute('placeholder'),
        isLexical: inp.hasAttribute('data-lexical-editor'),
        isContentEditable: inp.isContentEditable,
        dataAttrs: Object.fromEntries(Array.from(inp.attributes).filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])),
        classes: inp.className
      };
    }
    
    // 3. Botão enviar
    result.sendButton = null;
    const buttons = Array.from(document.querySelectorAll('button'));
    const sendBtn = buttons.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.innerText || '').toLowerCase();
      return aria.includes('enviar') || aria.includes('send') || 
             (text.includes('enviar') && b.offsetWidth < 60) ||
             b.querySelector('svg') && b.offsetWidth < 60 && b.offsetHeight < 60;
    });
    if (sendBtn) {
      result.sendButton = {
        tag: sendBtn.tagName,
        ariaLabel: sendBtn.getAttribute('aria-label'),
        selector: generateSelector(sendBtn),
        classes: sendBtn.className
      };
    }
    
    // 4. Estrutura geral do main
    result.mainStructure = Array.from(document.querySelector('main')?.children || []).map(c => ({
      tag: c.tagName,
      id: c.id,
      classPreview: typeof c.className === 'string' ? c.className.slice(0, 80) : null,
      textPreview: (c.innerText || '').trim().slice(0, 100)
    }));
    
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
  
  if (structure.messages && structure.messages.length > 0) {
    console.log(`\n✅ Encontradas ${structure.messages.length} mensagens!`);
    structure.messages.forEach((m, i) => {
      console.log(`  [${i}] role=${m.role} text="${m.text.slice(0, 80)}..."`);
      console.log(`      selector: ${m.selector}`);
    });
  } else {
    console.log('\n⚠️  Nenhuma mensagem encontrada. Body content dump:');
    (structure.bodyContentDump || []).forEach((line, i) => {
      console.log(`  [${i}] ${line.slice(0, 100)}`);
    });
  }
  
  console.log(`\n📝 Input: ${JSON.stringify(structure.input, null, 2)}`);
  console.log(`📤 Send button: ${JSON.stringify(structure.sendButton, null, 2)}`);
  
  // Guardar seletores
  let selectors = '';
  if (structure.input?.selector) selectors += `input_selector=${structure.input.selector}\n`;
  if (structure.sendButton?.selector) selectors += `send_button=${structure.sendButton.selector}\n`;
  if (structure.messages?.length && structure.messages[0]?.selector) {
    selectors += `message_selector=${structure.messages[0].selector}\n`;
  }
  
  fs.writeFileSync(path.join(process.cwd(), 'meta_inspector', 'chat_selectors.txt'), selectors, 'utf8');
  console.log(`\n💾 chat_selectors.txt guardado`);
  
  await context.close();
}

inspectChatPage().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
