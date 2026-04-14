const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LEGACY_HOME_PROFILE = path.join(os.homedir(), '.pw-brave-profile');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (fs.existsSync(LEGACY_HOME_PROFILE) ? LEGACY_HOME_PROFILE : path.join(MUSE_HOME, '.pw-brave-profile'));
const BROWSER_PATH = process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const META_URL = 'https://www.meta.ai/';

async function recordAndExtract() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  🎬 GRAVAR AÇÕES NO META AI + EXTRAIR DOM');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('O browser vai abrir no Meta AI.');
  console.log('FAZ TUDO O QUE QUISERES:');
  console.log('  1. Clica numa conversa existente');
  console.log('  2. OU envia "ola" numa conversa nova');
  console.log('  3. Observa a resposta aparecer');
  console.log('  4. Tenta clicar no botão "Copy" da resposta');
  console.log('\nQuando terminares, escreve "feito" aqui no terminal.\n');

  const launchOptions = {
    headless: false,
    viewport: null,
    args: ['--start-maximized']
  };
  if (fs.existsSync(BROWSER_PATH)) {
    launchOptions.executablePath = BROWSER_PATH;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  🎬 A GRAVAR TUDO...');
  console.log('═══════════════════════════════════════════════════════\n');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  
  // Fechar tabs antigas se possível
  const existingPages = context.pages();
  let page;
  if (existingPages.length > 0 && !existingPages[0].isClosed()) {
    page = existingPages[0];
  } else {
    try {
      page = await context.newPage();
    } catch (e) {
      console.log('Erro ao criar nova tab. A usar tab existente...');
      page = existingPages[0];
    }
  }
  
  // Setup recording
  const actions = [];
  
  page.on('request', req => {
    actions.push({ type: 'request', url: req.url().slice(0, 100), time: Date.now() });
  });
  
  page.on('dialog', dialog => {
    actions.push({ type: 'dialog', message: dialog.message(), time: Date.now() });
    dialog.dismiss();
  });
  
  page.on('console', msg => {
    if (msg.type() === 'error') {
      actions.push({ type: 'console_error', text: msg.text().slice(0, 200), time: Date.now() });
    }
  });

  console.log(`[START] A navegar para ${META_URL}...\n`);
  await page.goto(META_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  actions.push({ type: 'navigation', url: page.url(), time: Date.now() });
  
  console.log(`[PAGE] URL: ${page.url()}`);
  console.log('[PAGE] Título: ' + await page.title());
  
  await page.waitForSelector('textarea, [data-lexical-editor="true"], [contenteditable="true"]', { timeout: 30000 }).catch(() => {});
  console.log('[PAGE] Página pronta para interagir!\n');

  // Aguardar input do utilizador
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  await new Promise((resolve) => {
    rl.question('Escreve "feito" quando terminares: ', (answer) => {
      rl.close();
      console.log(`\n[STOP] Utilizador terminou. Ações registadas: ${actions.length}\n`);
      resolve();
    });
  });

  // ═══════════════════════════════════════════════════════
  // EXTRAÇÃO COMPLETA DO DOM
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📊 EXTRAÇÃO COMPLETA DO DOM');
  console.log('═══════════════════════════════════════════════════════\n');

  const fullExtract = await page.evaluate(() => {
    const result = {
      url: location.href,
      timestamp: new Date().toISOString(),
      title: document.title
    };

    // ═══════════ INPUT ═══════════
    result.input = null;
    const inputs = document.querySelectorAll('textarea, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"]');
    if (inputs.length) {
      const inp = inputs[inputs.length - 1];
      result.input = {
        tag: inp.tagName,
        selector: genSel(inp),
        isLexical: inp.hasAttribute('data-lexical-editor'),
        isContentEditable: inp.isContentEditable,
        placeholder: inp.getAttribute('placeholder'),
        dataAttrs: getDataAttrs(inp),
        classes: cls(inp),
        visible: inp.offsetWidth > 0 && inp.offsetHeight > 0
      };
    }

    // ═══════════ SEND BUTTON ═══════════
    result.sendButton = null;
    const allBtns = Array.from(document.querySelectorAll('button'));
    const sendBtn = allBtns.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return (aria.includes('enviar') || aria.includes('send')) && b.offsetWidth < 80 && b.offsetWidth > 0;
    });
    if (sendBtn) {
      result.sendButton = {
        ariaLabel: sendBtn.getAttribute('aria-label'),
        selector: genSel(sendBtn),
        dataAttrs: getDataAttrs(sendBtn),
        classes: cls(sendBtn)
      };
    }

    // ═══════════ COPY BUTTON ═══════════
    result.copyButton = null;
    const copyBtn = allBtns.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('copiar') || aria.includes('copy');
    });
    if (copyBtn) {
      result.copyButton = {
        ariaLabel: copyBtn.getAttribute('aria-label'),
        selector: genSel(copyBtn),
        dataAttrs: getDataAttrs(copyBtn)
      };
    }

    // ═══════════ NEW CHAT BUTTON ═══════════
    result.newChatButton = null;
    const newChatBtn = allBtns.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.innerText || '').toLowerCase();
      return aria.includes('nova conversa') || aria.includes('new chat') || 
             text.includes('nova conversa') || text.includes('new chat');
    });
    if (newChatBtn) {
      result.newChatButton = {
        ariaLabel: newChatBtn.getAttribute('aria-label'),
        selector: genSel(newChatBtn),
        dataAttrs: getDataAttrs(newChatBtn)
      };
    }

    // ═══════════ MESSAGES ═══════════
    result.messages = [];
    
    // By role attribute
    const byRole = document.querySelectorAll('[data-message-author-role]');
    byRole.forEach((el, i) => {
      result.messages.push({
        index: i,
        role: el.getAttribute('data-message-author-role'),
        text: (el.innerText || '').trim().slice(0, 500),
        tag: el.tagName,
        selector: genSel(el),
        classes: cls(el)
      });
    });

    // By article
    if (result.messages.length === 0) {
      const articles = document.querySelectorAll('article');
      articles.forEach((el, i) => {
        const text = (el.innerText || '').trim();
        if (text.length > 10) {
          result.messages.push({
            index: i,
            role: 'unknown',
            text: text.slice(0, 500),
            tag: el.tagName,
            selector: genSel(el),
            classes: cls(el)
          });
        }
      });
    }

    // By structure in main
    if (result.messages.length === 0) {
      const main = document.querySelector('main');
      if (main) {
        const allDivs = Array.from(main.querySelectorAll('div'));
        const textDivs = allDivs.filter(d => {
          const t = (d.innerText || '').trim();
          return t.length > 100 && t.length < 10000 && d.children.length > 3 && d.children.length < 100;
        });
        const unique = textDivs.filter((d, i) => !textDivs.some((o, j) => j !== i && o.contains(d)));
        unique.slice(-10).forEach((d, i) => {
          result.messages.push({
            index: i,
            role: 'unknown',
            text: (d.innerText || '').trim().slice(0, 500),
            tag: d.tagName,
            classes: cls(d),
            selector: genSel(d)
          });
        });
      }
    }

    // Body text dump
    if (result.messages.length === 0) {
      const bodyText = document.body.innerText;
      const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
      result.bodyTextDump = lines.filter(l => l.length > 30 && l.length < 1000).slice(-40);
    }

    // ═══════════ MAIN STRUCTURE ═══════════
    result.mainStructure = Array.from(document.querySelector('main')?.children || []).map(c => ({
      tag: c.tagName,
      classes: cls(c),
      childCount: c.children.length,
      textPreview: (c.innerText || '').trim().slice(0, 150)
    }));

    // ═══════════ CONVERSATION LINKS ═══════════
    result.conversationLinks = Array.from(document.querySelectorAll('nav a[href*="/prompt/"]'))
      .slice(0, 10)
      .map(a => ({
        href: a.getAttribute('href'),
        text: (a.innerText || '').trim().slice(0, 60),
        selector: genSel(a)
      }));

    return result;

    function genSel(el) {
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

    function getDataAttrs(el) {
      return Object.fromEntries(Array.from(el.attributes)
        .filter(a => a.name.startsWith('data-'))
        .map(a => [a.name, a.value]));
    }

    function cls(el) {
      return typeof el.className === 'string' ? el.className.slice(0, 120) : '';
    }
  });

  // ═══════════════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════════════
  console.log(JSON.stringify(fullExtract, null, 2));

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📝 RESUMO');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log(`📍 URL: ${fullExtract.url}`);
  console.log(`📌 Title: ${fullExtract.title}`);

  if (fullExtract.messages.length > 0) {
    console.log(`\n✅ ${fullExtract.messages.length} mensagens encontradas:`);
    fullExtract.messages.forEach((m, i) => {
      console.log(`  [${i}] role=${m.role} text="${m.text.slice(0, 60)}..."`);
      console.log(`      → ${m.selector}`);
    });
  } else {
    console.log('\n⚠️  Nenhuma mensagem encontrada');
  }

  console.log(`\n📝 Input: ${fullExtract.input ? fullExtract.input.selector : 'NOT FOUND'}`);
  console.log(`📤 Send: ${fullExtract.sendButton ? fullExtract.sendButton.selector : 'NOT FOUND'}`);
  console.log(`📋 Copy: ${fullExtract.copyButton ? fullExtract.copyButton.selector : 'NOT FOUND'}`);
  console.log(`➕ NewChat: ${fullExtract.newChatButton ? fullExtract.newChatButton.selector : 'NOT FOUND'}`);

  // Guardar seletores
  let selectors = '# Generated by record-and-extract.js\n';
  selectors += `# URL: ${fullExtract.url}\n`;
  selectors += `# Timestamp: ${fullExtract.timestamp}\n\n`;
  if (fullExtract.input?.selector) selectors += `input_selector=${fullExtract.input.selector}\n`;
  if (fullExtract.sendButton?.selector) selectors += `send_button=${fullExtract.sendButton.selector}\n`;
  if (fullExtract.copyButton?.selector) selectors += `copy_button=${fullExtract.copyButton.selector}\n`;
  if (fullExtract.newChatButton?.selector) selectors += `new_chat_button=${fullExtract.newChatButton.selector}\n`;
  if (fullExtract.messages?.length) {
    const lastMsg = fullExtract.messages[fullExtract.messages.length - 1];
    selectors += `message_selector=${lastMsg.selector}\n`;
    selectors += `message_role_attr=${lastMsg.role}\n`;
  }

  const outFile = path.join(process.cwd(), 'meta_inspector', 'selectors.txt');
  fs.writeFileSync(outFile, selectors, 'utf8');
  console.log(`\n💾 Guardado: ${outFile}`);
  console.log(`\nConteúdo:\n${selectors}`);

  await context.close();
}

recordAndExtract().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
