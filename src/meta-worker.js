const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');

const META_URL = process.env.META_URL || 'https://www.meta.ai/';

/**
 * Finds the Brave browser executable path by checking common installation locations.
 * Returns the first path that exists, or null if none found.
 */
function findBravePath() {
  const candidates = [
    // Brave Browser
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',

    // Google Chrome
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

    // Microsoft Edge
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const BROWSER_PATH = process.env.BROWSER_PATH || findBravePath();
const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LEGACY_HOME_PROFILE = path.join(os.homedir(), '.pw-brave-profile');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (fs.existsSync(LEGACY_HOME_PROFILE) ? LEGACY_HOME_PROFILE : path.join(MUSE_HOME, '.pw-brave-profile'));
const HEADLESS = String(process.env.META_HEADLESS || 'true').toLowerCase() !== 'false';
const USE_BRAVE_BINARY = String(process.env.META_USE_BRAVE || 'true').toLowerCase() !== 'false';
const SPOOF_BRAVE_UA = String(process.env.META_SPOOF_BRAVE || 'true').toLowerCase() !== 'false';
const STORAGE_STATE_FILE = process.env.META_STORAGE_STATE || path.join(MUSE_HOME, 'storage-state.json');
const BRAVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Brave/137.0.0.0';
const EXTRACTION_RULES = {
  minLen: 3,
  stablePolls: 3,  // Increased from 1 to 3 to avoid false positives
  pollMs: 180,
  quietMs: 220,
  minReadyMs: 200,
  blacklistContains: [
    'search for a command to run',
    'nova conversa',
    'new chat',
    'command palette',
    'copiar',
    'copy',
    'hoje',
    'ontem',
    'instantâneo',
    'instantaneo',
    'ask meta ai',
    '[conversation]',
    '[instruction]',
    'respond only as the assistant for the latest user turn',
    'system behavior:',
    'conversation so far:',
    'onde devemos comecar',
    'onde devemos começar',
    'where should we start',
    'responding with friendly greeting',
    'responding in portuguese',
    'respondendo em português'
  ],
  previewLikeContains: [
    'preview',
    'open link',
    'abrir link',
    'visit site',
    'visitar site',
    'learn more',
    'saiba mais'
  ]
};
const DEFAULT_RESPONSE_TIMEOUT_MS = Number(process.env.MUSE_RESPONSE_TIMEOUT_MS || 180000);
const DEFAULT_READINESS_TIMEOUT_MS = Number(process.env.MUSE_READINESS_TIMEOUT_MS || 15000);

function isUiStatusText(rawText) {
  const text = String(rawText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return true;
  if (text === 'checkpoint') return true;
  if (text.startsWith('perguntando sobre')) return true;
  if (text.startsWith('asking about')) return true;
  if (text.startsWith('responding with ')) return true;
  if (text.startsWith('responding in ')) return true;
  if (text.startsWith('respondendo com ')) return true;
  if (text.startsWith('respondendo em ')) return true;
  if (text.startsWith('inspecionando')) return true;
  if (text.startsWith('inspecting')) return true;
  if (text.startsWith('lendo arquivo')) return true;
  if (text.startsWith('lendo ')) return true;
  if (text.startsWith('reading file')) return true;
  if (text.startsWith('reading ')) return true;
  if (text.startsWith('criando site')) return true;
  if (text.startsWith('creating site')) return true;
  if (text.startsWith('criando app')) return true;
  if (text.startsWith('creating app')) return true;
  if (text.startsWith('analisando')) return true;
  if (text.startsWith('analyzing')) return true;
  if (text.startsWith('procurando')) return true;
  if (text.startsWith('searching')) return true;
  if (text.startsWith('listando')) return true;
  if (text.startsWith('listing')) return true;
  if (text === 'thinking' || text === 'a pensar') return true;
  return false;
}

function collapseRepeatedText(rawText) {
  const normalized = String(rawText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const dedupedLines = [];
    for (const line of lines) {
      if (!dedupedLines.length || dedupedLines[dedupedLines.length - 1] !== line) {
        dedupedLines.push(line);
      }
    }
    const joined = dedupedLines.join('\n').trim();
    if (joined && joined !== normalized) return joined;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 4 && words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(' ');
    const second = words.slice(half).join(' ');
    if (first === second) return first;
  }
  return normalized;
}

function loadSelectorsFromTxt() {
  const candidates = [
    process.env.MUSE_SELECTORS_FILE,
    path.join(MUSE_HOME, 'selectors.txt'),
    path.join(process.cwd(), 'meta_inspector', 'selectors.txt')
  ].filter(Boolean);
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return `${u.origin}${u.pathname}`.slice(0, 220);
  } catch {
    return String(rawUrl || '').slice(0, 220);
  }
}

class MetaWorker {
  constructor() {
    this.context = null;
    this.page = null;
    this.initialized = false;
    this.selectors = loadSelectorsFromTxt();
    this.sessions = new Map();
    this.boundPage = null;
    this.requestTrack = new Map();
    this.submitChain = Promise.resolve();
    this._debugEnabled = String(process.env.MUSE_DEBUG || '0') === '1';
    this.runtime = {
      phase: 'idle',
      phaseAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      busy: false,
      thinking: false,
      uiThinking: false,
      stopButtonVisible: false,
      inflightModelRequests: 0,
      totalModelRequests: 0,
      lastModelRequestAt: null,
      lastModelResponseAt: null,
      lastModelRequestUrl: null,
      lastSubmitAt: null,
      lastResponseAt: null,
      requestId: null,
      sessionId: null,
      pageUrl: null,
      lastError: null,
      timeline: []
    };
  }

  async submitPrompt(prompt, options = {}) {
    const run = async () => this._submitPromptCore(prompt, options);
    const task = this.submitChain.then(run, run);
    // Keep chain alive even if a request fails.
    this.submitChain = task.then(() => undefined, () => undefined);
    return task;
  }

  async probeReadiness(options = {}) {
    const run = async () => this._probeReadinessCore(options);
    const task = this.submitChain.then(run, run);
    this.submitChain = task.then(() => undefined, () => undefined);
    return task;
  }

  nowIso() {
    return new Date().toISOString();
  }

  _debugLog(msg) {
    if (this._debugEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[DEBUG] ${msg}`);
    }
  }

  pushTimeline(event, extra = {}) {
    const item = { at: this.nowIso(), event, ...extra };
    const prev = Array.isArray(this.runtime.timeline) ? this.runtime.timeline : [];
    this.runtime.timeline = [item, ...prev].slice(0, 40);
  }

  setRuntimeFields(extra = {}) {
    this.runtime = {
      ...this.runtime,
      ...extra,
      lastEventAt: this.nowIso()
    };
  }

  setPhase(phase, extra = {}) {
    const at = this.nowIso();
    const busyPhases = new Set(['init', 'preflight', 'submitting', 'waiting_response', 'thinking']);
    const busy = Object.prototype.hasOwnProperty.call(extra, 'busy')
      ? Boolean(extra.busy)
      : busyPhases.has(phase);
    this.runtime = {
      ...this.runtime,
      ...extra,
      phase,
      busy,
      phaseAt: at,
      lastEventAt: at
    };
    this.pushTimeline(`phase:${phase}`, {
      requestId: this.runtime.requestId || null,
      sessionId: this.runtime.sessionId || null,
      inflightModelRequests: this.runtime.inflightModelRequests || 0,
      thinking: Boolean(this.runtime.thinking)
    });
  }

  isLikelyModelRequest(req) {
    if (!req) return false;
    const kind = String(req.resourceType ? req.resourceType() : '').toLowerCase();
    if (!['fetch', 'xhr', 'eventsource', 'websocket'].includes(kind)) return false;
    const url = String(req.url ? req.url() : '').toLowerCase();
    const hostLooksRight =
      url.includes('meta.ai') ||
      url.includes('facebook.com') ||
      url.includes('fbcdn.net');
    if (!hostLooksRight) return false;
    if (kind === 'eventsource' || kind === 'websocket') return true;
    return /(graphql|chat|prompt|message|assistant|conversation|completion|stream|ask)/i.test(url);
  }

  updateThinkingFlag() {
    const thinking = Boolean(
      this.runtime.uiThinking ||
      this.runtime.stopButtonVisible ||
      (this.runtime.inflightModelRequests || 0) > 0
    );
    this.runtime.thinking = thinking;
    if (!thinking && this.runtime.phase === 'thinking') {
      this.setPhase('waiting_response');
    }
  }

  bindPageObservers() {
    if (!this.page || this.boundPage === this.page) return;
    this.boundPage = this.page;

    this.page.on('request', (req) => {
      const tracked = this.isLikelyModelRequest(req);
      this.requestTrack.set(req, {
        tracked,
        at: Date.now(),
        url: toSafeUrl(req.url ? req.url() : '')
      });
      if (!tracked) return;
      this.setRuntimeFields({
        inflightModelRequests: (this.runtime.inflightModelRequests || 0) + 1,
        totalModelRequests: (this.runtime.totalModelRequests || 0) + 1,
        lastModelRequestAt: this.nowIso(),
        lastModelRequestUrl: toSafeUrl(req.url ? req.url() : '')
      });
      this.updateThinkingFlag();
      if (this.runtime.phase === 'waiting_response' || this.runtime.phase === 'submitting') {
        this.setPhase('thinking');
      }
    });

    const onFinished = (req) => {
      const meta = this.requestTrack.get(req);
      if (meta) this.requestTrack.delete(req);
      if (!meta || !meta.tracked) return;
      this.setRuntimeFields({
        inflightModelRequests: Math.max(0, (this.runtime.inflightModelRequests || 0) - 1),
        lastModelResponseAt: this.nowIso()
      });
      this.updateThinkingFlag();
    };

    this.page.on('requestfinished', onFinished);
    this.page.on('requestfailed', onFinished);
  }

  // Wraps page.evaluate so navigation races don't crash a request. When the
  // page navigates mid-evaluate (e.g. home -> /prompt/uuid on submit), Chromium
  // destroys the execution context; we wait for the new document and retry once.
  async pageEval(...args) {
    try {
      return await this.page.evaluate(...args);
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (!/Execution context was destroyed|context or browser has been closed|frame was detached|because of a navigation/i.test(msg)) {
        throw err;
      }
      try {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 });
      } catch (_) { /* navigation may have already settled */ }
      await sleep(250);
      return this.page.evaluate(...args);
    }
  }

  // meta.ai is an SPA that often fires an immediate client redirect; waiting for
  // 'domcontentloaded' races with it and aborts (net::ERR_ABORTED). Navigate with
  // 'commit' (resolves once the response is committed), then let the DOM settle.
  async safeGoto(url, timeoutMs = 90000) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
        await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        return;
      } catch (err) {
        lastErr = err;
        if (!/ERR_ABORTED|net::ERR|because of a navigation/i.test(String((err && err.message) || ''))) throw err;
        await sleep(1000);
      }
    }
    throw lastErr;
  }

  async detectPageType() {
    return this.pageEval(() => {
      const url = location.href;
      const isChatPage = /\/prompt\//.test(url) || /\/chat\//.test(url);
      const hasAssistantMsg = !!document.querySelector(
        '[data-message-author-role="assistant"], [data-author="assistant"], [data-testid*="assistant-message"], [data-testid*="assistant"]'
      );
      const hasInput = !!document.querySelector('[data-lexical-editor="true"], textarea[data-testid="composer-input"], [contenteditable="true"]');
      const hasSuggestions = !!document.querySelector('.group\\/starter, [class*="starter"]');
      
      return {
        url,
        isChatPage,
        isHomePage: !isChatPage,
        hasAssistantMsg,
        hasInput,
        hasSuggestions,
        type: isChatPage ? 'chat' : (hasSuggestions ? 'home' : 'unknown')
      };
    });
  }

  async init() {
    if (this.initialized) return;
    this.setPhase('init', { busy: true, pageUrl: null, lastError: null });
    fs.mkdirSync(MUSE_HOME, { recursive: true });
    const baseOptions = {
      headless: HEADLESS,
      viewport: null,
      args: ['--start-maximized']
    };
    if (SPOOF_BRAVE_UA) {
      baseOptions.userAgent = BRAVE_UA;
    }

    const tryLaunch = async (useBravePath) => {
      const opts = { ...baseOptions };
      if (useBravePath) opts.executablePath = BROWSER_PATH;
      this.context = await chromium.launchPersistentContext(USER_DATA_DIR, opts);
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.bindPageObservers();
      await this.tryApplyStorageCookies();
      await this.safeGoto(META_URL, 90000);
      this.initialized = true;
      this.setPhase('ready', { busy: false, pageUrl: this.page.url() });
    };

    try {
      const canUseBrave = USE_BRAVE_BINARY && fs.existsSync(BROWSER_PATH);
      if (canUseBrave) {
        await tryLaunch(true);
      } else {
        await tryLaunch(false);
      }
    } catch (err) {
      // Fallback: if Brave headless/profile locking fails, use bundled Chromium.
      const msg = String(err && err.message ? err.message : err).toLowerCase();
      const shouldFallback =
        msg.includes('launchpersistentcontext') ||
        msg.includes('exitcode=21') ||
        msg.includes('target page, context or browser has been closed');
      if (!shouldFallback) throw err;
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
        this.page = null;
        this.initialized = false;
      }
      await tryLaunch(false);
    }
  }

  async reset() {
    try {
      if (this.context) {
        await this.context.close().catch(() => {});
      }
    } finally {
      this.context = null;
      this.page = null;
      this.boundPage = null;
      this.requestTrack.clear();
      this.initialized = false;
      this.setPhase('idle', {
        busy: false,
        thinking: false,
        uiThinking: false,
        stopButtonVisible: false,
        inflightModelRequests: 0,
        requestId: null,
        sessionId: null,
        pageUrl: null
      });
    }
  }

  async tryApplyStorageCookies() {
    try {
      if (!fs.existsSync(STORAGE_STATE_FILE)) return;
      const raw = fs.readFileSync(STORAGE_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.cookies) && parsed.cookies.length) {
        await this.context.addCookies(parsed.cookies);
      }
    } catch {
      // ignore cookie hydration errors
    }
  }

  async closeOtherPages() {
    try {
      if (!this.context || !this.page) return;
      const pages = this.context.pages();
      for (const p of pages) {
        if (p !== this.page && !p.isClosed()) {
          await p.close().catch(() => {});
        }
      }
    } catch {
      // Ignorar erros ao fechar abas
    }
  }

  async ensurePageReady() {
    if (!this.initialized) await this.init();
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.bindPageObservers();
      await this.safeGoto(META_URL, 90000);
    }
    await this.closeOtherPages();
    this.bindPageObservers();
    if (!this.page.url().includes('meta.ai')) {
      await this.safeGoto(META_URL, 90000);
    }
    this.setRuntimeFields({ pageUrl: this.page.url() });
  }

  async clickNewChatIfRequested(forceNew) {
    if (!forceNew) return;
    const candidates = [
      'button:has-text("Nova conversa")',
      'button:has-text("New chat")',
      '[aria-label*="Nova conversa"]',
      '[aria-label*="New chat"]'
    ];
    for (const selector of candidates) {
      const el = this.page.locator(selector).first();
      if (await el.count()) {
        try {
          await el.click({ timeout: 1500 });
          await sleep(800);
          return;
        } catch {
          // try next selector
        }
      }
    }
  }

  async selectorLooksUsable(selector, { requireInput = false } = {}) {
    if (!selector) return false;
    try {
      const loc = this.page.locator(selector).first();
      const count = await loc.count();
      if (!count) return false;
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) return false;
      if (!requireInput) return true;
      return await this.pageEval((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const isInput = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
        const isEditable = String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true' || el.isContentEditable;
        const roleTextbox = (el.getAttribute('role') || '').toLowerCase() === 'textbox';
        const canType = isInput || isEditable || roleTextbox;
        if (!canType) return false;
        const disabled = !!el.getAttribute('disabled') || !!el.getAttribute('aria-disabled');
        const readonly = !!el.getAttribute('readonly') || !!el.getAttribute('aria-readonly');
        return !disabled && !readonly;
      }, selector).catch(() => false);
    } catch {
      return false;
    }
  }

  async findInputElementSelector() {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      // Strategy 1: Lexical editor by attribute (most stable)
      const lexicalDiv = await this.page.locator('[data-lexical-editor="true"]').first();
      if (await lexicalDiv.count() && await lexicalDiv.isVisible().catch(() => false)) {
        this._inputIsLexical = true;
        return '[data-lexical-editor="true"]';
      }

      // Strategy 2: Textarea by data-testid
      const textarea = await this.page.locator('textarea[data-testid="composer-input"]').first();
      if (await textarea.count() && await textarea.isVisible().catch(() => false)) {
        this._inputIsLexical = false;
        return 'textarea[data-testid="composer-input"]';
      }

      // Strategy 3: Any contenteditable div
      const editable = await this.page.locator('[contenteditable="true"]').first();
      if (await editable.count() && await editable.isVisible().catch(() => false)) {
        this._inputIsLexical = true;
        return '[contenteditable="true"]';
      }

      await sleep(500);
    }
    return null;
  }

  async markBestInputAndGetSelector() {
    return this.pageEval(() => {
      const prev = document.querySelectorAll('[data-meta-input-target="1"]');
      prev.forEach((el) => el.removeAttribute('data-meta-input-target'));

      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      const candidates = Array.from(
        document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')
      ).filter(vis);

      if (!candidates.length) return false;

      candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const best = candidates[0];
      best.setAttribute('data-meta-input-target', '1');
      return true;
    });
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  saveSession(sessionId, data = {}) {
    if (!sessionId) return;
    const prev = this.sessions.get(sessionId) || {};
    this.sessions.set(sessionId, {
      sessionId,
      updatedAt: new Date().toISOString(),
      ...prev,
      ...data
    });
  }

  async restoreSessionIfNeeded(sessionId, sessionUrl) {
    if (!sessionId) return;
    const known = this.getSession(sessionId);
    const targetUrl = sessionUrl || (known && known.url);
    if (!targetUrl) return;
    if (this.page.url() !== targetUrl) {
      await this.safeGoto(targetUrl, 90000).catch(() => {});
      await sleep(1200);
    }
  }

  async detectBlockedState() {
    return this.pageEval(() => {
      const body = document.body;
      const text = body && typeof body.innerText === 'string' ? body.innerText.toLowerCase() : '';
      const hasLogin = text.includes('log in') || text.includes('iniciar sessão');
      const hasConsent = text.includes('welcome to meta ai') || text.includes('continuar') || text.includes('continue');
      const hasTextbox = !!document.querySelector('textarea,[role="textbox"],[contenteditable="true"]');
      return {
        hasLogin,
        hasConsent,
        hasTextbox,
        url: location.href
      };
    });
  }

  async probeUiThinking() {
    try {
      const ui = await this.pageEval(() => {
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        const hasStop = buttons.some((btn) => {
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          const txt = (btn.innerText || '').toLowerCase().trim();
          return aria.includes('stop') || aria.includes('parar') || txt === 'stop' || txt === 'parar';
        });

        const hasBusyNode = !!document.querySelector('[aria-busy="true"]');
        const hasSpinner = !!document.querySelector('svg[aria-label*="loading"], .loading, .spinner');
        return {
          stopButtonVisible: hasStop,
          uiThinking: hasStop || hasBusyNode || hasSpinner
        };
      });
      this.setRuntimeFields({
        stopButtonVisible: Boolean(ui.stopButtonVisible),
        uiThinking: Boolean(ui.uiThinking)
      });
      this.updateThinkingFlag();
      return ui;
    } catch {
      return { stopButtonVisible: false, uiThinking: false };
    }
  }

  async _submitPromptCore(prompt, { forceNewChat = false, sessionId = null, sessionUrl = null, timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS, alwaysFilePrompt = false, cancelRef = null } = {}) {
    const requestId = randomUUID().slice(0, 8);

    this.setPhase('preflight', {
      requestId,
      sessionId: sessionId || null,
      lastError: null,
      thinking: false,
      uiThinking: false,
      stopButtonVisible: false,
      inflightModelRequests: 0
    });

    try {
      const checkAborted = () => {
        if (cancelRef && cancelRef.aborted) {
          throw new Error('Request aborted by client connection close');
        }
      };

      // Initialize page FIRST (before any page access)
      await this.ensurePageReady();
      checkAborted();

      // NOW detect page type (page is guaranteed to exist)
      this._initialUrl = this.page.url();
      const pageInfo = await this.detectPageType();
      this._debugLog(`page_type: ${pageInfo.type} url=${(pageInfo.url || '').slice(0, 80)} chat=${pageInfo.isChatPage} assistant=${pageInfo.hasAssistantMsg} suggestions=${pageInfo.hasSuggestions}`);

      // Navigate according to session strategy.
      let restored = false;
      if (forceNewChat) {
        this._debugLog(`forceNewChat=true, navigating to home...`);
        await this.safeGoto(META_URL, 60000);
        await sleep(2000);
      } else {
        // Restore existing session if we have a saved URL
        await this.restoreSessionIfNeeded(sessionId, sessionUrl);
        // Re-check page type after restore (avoid stale pageInfo).
        const restoredInfo = await this.detectPageType();
        if (restoredInfo.isChatPage) {
          restored = true;
        } else {
          await this.clickNewChatIfRequested(true);
          await sleep(1000);
        }
      }

      // Re-detect page type after navigation
      const currentPageInfo = await this.detectPageType();
      this._debugLog(`page_after_nav: ${currentPageInfo.type} url=${(currentPageInfo.url || '').slice(0, 80)}`);
      
      this.setRuntimeFields({ pageUrl: this.page.url() });

      const promptText = (typeof prompt === 'object' && prompt.fullPrompt)
        ? (restored ? prompt.lastPrompt : prompt.fullPrompt)
        : prompt;

      // Stabilization: if we're on a chat page, wait for thinking to finish
      const currentPageInfo2 = await this.detectPageType();
      if (currentPageInfo2.isChatPage) {
        let waited = 0;
        while (waited < 5000) {
          checkAborted();
          const probe = await this.probeUiThinking();
          const thinking = probe.uiThinking || probe.stopButtonVisible || Number(this.runtime.inflightModelRequests || 0) > 0;
          if (!thinking) break;
          await sleep(500);
          waited += 500;
        }
        // eslint-disable-next-line no-console
        if (waited > 0) this._debugLog(`stabilization: waited ${waited}ms for thinking to settle`);
      }

      const earlyBlocked = await this.detectBlockedState();
      if ((earlyBlocked.hasLogin || earlyBlocked.hasConsent) && !earlyBlocked.hasTextbox) {
        throw new Error(
          'Sessao Meta AI nao pronta (login/consentimento em falta). Faz login uma vez no perfil atual e tenta novamente.'
        );
      }

      checkAborted();
      let inputSelector = await this.findInputElementSelector();
      if (!inputSelector && await this.markBestInputAndGetSelector()) {
        inputSelector = '[data-meta-input-target="1"]';
      }
      if (!inputSelector) {
        // Sometimes chat mounts late in headless mode. Retry once from home.
        await this.safeGoto(META_URL, 90000).catch(() => {});
        await sleep(1500);
        inputSelector = await this.findInputElementSelector();
        if (!inputSelector && await this.markBestInputAndGetSelector()) {
          inputSelector = '[data-meta-input-target="1"]';
        }
      }
      if (!inputSelector) {
        const blocked = await this.detectBlockedState();
        if (blocked.hasLogin || blocked.hasConsent || !blocked.hasTextbox) {
          throw new Error(
            'Sessao Meta AI nao pronta (login/consentimento em falta). Faz login uma vez no perfil atual e tenta novamente.'
          );
        }
        throw new Error(`Nao consegui encontrar o campo de input no meta.ai (url=${blocked.url || this.page.url()}).`);
      }

      const input = this.page.locator(inputSelector).first();
      const baselineSnapshot = await this.getConversationSnapshot(inputSelector);
      const baselineMsg = await this.getLastAssistantMessage();
      const baselineModelRequests = Number(this.runtime.totalModelRequests || 0);
      if (baselineMsg && baselineMsg.text && !baselineSnapshot.lastAssistantText) {
        baselineSnapshot.lastAssistantText = String(baselineMsg.text).trim();
      }

      const filePromptThreshold = Number(process.env.MUSE_FILE_PROMPT_THRESHOLD || 25000);
      let useFilePrompting = alwaysFilePrompt || promptText.length > filePromptThreshold;
      let tempFilePath = null;

      if (useFilePrompting) {
        this._debugLog(`Prompt is using file-prompting mode (always=${alwaysFilePrompt}, length=${promptText.length} chars).`);
        tempFilePath = path.join(os.tmpdir(), `client_prompt_${randomUUID().slice(0, 8)}.md`);
        try {
          checkAborted();
          fs.writeFileSync(tempFilePath, promptText, 'utf8');
          const fileInput = this.page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(tempFilePath);
          await sleep(2500);
        } catch (err) {
          this._debugLog(`Failed to upload file prompt: ${err.message}. Falling back to text prompt.`);
          useFilePrompting = false;
          try { fs.unlinkSync(tempFilePath); } catch (_) {}
          tempFilePath = null;
        }
      }

      const submittedPromptText = useFilePrompting
        ? "INSTRUCTIONS: Read the attached file. It contains your role, tools, and the task. Your ENTIRE reply must be tool_call XML blocks — nothing else. No planning, no describing, no greeting. First character of your reply must be '<'.\n\nINSTRUÇÕES: Lê o ficheiro anexado. Contém o teu papel, ferramentas e tarefa. A tua resposta COMPLETA deve ser blocos XML <tool_call> — nada mais. Sem planear, sem descrever. O primeiro carácter da tua resposta deve ser '<'."
        : promptText;

      checkAborted();
      this.setPhase('submitting', {
        requestId,
        sessionId: sessionId || null,
        pageUrl: this.page.url()
      });
      await this.setInputText(inputSelector, submittedPromptText, input);
      await this.ensurePromptSubmitted(inputSelector, submittedPromptText, baselineSnapshot, baselineModelRequests);

      if (useFilePrompting && tempFilePath) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (_) {}
      }

      // CONFIRM: prompt was actually sent
      await sleep(120);
      const postSendSnapshot = await this.getConversationSnapshot(inputSelector);
      // eslint-disable-next-line no-console
      console.log(
        `[DEBUG] post_send: url_changed=${postSendSnapshot.url !== baselineSnapshot.url}, input_empty=${!String(postSendSnapshot.inputText || '').trim()} user_count=${postSendSnapshot.userCount} assistant_count=${postSendSnapshot.assistantCount}`
      );

      // Wait for navigation to chat page (URL changes to /prompt/uuid)
      if (!String(postSendSnapshot.inputText || '').trim() && !/\/prompt\/|\/chat\//.test(String(postSendSnapshot.url || ''))) {
        // eslint-disable-next-line no-console
        console.log(`[DEBUG] waiting_for_navigation: input is empty, waiting for URL to change to /prompt/...`);
        try {
          await this.page.waitForURL(/\/prompt\//, { timeout: 15000 });
          this._debugLog(`navigation_complete: url=${this.page.url().slice(0, 80)}`);
        } catch (e) {
          // Already on a chat page from previous turn? That's OK.
          const alreadyChat = /\/prompt\//.test(this.page.url());
          this._debugLog(`navigation_timeout: still at ${this.page.url().slice(0, 80)} already_chat=${alreadyChat}`);
          if (!alreadyChat) {
            // Not on chat page — the submit likely failed. Try to recover.
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await sleep(2000);
          }
        }
      }

      this.setRuntimeFields({ lastSubmitAt: this.nowIso(), pageUrl: this.page.url() });
      await this.probeUiThinking();
      this.setPhase('waiting_response', {
        requestId,
        sessionId: sessionId || null,
        pageUrl: this.page.url()
      });

      // CONFIRM: we're on a chat page (not home)
      const isChatPage = await this.pageEval(() => {
        const hasAssistantMsg = !!document.querySelector(
          '[data-message-author-role="assistant"], [data-author="assistant"], [data-testid*="assistant-message"], [data-testid*="assistant"]'
        );
        const hasUserMsg = !!document.querySelector(
          '[data-message-author-role="user"], [data-message-author-role="human"], [data-author="user"], [data-author="human"], [data-testid*="user-message"], [data-testid*="human-message"], [data-testid*="user"]'
        );
        const chatUrl = /\/prompt\/|\/chat\//;
        return { hasAssistantMsg, hasUserMsg, isChatUrl: chatUrl.test(location.href) };
      });
      this._debugLog(`confirm_chat: ${JSON.stringify(isChatPage)}`);

      // FIX #4: Wait for user message to appear in DOM before polling
      // This prevents race condition where we start polling before the
      // submit was actually registered by Meta AI
      try {
        const promptHead = String(submittedPromptText || '').trim().slice(0, 40);
        if (promptHead.length > 5) {
          await this.page.waitForSelector(
            `[data-message-author-role="user"]`,
            { state: 'attached', timeout: 5000 }
          ).catch(async () => {
            // Fallback: check if any user message exists
            const hasUserMsg = await this.pageEval(() =>
              !!document.querySelector('[data-message-author-role="user"]')
            ).catch(() => false);
            if (!hasUserMsg) {
              this._debugLog('user_message_not_found_after_submit');
            }
          });
        }
      } catch (e) {
        this._debugLog(`user_message_wait_failed: ${e.message}`);
      }

      checkAborted();
      const response = await this.waitForAssistantResponse(submittedPromptText, { baselineSnapshot, baselineModelRequests }, timeoutMs, { cancelRef });
      const currentUrl = this.page.url();
      this.setPhase('response_ready', {
        busy: false,
        requestId,
        sessionId: sessionId || null,
        pageUrl: currentUrl,
        lastResponseAt: this.nowIso(),
        uiThinking: false,
        stopButtonVisible: false,
        thinking: false
      });
      if (sessionId) {
        this.saveSession(sessionId, { url: currentUrl });
      }
      return {
        text: response,
        meta: {
          url: this.page.url(),
          inputSelector,
          session: sessionId
            ? {
                id: sessionId,
                url: currentUrl
              }
            : null,
          runtime: this.getRuntimeStatus()
        }
      };
    } catch (error) {
      const errMsg = String(error && error.message ? error.message : error || 'unknown_error');
      this.setPhase('error', {
        busy: false,
        requestId,
        sessionId: sessionId || null,
        lastError: errMsg.slice(0, 220),
        pageUrl: this.page && !this.page.isClosed() ? this.page.url() : null
      });
      throw error;
    } finally {
      // FIX #3: Always clean up flags, even on error
      this.runtime.inflightModelRequests = 0;
      this.runtime.thinking = false;
      this.runtime.uiThinking = false;
      this.runtime.stopButtonVisible = false;
    }
  }

  async _probeReadinessCore({ timeoutMs = DEFAULT_READINESS_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    try {
      await Promise.race([
        (async () => {
          await this.ensurePageReady();
          await this.probeUiThinking().catch(() => ({ uiThinking: false, stopButtonVisible: false }));
        })(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Readiness timeout after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);

      const blocked = await this.detectBlockedState().catch(() => ({
        hasLogin: false,
        hasConsent: false,
        hasTextbox: false,
        url: this.page && !this.page.isClosed() ? this.page.url() : null
      }));
      const pageInfo = await this.detectPageType().catch(() => ({
        type: 'unknown',
        isChatPage: false,
        isHomePage: false,
        hasAssistantMsg: false,
        hasInput: false,
        hasSuggestions: false,
        url: this.page && !this.page.isClosed() ? this.page.url() : null
      }));
      const ready = Boolean(
        this.initialized &&
        !blocked.hasLogin &&
        !blocked.hasConsent &&
        (blocked.hasTextbox || pageInfo.hasInput)
      );

      return {
        ok: ready,
        ready,
        initialized: Boolean(this.initialized),
        blocked: {
          hasLogin: Boolean(blocked.hasLogin),
          hasConsent: Boolean(blocked.hasConsent),
          hasTextbox: Boolean(blocked.hasTextbox)
        },
        page: {
          type: pageInfo.type || 'unknown',
          url: pageInfo.url || (this.page && !this.page.isClosed() ? this.page.url() : null),
          isChatPage: Boolean(pageInfo.isChatPage),
          isHomePage: Boolean(pageInfo.isHomePage),
          hasInput: Boolean(pageInfo.hasInput),
          hasSuggestions: Boolean(pageInfo.hasSuggestions)
        },
        runtime: this.getRuntimeStatus(),
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      const message = String(error && error.message ? error.message : error || 'readiness_failed');
      this.setRuntimeFields({ lastError: message.slice(0, 220) });
      return {
        ok: false,
        ready: false,
        initialized: Boolean(this.initialized),
        blocked: null,
        page: {
          type: 'unknown',
          url: this.page && !this.page.isClosed() ? this.page.url() : null,
          isChatPage: false,
          isHomePage: false,
          hasInput: false,
          hasSuggestions: false
        },
        runtime: this.getRuntimeStatus(),
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: message
      };
    }
  }

  async tryClickSendButton() {
    const selectors = [
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Enviar"]',
      'button[aria-label="Send"]',
      'button[aria-label="Submit"]',
      'button:has-text("Enviar")',
      'button:has-text("Send")',
      'button[type="submit"]',
      '[data-testid*="send"]',
      '[role="button"][aria-label="Enviar"]',
      '[role="button"][aria-label="Send"]'
    ];

    for (const selector of selectors) {
      const loc = this.page.locator(selector).first();
      if (!await loc.count()) continue;
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;
      const disabled = await loc.isDisabled().catch(() => false);
      if (disabled) continue;
      try {
        await loc.click({ timeout: 2000 });
        return true;
      } catch {
        // try next selector
      }
    }

    return this.pageEval(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(vis);
      const sendLike = buttons.find((btn) => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const txt = (btn.innerText || '').toLowerCase();
        return aria.includes('enviar') || aria.includes('send') || txt === 'enviar' || txt === 'send';
      });
      if (!sendLike) return false;
      sendLike.click();
      return true;
    }).catch(() => false);
  }

  async copyLastResponse() {
    // Try to click a copy button close to the latest assistant message.
    const copied = await this.pageEval(async () => {
      const assistantNodes = Array.from(
        document.querySelectorAll('[data-message-author-role="assistant"], [data-author="assistant"], [data-testid*="assistant-message"]')
      );
      const byLabel = (root) => Array.from(root.querySelectorAll('button,[role="button"]')).filter((btn) => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const txt = (btn.innerText || '').toLowerCase();
        return aria.includes('copy') || aria.includes('copiar') || txt.includes('copy') || txt.includes('copiar');
      });

      let target = null;
      if (assistantNodes.length) {
        const lastAssistant = assistantNodes[assistantNodes.length - 1];
        const localCopy = byLabel(lastAssistant);
        if (localCopy.length) target = localCopy[localCopy.length - 1];
      }
      if (!target) {
        const globalCopy = byLabel(document);
        if (globalCopy.length) target = globalCopy[globalCopy.length - 1];
      }

      if (!target) return { ok: false, method: 'no-copy-btn' };
      target.click();
      await new Promise(r => setTimeout(r, 500));
      return { ok: true, method: 'copy-button-clicked' };
    });

    if (!copied.ok) return null;

    // Read from clipboard - try multiple methods
    try {
      const clipboardText = await this.pageEval(() => navigator.clipboard.readText());
      if (clipboardText && clipboardText.trim().length > 2 && !isUiStatusText(clipboardText)) {
        return { text: collapseRepeatedText(clipboardText.trim()), method: 'clipboard-direct' };
      }
    } catch (e) {
      // Clipboard API blocked
    }

    // Fallback: After clicking copy, Meta AI might show a toast "Copiado!"
    // The actual text might still be extractable from the page
    return null;
  }

  async extractLastAssistantFromDom() {
    return this.pageEval(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const collapseRepeatedTextLocal = (rawText) => {
        const normalized = String(rawText || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        if (!normalized) return '';
        const lines = normalized
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 1) {
          const dedupedLines = [];
          for (const line of lines) {
            if (!dedupedLines.length || dedupedLines[dedupedLines.length - 1] !== line) {
              dedupedLines.push(line);
            }
          }
          const joined = dedupedLines.join('\n').trim();
          if (joined && joined !== normalized) return joined;
        }
        const words = normalized.split(/\s+/).filter(Boolean);
        if (words.length >= 4 && words.length % 2 === 0) {
          const half = words.length / 2;
          const first = words.slice(0, half).join(' ');
          const second = words.slice(half).join(' ');
          if (first === second) return first;
        }
        return normalized;
      };
      const cleanupText = (raw) => {
        const text = String(raw || '').replace(/\u00a0/g, ' ').trim();
        if (!text) return '';
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !/^copiar resposta$/i.test(l))
          .filter((l) => !/^copy response$/i.test(l))
          .filter((l) => !/^copiar$/i.test(l))
          .filter((l) => !/^copy$/i.test(l))
          .filter((l) => !/^gosto$/i.test(l))
          .filter((l) => !/^like$/i.test(l))
          .filter((l) => !/^responding with /i.test(l))
          .filter((l) => !/^responding in /i.test(l))
          .filter((l) => !/^respondendo com /i.test(l))
          .filter((l) => !/^respondendo em /i.test(l))
          .filter((l) => !/^lendo arquivo/i.test(l))
          .filter((l) => !/^reading file/i.test(l))
          .filter((l) => !/^criando site/i.test(l))
          .filter((l) => !/^creating site/i.test(l))
          .filter((l) => !/^criando app/i.test(l))
          .filter((l) => !/^creating app/i.test(l));
        return lines.join('\n').trim();
      };
      const isUiStatus = (raw) => {
        const text = cleanupText(raw).replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text) return true;
        if (text === 'checkpoint') return true;
        if (text.startsWith('perguntando sobre')) return true;
        if (text.startsWith('asking about')) return true;
        if (text.startsWith('responding with ')) return true;
        if (text.startsWith('responding in ')) return true;
        if (text.startsWith('respondendo com ')) return true;
        if (text.startsWith('respondendo em ')) return true;
        if (text === 'thinking' || text === 'a pensar') return true;
        return false;
      };
      const collectMessageText = (node) => {
        const blocks = Array.from(
          node.querySelectorAll('p,li,pre,code,blockquote,h1,h2,h3,h4,h5,h6,div[dir="auto"]')
        )
          .filter((el) => isVisible(el))
          .map((el) => cleanupText(el.innerText || el.textContent || ''))
          .filter(Boolean)
          .filter((txt) => !isUiStatus(txt));
        const uniqueBlocks = Array.from(new Set(blocks));
        if (uniqueBlocks.length) {
          return collapseRepeatedTextLocal(uniqueBlocks.join('\n').trim());
        }
        return collapseRepeatedTextLocal(cleanupText(node.innerText || node.textContent || ''));
      };
      const hasActionButton = (node) => Array.from(node.querySelectorAll('button,[role="button"]')).some((btn) => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const txt = (btn.innerText || '').toLowerCase();
        return aria.includes('copy') || aria.includes('copiar') || aria.includes('like') || txt.includes('copy') || txt.includes('copiar');
      });

      let nodes = Array.from(
        (document.querySelector('main') || document).querySelectorAll('[data-message-author-role="assistant"], [data-author="assistant"], [data-testid*="assistant-message"]')
      );
      if (!nodes.length) {
        // Fallback: try data-role attribute (common in React apps)
        nodes = Array.from((document.querySelector('main') || document).querySelectorAll('[data-role="assistant"], [role="assistant"]'));
      }
      if (!nodes.length) {
        nodes = Array.from((document.querySelector('main') || document).querySelectorAll('article[data-testid*="message"], article'));
      }
      if (!nodes.length) {
        // Last resort: try to find messages by structure (div with assistant content)
        nodes = Array.from((document.querySelector('main') || document).querySelectorAll('div > div > div > div'))
          .filter(el => el.querySelector('p,li,pre,code') && !el.querySelector('input,textarea,button[type="submit"]'));
      }
      if (!nodes.length) return { text: '', method: 'assistant-not-found' };

      const visible = nodes
        .filter((n) => isVisible(n))
        .filter((n) => !n.closest('nav,aside,[role="navigation"],[data-testid*="sidebar"]'));
      if (!visible.length) return { text: '', method: 'assistant-empty' };

      const tail = visible.slice(-12);
      const candidates = tail
        .map((node, idx) => {
          const text = collectMessageText(node);
          const rect = node.getBoundingClientRect();
          return {
            node,
            idx,
            text,
            len: text.length,
            bottom: rect.bottom,
            hasActionButton: hasActionButton(node),
            hasStructuredContent: Boolean(node.querySelector('p,li,pre,code,blockquote,div[dir="auto"]'))
          };
        })
        .filter((c) => c.len >= 3)
        .filter((c) => !isUiStatus(c.text))
        .filter((c) => c.hasActionButton || c.hasStructuredContent || c.len >= 40);

      if (!candidates.length) return { text: '', method: 'assistant-empty' };

      const maxBottom = Math.max(...candidates.map((c) => Number(c.bottom || 0)));
      const latestZone = candidates.filter((c) => Number(c.bottom || 0) >= (maxBottom - 260));
      const pool = latestZone.length ? latestZone : candidates;

      pool.sort((a, b) => {
        if (Number(b.hasActionButton) !== Number(a.hasActionButton)) return Number(b.hasActionButton) - Number(a.hasActionButton);
        if (Number(b.hasStructuredContent) !== Number(a.hasStructuredContent)) return Number(b.hasStructuredContent) - Number(a.hasStructuredContent);
        if ((b.bottom || 0) !== (a.bottom || 0)) return (b.bottom || 0) - (a.bottom || 0);
        if (b.len !== a.len) return b.len - a.len;
        return b.idx - a.idx;
      });

      return { text: pool[0].text, method: 'assistant-dom' };
    }).catch((error) => ({
      text: '',
      method: `assistant-eval-failed:${String(error && error.message ? error.message : error).slice(0, 120)}`
    }));
  }

  async getLastAssistantMessage() {
    // PRIORITY 1: Direct DOM extraction from the latest assistant turn.
    const domResult = await this.extractLastAssistantFromDom();
    if (domResult && domResult.text) {
      return domResult;
    }

    // PRIORITY 2: Copy button fallback (can fail due clipboard permissions).
    const clipboardResult = await this.copyLastResponse();
    if (clipboardResult) {
      return clipboardResult;
    }

    return domResult || { text: '', method: 'assistant-not-found' };
  }

  async collectMainTextBlocks() {
    // Keep old method for baseline snapshot before sending
    return this.pageEval((rules) => {
      const root = document.querySelector('main') || document.body;
      if (!root) return [];
      const blacklistContains = rules.blacklistContains;
      const previewLikeContains = rules.previewLikeContains;
      const normalize = (s) => (s || '').trim().replace(/[ \t]+/g, ' ');
      const looksLikePreview = (text) => {
        const low = text.toLowerCase();
        const hasPreviewWord = previewLikeContains.some((w) => low.includes(w));
        const isShort = text.length <= 220;
        const urlCount = (text.match(/https?:\/\/|www\./gi) || []).length;
        return (hasPreviewWord && isShort) || (urlCount >= 1 && isShort && text.split(' ').length < 20);
      };
      const nodes = Array.from(root.querySelectorAll('p,li,article,div[dir="auto"],span,pre,code'))
        .map((n) => normalize(n && typeof n.innerText === 'string' ? n.innerText : ''))
        .filter((t) => t.length >= rules.minLen && t.length <= 4000)
        .filter((t) => !looksLikePreview(t))
        .filter((t) => {
          const low = t.toLowerCase();
          return !blacklistContains.some((b) => low.includes(b));
        });
      return Array.from(new Set(nodes));
    }, EXTRACTION_RULES);
  }

  async getConversationSnapshot(inputSelector = null) {
    const selector = inputSelector || '';
    return this.pageEval((sel) => {
      const collapseRepeatedTextLocal = (rawText) => {
        const normalized = String(rawText || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        if (!normalized) return '';
        const lines = normalized
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 1) {
          const dedupedLines = [];
          for (const line of lines) {
            if (!dedupedLines.length || dedupedLines[dedupedLines.length - 1] !== line) {
              dedupedLines.push(line);
            }
          }
          const joined = dedupedLines.join('\n').trim();
          if (joined && joined !== normalized) return joined;
        }
        const words = normalized.split(/\s+/).filter(Boolean);
        if (words.length >= 4 && words.length % 2 === 0) {
          const half = words.length / 2;
          const first = words.slice(0, half).join(' ');
          const second = words.slice(half).join(' ');
          if (first === second) return first;
        }
        return normalized;
      };
      const pickInputText = () => {
        const candidates = [];
        if (sel) candidates.push(document.querySelector(sel));
        candidates.push(document.querySelector('[data-lexical-editor="true"'));
        candidates.push(document.querySelector('textarea[data-testid="composer-input"'));
        candidates.push(document.querySelector('textarea'));
        candidates.push(document.querySelector('[contenteditable="true"'));
        for (const el of candidates) {
          if (!el) continue;
          if (typeof el.value === 'string') return el.value.trim();
          if (typeof el.innerText === 'string') return el.innerText.trim();
          if (typeof el.textContent === 'string') return el.textContent.trim();
        }
        return '';
      };
      
      const safeNormalizeText = (raw) => String(raw || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();

      const pickAssistantText = (nodes) => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const node = nodes[i];
          if (!node) continue;
          const txt = safeNormalizeText(node.innerText || node.textContent || '');
          if (!txt) continue;
          if (/^checkpoint$/i.test(txt)) continue;
          if (/^perguntando sobre/i.test(txt)) continue;
          if (/^asking about/i.test(txt)) continue;
          if (/^responding with /i.test(txt)) continue;
          if (/^responding in /i.test(txt)) continue;
          if (/^respondendo com /i.test(txt)) continue;
          if (/^respondendo em /i.test(txt)) continue;
          if (/^lendo arquivo/i.test(txt)) continue;
          if (/^reading file/i.test(txt)) continue;
          if (/^criando site/i.test(txt)) continue;
          if (/^creating site/i.test(txt)) continue;
          if (/^criando app/i.test(txt)) continue;
          if (/^creating app/i.test(txt)) continue;
          // Keep newlines but run the loop logic
          if (txt.length >= 3) return collapseRepeatedTextLocal(txt);
        }
        return '';
      };
      const pickUserText = (nodes) => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const node = nodes[i];
          if (!node) continue;
          const txt = safeNormalizeText(node.innerText || node.textContent || '');
          if (txt.length >= 1) return txt;
        }
        return '';
      };

      const userNodes = Array.from(
        document.querySelectorAll(
          '[data-message-author-role="user"], [data-message-author-role="human"], [data-author="user"], [data-author="human"], [data-testid*="user-message"], [data-testid*="human-message"], [data-testid*="user"]'
        )
      );
      const assistantNodes = Array.from(
        document.querySelectorAll(
          '[data-message-author-role="assistant"], [data-message-author-role="bot"], [data-author="assistant"], [data-author="bot"], [data-testid*="assistant-message"], [data-testid*="assistant"]'
        )
      );
      const url = location.href;
      const isChatPage = /\/prompt\/|\/chat\//.test(url);
      const hasSuggestions = !!document.querySelector('.group\\/starter, [class*="starter"]');

      return {
        url,
        isChatPage,
        hasSuggestions,
        userCount: userNodes.length,
        assistantCount: assistantNodes.length,
        inputText: pickInputText(),
        lastUserText: pickUserText(userNodes),
        lastAssistantText: pickAssistantText(assistantNodes)
      };
    }, selector).catch(() => ({
      url: this.page && !this.page.isClosed() ? this.page.url() : '',
      isChatPage: false,
      hasSuggestions: false,
      userCount: 0,
      assistantCount: 0,
      inputText: '',
      lastUserText: '',
      lastAssistantText: ''
    }));
  }

  async waitForAssistantResponse(userPrompt, baseline = {}, timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS, options = {}) {
    const started = Date.now();
    const promptNorm = String(userPrompt || '').trim().toLowerCase();
    let lastResponse = '';
    let stableCount = 0;
    let lastChangeAt = started;
    const baselineSnapshot = baseline && baseline.baselineSnapshot ? baseline.baselineSnapshot : {};
    const baselineModelRequests = Number(baseline && baseline.baselineModelRequests ? baseline.baselineModelRequests : 0);
    const baselineUserCount = Number(baselineSnapshot.userCount || 0);
    const baselineAssistantCount = Number(baselineSnapshot.assistantCount || 0);
    const baselineUserText = String(baselineSnapshot.lastUserText || '').trim();
    const baselineAssistantText = String(baselineSnapshot.lastAssistantText || '').trim();
    let sawModelActivity = false;
    let sawThinking = false;

    const isPromptEcho = (text) => {
      const t = String(text || '').trim().toLowerCase();
      if (!t) return false;
      if (t === promptNorm) return true;
      if (promptNorm && t.includes(promptNorm.slice(0, Math.min(140, promptNorm.length)))) return true;
      if (t.includes('[conversation]') || t.includes('[instruction]')) return true;
      if (t.includes('respond only as the assistant')) return true;
      if (t.includes('system behavior:') || t.includes('conversation so far:')) return true;
      if (t.includes('user:') && t.includes('assistant:') && t.length < 1200) return true;
      return false;
    };
    
    // BUG FIX #2: Detect duplicate/echo response from previous turn
    // Only flag as duplicate if the text is VERY similar (not just same topic)
    const isDuplicateFromPreviousTurn = (text) => {
      if (!text || !this._lastTurnResponse) return false;
      const normalized = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:]/g, '');
      const previousNormalized = String(this._lastTurnResponse || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:]/g, '');
      
      // Only flag if they are VERY similar (>85% match)
      if (normalized === previousNormalized) return true;
      
      // Check for near-exact match with minor whitespace differences
      const minLen = Math.min(normalized.length, previousNormalized.length);
      if (minLen > 10 && Math.abs(normalized.length - previousNormalized.length) < 5) {
        let matches = 0;
        for (let i = 0; i < minLen; i++) {
          if (normalized[i] === previousNormalized[i]) matches++;
        }
        const similarity = matches / minLen;
        if (similarity > 0.90) {
          this._debugLog(`potential_duplicate detected: similarity=${(similarity * 100).toFixed(1)}%`);
          return true;
        }
      }
      
      return false;
    };
    
    const looksLikeUiStatus = (text) => isUiStatusText(text);
    const looksIncompleteXml = (text) => {
      const t = String(text || '').trim();
      if (!t) return true;
      if (/<answer>/i.test(t) && !/<\/answer>/i.test(t)) return true;
      if (/<(read_file|ls_dir|get_dir_tree|search_pathnames_only|search_for_files|search_in_file|read_lint_errors|run_command|edit_file|create_file_or_folder|delete_file_or_folder)>/i.test(t)) {
        const closed = /<\/(read_file|ls_dir|get_dir_tree|search_pathnames_only|search_for_files|search_in_file|read_lint_errors|run_command|edit_file|create_file_or_folder|delete_file_or_folder)>/i.test(t);
        if (!closed) return true;
      }
      return false;
    };

    while (Date.now() - started < timeoutMs) {
      if (options.cancelRef && options.cancelRef.aborted) {
        throw new Error('Request aborted by client connection close');
      }
      await this.probeUiThinking();
      if (Number(this.runtime.totalModelRequests || 0) > baselineModelRequests) {
        sawModelActivity = true;
      }
      const thinkingNow = Boolean(
        this.runtime.uiThinking ||
        this.runtime.stopButtonVisible ||
        Number(this.runtime.inflightModelRequests || 0) > 0
      );
      if (thinkingNow) sawThinking = true;
      const snapshot = await this.getConversationSnapshot();
      const currentUrl = snapshot.url || (this.page && !this.page.isClosed() ? this.page.url() : '');

      // Ignore suggestion-only home state while waiting for real chat output.
      if (!snapshot.isChatPage && snapshot.hasSuggestions && snapshot.assistantCount <= baselineAssistantCount) {
        await sleep(EXTRACTION_RULES.pollMs);
        continue;
      }

      // Use rigorous extraction
      const msg = await this.getLastAssistantMessage();

      // Debug: dump page info when nothing found
      if (!msg.text && (Date.now() - started) % 5000 < EXTRACTION_RULES.pollMs) {
        this._debugLog(`extraction_failed: method=${msg.method} url=${currentUrl.slice(0, 120)} assistant_count=${snapshot.assistantCount} user_count=${snapshot.userCount}`);
      }

      this._debugLog(
        `poll: elapsed=${Date.now() - started}ms method=${msg.method} len=${(msg.text || '').length} stable=${stableCount} a_count=${snapshot.assistantCount} u_count=${snapshot.userCount} preview="${(msg.text || '').slice(0, 100).replace(/\n/g, ' ')}"`
      );

      const text = msg.text || '';
      const baselineSameText = Boolean(baselineAssistantText) && text.trim() === baselineAssistantText;
      const hasUserProgress = Number(snapshot.userCount || 0) > baselineUserCount;
      const hasUserTextProgress = Boolean(String(snapshot.lastUserText || '').trim()) &&
        String(snapshot.lastUserText || '').trim() !== baselineUserText;
      const hasAssistantCountProgress = Number(snapshot.assistantCount || 0) > baselineAssistantCount;
      const baselineHasAssistantText = Boolean(baselineAssistantText);
      const hasAssistantTextProgress = Boolean(text.trim()) && (
        (baselineHasAssistantText && !baselineSameText) ||
        (!baselineHasAssistantText && (
          hasAssistantCountProgress ||
          (sawThinking && sawModelActivity && (Date.now() - started) > 500)
        ))
      );
      const hasNewAssistantTurn = hasAssistantTextProgress ||
        (hasAssistantCountProgress && sawThinking && sawModelActivity);
      const modelLikelyAnsweredNow = sawModelActivity || thinkingNow;

      // Skip if echo, duplicate from previous turn, too short, or not ready
      if (!text || text.length < 3 || isPromptEcho(text) || isDuplicateFromPreviousTurn(text) || looksLikeUiStatus(text) || looksIncompleteXml(text) || !hasNewAssistantTurn || !modelLikelyAnsweredNow) {
        await sleep(EXTRACTION_RULES.pollMs);
        continue;
      }

      if (text === lastResponse) {
        stableCount += 1;
        this._debugLog(`response stable (${stableCount}/${EXTRACTION_RULES.stablePolls})`);
      } else {
        stableCount = 0;
        lastResponse = text;
        lastChangeAt = Date.now();
      }

      const now = Date.now();
      const thinkingNowLive = Boolean(
        this.runtime.thinking ||
        this.runtime.uiThinking ||
        this.runtime.stopButtonVisible ||
        Number(this.runtime.inflightModelRequests || 0) > 0
      );
      const quietEnough = (now - lastChangeAt) >= Number(EXTRACTION_RULES.quietMs || 200);
      const afterMinReady = (now - started) >= Number(EXTRACTION_RULES.minReadyMs || 150);

      // Fast-path: as soon as model stops streaming and content is quiet for a short moment.
      if (lastResponse && afterMinReady && quietEnough && !thinkingNowLive) {
        this.setRuntimeFields({
          lastResponseAt: this.nowIso(),
          uiThinking: false,
          stopButtonVisible: false,
          thinking: false
        });
        this._debugLog(`response finalized_fast: len=${lastResponse.length} method=${msg.method}`);
        return lastResponse;
      }

      if (lastResponse && stableCount >= EXTRACTION_RULES.stablePolls && afterMinReady) {
        this.setRuntimeFields({
          lastResponseAt: this.nowIso(),
          uiThinking: false,
          stopButtonVisible: false,
          thinking: false
        });
        this._debugLog(`response finalized_stable: len=${lastResponse.length} method=${msg.method}`);
        return lastResponse;
      }

      await sleep(EXTRACTION_RULES.pollMs);
    }

    if (!lastResponse) {
      throw new Error(`Timeout: sem resposta detectada no meta.ai em ${timeoutMs}ms.`);
    }
    
    // Save this turn's response for duplicate detection in the next turn
    this._lastTurnResponse = lastResponse;
    
    // BUG FIX #5: Clear thinking/inflight flags when response is ready
    this.runtime.inflightModelRequests = 0;
    this.runtime.thinking = false;
    this.runtime.uiThinking = false;
    this.runtime.stopButtonVisible = false;
    
    this._debugLog(`response returned (timeout): len=${lastResponse.length}`);
    return lastResponse;
  }

  async getInputText(inputSelector) {
    try {
      return await this.pageEval(() => {
        // Lexical editor
        const lexical = document.querySelector('[data-lexical-editor="true"]');
        if (lexical) return (lexical.innerText || '').trim();
        // Regular textarea
        const textarea = document.querySelector('textarea');
        if (textarea) return (textarea.value || '').trim();
        // Contenteditable
        const editable = document.querySelector('[contenteditable="true"]');
        if (editable) return (editable.innerText || '').trim();
        return '';
      });
    } catch {
      return '';
    }
  }

  async setInputText(inputSelector, prompt, inputLocator = null) {
    const text = String(prompt || '').replace(/\r\n/g, '\n');
    if (!text) return;

    const loc = inputLocator || this.page.locator(inputSelector).first();

    // FIX #1: Properly clear the lexical editor before writing
    // Triple-click to select all, then delete
    await loc.click({ timeout: 3000 }).catch(() => {});
    await sleep(200);
    
    // Triple-click to ensure full selection
    await loc.click({ clickCount: 3, timeout: 2000 }).catch(() => {});
    await sleep(200);
    
    // Delete selected content
    await this.page.keyboard.press('Backspace').catch(() => {});
    await sleep(150);
    
    // Extra safety: Ctrl+A then Backspace to ensure empty
    await this.page.keyboard.press('Control+a').catch(() => {});
    await sleep(100);
    await this.page.keyboard.press('Backspace').catch(() => {});
    await sleep(200);
    
    // Verify input is actually empty before writing
    const beforeText = await this.getInputText(inputSelector);
    if (beforeText && beforeText.trim().length > 0) {
      this._debugLog(`input_not_cleared_before_write: "${beforeText.slice(0, 80)}"`);
      // Force clear again
      await this.pageEval((sel) => {
        const editor = document.querySelector(sel) || 
                       document.querySelector('[data-lexical-editor="true"]') ||
                       document.querySelector('[contenteditable="true"]');
        if (editor) {
          editor.textContent = '';
          editor.innerText = '';
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, inputSelector).catch(() => {});
      await sleep(150);
    }

    // Write the whole prompt atomically so multiline system prompts do not
    // turn into multiple Enter submissions while being typed.
    await loc.focus().catch(() => {});
    await sleep(100);

    await this.page.keyboard.insertText(text).catch(async () => {
      this._debugLog('keyboard.insertText failed, trying DOM write fallback');
      await this.pageEval((sel, txt) => {
        const editor = document.querySelector(sel) ||
          document.querySelector('[data-lexical-editor="true"]') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('textarea');
        if (!editor) return false;

        if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
          editor.value = txt;
        } else {
          editor.textContent = txt;
          editor.innerText = txt;
        }

        editor.dispatchEvent(new Event('focus', { bubbles: true }));
        editor.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertFromPaste',
          data: txt,
          bubbles: true
        }));
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, inputSelector, text).catch(() => {});
    });

    await sleep(300);
    
    // FIX #3: Verify text was actually written
    let typed = await this.getInputText(inputSelector);
    const expectedLen = text.trim().length;
    const actualLen = (typed || '').trim().length;
    
    if (actualLen < Math.min(8, expectedLen)) {
      this._debugLog(`input_write_failed: expected=${expectedLen}, got=${actualLen}`);
      // Last resort: direct DOM write with paste-like events.
      await this.pageEval((sel, txt) => {
        const editor = document.querySelector(sel) ||
                       document.querySelector('[data-lexical-editor="true"]') ||
                       document.querySelector('[contenteditable="true"]') ||
                       document.querySelector('textarea');
        if (!editor) return false;

        if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
          editor.value = txt;
        } else {
          editor.textContent = txt;
          editor.innerText = txt;
        }

        const events = [
          new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: txt, bubbles: true }),
          new Event('focus', { bubbles: true }),
          new Event('input', { bubbles: true }),
          new Event('change', { bubbles: true }),
        ];
        events.forEach(e => editor.dispatchEvent(e));
        return true;
      }, inputSelector, text).catch(() => {});
      
      await sleep(250);
      typed = await this.getInputText(inputSelector);
      const retryLen = (typed || '').trim().length;
      this._debugLog(`input_retry: expected=${expectedLen}, got=${retryLen}`);
    }

    if (!typed || !typed.trim()) {
      throw new Error('Nao consegui escrever o prompt no input do Meta AI.');
    }
    
    this._debugLog(`input_written: len=${(typed || '').trim().length}/${expectedLen}`);
  }

  async waitForSubmitAck(_prompt, baselineSnapshot = null, inputSelector = null, baselineModelRequests = 0, timeoutMs = 2600) {
    const base = baselineSnapshot || {};
    const baselineUrl = String(base.url || '');
    const baselineUserCount = Number(base.userCount || 0);
    const baselineUserText = String(base.lastUserText || '').trim();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.getConversationSnapshot(inputSelector);
      const ui = await this.probeUiThinking();
      if (ui.uiThinking && this.runtime.phase !== 'thinking') {
        this.setPhase('thinking');
      }
      const currentUrl = String(snapshot.url || '');
      const urlProgress = Boolean(
        currentUrl &&
        currentUrl !== baselineUrl &&
        /\/prompt\/|\/chat\//.test(currentUrl)
      );
      const userTurnProgress = Number(snapshot.userCount || 0) > baselineUserCount;
      const userTextProgress = Boolean(String(snapshot.lastUserText || '').trim()) &&
        String(snapshot.lastUserText || '').trim() !== baselineUserText;
      const modelActivity = Number(this.runtime.totalModelRequests || 0) > Number(baselineModelRequests || 0);
      const thinkingProgress = Boolean(
        ui.uiThinking ||
        this.runtime.stopButtonVisible ||
        Number(this.runtime.inflightModelRequests || 0) > 0
      );
      const inputWasCleared = !String(snapshot.inputText || '').trim();
      const submitLikely = (
        urlProgress ||
        userTurnProgress ||
        userTextProgress ||
        (inputWasCleared && (thinkingProgress || modelActivity) && /\/prompt\/|\/chat\//.test(currentUrl))
      );
      if (submitLikely) {
        this.setRuntimeFields({
          lastSubmitAt: this.nowIso(),
          pageUrl: currentUrl || (this.page && !this.page.isClosed() ? this.page.url() : null)
        });
        return true;
      }
      await sleep(180);
    }
    return false;
  }

  async ensurePromptSubmitted(inputSelector, prompt = '', baselineSnapshot = null, baselineModelRequests = 0) {
    const attempts = [
      {
        name: 'send_button',
        run: async () => this.tryClickSendButton()
      },
      {
        name: 'enter',
        run: async () => {
          await this.page.keyboard.press('Enter').catch(() => {});
          return true;
        }
      },
      {
        name: 'double_enter',
        run: async () => {
          await this.page.keyboard.press('Enter').catch(() => {});
          await sleep(120);
          await this.page.keyboard.press('Enter').catch(() => {});
          return true;
        }
      },
      {
        name: 'send_button_retry',
        run: async () => this.tryClickSendButton()
      }
    ];

    let remaining = '';
    let failedCount = 0;
    for (const attempt of attempts) {
      // Recovery: if previous attempts failed, reload page to reset DOM state
      if (failedCount >= 2) {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(2000);
        // Re-find input after reload
        inputSelector = await this.findInputElementSelector() || inputSelector;
      }

      await attempt.run().catch(() => false);
      await sleep(350);
      const ack = await this.waitForSubmitAck(prompt, baselineSnapshot, inputSelector, baselineModelRequests, 3000);
      remaining = await this.getInputText(inputSelector);
      
      // FIX #4: Validate submit actually worked
      if (ack) {
        const rem = String(remaining || '').trim();
        if (!rem) {
          this._debugLog(`submit_ack_success: method=${attempt.name}`);
          return;
        }
        const promptHead = String(prompt || '').trim().slice(0, 80);
        const stillLooksLikePrompt = Boolean(promptHead) && rem.includes(promptHead.slice(0, 24));
        const thinking = Boolean(
          this.runtime.thinking ||
          this.runtime.uiThinking ||
          this.runtime.stopButtonVisible ||
          Number(this.runtime.inflightModelRequests || 0) > 0
        );
        // If input is NOT the prompt text AND thinking started, submit worked
        if (!stillLooksLikePrompt || thinking) {
          this._debugLog(`submit_ack_with_thinking: method=${attempt.name} thinking=${thinking}`);
          return;
        }
      }
      
      // Defensive fallback: input cleared plus active thinking signal.
      if (!String(remaining || '').trim()) {
        const thinking = Boolean(
          this.runtime.thinking ||
          this.runtime.uiThinking ||
          this.runtime.stopButtonVisible ||
          Number(this.runtime.inflightModelRequests || 0) > 0
        );
        if (thinking) return;
      }
      failedCount++;
      this._debugLog(`submit_attempt_failed: method=${attempt.name} remaining="${String(remaining || '').slice(0, 80)}"`);
    }

    this._debugLog(`submit_failed: remaining_text="${(remaining || '').slice(0, 80)}" url=${this.page.url()}`);
    throw new Error('Nao consegui submeter a mensagem no Meta AI (sem confirmacao de envio).');
  }

  getRuntimeStatus() {
    const livePageUrl = this.page && !this.page.isClosed() ? this.page.url() : this.runtime.pageUrl;
    const inflightModelRequests = Math.max(0, Number(this.runtime.inflightModelRequests || 0));
    const thinking = Boolean(
      this.runtime.thinking ||
      this.runtime.uiThinking ||
      this.runtime.stopButtonVisible ||
      inflightModelRequests > 0
    );
    return {
      ...this.runtime,
      pageUrl: livePageUrl || null,
      inflightModelRequests,
      thinking,
      timeline: Array.isArray(this.runtime.timeline) ? [...this.runtime.timeline] : []
    };
  }
}

const metaWorker = new MetaWorker();

function getMetaRuntimeConfig() {
  return {
    userDataDir: USER_DATA_DIR,
    headless: HEADLESS,
    useBraveBinary: USE_BRAVE_BINARY,
    browserPath: BROWSER_PATH
  };
}

function getMetaWorkerStatus() {
  return metaWorker.getRuntimeStatus();
}

module.exports = { metaWorker, getMetaRuntimeConfig, getMetaWorkerStatus };
