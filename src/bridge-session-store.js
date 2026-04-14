/**
 * bridge-session-store.js
 * 
 * Persiste o mapeamento entre sessões do OpenClaude e chats do Meta.ai.
 * Formato: ~/.musespark/bridge-sessions.json
 * 
 * {
 *   "sessions": {
 *     "uuid-session-id": {
 *       "sessionId": "uuid-session-id",
 *       "workspacePath": "~/Desktop/projeto",
 *       "chatUrl": "https://www.meta.ai/chat/abc-123",
 *       "lastUsed": "2026-04-12T15:30:00Z",
 *       "createdAt": "2026-04-10T09:00:00Z",
 *       "isCompacted": false,
 *       "compactionCount": 0,
 *       "clientType": "openclaude"  // or "void" — additive field, may be absent on old records
 *     }
 *   }
 * }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const BRIDGE_SESSIONS_FILE = path.join(MUSE_HOME, 'bridge-sessions.json');

function ensureStoreFile() {
  if (!fs.existsSync(BRIDGE_SESSIONS_FILE)) {
    fs.mkdirSync(MUSE_HOME, { recursive: true });
    fs.writeFileSync(BRIDGE_SESSIONS_FILE, JSON.stringify({ sessions: {} }, null, 2), 'utf8');
  }
}

function loadStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(BRIDGE_SESSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { sessions: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(MUSE_HOME, { recursive: true });
  fs.writeFileSync(BRIDGE_SESSIONS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function truncateText(value, maxLen = 400) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function normalizeHistoryEntry(entry, fallback = {}) {
  const toolCalls = Array.isArray(entry.toolCalls)
    ? entry.toolCalls
        .map((tool) => {
          if (!tool) return null;
          if (typeof tool === 'string') return { name: tool };
          return {
            name: tool.name || 'unknown',
            toolCallId: tool.toolCallId || null,
            argumentsPreview: truncateText(tool.argumentsPreview || tool.arguments || '', 200)
          };
        })
        .filter(Boolean)
    : [];

  const toolResults = Array.isArray(entry.toolResults)
    ? entry.toolResults
        .map((tool) => {
          if (!tool) return null;
          return {
            toolName: tool.toolName || 'unknown',
            status: tool.status || 'UNKNOWN',
            toolCallId: tool.toolCallId || null,
            outputPreview: truncateText(tool.outputPreview || tool.output || '', 240)
          };
        })
        .filter(Boolean)
    : [];

  return {
    at: entry.at || fallback.at || new Date().toISOString(),
    kind: entry.kind || fallback.kind || 'turn',
    clientType: entry.clientType || fallback.clientType || null,
    promptKind: entry.promptKind || fallback.promptKind || null,
    chatUrl: entry.chatUrl || fallback.chatUrl || null,
    isCompacted: !!entry.isCompacted,
    usedTools: Boolean(entry.usedTools || toolCalls.length || toolResults.length),
    requestMessageCount: Number.isFinite(entry.requestMessageCount) ? entry.requestMessageCount : null,
    userQueryPreview: truncateText(entry.userQueryPreview || entry.userQuery || '', 240),
    responsePreview: truncateText(entry.responsePreview || entry.responseText || '', 240),
    error: entry.error ? truncateText(entry.error, 240) : null,
    toolCalls,
    toolResults
  };
}

function normalizeSession(session) {
  const history = Array.isArray(session.history) ? session.history : [];
  const normalizedHistory = history.map((entry) => normalizeHistoryEntry(entry, {
    chatUrl: session.chatUrl,
    clientType: session.clientType
  }));
  const lastEntry = normalizedHistory[normalizedHistory.length - 1] || null;

  return {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    chatUrl: session.chatUrl,
    lastUsed: session.lastUsed,
    createdAt: session.createdAt,
    isCompacted: !!session.isCompacted,
    compactionCount: session.compactionCount || 0,
    clientType: session.clientType || null,
    historyCount: normalizedHistory.length,
    lastAction: lastEntry
      ? {
          at: lastEntry.at,
          kind: lastEntry.kind,
          promptKind: lastEntry.promptKind,
          usedTools: lastEntry.usedTools,
          toolCalls: lastEntry.toolCalls.map((tool) => tool.name),
          toolResults: lastEntry.toolResults.map((tool) => ({
            toolName: tool.toolName,
            status: tool.status
          }))
        }
      : null,
    history: normalizedHistory
  };
}

/**
 * Encontra uma sessão existente pelo session_id do OpenClaude.
 */
