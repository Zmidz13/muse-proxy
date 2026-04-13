const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  console.log('=== Meta AI Session Recorder ===');
  console.log('');
  console.log('O que fazer:');
  console.log('1. Navegar pelo Meta AI');
  console.log('2. Clicar no botao thinking (se existir)');
  console.log('3. Enviar uma mensagem de teste');
  console.log('4. Interagir com a resposta (copiar, etc.)');
  console.log('');
  console.log('Quando terminares, escreve "feito" no terminal.');
  console.log('');

  const userDataDir = path.join(os.homedir(), '.pw-brave-profile');
  const browser = await chromium.launchPersistentContext(userDataDir, {
    executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    headless: false,
    args: ['--profile-directory=Default']
  });

  // Use the first existing tab (persistent context always has at least one)
  const pages = await browser.pages();
  const page = pages[0];

  const outputDir = path.join('./meta_inspector', `recording_${timestamp()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const recordedData = {
    urls: [],
    clicks: [],
    selectors: [],
    domDumps: [],
    thinkingButtons: [],
    errors: []
  };

  // Track navigation
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      const url = page.url();
      recordedData.urls.push({ at: new Date().toISOString(), url });
      console.log(`[NAV] ${url}`);

      // Dump DOM snapshot after navigation
      try {
        const html = await page.content();
        const domFile = `dom_${timestamp()}.html`;
        fs.writeFileSync(path.join(outputDir, domFile), html);
        recordedData.domDumps.push({ at: new Date().toISOString(), file: domFile, url });
      } catch (e) {
        recordedData.errors.push({ at: new Date().toISOString(), type: 'dom-dump', error: e.message });
      }
    }
  });

  // Track page interactions
  page.on('console', async (msg) => {
    if (msg.type() === 'error') {
      recordedData.errors.push({ at: new Date().toISOString(), type: 'console', error: msg.text() });
    }
  });

  console.log('A abrir Meta AI...');
  await page.goto('https://www.meta.ai/', { waitUntil: 'domcontentloaded' });
  recordedData.urls.push({ at: new Date().toISOString(), url: page.url() });

  // Give time for login
  console.log('A aguardar 3s para carregamento...');
  await page.waitForTimeout(3000);

  console.log('');
  console.log('Browser aberto! Faz o que precisas no Meta AI.');
  console.log('Quando terminares, escreve "feito" aqui no terminal.');
  console.log('');

  // Interactive commands
  let done = false;
  while (!done) {
    const cmd = await ask('> ');
    const trimmed = cmd.trim().toLowerCase();

    if (trimmed === 'feito' || trimmed === 'done' || trimmed === 'exit') {
      done = true;
      break;
    }

    if (trimmed === 'dump') {
      // Manual DOM dump
      try {
        const html = await page.content();
        const domFile = `dom_${timestamp()}.html`;
        fs.writeFileSync(path.join(outputDir, domFile), html);
        recordedData.domDumps.push({ at: new Date().toISOString(), file: domFile, url: page.url() });
        console.log(`  -> DOM salvo: ${domFile}`);
      } catch (e) {
        console.log(`  -> Erro: ${e.message}`);
      }
      continue;
    }

    if (trimmed === 'screenshot' || trimmed === 'shot') {
      try {
        const shotFile = `shot_${timestamp()}.png`;
        await page.screenshot({ path: path.join(outputDir, shotFile), fullPage: true });
        console.log(`  -> Screenshot salvo: ${shotFile}`);
      } catch (e) {
        console.log(`  -> Erro: ${e.message}`);
      }
      continue;
    }

    if (trimmed === 'think' || trimmed === 'thinking') {
      // Find thinking/reasoning buttons
      try {
        const buttons = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('button, [role="button"], a, span[role="button"]'));
          const candidates = all.filter(el => {
            const text = (el.innerText || el.textContent || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const testid = (el.getAttribute('data-testid') || '').toLowerCase();
            return (
              text.includes('think') || text.includes('reason') || text.includes('deep') ||
              text.includes('spark') || text.includes('pesquisa') || text.includes('search') ||
              aria.includes('think') || aria.includes('reason') || aria.includes('deep') ||
              testid.includes('think') || testid.includes('reason')
            );
          });
          return candidates.map(el => ({
            tag: el.tagName,
            text: (el.innerText || '').slice(0, 80),
            ariaLabel: el.getAttribute('aria-label'),
            className: el.className,
            id: el.id,
            dataTestId: el.getAttribute('data-testid'),
            selector: el.id ? `#${el.id}` : null,
            rect: el.getBoundingClientRect ? (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null
          }));
        });
        recordedData.thinkingButtons = buttons;
        console.log(`  -> Encontrados ${buttons.length} candidatos:`);
        buttons.forEach((b, i) => console.log(`    ${i + 1}. ${JSON.stringify(b, null, 2)}`));
      } catch (e) {
        console.log(`  -> Erro: ${e.message}`);
      }
      continue;
    }

    if (trimmed === 'selectors') {
      // Extract all useful selectors
      try {
        const selectors = await page.evaluate(() => {
          const inputEl = document.querySelector('[data-lexical-editor="true"]');
          const sendBtn = document.querySelector('[data-testid="composer-send-button"]');
          const copyBtns = Array.from(document.querySelectorAll('[aria-label*="Copiar"], [aria-label*="Copy"]'));
          const stopBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            const t = (b.innerText || '').toLowerCase();
            return a.includes('stop') || a.includes('parar') || t.includes('stop');
          });
          const messageEl = document.querySelector('main > div > div > div > div > div > div:last-of-type');

          return {
            input_selector: inputEl ? `[data-lexical-editor="true"]` : 'NOT FOUND',
            send_button: sendBtn ? `[data-testid="composer-send-button"]` : 'NOT FOUND',
            copy_button: copyBtns.length > 0 ? copyBtns.map(b => `[aria-label="${b.getAttribute('aria-label')}"]`).join(', ') : 'NOT FOUND',
            stop_button: stopBtns.length > 0 ? 'button:has-text("stop") or button:has-text("parar")' : 'NOT FOUND',
            message_selector: messageEl ? 'main > div > div > div > div > div > div:last-of-type' : 'NOT FOUND'
          };
        });
        recordedData.selectors = selectors;
        console.log('  -> Seletores:');
        console.log(JSON.stringify(selectors, null, 2));
      } catch (e) {
        console.log(`  -> Erro: ${e.message}`);
      }
      continue;
    }

    if (trimmed === 'url') {
      console.log(`  -> URL atual: ${page.url()}`);
      continue;
    }

    if (trimmed === 'help') {
      console.log('Comandos disponiveis:');
      console.log('  dump       - Guardar snapshot do DOM');
      console.log('  screenshot - Guardar screenshot da pagina');
      console.log('  think      - Procurar botoes de thinking/reasoning');
      console.log('  selectors  - Extrair seletores CSS uteis');
      console.log('  url        - Mostrar URL atual');
      console.log('  help       - Mostrar esta ajuda');
      console.log('  feito      - Terminar gravacao e guardar tudo');
      continue;
    }

    if (trimmed === '') continue;

    console.log(`  Comando desconhecido. Escreve "help" para ver opcoes.`);
  }

  // Final dump
  console.log('\nA guardar dados finais...');
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(outputDir, 'final_dom.html'), html);
    recordedData.domDumps.push({ at: new Date().toISOString(), file: 'final_dom.html', url: page.url() });
  } catch (e) {
    recordedData.errors.push({ at: new Date().toISOString(), type: 'final-dom-dump', error: e.message });
  }

  try {
    await page.screenshot({ path: path.join(outputDir, 'final_screenshot.png'), fullPage: true });
  } catch (e) {
    recordedData.errors.push({ at: new Date().toISOString(), type: 'final-screenshot', error: e.message });
  }

  await browser.close();

  // Save summary
  const summary = {
    recordedAt: new Date().toISOString(),
    outputDir,
    summary: {
      urlsVisited: recordedData.urls.length,
      domDumps: recordedData.domDumps.length,
      thinkingButtonsFound: recordedData.thinkingButtons.length,
      errors: recordedData.errors.length
    },
    ...recordedData
  };

  fs.writeFileSync(path.join(outputDir, 'recording_summary.json'), JSON.stringify(summary, null, 2));

  // Update selectors.txt if we found new ones
  if (recordedData.selectors && Object.keys(recordedData.selectors).length > 0) {
    const selectorsPath = path.join('./meta_inspector', 'selectors.txt');
    const lines = [];
    lines.push(`# Updated: ${new Date().toISOString()}`);
    for (const [key, value] of Object.entries(recordedData.selectors)) {
      lines.push(`${key}=${value}`);
    }
    lines.push('');
    fs.writeFileSync(selectorsPath, lines.join('\n'));
    console.log(`Seletores atualizados em: ${selectorsPath}`);
  }

  console.log(`\n=== Gravacao terminada ===`);
  console.log(`Dados guardados em: ${outputDir}`);
  console.log(`Arquivos: ${fs.readdirSync(outputDir).join(', ')}`);

  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
