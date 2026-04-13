const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LEGACY_HOME_PROFILE = path.join(os.homedir(), '.pw-brave-profile');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (require('fs').existsSync(LEGACY_HOME_PROFILE) ? LEGACY_HOME_PROFILE : path.join(MUSE_HOME, '.pw-brave-profile'));
const BROWSER_PATH = process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const META_URL = process.env.META_URL || 'https://www.meta.ai/';

async function inspectMetaAI() {
  console.log('A abrir browser...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: require('fs').existsSync(BROWSER_PATH) ? BROWSER_PATH : undefined,
    viewport: null,
    args: ['--start-maximized']
  });
  const page = context.pages()[0] || await context.newPage();
  
  console.log(`A navegar para ${META_URL}...`);
  await page.goto(META_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  console.log('  A aguardar network idle...');
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('  DOM ready!');

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  A aguardar 30s para a página carregar completamente');
  console.log('  (vai ver a página do Meta AI no seu browser)');
  console.log('═══════════════════════════════════════════════════════\n');

  await new Promise(r => setTimeout(r, 30000));
  
  console.log('\n📊 A extrair estrutura do Meta AI...\n');
  
  const structure = await page.evaluate(() => {
    const result = {};
    
    // 1. URL atual
    result.url = location.href;
    result.title = document.title;
    
    // 2. Input/Textarea
    result.inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .map(el => ({
        tag: el.tagName,
        type: el.type || null,
        placeholder: el.getAttribute('placeholder'),
        id: el.id,
        classes: el.className,
        dataAttrs: Object.fromEntries(Array.from(el.attributes)
          .filter(a => a.name.startsWith('data-'))
          .map(a => [a.name, a.value])),
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        selector: generateSelector(el)
      }));
    
    // 3. Botões
    result.buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0)
      .map(el => ({
        tag: el.tagName,
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60),
        ariaLabel: el.getAttribute('aria-label'),
        type: el.type,
        disabled: el.disabled,
        id: el.id,
        classes: el.className,
        dataAttrs: Object.fromEntries(Array.from(el.attributes)
          .filter(a => a.name.startsWith('data-'))
          .map(a => [a.name, a.value])),
        selector: generateSelector(el)
      }));
    
    // 4. Links
    result.links = Array.from(document.querySelectorAll('a[href]'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0)
      .map(el => ({
        href: el.getAttribute('href'),
        text: (el.innerText || '').trim().slice(0, 60),
        selector: generateSelector(el)
      }));
    
    // 5. Mensagens de chat
    result.chatMessages = Array.from(document.querySelectorAll('[data-message-author-role], article, [class*="message"], [class*="chat"]'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0)
      .map(el => ({
        tag: el.tagName,
        role: el.getAttribute('data-message-author-role'),
        textPreview: (el.innerText || '').trim().slice(0, 100),
        id: el.id,
        classes: el.className,
        selector: generateSelector(el)
      }));
    
    // 6. Elementos com texto significativo
    result.textBlocks = Array.from(document.querySelectorAll('p, div, span, li, pre, code'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0)
      .filter(el => {
        const text = (el.innerText || '').trim();
        return text.length > 30 && text.length < 500;
      })
      .slice(-20)
      .map(el => ({
        tag: el.tagName,
        text: (el.innerText || '').trim().slice(0, 120),
        classes: el.className,
        selector: generateSelector(el)
      }));
    
    // 7. Main content areas
    result.mainAreas = Array.from(document.querySelectorAll('main, #main, [role="main"], [class*="main"], [class*="content"], [class*="chat"]'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0)
      .map(el => ({
        tag: el.tagName,
        id: el.id,
        classes: el.className,
        textPreview: (el.innerText || '').trim().slice(0, 80),
        selector: generateSelector(el)
      }));
    
    // 8. Formulários
    result.forms = Array.from(document.querySelectorAll('form'))
      .map(el => ({
        action: el.action,
        method: el.method,
        id: el.id,
        classes: el.className,
        selector: generateSelector(el),
        inputs: Array.from(el.querySelectorAll('input, textarea, [contenteditable]')).map(i => ({
          tag: i.tagName,
          type: i.type,
          name: i.name,
          id: i.id
        }))
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
  
  // Escrever resultado
  const fs = require('fs');
  const outFile = path.join(process.cwd(), 'meta_inspector', 'selectors.txt');
  
  console.log('\n📄 Estrutura extraída:');
  console.log('═══════════════════════════════════════════════════════');
  console.log(JSON.stringify(structure, null, 2));
  console.log('═══════════════════════════════════════════════════════\n');
  
  // Gerar selectors.txt otimizado
  let selectors = '';
  
  // Input selector
  if (structure.inputs.length) {
    const input = structure.inputs.find(i => i.visible && (i.tag === 'TEXTAREA' || i.role === 'textbox')) || structure.inputs[0];
    selectors += `input_selector=${input.selector}\n`;
  }
  
  // Send button
  const sendBtn = structure.buttons.find(b => 
    b.text.toLowerCase().includes('enviar') || 
    b.text.toLowerCase().includes('send') ||
    b.ariaLabel?.toLowerCase().includes('enviar') ||
    b.ariaLabel?.toLowerCase().includes('send') ||
    b.text.includes('▶') ||
    b.text.includes('➤')
  );
  if (sendBtn) {
    selectors += `send_button=${sendBtn.selector}\n`;
  }
  
  // Chat messages
  if (structure.chatMessages.length) {
    const msg = structure.chatMessages[structure.chatMessages.length - 1];
    selectors += `last_message=${msg.selector}\n`;
    selectors += `message_role_attr=${msg.role ? msg.role : 'unknown'}\n`;
  }
  
  // Main chat area
  if (structure.mainAreas.length) {
    const main = structure.mainAreas[0];
    selectors += `main_chat_area=${main.selector}\n`;
  }
  
  fs.writeFileSync(outFile, selectors, 'utf8');
  console.log(`\n✅ selectors.txt atualizado: ${outFile}`);
  console.log('\nConteúdo:');
  console.log(selectors);
  
  await context.close();
}

inspectMetaAI().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