function findBySessionId(sessionId) {
  if (!sessionId) return null;
  const store = loadStore();
  const session = store.sessions[sessionId];
  return session ? normalizeSession(session) : null;
}

/**
 * Encontra uma sessão existente pelo workspace path.
 * Útil quando o session_id mudou mas o workspace é o mesmo.
 */
function findByWorkspace(workspacePath) {
  if (!workspacePath) return null;
  const store = loadStore();
  const normalized = workspacePath.replace(/\//g, '\\').toLowerCase().trim();
  for (const [, session] of Object.entries(store.sessions)) {
    const sessWorkspace = (session.workspacePath || '').replace(/\//g, '\\').toLowerCase().trim();
    if (sessWorkspace === normalized) return normalizeSession(session);
  }
  return null;
}

/**
 * Cria ou atualiza uma sessão.
 *
 * @param {Object} opts
 * @param {string}  opts.sessionId
 * @param {string}  [opts.workspacePath]
 * @param {string}  [opts.chatUrl]
 * @param {boolean} [opts.isCompacted=false]
 * @param {'openclaude'|'void'} [opts.clientType]  additive — stored but never breaks old records
 * @param {Object} [opts.historyEvent]  rich audit entry appended to history
 */
function upsertSession({ sessionId, workspacePath, chatUrl, isCompacted = false, clientType, historyEvent = null }) {
  const store = loadStore();
  const now = new Date().toISOString();

  if (!store.sessions[sessionId]) {
    store.sessions[sessionId] = {
      sessionId,
      workspacePath: workspacePath || null,
      chatUrl: chatUrl || null,
      createdAt: now,
      lastUsed: now,
      isCompacted: false,
      compactionCount: 0,
      clientType: clientType || null,
      history: []
    };
  }

  const entry = store.sessions[sessionId];
  entry.lastUsed = now;
  if (workspacePath) entry.workspacePath = workspacePath;
  if (chatUrl) entry.chatUrl = chatUrl;
  // clientType is only set once (on creation) unless explicitly updated
  if (clientType && !entry.clientType) entry.clientType = clientType;
  if (isCompacted) {
    entry.isCompacted = true;
    entry.compactionCount = (entry.compactionCount || 0) + 1;
  }

  // Mantém histórico limitado (últimas 20 entradas)
  if (!entry.history) entry.history = [];
  entry.history.push(normalizeHistoryEntry(historyEvent || {}, {
    at: now,
    chatUrl: chatUrl || entry.chatUrl,
    clientType: clientType || entry.clientType,
    kind: 'turn',
    isCompacted
  }));
  if (entry.history.length > 20) entry.history = entry.history.slice(-20);

  saveStore(store);
  return normalizeSession(entry);
}

/**
 * Remove uma sessão.
 */
function removeSession(sessionId) {
  const store = loadStore();
  if (store.sessions[sessionId]) {
    delete store.sessions[sessionId];
    saveStore(store);
    return true;
  }
  return false;
}

/**
 * Lista todas as sessões.
 */
function listSessions() {
  const store = loadStore();
  return Object.values(store.sessions).map((session) => {
    const normalized = normalizeSession(session);
    return {
      sessionId: normalized.sessionId,
      workspacePath: normalized.workspacePath,
      chatUrl: normalized.chatUrl,
      lastUsed: normalized.lastUsed,
      createdAt: normalized.createdAt,
      isCompacted: normalized.isCompacted,
      compactionCount: normalized.compactionCount,
      clientType: normalized.clientType,
      historyCount: normalized.historyCount,
      lastAction: normalized.lastAction
    };
  });
}

function getSessionDetails(sessionId) {
  if (!sessionId) return null;
  const store = loadStore();
  const session = store.sessions[sessionId];
  return session ? normalizeSession(session) : null;
}

/**
 * Limpa sessões antigas (não usadas há mais de N dias).
 */
function cleanupExpiredSessions(maxAgeDays = 30) {
  const store = loadStore();
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  for (const [id, session] of Object.entries(store.sessions)) {
    const lastUsed = new Date(session.lastUsed).getTime();
    if (lastUsed < cutoff) {
      delete store.sessions[id];
      cleaned++;
    }
  }
  if (cleaned > 0) saveStore(store);
  return cleaned;
}

module.exports = {
  findBySessionId,
  findByWorkspace,
  upsertSession,
  removeSession,
  listSessions,
  getSessionDetails,
  cleanupExpiredSessions,
  getStoreFilePath: () => BRIDGE_SESSIONS_FILE
};
