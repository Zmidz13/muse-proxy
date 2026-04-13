/**
 * bridge-browser-manager.js
 * 
 * Browser management para o modo bridge (start2):
 * - Abre novo separador
 * - Navega para chat existente OU meta.ai homepage
 * - Espera estar 100% funcional
 * - Fecha TODOS os outros separadores/janelas
 * - Mantem apenas o seu aberto
 */
const { chromium } = require('playwright');
const { sleep } = require('./bridge-utils');
const fs = require('fs');
const path = require('path');
const os = require('os');

const META_URL = process.env.META_URL || 'https://www.meta.ai/';

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
const HEADLESS = String(process.env.META_HEADLESS || 'true').toLowerCase() !== 'false';
const USE_BRAVE_BINARY = String(process.env.META_USE_BRAVE || 'true').toLowerCase() !== 'false';
const SPOOF_BRAVE_UA = String(process.env.META_SPOOF_BRAVE || 'true').toLowerCase() !== 'false';

const BRAVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Brave/137.0.0.0';

class BridgeBrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentChatUrl = null;
    this.currentSessionId = null;
    this._ready = false;
  }

  /**
   * Inicializa o browser (na primeira vez).
   */
  async init() {
    if (this.browser) return;

    const launchOptions = {
      headless: HEADLESS,
      timeout: 90000
    };

    if (USE_BRAVE_BINARY) {
      launchOptions.channel = 'brave';
      launchOptions.executablePath = BROWSER_PATH;
    }

    try {
      this.browser = await chromium.launch(launchOptions);
    } catch (err) {
      // Fallback para chromium normal
      this.browser = await chromium.launch({ headless: HEADLESS });
    }

    const contextOptions = {
      userAgent: SPOOF_BRAVE_UA ? BRAVE_UA : undefined,
      viewport: { width: 1280, height: 720 }
    };

    // Tenta carregar cookies de sessao anterior
    const storageState = this._loadStorageState();
    if (storageState) {
      contextOptions.storageState = storageState;
    }

    this.context = await this.browser.newContext(contextOptions);
    this._ready = false;
  }

  /**
   * Abre um novo separador e navega para o URL adequado.
   * Se chatUrl existe → abre esse chat.
   * Se nao → abre meta.ai homepage (novo chat).
   * 
   * ANTES de fechar outros separadores → espera o seu estar funcional.
   * DEPOIS → fecha TODOS os outros.
   */
  async openSession({ chatUrl, sessionId } = {}) {
    if (!this.browser) await this.init();

    // Passo 1: Abre novo separador
    const newPage = await this.context.newPage();

    // Passo 2: Navega para o URL adequado
    const targetUrl = chatUrl || META_URL;
    await newPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Passo 3: Espera estar funcional (input visivel)
    await this._waitForPageReady(newPage);

    // Passo 4: Agora que o nosso separador esta pronto, fecha TODOS os outros
    await this._closeOtherPages(newPage);

    // Passo 5: Atualiza estado
    this.page = newPage;
    this.currentChatUrl = newPage.url();
    this.currentSessionId = sessionId || null;
    this._ready = true;

    // eslint-disable-next-line no-console
    console.log(`[BRIDGE] Browser ready: ${this.currentChatUrl.slice(0, 100)}`);

    return this.currentChatUrl;
  }

  /**
   * Reabre um chat existente (quando voltas a um workspace).
   */
  async reopenChat(chatUrl) {
    if (!chatUrl) {
      return this.openSession({ chatUrl: META_URL });
    }
    return this.openSession({ chatUrl });
  }

  /**
   * Cria um NOVO chat (quando deteta compactação).
   */
  async createNewChat() {
    return this.openSession({ chatUrl: META_URL });
  }

  /**
   * Envia um prompt para o Meta.ai.
   */
  async submitPrompt(text, options = {}) {
    if (!this.page || !this._ready) {
      throw new Error('Browser not ready');
    }

    const timeout = options.timeoutMs || 35000;

    // Encontra o input field
    const inputSelector = await this._findInputSelector();
    if (!inputSelector) {
      throw new Error('Nao consegui encontrar o campo de input no meta.ai');
    }

    const input = this.page.locator(inputSelector).first();

    // Preenche o texto
    await this._setInputText(inputSelector, text);

    // Submete
    await this._ensurePromptSubmitted(inputSelector, text);

    // Espera resposta
    const response = await this._waitForResponse(timeout);

    // Atualiza o chat URL (pode ter mudado para /prompt/uuid)
    this.currentChatUrl = this.page.url();

    return {
      text: response,
      url: this.currentChatUrl
    };
  }

  /**
   * Fecha o browser completamente.
   */
  async close() {
    try {
      if (this.context) {
        await this._saveStorageState().catch(() => {});
        await this.context.close().catch(() => {});
      }
    } finally {
      this.context = null;
      this.page = null;
      this.browser = null;
      this._ready = false;
      this.currentChatUrl = null;
      this.currentSessionId = null;
    }
  }

  /**
   * Retorna o estado atual.
   */
  getStatus() {
    return {
      ready: this._ready,
      url: this.currentChatUrl,
      sessionId: this.currentSessionId
    };
  }

  // ─── Métodos privados ───

  /**
   * Espera a pagina estar pronta (input visivel).
   */
  async _waitForPageReady(page) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        // Verifica se ha um input field visivel
        const hasInput = await page.evaluate(() => {
          const selectors = [
            '[data-lexical-editor="true"]',
            'textarea[data-testid="composer-input"]',
            '[contenteditable="true"]'
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return true;
          }
          return false;
        });

        if (hasInput) {
          // eslint-disable-next-line no-console
          console.log(`[BRIDGE] Page ready: ${page.url().slice(0, 100)}`);
          return;
        }
      } catch {
        // ignore
      }
      await sleep(500);
    }
    // eslint-disable-next-line no-console
    console.log(`[BRIDGE] Page loaded (input may be late): ${page.url().slice(0, 100)}`);
  }

  /**
   * Fecha TODOS os outros separadores, mantendo apenas o nosso.
   */
  async _closeOtherPages(keepPage) {
    try {
      const pages = this.context.pages();
      for (const p of pages) {
        if (p !== keepPage && !p.isClosed()) {
          await p.close().catch(() => {});
        }
      }
    } catch {
      // Ignorar erros ao fechar
    }
  }

  /**
   * Encontra o selector do input field.
   */
  async _findInputSelector() {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      // Strategy 1: Lexical editor
      const lexical = this.page.locator('[data-lexical-editor="true"]').first();
      if (await lexical.count() && await lexical.isVisible().catch(() => false)) {
        return '[data-lexical-editor="true"]';
      }

      // Strategy 2: Textarea
      const textarea = this.page.locator('textarea[data-testid="composer-input"]').first();
      if (await textarea.count() && await textarea.isVisible().catch(() => false)) {
        return 'textarea[data-testid="composer-input"]';
      }

      // Strategy 3: Contenteditable
      const editable = this.page.locator('[contenteditable="true"]').first();
      if (await editable.count() && await editable.isVisible().catch(() => false)) {
        return '[contenteditable="true"]';
      }

      await sleep(500);
    }
    return null;
  }

  /**
   * Preenche o texto no input field.
   */
  async _setInputText(selector, text) {
    if (selector === '[data-lexical-editor="true"]' || selector === '[contenteditable="true"]') {
      // Contenteditable: usa fill via JavaScript
      await this.page.evaluate((sel, txt) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.focus();
        el.innerHTML = '';
        document.execCommand('insertText', false, txt);
      }, selector, text);
    } else {
      // Textarea normal
      await this.page.locator(selector).fill(text);
    }
  }

  /**
   * Submete o prompt (clica no botao Send).
   */
  async _ensurePromptSubmitted(selector, text) {
    // Tenta Enter ou botao Send
    try {
      if (selector === '[data-lexical-editor="true"]' || selector === '[contenteditable="true"]') {
        // Lexical: usa JavaScript para simular envio
        await this.page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"], button[aria-label*="Send"], button:has-text("Send")');
          if (btn) btn.click();
        });
        await sleep(300);
      } else {
        await this.page.locator(selector).press('Enter');
      }
    } catch {
      // Fallback: tenta clicar no botao Send
      try {
        const sendBtn = this.page.locator('button[type="submit"]').first();
        if (await sendBtn.count()) await sendBtn.click();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Espera pela resposta do Meta.ai.
   */
  async _waitForResponse(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    // Espera o "thinking" aparecer e desaparecer
    let thinkingDetected = false;
    while (Date.now() < deadline) {
      const thinking = await this.page.evaluate(() => {
        return !!document.querySelector('[data-message-author-role="assistant"]');
      });

      if (thinking) {
        thinkingDetected = true;
        // Espera um pouco para a resposta completar
        await sleep(2000);
        break;
      }
      await sleep(500);
    }

    // Extrai a resposta
    const text = await this._extractResponse();
    return text || '';
  }

  /**
   * Extrai a resposta do Meta.ai do DOM.
   */
  async _extractResponse() {
    try {
      return await this.page.evaluate(() => {
        const selectors = [
          '[data-message-author-role="assistant"]',
          '[data-author="assistant"]',
          '[data-testid*="assistant-message"]'
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            return el.textContent || el.innerText || '';
          }
        }
        return '';
      });
    } catch {
      return '';
    }
  }

  /**
   * Tenta carregar o estado de storage (cookies).
   */
  _loadStorageState() {
    try {
      const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
      const stateFile = path.join(MUSE_HOME, 'storage-state.json');
      if (fs.existsSync(stateFile)) {
        return stateFile;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Salva o estado de storage (cookies) para reutilizacao.
   */
  async _saveStorageState() {
    try {
      if (!this.context) return;
      const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
      const stateFile = path.join(MUSE_HOME, 'storage-state.json');
      const state = await this.context.storageState();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }
}

// Singleton
const bridgeBrowserManager = new BridgeBrowserManager();

module.exports = { BridgeBrowserManager, bridgeBrowserManager };
