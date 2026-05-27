/**
 * OpenAI-compatible gateway server.
 *
 * Powers the `start`, `start1` and `startvoid` CLI commands. Exposes
 * /v1/chat/completions (streaming + non-streaming) and /v1/models, drives
 * Meta AI through meta-worker.js, and either executes tools locally
 * (agentic mode) or forwards them to the client (Void IDE mode).
 */
const express = require('express');
const { randomUUID, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { metaWorker, getMetaRuntimeConfig, getMetaWorkerStatus } = require('./meta-worker');
const { listKeys, validateApiKey, touchKeyUsage } = require('./key-store');
const { version: APP_VERSION } = require('../package.json');
const { RAW_AGENT_SYSTEM } = require('./system-prompt');
const { parseToolCallXML, extractToolCallsXML, executeToolCall, hasToolCall } = require('./action-runner');
const { rotatePromptLogs, getPromptLogDir } = require('./log-utils');
const {
  runVoidBridgeLoop,
  continueVoidBridgeLoop,
  formatToolResultForMetaAI,
  hasToolCall: hasJSONToolCall,
  parseAllToolCalls,
  toOpenAIToolCall
} = require('./void-protocol-handler');
const { getVoidToolsDefinitions } = require('./void-tools-schema');

const MODEL_NAME = 'gpt-4o';
const MAX_LOGS = 300;
const WORKER_TIMEOUT_MS = Number(process.env.MUSE_WORKER_TIMEOUT_MS || 25000);
const WORKER_COLD_TIMEOUT_MS = Number(process.env.MUSE_WORKER_COLD_TIMEOUT_MS || 90000);
const WORKER_READINESS_TIMEOUT_MS = Number(process.env.MUSE_READINESS_TIMEOUT_MS || 15000);
const GATEWAY_MAX_RETRIES = Math.max(0, Number(process.env.MUSE_GATEWAY_MAX_RETRIES || 1));
const WARMUP_ON_START = String(process.env.MUSE_WARMUP_ON_START || 'true').toLowerCase() !== 'false';
const RECENT_CACHE_MS = Math.max(0, Number(process.env.MUSE_RECENT_CACHE_MS || 0));
const RECENT_CACHE_ENABLED = RECENT_CACHE_MS > 0;
const PROMPT_MODE = String(process.env.MUSE_PROMPT_MODE || 'compact_context').toLowerCase();
const PROMPT_DEBUG = String(process.env.MUSE_DEBUG_PROMPT || '0') === '1';
const META_PROMPT_LOG_ENABLED = String(process.env.MUSE_LOG_META_PROMPTS || '1') !== '0';
const META_PROMPT_LOG_DIR = getPromptLogDir();
const CLIENT_PAYLOAD_LOG_ENABLED = String(process.env.MUSE_LOG_CLIENT_PAYLOADS || '0') === '1';

function normalizeToolExecutionMode(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'void' || value === 'void-bridge') return 'void';
  if (value === 'ide' || value === 'ide-pass-through' || value === 'bridge' || value === 'ide-bridge') return 'ide';
  if (value === 'auto') return 'auto';
  return 'local';
}

/**
 * Read tool execution mode lazily — CLI may set MUSE_TOOL_EXECUTION_MODE
 * AFTER this module is loaded (require happens before env var is set).
 * ALWAYS reads from process.env fresh to catch CLI overrides.
 */
function getDefaultToolExecutionMode() {
  return normalizeToolExecutionMode(String(process.env.MUSE_TOOL_EXECUTION_MODE || 'local').toLowerCase());
}

// Cached at startup for banner display; code paths use getDefaultToolExecutionMode() for freshness
const DEFAULT_TOOL_EXECUTION_MODE = getDefaultToolExecutionMode();

function writeMetaPromptLog(kind, payload) {
  if (!META_PROMPT_LOG_ENABLED) return;
  try {
    fs.mkdirSync(META_PROMPT_LOG_DIR, { recursive: true });
    const id = randomUUID().slice(0, 8);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(META_PROMPT_LOG_DIR, `${stamp}_${kind}_${id}.log.txt`);
    const body = String(payload || '');
    fs.writeFileSync(file, body, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[PROMPT_LOG] ${kind} ${file}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[PROMPT_LOG] failed: ${String(err && err.message ? err.message : err)}`);
  }
}

function writeClientPayloadLog(kind, payload) {
  if (!CLIENT_PAYLOAD_LOG_ENABLED) return;
  try {
    fs.mkdirSync(META_PROMPT_LOG_DIR, { recursive: true });
    const id = randomUUID().slice(0, 8);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(META_PROMPT_LOG_DIR, `${stamp}_${kind}_${id}.log.txt`);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    fs.writeFileSync(file, body, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[CLIENT_PAYLOAD] ${kind} ${file}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[CLIENT_PAYLOAD] failed: ${String(err && err.message ? err.message : err)}`);
  }
}

async function submitPromptLogged(prompt, options = {}, meta = {}) {
  const header = [
    `at=${new Date().toISOString()}`,
    `source=${meta.source || 'unknown'}`,
    `endpoint=${meta.endpoint || 'unknown'}`,
    `session_id=${meta.sessionId || ''}`,
    `iteration=${meta.iteration || ''}`,
    `is_new_session=${meta.isNewSession ? '1' : '0'}`,
    `prompt_len=${String(prompt || '').length}`
  ].join('\n');
  writeMetaPromptLog('send', `${header}\n\n----- PROMPT START -----\n${String(prompt || '')}\n----- PROMPT END -----\n`);

  const result = await metaWorker.submitPrompt(prompt, options);

  const responseText = String(result && result.text ? result.text : '');
  const responseHeader = [
    `at=${new Date().toISOString()}`,
    `source=${meta.source || 'unknown'}`,
    `endpoint=${meta.endpoint || 'unknown'}`,
    `session_id=${meta.sessionId || ''}`,
    `iteration=${meta.iteration || ''}`,
    `response_len=${responseText.length}`
  ].join('\n');
  writeMetaPromptLog('recv', `${responseHeader}\n\n----- RESPONSE START -----\n${responseText}\n----- RESPONSE END -----\n`);

  return result;
}

function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout (${label}) after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function describeWorkerProgress(runtime, { openingChat = false } = {}) {
  const ws = runtime || {};
  const phase = String(ws.phase || '').trim().toLowerCase();
  const thinking = Boolean(ws.thinking || ws.uiThinking || ws.stopButtonVisible || Number(ws.inflightModelRequests || 0) > 0);
  if (openingChat && (!phase || phase === 'idle')) return 'A abrir sessao no Meta...';
  if (phase === 'submitting') return 'A enviar instrucao ao Meta...';
  if (phase === 'waiting_response') return 'A aguardar resposta do Meta...';
  if (phase === 'thinking' || thinking) return 'O Meta esta a processar o pedido...';
  if (phase === 'navigating') return 'A preparar a sessao do Meta...';
  return '';
}

function createChatCompletionStreamWriter(res, { model }) {
  const id = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  let opened = false;
  let lastProgress = '';
  const emittedChunks = [];

  // If the client disconnects mid-stream, stop emitting so we never write to a
  // destroyed socket. The agent loop's `!streamWriter.closed` checks then bail.
  res.on('close', () => { closed = true; });

  const writeChunk = (chunk) => {
    if (closed) return;
    emittedChunks.push(chunk);
    // Debug: log SSE chunks that contain tool_calls
    if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.tool_calls) {
      // eslint-disable-next-line no-console
      console.log(`[SSE_chunk] tool_calls: ${JSON.stringify(chunk.choices[0].delta.tool_calls)}`);
    }
    if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) {
      // eslint-disable-next-line no-console
      console.log(`[SSE_chunk] finish_reason: ${chunk.choices[0].finish_reason}`);
    }
    try {
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    } catch (err) {
      closed = true;
      // eslint-disable-next-line no-console
      console.log(`[SSE] write failed, closing stream: ${err && err.message ? err.message : err}`);
    }
  };

  const open = () => {
    if (opened || closed) return;
    opened = true;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: "" }, finish_reason: null }]
    });
  };

  const pushText = (content) => {
    if (!content || closed) return;
    open();
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    });
  };

  let hadAnyToolCalls = false;

  return {
    id,
    created,
    open() { open(); }, // Expose to allow opening stream immediately
    progress(text) {
      const normalized = String(text || '').replace(/\s+/g, ' ').trim();
      if (!normalized || normalized === lastProgress) return;
      lastProgress = normalized;
      // Progress from Meta's thinking state is intentionally NOT streamed to the IDE.
      // Only tool events emit visible feedback (see tool() below).
    },
    tool(toolInfo) {
      if (closed || !toolInfo || String(toolInfo.phase || '') !== 'start') return;
      const name = String(toolInfo.name || '').trim();
      if (!name) return;
      open();
      hadAnyToolCalls = true;
      const _p = toolInfo.params || {};

      // Emit tool_calls exactly as OpenAI SDK streams them (split definition and arguments)
      // Some IDE parsers (like Void's) expect arguments to arrive in chunks WITHOUT an ID.
      const currentCallId = `call_${randomUUID().slice(0, 24)}`;
      const argsString = JSON.stringify(_p);

      // eslint-disable-next-line no-console
      console.log(`[STREAM_TOOL] Emitting tool_call: id=${currentCallId} name=${name} args_len=${argsString.length}`);

      // Chunk 1: Initialize the tool call (id, type, name, empty arguments)
      writeChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: currentCallId,
              type: 'function',
              function: {
                name: name,
                arguments: ""
              }
            }]
          },
          finish_reason: null
        }]
      });

      // Chunk 2: Send the arguments (no id, no type, no name)
      writeChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: argsString
              }
            }]
          },
          finish_reason: null
        }]
      });
    },
    final(text) {
      const normalized = String(text || '');
      if (!normalized) return;
      pushText(normalized);
    },
    done() {
      if (closed) return;
      open();
      const finish = hadAnyToolCalls ? 'tool_calls' : 'stop';
      writeChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: null }, finish_reason: finish }]
      });
      writeClientPayloadLog('client_stream_response', {
        id,
        created,
        model,
        chunks: emittedChunks,
        done: true
      });
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch { /* socket already gone */ }
      closed = true;
    },
    get closed() {
      return closed;
    }
  };
}

function normalizeToolCallsForClient(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];

  const stringifyToolValue = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    return JSON.stringify(value);
  };

  const mapToolParamsForVoid = (toolCall) => {
    const name = String(toolCall && toolCall.name ? toolCall.name : '').trim();
    const p = (toolCall && toolCall.params) || {};
    const pick = (...keys) => {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined && p[key] !== null && p[key] !== '') {
          return p[key];
        }
      }
      return undefined;
    };

    const compact = (obj) => Object.fromEntries(
      Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );

    if (name === 'read_file') {
      return compact({
        uri: stringifyToolValue(p.uri),
        start_line: stringifyToolValue(p.start_line || p.startLine),
        end_line: stringifyToolValue(p.end_line || p.endLine),
        page_number: stringifyToolValue(p.page_number || p.pageNumber)
      });
    }
    if (name === 'ls_dir' || name === 'get_dir_tree') {
      return compact({
        uri: stringifyToolValue(p.uri),
        page_number: stringifyToolValue(p.page_number || p.pageNumber)
      });
    }
    if (name === 'search_pathnames_only') {
      return compact({
        query: stringifyToolValue(p.query),
        include_pattern: stringifyToolValue(p.include_pattern || p.includePattern),
        page_number: stringifyToolValue(p.page_number || p.pageNumber)
      });
    }
    if (name === 'search_for_files') {
      return compact({
        query: stringifyToolValue(p.query),
        search_in_folder: stringifyToolValue(p.search_in_folder || p.searchInFolder || p.uri),
        is_regex: stringifyToolValue(p.is_regex || p.isRegex),
        page_number: stringifyToolValue(p.page_number || p.pageNumber)
      });
    }
    if (name === 'search_in_file') {
      return compact({
        uri: stringifyToolValue(p.uri),
        query: stringifyToolValue(p.query),
        is_regex: stringifyToolValue(p.is_regex || p.isRegex)
      });
    }
    if (name === 'read_lint_errors') {
      return compact({ uri: stringifyToolValue(p.uri) });
    }
    if (name === 'run_command') {
      return compact({
        command: stringifyToolValue(p.command),
        cwd: stringifyToolValue(p.cwd || p.uri)
      });
    }
    if (name === 'edit_file') {
      return compact({
        uri: stringifyToolValue(p.uri),
        search_replace_blocks: stringifyToolValue(
          pick('search_replace_blocks', 'searchReplaceBlocks', 'content', 'new_content', 'newContent')
        )
      });
    }
    if (name === 'rewrite_file') {
      return compact({
        uri: stringifyToolValue(p.uri),
        new_content: stringifyToolValue(p.new_content || p.newContent || p.content)
      });
    }
    if (name === 'create_file_or_folder') {
      return compact({
        uri: stringifyToolValue(normalizeCreateUriForFolder(p.uri || '', p.kind || p.type || ''))
      });
    }
    if (name === 'delete_file_or_folder') {
      return compact({
        uri: stringifyToolValue(p.uri),
        is_recursive: stringifyToolValue(p.is_recursive || p.isRecursive)
      });
    }
    return compact(Object.fromEntries(
      Object.entries(p).map(([key, value]) => [key, stringifyToolValue(value)])
    ));
  };

  return toolCalls
    .filter((toolCall) => toolCall && toolCall.name)
    .slice(0, 1)
    .map((toolCall, index) => ({
      id: `call_${createHash('sha1').update(`${toolCall.name}:${JSON.stringify(toolCall.params || {})}`).digest('hex').slice(0, 12)}`,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(mapToolParamsForVoid(toolCall))
      },
      _musespark_index: index
    }));
}

function extractClientFacingToolCalls(agentResult, { executeToolsLocally }) {
  if (!agentResult) return [];
  if (!executeToolsLocally) {
    return normalizeToolCallsForClient(agentResult.pendingToolCalls);
  }
  if (!Array.isArray(agentResult.executedTools) || !agentResult.executedTools.length) return [];
  return agentResult.executedTools.map((entry, index) => ({
    id: `call_${createHash('sha1').update(`${entry.name}:${JSON.stringify(entry.params || {})}:${index}`).digest('hex').slice(0, 12)}`,
    type: 'function',
    function: {
      name: entry.name,
      arguments: JSON.stringify(entry.params || {})
    },
    _musespark_index: index
  }));
}

function toolCallXml(toolCall) {
  if (!toolCall || !toolCall.name) return '';
  const paramsXml = Object.entries(toolCall.params || {})
    .map(([k, v]) => `<${k}>\n${typeof v === 'object' ? JSON.stringify(v) : String(v)}\n</${k}>`)
    .join('\n');
  return `\n<${toolCall.name}>\n${paramsXml}\n</${toolCall.name}>\n`;
}

function createCallStore() {
  return {
    startedAt: new Date().toISOString(),
    totalCalls: 0,
    successCalls: 0,
    errorCalls: 0,
    lastEventAt: null,
    logs: []
  };
}

function createAutoSessionStore() {
  return new Map();
}
function createInflightStore() {
  return new Map();
}
function createRecentStore() {
  return new Map();
}

function hasOpenAIToolHistory(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  return arr.some((m) => {
    if (!m) return false;
    if (m.role === 'tool' && (m.tool_call_id || contentToText(m.content))) return true;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    return false;
  });
}

function explicitToolModeFromRequest(req, metadata) {
  const md = metadata || {};
  const headers = (req && req.headers) || {};
  const explicit = md.tool_execution_mode || md.musespark_tool_mode || headers['x-musespark-tool-mode'];
  return explicit ? normalizeToolExecutionMode(explicit) : null;
}

function determineToolExecutionMode({ req, metadata, messages, sessionRecord }) {
  const explicit = explicitToolModeFromRequest(req, metadata);
  // Always read env var fresh — CLI sets it AFTER module load
  const currentDefault = getDefaultToolExecutionMode();
  // VOID mode has highest priority — gateway MUST act as bridge only
  if (currentDefault === 'void') return 'void';
  if (explicit && explicit === 'void') return 'void';
  if (explicit && explicit !== 'auto') return explicit;
  if (sessionRecord && sessionRecord.toolExecutionMode) return normalizeToolExecutionMode(sessionRecord.toolExecutionMode);
  if (hasOpenAIToolHistory(messages)) return 'ide';
  if (explicit === 'auto') return hasOpenAIToolHistory(messages) ? 'ide' : 'local';
  if (currentDefault === 'auto') return hasOpenAIToolHistory(messages) ? 'ide' : 'local';
  return currentDefault;
}

function workerSnapshot() {
  try {
    return getMetaWorkerStatus();
  } catch {
    return null;
  }
}


async function workerDeepReadiness(timeoutMs = WORKER_READINESS_TIMEOUT_MS) {
  if (!metaWorker || typeof metaWorker.probeReadiness !== 'function') {
    const ws = workerSnapshot();
    const ready = Boolean(ws && (ws.pageUrl || ws.phase === 'idle' || ws.phase === 'ready'));
    return {
      ok: ready,
      ready,
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      runtime: ws || null,
      mode: 'fallback'
    };
  }
  return metaWorker.probeReadiness({ timeoutMs });
}

function summarizeHealth({ deepReadiness = null } = {}) {
  const runtime = getMetaRuntimeConfig();
  const ws = workerSnapshot();
  const keys = listKeys();
  const shallowReady = Boolean(
    keys.length &&
    ws &&
    !ws.lastError &&
    !String(ws.phase || '').toLowerCase().includes('error')
  );
  const ready = deepReadiness ? Boolean(deepReadiness.ready) : shallowReady;
  return {
    ok: ready,
    ready,
    keysConfigured: keys.length,
    worker: ws || null,
    runtime,
    deepReadiness: deepReadiness || null,
    checkedAt: new Date().toISOString()
  };
}

function workerLogFields() {
  const ws = workerSnapshot();
  if (!ws) return {};
  return {
    workerPhase: ws.phase || null,
    workerThinking: Boolean(ws.thinking),
    workerInflight: Number(ws.inflightModelRequests || 0)
  };
}

function hashText(value) {
  return createHash('sha1').update(String(value || '')).digest('hex');
}

function firstTextByRole(messages, role) {
  if (!Array.isArray(messages)) return '';
  const found = messages.find((m) => m && m.role === role);
  if (!found) return '';
  if (typeof found.content === 'string') return found.content;
  return '';
}

function pickAgentKey(req, metadata, messages) {
  const md = metadata || {};
  const header = req.headers || {};
  const direct =
    md.agent_id ||
    md.conversation_id ||
    md.thread_id ||
    md.chat_id ||
    header['x-void-agent-id'] ||
    header['x-void-conversation-id'] ||
    header['x-conversation-id'] ||
    header['x-thread-id'];

  if (direct) return `explicit:${String(direct).trim()}`;

  // Default to sticky per API key when metadata is absent.
  // This prevents opening many parallel Meta chats for the same IDE thread.
  return `sticky:${String(req.museKeyId || 'anon')}`;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
  }
  return '';
}

function sanitizeMessageText(text) {
  let t = String(text || '');
  t = t.replace(/\r/g, '');
  t = t.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');
  t = t.replace(/Available tools:[\s\S]*/i, '');
  t = t.replace(/Here is the user's system information:[\s\S]*/i, '');
  t = t.replace(/^\s*SELECTIONS\s*$/gim, '');
  return t.trim();
}

function isInternalLikeText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  const patterns = [
    'api_gateway_context',
    'user_query',
    'you are serving requests as an api model',
    'you have runtime awareness',
    'do not mention this context block',
    'you are an expert coding agent',
    'please assist the user with their query',
    'here is the user\'s system information',
    '<system_info>',
    '</system_info>',
    'open files:no opened files',
    'available tools',
    '<read_file>',
    '<ls_dir>',
    '<search_in_file>',
    'workspace contains these folders:',
    'active file:',
    'for an ide assistant.',
    'conversation so far:',
    '<system_message>',
    'available tools:',
    'here is the user\'s system information:'
  ];
  return patterns.some((p) => t.includes(p));
}

function pickBestUserText(raw) {
  const text = sanitizeMessageText(raw);
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isInternalLikeText(l));
  if (!lines.length) return isInternalLikeText(text) ? '' : text;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (line.length < 2) continue;
    if (/^[-_*#`[\]{}()<>]+$/.test(line)) continue;
    if (/^(assistant|system|user)\s*:/i.test(line)) continue;
    return line.slice(0, 4000);
  }
  return lines[lines.length - 1].slice(0, 4000);
}

function isToolResultLikeText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/<TOOL_RESULT\b/i.test(t)) return true;
  if (/<[a-z_]+_result>/i.test(t)) return true;
  return false;
}

function latestUserOnlyPrompt(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (!m || m.role !== 'user') continue;
    const raw = contentToText(m.content);
    if (isToolResultLikeText(raw)) continue;
    const txt = pickBestUserText(raw);
    if (txt) return txt;
  }
  return '';
}

function latestMeaningfulUserPrompt(messages, { fallbackToPrevious = true } = {}) {
  const arr = Array.isArray(messages) ? messages : [];
  const collected = [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (!m || m.role !== 'user') continue;
    const raw = contentToText(m.content);
    if (isToolResultLikeText(raw)) continue;
    const txt = pickBestUserText(raw);
    if (!txt) continue;
    collected.push(txt);
    if (collected.length >= 2) break;
  }
  if (!collected.length) return '';
  const latest = collected[0];
  if (!fallbackToPrevious) return latest;
  if (isBriefFollowUp(latest) && collected[1]) {
    return `${collected[1]}\n\nFollow-up do utilizador: ${latest}`;
  }
  return latest;
}

function compactIdeSystemPrompt(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return '';
  return text.slice(0, 5000);
}

function inferWorkspacePath(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const joined = arr
    .map((m) => String(contentToText(m && m.content) || '').replace(/\r/g, ''))
    .filter(Boolean)
    .join('\n');
  if (!joined) return '';

  const candidates = [];
  const pushPath = (raw) => {
    const value = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!value) return;
    candidates.push(value);
  };

  const workspaceMatch = joined.match(/workspace contains these folders:\s*([^\n<]+)/i);
  if (workspaceMatch && workspaceMatch[1]) pushPath(workspaceMatch[1]);
  const cwdMatch = joined.match(/\bcwd\s*[:=]\s*([^\n<]+)/i);
  if (cwdMatch && cwdMatch[1]) pushPath(cwdMatch[1]);
  const activeFile = joined.match(/active file:\s*([^\n<]+)/i);
  if (activeFile && activeFile[1]) pushPath(activeFile[1]);

  const windowsPathRegex = /[A-Za-z]:\\[^\r\n<>"]+/g;
  const found = joined.match(windowsPathRegex) || [];
  for (const p of found) pushPath(p);

  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/^\s*-\s*/, '')
      .replace(/\s*\|\s*.*$/, '')
      .replace(/\//g, '\\')
      .trim();
    if (!normalized) continue;
    try {
      if (fs.existsSync(normalized)) {
        const stat = fs.statSync(normalized);
        if (stat.isDirectory()) return normalized;
        if (stat.isFile()) return path.dirname(normalized);
      }
    } catch {
      // ignore and continue
    }
    if (/\\[^\\]+\.[a-z0-9]{1,8}$/i.test(normalized)) {
      const dir = path.dirname(normalized);
      if (dir && fs.existsSync(dir)) return dir;
    }
  }

  return '';
}

function extractRuntimeContext(messages) {
  const all = (Array.isArray(messages) ? messages : [])
    .map((m) => sanitizeMessageText(contentToText(m && m.content)))
    .filter(Boolean)
    .join('\n');

  const osMatch = all.match(/-\s*([a-zA-Z0-9_-]+)\s*$/m);
  const workspaceMatch = all.match(/workspace contains these folders:\s*([^\n<]+)/i);
  const activeMatch = all.match(/active file:\s*([^\n<]+)/i);
  const cwdMatch = all.match(/<cwd>([\s\S]*?)<\/cwd>/i) || all.match(/\bcwd\s*[:=]\s*([^\n<]+)/i);
  const inferredWorkspace = inferWorkspacePath(messages);

  const parts = [];
  parts.push(`os=${(osMatch && osMatch[1] ? osMatch[1].trim() : process.platform)}`);
  if (workspaceMatch && workspaceMatch[1]) {
    parts.push(`workspace=${workspaceMatch[1].trim().slice(0, 220)}`);
  } else if (inferredWorkspace) {
    parts.push(`workspace=${inferredWorkspace.slice(0, 220)}`);
  }
  if (cwdMatch && cwdMatch[1]) parts.push(`cwd=${cwdMatch[1].trim().slice(0, 220)}`);
  if (!cwdMatch || !cwdMatch[1]) parts.push(`cwd=${inferredWorkspace || process.cwd()}`);
  if (activeMatch && activeMatch[1]) parts.push(`active_file=${activeMatch[1].trim().slice(0, 80)}`);
  return parts.join(' | ');
}

function extractIdeSystemPrompt(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const systems = arr
    .filter((m) => m && m.role === 'system')
    .map((m) => contentToText(m.content))
    .map((t) => String(t || '').replace(/\r/g, '').trim())
    .filter(Boolean);
  let merged = systems.join('\n\n');

  // Fallback: some clients embed system data inside user content.
  if (!merged) {
    const embedded = arr
      .map((m) => contentToText(m && m.content))
      .map((t) => {
        const m = String(t || '').match(/<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/i);
        return m ? m[1].trim() : '';
      })
      .filter(Boolean);
    if (embedded.length) merged = embedded.join('\n\n');
  }

  return String(merged || '').slice(0, 6000);
}

function extractLatestToolResult(messages) {
  const arr = Array.isArray(messages) ? messages : [];

  // First pass: look for tool role messages
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (!m || m.role !== 'tool') continue;
    const raw = String(contentToText(m.content) || '').replace(/\r/g, '').trim();
    if (!raw) continue;

    // New format: [TOOL_RESULT tool_name]\n[STATUS: SUCCESS/ERROR]\n<output>\n\nREMINDER:...
    const newFormatMatch = raw.match(/^\[TOOL_RESULT ([a-z_]+)\]\s*\n\[STATUS: (SUCCESS|ERROR)\]\s*\n([\s\S]*?)(?:\n\nREMINDER:|$)/i);
    if (newFormatMatch) {
      return {
        name: String(newFormatMatch[1] || 'tool').trim() || 'tool',
        output: String(newFormatMatch[3] || '').trim().slice(0, 12000)
      };
    }

    // Old XML format (backwards compat)
    const xmlMatch = raw.match(/<TOOL_RESULT\s+name="([^"]+)"\s*>([\s\S]*?)<\/TOOL_RESULT>/i);
    if (xmlMatch) {
      return {
        name: String(xmlMatch[1] || 'tool').trim() || 'tool',
        output: String(xmlMatch[2] || '').trim().slice(0, 12000)
      };
    }
  }

  // Second pass: OpenAI-style history coming back from Void IDE:
  // assistant { tool_calls: [...] } followed by role=tool { tool_call_id, content }
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (!m || m.role !== 'tool') continue;
    const raw = String(contentToText(m.content) || '').replace(/\r/g, '').trim();
    if (!raw) continue;

    const wantedId = String(m.tool_call_id || '').trim();
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = arr[j];
      if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.tool_calls) || !prev.tool_calls.length) continue;
      let matched = null;
      if (wantedId) {
        matched = prev.tool_calls.find((tc) => tc && String(tc.id || '').trim() === wantedId) || null;
      }
      if (!matched) matched = prev.tool_calls[prev.tool_calls.length - 1];
      const name = matched && matched.function && matched.function.name
        ? String(matched.function.name).trim()
        : '';
      if (name) {
        return {
          name,
          output: raw.slice(0, 12000)
        };
      }
    }
  }

  return null;
}

function extractRecentConversation(messages, { maxItems = 6, maxChars = 5000 } = {}) {
  const arr = Array.isArray(messages) ? messages : [];
  const items = [];
  for (const m of arr) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const toolNames = m.tool_calls
        .map((tc) => tc && tc.function && tc.function.name)
        .filter(Boolean)
        .slice(0, 4)
        .join(', ');
      if (toolNames) items.push({ role: 'assistant', content: `[tool_calls] ${toolNames}` });
    }
    const raw = contentToText(m.content);
    const txt = sanitizeMessageText(raw);
    if (!txt) continue;
    items.push({ role: m.role, content: txt.slice(0, 1200) });
  }
  const recent = items.slice(-maxItems);
  let xml = recent.map((item) => `<message role="${escapeXml(item.role)}">${toCData(item.content)}</message>`).join('\n');
  if (xml.length > maxChars) xml = xml.slice(xml.length - maxChars);
  return xml;
}

function isBriefFollowUp(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.length <= 20) return true;
  return /^(ok|okay|por favor|continua|continue|segue|prossegue|go on|please|pls|avança|avanca)$/i.test(t);
}

/**
 * Extract only the user's query text for the Meta AI input.
 * The Meta AI input should only contain the user's natural language text,
 * not the full XML gateway prompt with tool definitions.
 */
function extractUserQueryForInput(messages, isFirstTurn) {
  const arr = Array.isArray(messages) ? messages : [];
  
  // Find the latest user message
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (!m || m.role !== 'user') continue;
    
    let content = typeof m.content === 'string' ? m.content : '';
    if (Array.isArray(m.content)) {
      const textParts = m.content.filter(c => c && c.type === 'text').map(c => c.text);
      content = textParts.join('\n');
    }
    
    // Clean up the content
    content = sanitizeMessageText(content || '').trim();
    
    // For first turn, the user message might be wrapped in gateway XML
    // For subsequent turns, it should be plain text
    if (isFirstTurn) {
      // Extract from <latest_user_query> if present
      const queryMatch = content.match(/<latest_user_query>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/latest_user_query>/i);
      if (queryMatch && queryMatch[1]) {
        return queryMatch[1].trim().slice(0, 2000);
      }
    }
    
    // Return the clean user text, truncated to avoid overflow
    return content.slice(0, 2000);
  }
  
  // Fallback: return a generic message if no user text found
  return 'Continue the previous conversation.';
}

function toCData(value) {
  const txt = String(value || '');
  return `<![CDATA[${txt.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeCreateUriForFolder(uri, kind = '') {
  let u = String(uri || '').trim();
  if (!u) return u;
  const k = String(kind || '').trim().toLowerCase();
  const explicitFolder = k === 'folder' || k === 'dir' || k === 'directory';
  const endsWithSlash = /[\\\/]$/.test(u);
  const base = path.basename(u.replace(/[\\\/]+$/, ''));
  const hasDot = base.includes('.');
  if ((explicitFolder || !hasDot) && !endsWithSlash) {
    u += '\\';
  }
  return u;
}

function serializeToolCallXml(toolCall) {
  const call = toolCall || {};
  const name = String(call.name || '').trim();
  const p = call.params || {};
  if (!name) return '';
  if (name === 'read_file') {
    const line = p.line ? `<line>${escapeXml(p.line)}</line>` : '';
    const start = p.start_line ? `<start_line>${escapeXml(p.start_line)}</start_line>` : '';
    const end = p.end_line ? `<end_line>${escapeXml(p.end_line)}</end_line>` : '';
    return `<read_file><uri>${escapeXml(p.uri || '')}</uri>${line}${start}${end}</read_file>`;
  }
  if (name === 'ls_dir') return `<ls_dir><uri>${escapeXml(p.uri || '')}</uri></ls_dir>`;
  if (name === 'get_dir_tree') return `<get_dir_tree><uri>${escapeXml(p.uri || '')}</uri></get_dir_tree>`;
  if (name === 'search_pathnames_only') return `<search_pathnames_only><query>${escapeXml(p.query || '')}</query></search_pathnames_only>`;
  if (name === 'search_for_files') {
    const folder = p.searchInFolder ? `<search_in_folder>${escapeXml(p.searchInFolder)}</search_in_folder>` : '';
    const isRegex = Object.prototype.hasOwnProperty.call(p, 'isRegex') ? `<is_regex>${escapeXml(p.isRegex)}</is_regex>` : '';
    return `<search_for_files><query>${escapeXml(p.query || '')}</query>${folder}${isRegex}</search_for_files>`;
  }
  if (name === 'search_in_file') return `<search_in_file><uri>${escapeXml(p.uri || '')}</uri><query>${escapeXml(p.query || '')}</query></search_in_file>`;
  if (name === 'read_lint_errors') return `<read_lint_errors><uri>${escapeXml(p.uri || '')}</uri></read_lint_errors>`;
  if (name === 'run_command') return `<run_command><command>${escapeXml(p.command || '')}</command><cwd>${escapeXml(p.cwd || '')}</cwd></run_command>`;
  if (name === 'edit_file') return `<edit_file><uri>${escapeXml(p.uri || '')}</uri><search_replace_blocks>${escapeXml(p.content || '')}</search_replace_blocks></edit_file>`;
  if (name === 'create_file_or_folder') {
    const normalizedUri = normalizeCreateUriForFolder(p.uri || '', p.kind || p.type || '');
    return `<create_file_or_folder><uri>${escapeXml(normalizedUri)}</uri></create_file_or_folder>`;
  }
  if (name === 'delete_file_or_folder') {
    const recursive = Object.prototype.hasOwnProperty.call(p, 'isRecursive') ? `<is_recursive>${escapeXml(p.isRecursive)}</is_recursive>` : '';
    return `<delete_file_or_folder><uri>${escapeXml(p.uri || '')}</uri>${recursive}</delete_file_or_folder>`;
  }
  return '';
}

function selectFallbackToolCall(userText, workspacePath) {
  const latestUserText = String(userText || '');
  const cwd = workspacePath || process.cwd();
  const asksIndex = /(index\.html|ler o index|le o index|read index|abrir index)/i.test(latestUserText);
  const indexPath = path.join(cwd, 'index.html');
  if (asksIndex && fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
    return { name: 'read_file', params: { uri: indexPath } };
  }
  return { name: 'get_dir_tree', params: { uri: cwd } };
}

function isFileIntent(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  // File/content intent: includes creation, modification, listing, and codebase queries
  return /(arquivo|arquivos|file|files|codebase|c[oó]digo|pasta|folder|diret[oó]rio|directory|listar|list|ver os arquivos|verifica|criar|cria|crie|make|build|edit|modifica|altera|deleta|apaga|escreve|write|setup|monta|inicia|projeto|site|app|programa|ferramenta|script|html|css|javascript)/i.test(t);
}

function looksActionNarration(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  return /(deixa[\s-]?me\s+(ver|ler|inspecionar|analisar|listar)|vou\s+(ver|ler|inspecionar|analisar|listar|abrir|checar)|primeiro[\s,:-]+.*(ver|ler|inspecionar|analisar|listar|abrir|checar)|inspecionando|inspecting|lendo\b|reading\b|analisando|analyzing|listando|listing|explorando|exploring)/i.test(t);
}

function looksPromisedFileAction(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  return /(vou\s+(criar|editar|alterar|modificar|apagar|escrever|montar|construir|gerar|come[çc]ar)|irei\s+(criar|editar|alterar|modificar|apagar|escrever)|agora\s+vou\s+(criar|editar|alterar|modificar|apagar|escrever)|perfeito[\s,:-]+vou\s+(criar|editar|alterar|modificar|apagar|escrever)|i(?:'|’)ll\s+(create|edit|update|modify|delete|write|build)|going to\s+(create|edit|update|modify|delete|write|build))/i.test(t);
}

function looksBarePathReply(text, workspaceHint) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t || t.length > 260 || /[<>]/.test(t)) return false;
  const lines = t.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 2) return false;
  const normalizedWorkspace = String(workspaceHint || '').trim().toLowerCase();
  const pathLike = /^(?:[a-zA-Z]:[\\/]|[.~]{0,2}[\\/])/;
  return lines.every((line) => {
    const lower = line.toLowerCase();
    return pathLike.test(line) || (normalizedWorkspace && lower === normalizedWorkspace);
  });
}

function isGreetingIntent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  return /^(oi|ol[aá]|ola|hello|hey|alo|al[oô]|bom dia|boa tarde|boa noite|yo|sup)[!,. ]*$/i.test(t);
}

function isContextIntent(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /(onde est[aá]s|where are you|sabes onde|workspace|cwd|diret[oó]rio atual|pasta principal|em que pasta)/i.test(t);
}

function isCapabilitiesIntent(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /(o que podes fazer|o que consegue fazer|what can you do|como podes ajudar|how can you help)/i.test(t);
}

function looksGenericOrPathRequest(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return true;
  const startsGreeting = /^(ol[aá]|oi|hey|hello)\b/i.test(t);
  const asksHelpTone = /(como posso|em que posso|what can i help|how can i help|quer que eu|pronto pra|tudo certo)/i.test(t);
  if (startsGreeting && asksHelpTone) return true;
  const genericRx = [
    /ol[aá][!,\s].*como posso.*ajudar/i,
    /ol[aá][!,\s].*em que posso.*ajudar/i,
    /como posso.*ajudar/i,
    /em que posso.*ajudar/i,
    /posso te ajudar/i,
    /posso ajudar/i,
    /what can i help/i,
    /how can i help/i,
    /\bi(?:'|’)m here\b/i,
    /\bestou aqui\b/i,
    /^got it\b/i
  ];
  const asksPath = /(caminho absoluto|caminho completo|absolute path|full path|qual pasta|which folder|what folder|informe o caminho)/i.test(t);
  return genericRx.some((rx) => rx.test(t)) || asksPath;
}

function looksToolUnavailableReply(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  return /(ferramenta.*n[aã]o (est[aá] dispon[ií]vel|consegui)|n[aã]o consegui listar os arquivos|tool .* not available|cannot use (that )?tool|erro interno aqui)/i.test(t);
}

function looksFileActionResult(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\[(file|dir)\]/i.test(t)) return true;
  if (/^error:\s*(file|directory|not a file|not a directory)/im.test(t)) return true;
  if (/^caminho:|^path:/im.test(t)) return true;
  return false;
}

function normalizeBrokenEditContent(raw) {
  let text = String(raw || '')
    .replace(/\r/g, '')
    .replace(/^Code\s*\n?/gim, '')
    .replace(/^<{6,7}\s*[A-Za-z_ -]*\s*$/gm, '')
    .replace(/^>{6,7}\s*[A-Za-z_ -]*\s*$/gm, '')
    .replace(/^={3,}\s*$/gm, '')
    .replace(/^\s*(ORIGINAL|SEARCH|UPDATED|REPLACE)\s*$/gim, '')
    .trim();

  // Strip CDATA wrappers everywhere (including inline: <![CDATA[<<<<<<< ORIGINAL)
  text = text.replace(/<!\[CDATA\[/gi, '');
  text = text.replace(/\]\]>/g, '');

  // Strip broken markers inline (not just full lines)
  text = text.replace(/<{6,7}\s*(ORIGINAL|SEARCH)\s*/gi, '');
  text = text.replace(/\>{6,7}\s*(UPDATED|REPLACE)\s*/gi, '');
  text = text.replace(/>={3,}/g, '');

  return text.trim();
}

/**
 * Meta AI's DOM extraction often returns the full response duplicated
 * (text + XML appears twice). This detects and removes the duplication.
 */
function deduplicateResponse(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 20) return t;

  // Strategy 1: Try exact halving (most common duplication pattern)
  if (t.length % 2 === 0) {
    const half = t.length / 2;
    const first = t.slice(0, half).trim();
    const second = t.slice(half).trim();
    if (first === second) return first;
  }

  // Strategy 2: Find the first complete tool call XML, see if the same tag appears again after it
  const toolTags = ['get_dir_tree', 'read_file', 'ls_dir', 'edit_file', 'create_file_or_folder',
    'delete_file_or_folder', 'run_command', 'search_for_files', 'search_in_file',
    'search_pathnames_only', 'read_lint_errors', 'tool_call', 'task_complete'];
  for (const tag of toolTags) {
    const rx = new RegExp(`(<${tag}\\b[\\s\\S]*?<\\/${tag}>)`, 'gi');
    const matches = t.match(rx);
    if (matches && matches.length >= 2 && matches[0].trim() === matches[1].trim()) {
      // The same tool call appears twice — keep only up to the end of the first one
      const firstEnd = t.indexOf(matches[0]) + matches[0].length;
      // Keep any narrative text before the tool call + the first tool call itself
      return t.slice(0, firstEnd).trim();
    }
  }

  // Strategy 3: Split on the first tool call tag, check if pre-text is duplicated after it
  const firstToolMatch = t.match(/<(get_dir_tree|read_file|ls_dir|edit_file|create_file_or_folder|delete_file_or_folder|run_command|search_for_files|search_in_file|tool_call)\b/i);
  if (firstToolMatch) {
    const tagStart = t.indexOf(firstToolMatch[0]);
    const preText = t.slice(0, tagStart).replace(/\s+/g, ' ').trim();
    if (preText.length >= 10) {
      const afterTool = t.slice(tagStart);
      const closingTag = `</${firstToolMatch[1]}>`;
      const closingIdx = afterTool.indexOf(closingTag);
      if (closingIdx > 0) {
        const remainder = afterTool.slice(closingIdx + closingTag.length).replace(/\s+/g, ' ').trim();
        if (remainder.startsWith(preText.slice(0, Math.min(40, preText.length)))) {
          return t.slice(0, tagStart + closingIdx + closingTag.length).trim();
        }
      }
    }
  }

  // Strategy 4: Fuzzy narrative text deduplication (no XML tags)
  // If the first 40+ characters appear again later, the rest is a duplicate.
  const normalized = t.replace(/\s+/g, ' ');
  const prefixLen = Math.min(50, Math.floor(normalized.length / 3));
  if (prefixLen >= 20) {
    const prefix = normalized.slice(0, prefixLen);
    const secondIdx = normalized.indexOf(prefix, prefixLen + 5);
    if (secondIdx > 0 && secondIdx < normalized.length * 0.75) {
      // Map back to original string position
      // Find the character in original `t` that corresponds to secondIdx in normalized
      let origPos = 0;
      let normPos = 0;
      for (origPos = 0; origPos < t.length && normPos < secondIdx; origPos++) {
        if (/\s/.test(t[origPos])) {
          while (origPos + 1 < t.length && /\s/.test(t[origPos + 1])) origPos++;
        }
        normPos++;
      }
      if (origPos > 0) {
        return t.slice(0, origPos).trim();
      }
    }
  }

  return t;
}

function buildNoToolCallError(userText) {
  const request = String(userText || '').trim();
  const suffix = request ? ` Pedido: "${request.slice(0, 220)}"` : '';
  return `Erro: o modelo respondeu em texto normal em vez de emitir uma IDE tool call para este pedido de código.${suffix}`;
}

async function runAgentLoop(messages, { forceNewChat, sessionId, sessionUrl, timeoutMs, requestedModel, req, onProgress, onToolEvent, executeToolsLocally }) {
  const MAX_AGENT_ITERATIONS = 8;
  const history = Array.isArray(messages) ? [...messages] : [];
  const initialUserText = latestMeaningfulUserPrompt(history);
  const inferredWorkspace = inferWorkspacePath(history) || process.cwd();
  const isNewSession = Boolean(forceNewChat || (!sessionId && !sessionUrl));
  let currentSessionUrl = sessionUrl || null;
  let iterations = 0;
  let hadToolCalls = false;
  let lastMeta = null;
  let lastText = '';
  const seenToolCalls = new Set();
  let lastToolOutput = '';
  let noToolRetryCount = 0;
  const executedTools = [];
  let pendingToolCalls = [];

  const toolProgressLabel = (toolCall) => {
    if (!toolCall || !toolCall.name) return 'A executar a tool pedida...';
    if (toolCall.name === 'get_dir_tree') return 'A executar get_dir_tree para inspecionar o workspace...';
    if (toolCall.name === 'read_file') return 'A executar read_file para ler o ficheiro pedido...';
    if (toolCall.name === 'search_for_files') return 'A executar search_for_files para procurar no projeto...';
    if (toolCall.name === 'search_in_file') return 'A executar search_in_file para localizar o trecho pedido...';
    if (toolCall.name === 'run_command') return 'A executar run_command no terminal do workspace...';
    if (toolCall.name === 'task_complete') return 'A finalizar a tarefa...';
    return `A executar ${toolCall.name}...`;
  };

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i += 1) {
    iterations = i + 1;
    const promptIsNewSession = i === 0 ? isNewSession : false;
    const shouldForceNewChat = i === 0 ? Boolean(forceNewChat || (!currentSessionUrl && !sessionId)) : false;
    if (typeof onProgress === 'function') {
      onProgress(i === 0
        ? 'A preparar a sessao de trabalho...'
        : (hadToolCalls ? 'A continuar o fluxo com o resultado da tool...' : 'A pedir novamente uma tool call ao modelo...'));
    }

    // Build the full XML prompt for logging/context
    const fullPrompt = buildApiStylePrompt(history, { isNewSession: promptIsNewSession });

    let result;
    let progressTimer = null;
    let lastProgressText = '';
    try {
      if (typeof onProgress === 'function') {
        const immediate = describeWorkerProgress(workerSnapshot(), { openingChat: shouldForceNewChat });
        if (immediate) {
          lastProgressText = immediate;
          onProgress(immediate);
        }
        progressTimer = setInterval(() => {
          const next = describeWorkerProgress(workerSnapshot(), { openingChat: shouldForceNewChat });
          if (next && next !== lastProgressText) {
            lastProgressText = next;
            onProgress(next);
          }
        }, 700);
      }
      result = await submitPromptLogged(
        fullPrompt,
        {
          forceNewChat: shouldForceNewChat,
          sessionId: sessionId || null,
          sessionUrl: currentSessionUrl,
          timeoutMs
        },
        {
          source: 'runAgentLoop',
          endpoint: req && req.path ? req.path : '/v1/chat/completions',
          sessionId,
          iteration: i + 1,
          isNewSession: promptIsNewSession,
          fullPromptLength: fullPrompt.length  // Log full prompt size for debugging
        }
      );
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }

    const assistantText = deduplicateResponse(String(result && result.text ? result.text : '')).trim();
    lastMeta = result && result.meta ? result.meta : null;
    lastText = assistantText;
    currentSessionUrl = result && result.meta && result.meta.session && result.meta.session.url
      ? result.meta.session.url
      : currentSessionUrl;
    if (typeof onProgress === 'function') onProgress('Resposta recebida do Meta. A validar o proximo passo...');

    if (!assistantText) {
      return {
        text: '',
        meta: lastMeta,
        iterations,
        hadToolCalls,
        executedTools,
        pendingToolCalls
      };
    }

    if (!hasToolCall(assistantText)) {
      const latestUserText = initialUserText || latestMeaningfulUserPrompt(history);
      const cleanedAssistant = cleanAssistantOutput(assistantText) || assistantText;
      const fileIntent = isFileIntent(latestUserText);
      const hasToolResultInHistory = Boolean(extractLatestToolResult(history));

      if (fileIntent && !isGreetingIntent(latestUserText)) {
        if (!hadToolCalls && !hasToolResultInHistory && (looksActionNarration(cleanedAssistant) || looksToolUnavailableReply(cleanedAssistant))) {
          const fallbackToolCall = selectFallbackToolCall(latestUserText, inferredWorkspace);
          if (!executeToolsLocally) {
            hadToolCalls = true;
            pendingToolCalls = [fallbackToolCall];
            return {
              text: toolCallXml(fallbackToolCall),
              meta: lastMeta,
              iterations,
              hadToolCalls,
              executedTools,
              pendingToolCalls
            };
          }
          if (typeof onProgress === 'function') onProgress(toolProgressLabel(fallbackToolCall));
          if (typeof onToolEvent === 'function') {
            onToolEvent({ phase: 'start', name: fallbackToolCall.name, params: fallbackToolCall.params || {} });
          }
          let toolOutput = '';
          try {
            toolOutput = await executeToolCall(fallbackToolCall);
          } catch (error) {
            toolOutput = `Tool execution failed: ${String(error && error.message ? error.message : error)}`;
          }
          hadToolCalls = true;
          lastToolOutput = toolOutput;
          executedTools.push({
            name: fallbackToolCall.name,
            params: fallbackToolCall.params || {},
            ok: !hasToolError(toolOutput)
          });
          history.push({ role: 'assistant', content: assistantText });
          history.push({
            role: 'tool',
            content: formatToolResult(fallbackToolCall.name, toolOutput)
          });
          if (typeof onToolEvent === 'function') {
            onToolEvent({
              phase: 'finish',
              name: fallbackToolCall.name,
              params: fallbackToolCall.params || {},
              ok: !hasToolError(toolOutput)
            });
          }
          if (typeof onProgress === 'function') onProgress(`A tool ${fallbackToolCall.name} terminou com sucesso.`);
          continue;
        }

        if (hasToolResultInHistory && looksPromisedFileAction(cleanedAssistant) && !looksFileActionResult(cleanedAssistant)) {
          noToolRetryCount += 1;
          if (noToolRetryCount >= MAX_AGENT_ITERATIONS || i === MAX_AGENT_ITERATIONS - 1) {
            return {
              text: buildNoToolCallError(latestUserText),
              meta: lastMeta,
              iterations,
              hadToolCalls,
              executedTools,
              pendingToolCalls
            };
          }
          history.push({ role: 'assistant', content: assistantText });
          history.push({
            role: 'system',
            content: 'Your previous reply narrated a file action. Emit only the next IDE tool call XML block now.'
          });
          if (typeof onProgress === 'function') onProgress('A pedir ao modelo a tool call seguinte em vez de narrativa...');
          continue;
        }

        if (!hadToolCalls && !hasToolResultInHistory) {
          noToolRetryCount += 1;
          if (noToolRetryCount >= MAX_AGENT_ITERATIONS || i === MAX_AGENT_ITERATIONS - 1) {
            return {
              text: buildNoToolCallError(latestUserText),
              meta: lastMeta,
              iterations,
              hadToolCalls,
              executedTools,
              pendingToolCalls
            };
          }

          history.push({ role: 'assistant', content: assistantText });
          history.push({
            role: 'system',
            content: [
              'Take action now using the IDE tool protocol.',
              'Output exactly one IDE tool call XML block and no narrative text.',
              'If the user asked to inspect the project, prefer get_dir_tree or read_file first.',
              'If you answer in normal text again, the request will fail.'
            ].join(' ')
          });
          if (typeof onProgress === 'function') onProgress('A pedir ao modelo para responder com uma tool call valida...');
          continue;
        }
        // When hadToolCalls=true and model responds with text (no tool),
        // check if there's still work to do (e.g. file was created empty, needs edit_file).
        if (hadToolCalls && fileIntent && !isGreetingIntent(latestUserText)) {
          if (looksBarePathReply(cleanedAssistant, inferredWorkspace)) {
            noToolRetryCount += 1;
            if (noToolRetryCount < MAX_AGENT_ITERATIONS && i < MAX_AGENT_ITERATIONS - 1) {
              history.push({ role: 'assistant', content: assistantText });
              history.push({
                role: 'system',
                content: 'Your previous reply only echoed a path or placeholder. Continue the IDE workflow now. Emit exactly one next tool call XML block, or <task_complete><message>...</message></task_complete> if the task is truly finished.'
              });
              if (typeof onProgress === 'function') onProgress('A pedir ao modelo para continuar o fluxo util em vez de devolver apenas um caminho...');
              continue;
            }
          }
          // If the model is narrating what it will do next instead of doing it, nudge it.
          if (looksPromisedFileAction(cleanedAssistant) || looksActionNarration(cleanedAssistant)) {
            noToolRetryCount += 1;
            if (noToolRetryCount < MAX_AGENT_ITERATIONS && i < MAX_AGENT_ITERATIONS - 1) {
              history.push({ role: 'assistant', content: assistantText });
              history.push({
                role: 'system',
                content: 'The file was created but is empty. Now use edit_file to write the full content into it. Output only the edit_file tool call XML, no narrative text.'
              });
              if (typeof onProgress === 'function') onProgress('A pedir ao modelo para escrever o conteudo no ficheiro...');
              continue;
            }
          } else {
            // Model responded with a final narrative after tool execution — this is valid!
            // Return the narrative as the final answer.
            return { text: cleanedAssistant || assistantText, meta: lastMeta, iterations, hadToolCalls, executedTools, pendingToolCalls };
          }
        }
      }

      return { text: assistantText, meta: lastMeta, iterations, hadToolCalls, executedTools, pendingToolCalls };
    }

    const toolCalls = extractToolCallsXML(assistantText);
    if (!toolCalls.length) {
      // Tool-like output exists but parser could not decode it safely.
      // Return raw text and let cleanAssistantOutput extract <answer> safely.
      return {
        text: assistantText,
        meta: lastMeta,
        iterations,
        hadToolCalls,
        executedTools,
        pendingToolCalls
      };
    }

    hadToolCalls = true;
    if (!executeToolsLocally && toolCalls.length === 1 && toolCalls[0].name === 'task_complete') {
      let finalMsg = '';
      try {
        finalMsg = await executeToolCall(toolCalls[0]);
      } catch (error) {
        finalMsg = `Tool execution failed: ${String(error && error.message ? error.message : error)}`;
      }
      if (typeof finalMsg === 'string' && finalMsg.startsWith('__TASK_COMPLETE__:')) {
        finalMsg = finalMsg.slice('__TASK_COMPLETE__:'.length);
      }
      return {
        text: finalMsg,
        meta: lastMeta,
        iterations,
        hadToolCalls,
        executedTools,
        pendingToolCalls
      };
    }
    if (!executeToolsLocally) {
      pendingToolCalls = toolCalls.slice(0, 1);
      return {
        text: assistantText,
        meta: lastMeta,
        iterations,
        hadToolCalls,
        executedTools,
        pendingToolCalls
      };
    }

    history.push({ role: 'assistant', content: assistantText });
    let executedAnyToolInBatch = false;

    for (const toolCall of toolCalls) {
      if (!toolCall || !toolCall.name) continue;

      // AUTO-CONVERTER: Fix Meta AI's broken edit_file format
      // Meta AI sends: <<<<<<< SEARCH\n(content)\n>>>>>>> REPLACE (no ======= separator)
      // Strategy: clean markers and handle based on file state
      if (toolCall.name === 'edit_file' && toolCall.params && toolCall.params.uri) {
        const raw = String(toolCall.params.content || '');
        const hasMarkers = /<{6,7}\s*\w*/.test(raw) && />{6,7}\s*\w*/.test(raw);
        const looksBrokenEdit =
          /<{6,7}\s*\w*/.test(raw) ||
          /(^|\n)\s*(UPDATED|REPLACE)\s*$/i.test(raw) ||
          /^Code\b/i.test(raw);
        const hasSeparator = /={3,}/.test(raw);
        if ((hasMarkers && !hasSeparator) || (looksBrokenEdit && !hasSeparator)) {
          const cleaned = normalizeBrokenEditContent(raw);
          if (cleaned.length > 10) {
            const fs = require('fs');
            const path = require('path');
            const resolved = path.resolve(toolCall.params.uri);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
              try {
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                fs.writeFileSync(resolved, cleaned, 'utf8');
                lastToolOutput = `File written: ${resolved} (${cleaned.length} bytes)`;
                history.push({
                  role: 'tool',
                  content: formatToolResult('edit_file', lastToolOutput)
                });
                executedTools.push({ name: 'edit_file', params: toolCall.params || {}, ok: true });
                executedAnyToolInBatch = true;
                continue;
              } catch (writeErr) {
                lastToolOutput = `Error writing file: ${writeErr.message}`;
              }
            } else {
              const currentContent = fs.readFileSync(resolved, 'utf8');
              const normalizedClean = cleaned.replace(/\r\n/g, '\n').trim();
              const normalizedCurrent = currentContent.replace(/\r\n/g, '\n').trim();
              try {
                if (normalizedClean === normalizedCurrent) {
                  lastToolOutput = `File unchanged: ${resolved}`;
                } else {
                  fs.writeFileSync(resolved, cleaned, 'utf8');
                  lastToolOutput = `File updated (full replace): ${resolved} (${cleaned.length} bytes)`;
                }
                history.push({
                  role: 'tool',
                  content: formatToolResult('edit_file', lastToolOutput)
                });
                executedTools.push({ name: 'edit_file', params: toolCall.params || {}, ok: !hasToolError(lastToolOutput) });
                executedAnyToolInBatch = true;
                continue;
              } catch (writeErr) {
                lastToolOutput = `Error writing file: ${writeErr.message}`;
              }
            }
          }
        }
      }

      const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.params || {}).slice(0, 600)}`;
      if (seenToolCalls.has(toolKey)) {
        continue;
      }
      seenToolCalls.add(toolKey);
      executedAnyToolInBatch = true;

      if (typeof onProgress === 'function') onProgress(toolProgressLabel(toolCall));
      if (typeof onToolEvent === 'function') {
        onToolEvent({ phase: 'start', name: toolCall.name, params: toolCall.params || {} });
      }

      let toolOutput = '';
      try {
        toolOutput = await executeToolCall(toolCall);
      } catch (error) {
        toolOutput = `Tool execution failed: ${String(error && error.message ? error.message : error)}`;
      }

      if (typeof toolOutput === 'string' && toolOutput.startsWith('__TASK_COMPLETE__:')) {
        const finalMsg = toolOutput.slice('__TASK_COMPLETE__:'.length);
        return {
          text: finalMsg,
          meta: lastMeta,
          iterations,
          hadToolCalls: true,
          executedTools,
          pendingToolCalls,
          isTaskComplete: true
        };
      }

      if (typeof onProgress === 'function') {
        onProgress(hasToolError(toolOutput)
          ? `A tool ${toolCall.name} terminou com erro.`
          : `A tool ${toolCall.name} terminou com sucesso.`);
      }
      executedTools.push({
        name: toolCall.name,
        params: toolCall.params || {},
        ok: !hasToolError(toolOutput)
      });
      if (typeof onToolEvent === 'function') {
        onToolEvent({
          phase: 'finish',
          name: toolCall.name,
          params: toolCall.params || {},
          ok: !hasToolError(toolOutput)
        });
      }
      lastToolOutput = toolOutput;
      history.push({
        role: 'tool',
        content: `TOOL_RESULT[${toolCall.name}]:\n${String(toolOutput || '').slice(0, 15000)}\n\nREMINDER: Respond ONLY with the next XML tool call. No explanations.`
      });
    }

    if (!executedAnyToolInBatch) {
      const fallback = lastToolOutput
        ? String(lastToolOutput).slice(0, 4000)
        : 'Nao foi possivel concluir: o modelo repetiu tool calls sem progresso.';
      return {
        text: fallback,
        meta: lastMeta,
        iterations,
        hadToolCalls,
        executedTools,
        pendingToolCalls
      };
    }
  }

  // If the loop ended and lastText is still a tool call (model never gave a final answer),
  // return the last tool output formatted nicely instead of bare XML or a raw path.
  const finalText = (() => {
    if (!lastText) return lastText;
    if (hasToolCall(lastText)) {
      // Model's last response was still a tool call — return last tool output if available.
      if (lastToolOutput) {
        const lines = String(lastToolOutput).split('\n');
        const summary = lines.slice(0, 60).join('\n');
        return `Resultado da última operação:\n\`\`\`\n${summary}\n\`\`\``;
      }
      return '';
    }
    return lastText;
  })();

  return {
    text: finalText,
    meta: lastMeta,
    iterations,
    hadToolCalls,
    executedTools,
    pendingToolCalls
  };
}

function buildApiStylePrompt(messages, { isNewSession = false } = {}) {
  const arr = Array.isArray(messages) ? messages : [];
  if (!arr.length) return '';

  const MAX_TOTAL = 18000;
  const toText = (m) => {
    if (!m) return '';
    let content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n') : '');
    content = sanitizeMessageText(content);
    return content.trim();
  };

  const normalized = arr
    .map((m) => ({
      role: m && m.role ? m.role : 'unknown',
      content: toText(m)
    }))
    .filter((m) => m.content);

  if (!normalized.length) return '';

  const latestUserRaw = [...normalized].reverse().find((m) => m.role === 'user');
  const latestUserText = pickBestUserText(latestMeaningfulUserPrompt(arr)) ||
    pickBestUserText(latestUserRaw ? latestUserRaw.content : '') ||
    '';
  const runtimeContext = extractRuntimeContext(arr);
  const ideSystemPrompt = compactIdeSystemPrompt(extractIdeSystemPrompt(arr));
  const inferredWorkspace = inferWorkspacePath(arr);
  const latestToolResult = extractLatestToolResult(arr);
  const recentConversation = extractRecentConversation(arr);
  const latestToolResultBlock = latestToolResult
    ? `<latest_tool_result name="${escapeXml(latestToolResult.name)}">${toCData(latestToolResult.output)}</latest_tool_result>`
    : '<latest_tool_result/>';
  const sessionContractBlock = '<session_contract><![CDATA[' +
    'This rule applies to the entire current session. ' +
    'When the user asks to create or modify a site, app, codebase, file, folder, config, asset, or project, use only the IDE tool calls defined in <ide_system_prompt>. ' +
    'Do not use hidden, internal, or Meta-native tools as a substitute for the IDE tools. ' +
    'When building a site or app, you MUST create multiple distinct, professional files (e.g., separate HTML, CSS, JS files). DO NOT generate the entire site in a single monolithic file. Prioritize top-tier premium design aesthetics. ' +
    'CRITICAL: You MUST output EXACTLY ONE tool call per response. The IDE cannot process multiple tools at once. Send ONE tool call, wait for the <latest_tool_result>, and then send the next ONE.' +
    'Do not say that work was done unless the corresponding IDE tool call is present in your response.' +
  ']]></session_contract>';
  const executionRulesBlock = '<execution_rules><![CDATA[' +
    'Follow the IDE tool protocol strictly. ' +
    'Use a tool call for file/dir/command requests. ' +
    'For requests to build or modify sites, apps, code, files, folders, configs, or assets, respond with tool calls instead of descriptive text. ' +
    'Do not claim that work was done unless the corresponding tool call is present. ' +
    'If latest_tool_result is present, answer the user based on that result and do not repeat the same tool call unless needed. ' +
    'If a tool result says "File does not exist", DO NOT attempt to read_file or edit_file on it again. You MUST CREATE the file using create_file_or_folder first! ' +
    'If latest_tool_result already contains the requested listing/content, prefer a final answer instead of calling another tool. ' +
    'If edit_file failed because the block format was invalid, do not repeat the same malformed edit_file. Read the file first or send a full-file replacement. ' +
    'When creating web apps, split code into multiple semantic files via proper tools. YOU MUST NEVER SEND BATCHED TOOL CALLS. Output only ONE tool at a time, wait for the result from the IDE, then proceed.' +
    'Avoid generic greetings when the user made a concrete request.' +
  ']]></execution_rules>';

  // Requested flow:
  // - New session: prompt_master XML + IDE system prompt + current user prompt
  // - Existing session: only current user prompt
  let fullPrompt = '';
  if (isNewSession) {
    fullPrompt = [
      RAW_AGENT_SYSTEM,
      '',
      '<gateway_request>',
      '<session_mode>new</session_mode>',
      runtimeContext ? `<runtime_context>${toCData(runtimeContext)}</runtime_context>` : '<runtime_context/>',
      ideSystemPrompt ? `<ide_system_prompt>${toCData(ideSystemPrompt)}</ide_system_prompt>` : '<ide_system_prompt/>',
      inferredWorkspace ? `<workspace_hint>${toCData(inferredWorkspace)}</workspace_hint>` : '<workspace_hint/>',
      recentConversation ? `<recent_conversation>${recentConversation}</recent_conversation>` : '<recent_conversation/>',
      sessionContractBlock,
      latestToolResultBlock,
      executionRulesBlock,
      '<latest_user_query>',
      toCData(latestUserText),
      '</latest_user_query>',
      '</gateway_request>'
    ].join('\n');
  } else {
    // Continue mode: still send IDE system context every turn to keep behavior aligned with IDE expectations.
    fullPrompt = [
      '<gateway_turn>',
      runtimeContext ? `<runtime_context>${toCData(runtimeContext)}</runtime_context>` : '<runtime_context><![CDATA[ide_gateway]]></runtime_context>',
      ideSystemPrompt ? `<ide_system_prompt>${toCData(ideSystemPrompt)}</ide_system_prompt>` : '<ide_system_prompt/>',
      inferredWorkspace ? `<workspace_hint>${toCData(inferredWorkspace)}</workspace_hint>` : '<workspace_hint/>',
      recentConversation ? `<recent_conversation>${recentConversation}</recent_conversation>` : '<recent_conversation/>',
      latestToolResultBlock,
      executionRulesBlock,
      '<latest_user_query>',
      toCData(latestUserText),
      '</latest_user_query>',
      '</gateway_turn>'
    ].join('\n');
  }

  return fullPrompt.slice(0, MAX_TOTAL);
}

function cleanAssistantOutput(text) {
  let out = String(text || '').replace(/\r/g, '').trim();
  if (!out) return '';

  // Extract from <answer> tags if present — text to show user
  const answerMatch = out.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (answerMatch) {
    out = answerMatch[1].trim();
  }

  // Extract code_block content if no answer tag
  const codeMatch = out.match(/<code_block[\s\S]*?>([\s\S]*?)<\/code_block>/i);
  if (codeMatch && !answerMatch) {
    out = codeMatch[1].trim();
  }

  // Remove tool call XML from the text output (tools are handled separately)
  // This prevents leaking raw XML to the IDE
  const toolTags = ['tool_call', 'read_file', 'ls_dir', 'get_dir_tree', 'run_command', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'read_lint_errors', 'edit_file', 'create_file_or_folder', 'delete_file_or_folder', 'task_complete'];
  for (const tag of toolTags) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'), ' ');
  }
  out = out.trim();

  const blockPatterns = [
    /Instruction:\s*Reply only to the latest user message[\s\S]*$/gi,
    /You are MUSE, an API model\.[\s\S]*?(?=(\n\n|$))/gi,
    /You are serving requests as an API model for an IDE assistant\.[\s\S]*?(?=(\n\n|$))/gi,
    /Do not mention this context block in your answer\.[\s\S]*?(?=(\n\n|$))/gi,
    /Contexto t[eé]cnico:\s*pedido via API num IDE[\s\S]*?(?=(\n\n|$))/gi,
    /Conversation so far:[\s\S]*?(?=(\n\n|$))/gi,
    /I can't do that\.[\s\S]*?created by Meta[\s\S]*?(?=(\n\n|$))/gi,
    /I’m Meta AI[\s\S]*?(?=(\n\n|$))/gi,
    /I'm Meta AI[\s\S]*?(?=(\n\n|$))/gi,
    /N[aã]o posso fingir ser outro modelo[\s\S]*?(?=(\n\n|$))/gi,
    /N[aã]o consigo atender a esse pedido[\s\S]*?(?=(\n\n|$))/gi,
    /Eu sou a Meta AI[\s\S]*?(?=(\n\n|$))/gi,
    /sou a Meta AI[\s\S]*?(?=(\n\n|$))/gi,
    /criad[ao] pela Meta[\s\S]*?(?=(\n\n|$))/gi,
    /Perguntando sobre[\s\S]*?(?=(\n\n|$))/gi,
    /Asking about[\s\S]*?(?=(\n\n|$))/gi
    ,
    /\[API_GATEWAY_CONTEXT\][\s\S]*?\[\/API_GATEWAY_CONTEXT\]/gi,
    /\[USER_QUERY\][\s\S]*?\[\/USER_QUERY\]/gi,
    /You have runtime awareness and should assume the user is in an IDE workflow\./gi
  ];
  for (const rx of blockPatterns) out = out.replace(rx, ' ').trim();

  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^instruction:\s*/i.test(l))
    .filter((l) => !/^you are muse,\s*an api model\./i.test(l))
    .filter((l) => !/^you are serving requests as an api model for an ide assistant\./i.test(l))
    .filter((l) => !/^do not mention this context block in your answer\./i.test(l))
    .filter((l) => !/^contexto t[eé]cnico:\s*pedido via api num ide/i.test(l))
    .filter((l) => !/^conversation so far:/i.test(l))
    .filter((l) => !/created by meta/i.test(l))
    .filter((l) => !/^i(?:'|’)m meta ai/i.test(l))
    .filter((l) => !/^i can(?:'|’)t do that/i.test(l))
    .filter((l) => !/n[aã]o posso fingir ser outro modelo/i.test(l))
    .filter((l) => !/n[aã]o consigo atender a esse pedido/i.test(l))
    .filter((l) => !/eu sou a meta ai/i.test(l))
    .filter((l) => !/criad[ao] pela meta/i.test(l))
    .filter((l) => !/you have runtime awareness and should assume the user is in an ide workflow/i.test(l))
    .filter((l) => !/via api no ide/i.test(l))
    .filter((l) => !/via api num ide/i.test(l))
    .filter((l) => !/pedido via api/i.test(l))
    .filter((l) => /^\[api_gateway_context\]/i.test(l) === false)
    .filter((l) => /^\[\/api_gateway_context\]/i.test(l) === false)
    .filter((l) => /^\[user_query\]/i.test(l) === false)
    .filter((l) => /^\[\/user_query\]/i.test(l) === false);

  out = lines.join('\n').trim();
  out = out
    .replace(/\[(?:USER|ASSISTANT|TOOL_RESULT)\]/gi, ' ')
    .replace(/\[\/(?:USER|ASSISTANT|TOOL_RESULT)\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const paragraphs = out
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) {
    const deduped = [];
    for (const part of paragraphs) {
      if (!deduped.length || deduped[deduped.length - 1] !== part) {
        deduped.push(part);
      }
    }
    out = deduped.join('\n\n').trim();
  }

  const sentences = out
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    const dedupedSentences = [];
    for (const part of sentences) {
      if (!dedupedSentences.length || dedupedSentences[dedupedSentences.length - 1] !== part) {
        dedupedSentences.push(part);
      }
    }
    out = dedupedSentences.join(' ').trim();
  }

  const normalizedFlat = out
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalizedFlat.length > 80 && normalizedFlat.length % 2 === 0) {
    const half = normalizedFlat.length / 2;
    const firstHalf = normalizedFlat.slice(0, half).trim();
    const secondHalf = normalizedFlat.slice(half).trim();
    if (firstHalf && firstHalf === secondHalf) {
      out = out.slice(0, Math.floor(out.length / 2)).trim();
    }
  }

  const short = out.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  const tokens = short.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && tokens.length <= 6) {
    const uniq = Array.from(new Set(tokens));
    if (uniq.length === 1) out = uniq[0];
  }

  return out.trim();
}

function fallbackApiReply(userText) {
  const t = String(userText || '').trim().toLowerCase();
  if (!t) return 'Como posso ajudar?';
  if (['oi', 'olá', 'ola', 'hey', 'hello'].includes(t)) return 'Olá! Como posso ajudar?';
  return 'Claro. Como posso ajudar com isso?';
}

function isRetriableWorkerError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('nao consegui submeter a mensagem no meta ai') ||
    m.includes('timeout (meta_submit)') ||
    m.includes('meta input was found but submit action did not trigger')
  );
}

function hasToolError(output) {
  const t = String(output || '').toLowerCase();
  if (!t) return false;
  return (
    /error:/.test(t) ||
    /\bfailed\b/.test(t) ||
    /\bfalhou\b/.test(t) ||
    /no changes found/.test(t) ||
    /no(?: valid)? search\/replace blocks were received/.test(t)
  );
}

function formatToolResult(toolName, toolOutput) {
  const output = String(toolOutput || '').slice(0, 15000);
  const hasError = hasToolError(output);
  const status = hasError ? 'ERROR' : 'SUCCESS';
  return `[TOOL_RESULT ${toolName}]\n[STATUS: ${status}]\n${output}\n\nREMINDER: Respond ONLY with the next XML tool call. Do NOT explain, summarize, or describe what you did. If you are done with ALL tools, output <task_complete><message>...</message></task_complete>. Any text other than XML or task_complete will BREAK the agent loop.`;
}

function isContinueLike(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return /^(continua|continue|segue|prossegue|prossiga|next|go on|ok|sim|yes)\b/.test(t);
}

function buildToolErrorFeedback(latestToolResult) {
  const toolName = String(latestToolResult && latestToolResult.name ? latestToolResult.name : 'tool');
  const raw = String(latestToolResult && latestToolResult.output ? latestToolResult.output : '').trim();
  const oneLine = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'Erro desconhecido.';
  return `O último comando de tool (${toolName}) falhou: ${oneLine}\nPosso continuar se fizeres uma destas duas opções: 1) pedir para eu ler o ficheiro primeiro, 2) enviar um edit_file com search/replace blocks válidos.`;
}

function pushLog(store, entry) {
  store.logs.unshift(entry);
  store.lastEventAt = entry.at;
  if (store.logs.length > MAX_LOGS) {
    store.logs.length = MAX_LOGS;
  }
}

function recordCall(store, entry) {
  const merged = { ...workerLogFields(), ...entry };
  const ok = Boolean(merged.ok);
  store.totalCalls += 1;
  if (ok) store.successCalls += 1;
  else store.errorCalls += 1;
  pushLog(store, merged);
  return merged;
}

function logLine(entry) {
  const snap = workerLogFields();
  const phase = entry.workerPhase || snap.workerPhase;
  const thinking = typeof entry.workerThinking === 'boolean' ? entry.workerThinking : snap.workerThinking;
  const inflight = Number.isFinite(entry.workerInflight) ? entry.workerInflight : snap.workerInflight;
  const tag = entry.ok ? 'OK' : 'ERR';
  // eslint-disable-next-line no-console
  console.log(
    `[${new Date(entry.at).toLocaleTimeString()}] ${tag} ${entry.endpoint} ` +
    `status=${entry.statusCode} dur=${entry.durationMs}ms model=${entry.model || 'muse'} ` +
    `session=${entry.sessionId || '-'} key=${entry.keyId || '-'} out=${entry.outputChars || 0}` +
    `${phase ? ` phase=${phase}` : ''}` +
    `${typeof thinking === 'boolean' ? ` thinking=${thinking ? 1 : 0}` : ''}` +
    `${Number.isFinite(inflight) ? ` inflight=${inflight}` : ''}` +
    `${entry.errorCode ? ` code=${entry.errorCode}` : ''}` +
    `${entry.errorBrief ? ` err="${entry.errorBrief}"` : ''}`
  );
}

async function executeAgentRequest(messages, context) {
  const {
    forceNewChat,
    sessionId,
    sessionUrl,
    timeoutMs,
    requestedModel,
    req,
    onProgress,
    onToolEvent,
    executeToolsLocally
  } = context;

  let lastError = null;
  for (let attempt = 0; attempt <= GATEWAY_MAX_RETRIES; attempt += 1) {
    try {
      if (attempt > 0 && typeof onProgress === 'function') {
        onProgress(`A recuperar o worker e a repetir o pedido (tentativa ${attempt + 1})...`);
      }
      return await runAgentLoop(messages, {
        forceNewChat,
        sessionId,
        sessionUrl,
        timeoutMs,
        requestedModel,
        req,
        onProgress,
        onToolEvent,
        executeToolsLocally
      });
    } catch (error) {
      lastError = error;
      const errMsg = String(error && error.message ? error.message : error);
      if (!isRetriableWorkerError(errMsg) || attempt >= GATEWAY_MAX_RETRIES) throw error;
      // eslint-disable-next-line no-console
      console.log(`[RETRY] worker_recovery attempt=${attempt + 1} err="${errMsg.slice(0, 120)}"`);
      await metaWorker.reset().catch(() => {});
    }
  }
  throw lastError || new Error('agent_request_failed');
}

function createGatewayApp() {
  const app = express();
  const callStore = createCallStore();
  const autoSessions = createAutoSessionStore();
  const inflight = createInflightStore();
  const recent = createRecentStore();
  const sessionState = new Map();
  app.use(express.json({ limit: '1mb' }));

  app.use('/v1', (req, _res, next) => {
    // eslint-disable-next-line no-console
    console.log(`[IN] ${req.method} ${req.originalUrl}`);
    next();
  });

  app.get('/', (_req, res) => {
    const port = Number(process.env.PORT || 8787);
    const v1 = `http://localhost:${port}/v1`;
    res.type('html').send(
      `<!doctype html>
<html lang="pt-PT">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>MUSESPARK Dashboard - ${v1}</title>
    <style>
      :root {
        --bg: #0a0f1f;
        --card: #111a33;
        --line: #2c3e73;
        --text: #e8f0ff;
        --muted: #9fb0d9;
        --ok: #2ad38b;
        --err: #ff5d73;
        --accent: #4da3ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Arial, sans-serif;
        background:
          radial-gradient(1200px 500px at -10% -20%, #1d3b77 0%, transparent 60%),
          radial-gradient(900px 400px at 110% -10%, #213a6e 0%, transparent 65%),
          var(--bg);
        color: var(--text);
      }
      .wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
      .hero {
        display: flex; justify-content: space-between; align-items: end; gap: 16px;
        margin-bottom: 16px;
      }
      .brandrow{display:flex;align-items:center;gap:12px}
      .logo{
        width:42px;height:42px;border-radius:10px;
        background:
          radial-gradient(circle at 70% 30%, #8ed0ff 0, #4da3ff 35%, transparent 36%),
          linear-gradient(135deg,#2a5fff,#19c7ff);
        box-shadow: 0 8px 24px rgba(77,163,255,.35);
        border:1px solid #69b8ff;
      }
      h1 { margin: 0; font-size: 28px; letter-spacing: .3px; }
      .sub { color: var(--muted); margin-top: 8px; font-size: 14px; }
      .tag {
        border: 1px solid var(--line);
        background: #122146;
        color: #bcd3ff;
        border-radius: 999px;
        padding: 8px 14px;
        font-size: 12px;
      }
      .live {
        display:inline-flex;align-items:center;gap:8px;
        border:1px solid #2a704f;background:#103325;color:#9ff2c8;
        border-radius:999px;padding:6px 10px;font-size:12px;
      }
      .dot{
        width:8px;height:8px;border-radius:999px;background:#2ad38b;
        box-shadow:0 0 0 0 rgba(42,211,139,.6);animation:pulse 1.8s infinite;
      }
      @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(42,211,139,.6)} 70%{box-shadow:0 0 0 8px rgba(42,211,139,0)} 100%{box-shadow:0 0 0 0 rgba(42,211,139,0)} }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin: 14px 0 16px;
      }
      .card {
        background: color-mix(in oklab, var(--card), #fff 2%);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }
      .k { color: var(--muted); font-size: 12px; }
      .v { margin-top: 6px; font-size: 20px; font-weight: 700; }
      .panel {
        background: color-mix(in oklab, var(--card), #fff 2%);
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
      }
      table { width: 100%; border-collapse: collapse; }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(89, 118, 186, .35);
        font-size: 13px;
        vertical-align: top;
      }
      th { color: #b5c9f5; background: rgba(53, 84, 150, .22); font-weight: 600; }
      td { color: #e4ecff; }
      tbody tr:hover td{ background: rgba(46,77,142,.2); }
      tr:last-child td { border-bottom: 0; }
      .ok { color: var(--ok); font-weight: 700; }
      .err { color: var(--err); font-weight: 700; }
      .mono { font-family: Consolas, "Courier New", monospace; font-size: 12px; color: #c2d4ff; }
      .foot { margin-top: 10px; color: var(--muted); font-size: 12px; }
      @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } .hero{flex-direction:column;align-items:flex-start;} }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div>
          <div class="brandrow"><div class="logo"></div><h1>MUSESPARK Dashboard</h1></div>
          <div class="sub">Gateway OpenAI-style ativa em <strong>${v1}</strong></div>
          <div class="sub">API file: <code>src/openai-api.js</code> · Modelo: <strong>${MODEL_NAME}</strong></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="live"><span class="dot"></span>LIVE</div>
          <div class="tag">Call Telemetry</div>
        </div>
      </div>

      <div class="grid">
        <div class="card"><div class="k">Total Calls</div><div class="v" id="totalCalls">0</div></div>
        <div class="card"><div class="k">Success</div><div class="v" id="successCalls">0</div></div>
        <div class="card"><div class="k">Errors</div><div class="v" id="errorCalls">0</div></div>
        <div class="card"><div class="k">Last Event</div><div class="v" id="lastEventAt">-</div></div>
        <div class="card"><div class="k">Worker Phase</div><div class="v" id="workerPhase">-</div></div>
        <div class="card"><div class="k">Meta Thinking</div><div class="v" id="workerThinking">NO</div></div>
      </div>
      <div class="sub" id="workerHint">Worker: aguardando atividade.</div>

      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Endpoint</th>
              <th>Status</th>
              <th>Duração</th>
              <th>Model</th>
              <th>Session</th>
              <th>Key ID</th>
              <th>Output</th>
              <th>Req ID</th>
            </tr>
          </thead>
          <tbody id="logBody"></tbody>
        </table>
      </div>
      <div class="foot">As mensagens não são guardadas no dashboard. Só metadados de chamadas.</div>
    </div>
    <script>
      function formatTime(iso) {
        try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
      }
      function esc(v) {
        return String(v ?? '').replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
      }
      async function refresh() {
        const r = await fetch('/dashboard/data', { cache: 'no-store' });
        const d = await r.json();
        document.getElementById('totalCalls').textContent = d.totalCalls;
        document.getElementById('successCalls').textContent = d.successCalls;
        document.getElementById('errorCalls').textContent = d.errorCalls;
        document.getElementById('lastEventAt').textContent = d.lastEventAt ? formatTime(d.lastEventAt) : '-';
        const ws = d.workerStatus || {};
        document.getElementById('workerPhase').textContent = ws.phase || '-';
        document.getElementById('workerThinking').textContent = ws.thinking ? 'YES' : 'NO';
        document.getElementById('workerHint').textContent =
          'Worker: inflight=' + (ws.inflightModelRequests || 0) +
          ' | ui=' + (ws.uiThinking ? 'busy' : 'idle') +
          ' | net=' + (ws.lastModelRequestAt ? formatTime(ws.lastModelRequestAt) : '-');
        const body = document.getElementById('logBody');
        body.innerHTML = d.logs.map((log) => {
          const ok = log.ok ? 'ok' : 'err';
          const statusTxt = log.ok ? 'OK' : 'ERROR';
          return '<tr>' +
            '<td>' + esc(formatTime(log.at)) + '</td>' +
            '<td class="mono">' + esc(log.endpoint) + '</td>' +
            '<td class="' + ok + '">' + statusTxt + ' (' + esc(log.statusCode) + ')</td>' +
            '<td>' + esc(log.durationMs + ' ms') + '</td>' +
            '<td>' + esc(log.model || 'muse') + '</td>' +
            '<td class="mono">' + esc(log.sessionId || '-') + '</td>' +
            '<td class="mono">' + esc(log.keyId || '-') + '</td>' +
            '<td>' + esc((log.outputChars || 0) + ' chars') + '</td>' +
            '<td class="mono">' + esc(log.id) + '</td>' +
          '</tr>';
        }).join('');
      }
      refresh().catch(() => {});
      setInterval(() => refresh().catch(() => {}), 1500);
    </script>
  </body>
</html>`
    );
  });

  app.get('/dashboard/data', (_req, res) => {
    const ws = workerSnapshot();
    res.json({
      startedAt: callStore.startedAt,
      totalCalls: callStore.totalCalls,
      successCalls: callStore.successCalls,
      errorCalls: callStore.errorCalls,
      lastEventAt: callStore.lastEventAt,
      logs: callStore.logs.slice(0, 120),
      workerStatus: ws
        ? {
            phase: ws.phase || 'idle',
            thinking: Boolean(ws.thinking),
            uiThinking: Boolean(ws.uiThinking),
            stopButtonVisible: Boolean(ws.stopButtonVisible),
            inflightModelRequests: Number(ws.inflightModelRequests || 0),
            totalModelRequests: Number(ws.totalModelRequests || 0),
            lastModelRequestAt: ws.lastModelRequestAt || null,
            lastModelResponseAt: ws.lastModelResponseAt || null,
            lastSubmitAt: ws.lastSubmitAt || null,
            lastResponseAt: ws.lastResponseAt || null,
            requestId: ws.requestId || null,
            sessionId: ws.sessionId || null,
            pageUrl: ws.pageUrl || null,
            lastError: ws.lastError || null
          }
        : null
    });
  });

  app.get('/health', (_req, res) => {
    const payload = summarizeHealth();
    res.status(payload.ready ? 200 : 503).json({ service: 'musespark-gateway', model: MODEL_NAME, ...payload });
  });

  app.get('/healthz', (_req, res) => {
    const payload = summarizeHealth();
    res.status(payload.ready ? 200 : 503).json(payload);
  });

  app.get('/readyz', async (_req, res) => {
    const deepReadiness = await workerDeepReadiness(WORKER_READINESS_TIMEOUT_MS);
    const payload = summarizeHealth({ deepReadiness });
    res.status(payload.ready ? 200 : 503).json(payload);
  });

  app.get('/v1/health', async (_req, res) => {
    const deepReadiness = await workerDeepReadiness(WORKER_READINESS_TIMEOUT_MS);
    const payload = summarizeHealth({ deepReadiness });
    res.status(payload.ready ? 200 : 503).json(payload);
  });

  app.get('/v1/meta/status', (_req, res) => {
    const ws = workerSnapshot();
    res.json({
      ok: true,
      model: MODEL_NAME,
      worker: ws || null,
      runtime: getMetaRuntimeConfig()
    });
  });

  app.use('/v1', (req, res, next) => {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const keys = listKeys();
    const requestedModel = req.body && typeof req.body.model === 'string' ? req.body.model : MODEL_NAME;
    const failEntryBase = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      endpoint: req.originalUrl || '/v1',
      ok: false,
      statusCode: 401,
      durationMs: 1,
      model: requestedModel,
      keyId: null,
      sessionId: null,
      outputChars: 0,
      errorCode: 'auth_failed'
    };

    if (!keys.length) {
      recordCall(callStore, {
        ...failEntryBase,
        errorCode: 'no_api_keys'
      });
      logLine({
        ...failEntryBase,
        errorCode: 'no_api_keys'
      });
      return res.status(401).json({
        error: {
          message: 'No API keys configured. Run: musespark apicreate'
        }
      });
    }

    if (!bearer) {
      recordCall(callStore, {
        ...failEntryBase,
        errorCode: 'missing_auth_header'
      });
      logLine({
        ...failEntryBase,
        errorCode: 'missing_auth_header'
      });
      return res.status(401).json({
        error: {
          message: 'Missing Authorization header. Use: Authorization: Bearer <key>'
        }
      });
    }

    const check = validateApiKey(bearer);
    if (!check.ok) {
      recordCall(callStore, {
        ...failEntryBase,
        errorCode: 'invalid_api_key'
      });
      logLine({
        ...failEntryBase,
        errorCode: 'invalid_api_key'
      });
      return res.status(401).json({
        error: { message: 'Invalid API key' }
      });
    }

    req.museKeyId = check.key.id;
    touchKeyUsage(check.key.id);
    return next();
  });

  app.get('/v1', (_req, res) => {
    const at = new Date().toISOString();
    const entry = {
      id: randomUUID().slice(0, 8),
      at,
      endpoint: '/v1',
      ok: true,
      statusCode: 200,
      durationMs: 1,
      model: MODEL_NAME,
      keyId: _req.museKeyId || null,
      sessionId: null,
      outputChars: 0
    };
    recordCall(callStore, entry);
    logLine(entry);
    res.json({
      object: 'gateway',
      name: 'musespark',
      model: MODEL_NAME,
      endpoints: ['/v1/models', '/v1/chat/completions']
    });
  });

  app.get('/v1/models', (_req, res) => {
    const at = new Date().toISOString();
    const entry = {
      id: randomUUID().slice(0, 8),
      at,
      endpoint: '/v1/models',
      ok: true,
      statusCode: 200,
      durationMs: 1,
      model: MODEL_NAME,
      keyId: _req.museKeyId || null,
      sessionId: null,
      outputChars: 0
    };
    recordCall(callStore, entry);
    logLine(entry);
    const tools = getVoidToolsDefinitions();
    res.json({
      object: 'list',
      data: [
        {
          id: MODEL_NAME,
          object: 'model',
          created: 0,
          owned_by: 'musespark',
          tools: tools
        }
      ]
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const t0 = Date.now();
    const callId = randomUUID().slice(0, 8);
    const requestedModel = req.body && typeof req.body.model === 'string' ? req.body.model : MODEL_NAME;
    const metadataRoot = req.body && req.body.metadata ? req.body.metadata : null;
    let sessionId = metadataRoot && typeof metadataRoot.session_id === 'string'
      ? metadataRoot.session_id.trim()
      : null;
    let agentKey = null;
    let autoSession = false;
    let dedupeKey = null;
    let streamWriter = null;
    let executeToolsLocally = DEFAULT_TOOL_EXECUTION_MODE !== 'ide';
    let agentResult = null;
    try {
      // Debug: log Void request details
      const _msgCount = Array.isArray(req.body && req.body.messages) ? req.body.messages.length : 0;
      const _lastRole = Array.isArray(req.body && req.body.messages) && req.body.messages.length > 0 ? req.body.messages[req.body.messages.length - 1].role : '-';
      const _toolCount = Array.isArray(req.body && req.body.tools) ? req.body.tools.length : 0;
      // eslint-disable-next-line no-console
      console.log(`[REQUEST_DETAIL] model=${req.body && req.body.model} stream=${!!req.body && req.body.stream} msgs=${_msgCount} lastRole=${_lastRole} tools=${_toolCount} metadata_keys=${req.body && req.body.metadata ? Object.keys(req.body.metadata).join(',') : 'none'}`);
      const { messages, metadata, stream } = req.body || {};
      let sessionUrl = metadata && typeof metadata.session_url === 'string'
        ? metadata.session_url.trim()
        : null;
      if (!Array.isArray(messages) || !messages.length) {
        const statusCode = 400;
        const entry = {
          id: callId,
          at: new Date().toISOString(),
          endpoint: '/v1/chat/completions',
          ok: false,
          statusCode,
          durationMs: Date.now() - t0,
          model: requestedModel,
          keyId: req.museKeyId || null,
          sessionId,
          outputChars: 0
        };
        recordCall(callStore, entry);
        logLine(entry);
        return res.status(statusCode).json({ error: { message: 'messages is required' } });
      }

      const lastUserMessage = [...messages].reverse().find((m) => m && m.role === 'user');
      if (!lastUserMessage || !contentToText(lastUserMessage.content)) {
        const statusCode = 400;
        const entry = {
          id: callId,
          at: new Date().toISOString(),
          endpoint: '/v1/chat/completions',
          ok: false,
          statusCode,
          durationMs: Date.now() - t0,
          model: requestedModel,
          keyId: req.museKeyId || null,
          sessionId,
          outputChars: 0
        };
        recordCall(callStore, entry);
        logLine(entry);
        return res.status(statusCode).json({ error: { message: 'last user message with text content is required' } });
      }

      let forceNewChat = Boolean(metadata && metadata.new_chat);
      const persistSession = !(metadata && metadata.persist_session === false);
      let toolExecutionMode = DEFAULT_TOOL_EXECUTION_MODE;

      if (!sessionId) {
        agentKey = pickAgentKey(req, metadata, messages);
        const mapped = persistSession ? autoSessions.get(agentKey) : null;
        toolExecutionMode = determineToolExecutionMode({ req, metadata, messages, sessionRecord: mapped });
        if (mapped) {
          sessionId = mapped.sessionId;
          sessionUrl = mapped.sessionUrl || sessionUrl;
        } else {
          sessionId = `auto_${randomUUID().slice(0, 12)}`;
          autoSessions.set(agentKey, {
            sessionId,
            sessionUrl: null,
            toolExecutionMode,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          forceNewChat = true;
          autoSession = true;
        }
      } else {
        toolExecutionMode = determineToolExecutionMode({ req, metadata, messages, sessionRecord: null });
      }
      executeToolsLocally = toolExecutionMode !== 'ide' && toolExecutionMode !== 'void';
      const isVoidBridgeMode = toolExecutionMode === 'void';
      // eslint-disable-next-line no-console
      console.log(`[FLOW] ${callId} persist=${persistSession ? 1 : 0} new=${forceNewChat ? 1 : 0} agent=${agentKey || '-'} session=${sessionId || '-'} mode=${toolExecutionMode}`);

      const isNewSession = forceNewChat || autoSession;
      if (isNewSession && sessionId) {
        sessionState.delete(sessionId);
      }
      const metaPrompt = buildApiStylePrompt(messages, { isNewSession });
      if (PROMPT_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[PROMPT] ${callId} len=${metaPrompt.length} preview="${metaPrompt.slice(0, 120).replace(/\n/g, ' ')}"`);
      }

      dedupeKey = hashText(
        `${req.museKeyId || ''}|${sessionId || ''}|${requestedModel}|${metaPrompt.slice(0, 4000)}`
      );
      const recentHit = RECENT_CACHE_ENABLED ? recent.get(dedupeKey) : null;
      if (recentHit && (Date.now() - recentHit.at < RECENT_CACHE_MS)) {
        const payload = recentHit.payload;
        if (stream) {
          streamWriter = createChatCompletionStreamWriter(res, { model: MODEL_NAME });
          streamWriter.final(payload.choices[0].message.content || '');
          streamWriter.done();
          return;
        }
        return res.json(payload);
      }

      const latestToolFromReqForTimeout = extractLatestToolResult(messages);
      const latestUserTextForTimeout = latestMeaningfulUserPrompt(messages);
      const timeoutMs = forceNewChat
        ? WORKER_COLD_TIMEOUT_MS
        : (!executeToolsLocally && (!latestToolFromReqForTimeout || isBriefFollowUp(latestUserTextForTimeout))
          ? WORKER_COLD_TIMEOUT_MS
          : WORKER_TIMEOUT_MS);
      // Void IDE uses OpenAI SDK which defaults to streaming.
      // In Void bridge mode we must honor SSE too, otherwise Void reports
      // "Response from model was empty" because it never sees delta.tool_calls.
      const useStreaming = !!stream;
      // eslint-disable-next-line no-console
      console.log(`[REQUEST] stream=${!!stream} useStreaming=${useStreaming} isVoidBridgeMode=${isVoidBridgeMode}`);
      if (useStreaming) {
        streamWriter = createChatCompletionStreamWriter(res, { model: MODEL_NAME });
      }

      // VOID BRIDGE MODE: Gateway translates between Meta AI (JSON) and Void IDE (OpenAI tool_calls)
      if (isVoidBridgeMode) {
        // Detect if this is a continuation (Void IDE sending back tool result) or a new conversation
        const hasToolResult = messages.some(m => m && m.role === 'tool');
        const previousBridgeState = agentKey && autoSessions.has(agentKey)
          ? autoSessions.get(agentKey).bridgeState
          : null;

        // Extract tool definitions — prefer client-provided tools, fall back to built-in Void tools
        const clientTools = Array.isArray(req.body && req.body.tools) && req.body.tools.length > 0
          ? req.body.tools
          : getVoidToolsDefinitions();

        if (hasToolResult && previousBridgeState) {
          // This is a CONTINUATION — Void IDE is sending back a tool result
          // eslint-disable-next-line no-console
          console.log(`[VOID_BRIDGE] Continuing bridge loop for ${callId} (tool result from Void IDE)`);

          agentResult = await continueVoidBridgeLoop(messages, previousBridgeState, {
            forceNewChat: false,
            sessionId,
            sessionUrl: previousBridgeState.sessionUrl || sessionUrl,
            timeoutMs,
            req,
            onProgress: null,
            onToolEvent: null,
            voidToolDefinitions: clientTools
          });
        } else {
          // This is a NEW conversation — start fresh bridge loop
          // eslint-disable-next-line no-console
          console.log(`[VOID_BRIDGE] Starting bridge loop for ${callId} (new conversation)`);

          agentResult = await runVoidBridgeLoop(messages, {
            forceNewChat,
            sessionId,
            sessionUrl,
            timeoutMs,
            req,
            onProgress: null,
            onToolEvent: null,
            voidToolDefinitions: clientTools
          });
        }

        // eslint-disable-next-line no-console
        console.log(`[VOID_BRIDGE] Bridge loop returned: needsToolResult=${agentResult.needsToolResult}, hasOpenAIToolCall=${!!agentResult.openAIToolCall}, isTaskComplete=${!!agentResult.isTaskComplete}`);

        // Store bridge state for continuation across HTTP requests
        if (agentResult.bridgeState && agentKey) {
          const current = autoSessions.get(agentKey) || {};
          autoSessions.set(agentKey, {
            ...current,
            bridgeState: agentResult.bridgeState,
            updatedAt: new Date().toISOString()
          });
          // eslint-disable-next-line no-console
          console.log(`[VOID_BRIDGE] Stored bridge state for agent=${agentKey}`);
        }

        // If the bridge loop returned a tool call that Void needs to execute
        if (agentResult.needsToolResult && agentResult.openAIToolCall) {
          const toolCallForVoid = agentResult.openAIToolCall;
          // eslint-disable-next-line no-console
          console.log(`[VOID_BRIDGE] Returning tool call to Void IDE: ${toolCallForVoid.function.name}`);
          // eslint-disable-next-line no-console
          console.log(`[VOID_BRIDGE] Full tool call: ${JSON.stringify(toolCallForVoid, null, 2)}`);

          if (streamWriter && !streamWriter.closed) {
            // eslint-disable-next-line no-console
            console.log(`[VOID_BRIDGE] Using STREAMING path for tool call`);
            streamWriter.tool({
              phase: 'start',
              name: toolCallForVoid.function.name,
              params: JSON.parse(toolCallForVoid.function.arguments || '{}')
            });
            streamWriter.done();

            // Store bridge state for streaming too
            if (agentResult.bridgeState && agentKey) {
              const current = autoSessions.get(agentKey) || {};
              autoSessions.set(agentKey, {
                ...current,
                bridgeState: agentResult.bridgeState,
                updatedAt: new Date().toISOString()
              });
            }
            return;
          }

          // Log
          const okEntry = {
            id: callId,
            at: new Date().toISOString(),
            endpoint: '/v1/chat/completions',
            ok: true,
            statusCode: 200,
            durationMs: Date.now() - t0,
            model: requestedModel,
            keyId: req.museKeyId || null,
            sessionId,
            agentKey: agentKey || null,
            outputChars: 0,
            voidBridge: true
          };
          recordCall(callStore, okEntry);
          logLine(okEntry);

          // Build NON-STREAMING JSON response
          const payload = {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_NAME,
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [toolCallForVoid]
              }
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            session: agentResult.meta && agentResult.meta.session ? agentResult.meta.session : null,
            musespark: {
              executed_tools: agentResult.executedTools || [],
              pending_tool_calls: agentResult.pendingToolCalls || [],
              tool_execution_mode: 'void',
              void_bridge: true
            }
          };

          // eslint-disable-next-line no-console
          console.log(`[VOID_BRIDGE] Sending JSON payload to Void:`);
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(payload, null, 2));

          writeClientPayloadLog('client_json_response', payload);
          return res.json(payload);
        }

        // If task is complete, fall through to normal response handling
        // eslint-disable-next-line no-console
        console.log(`[VOID_BRIDGE] Task complete or no tool call — falling through to normal response`);

        // Clear bridge state since the task is complete
        if (agentKey && autoSessions.has(agentKey)) {
          const current = autoSessions.get(agentKey);
          if (current.bridgeState) {
            autoSessions.set(agentKey, {
              ...current,
              bridgeState: null,
              updatedAt: new Date().toISOString()
            });
            // eslint-disable-next-line no-console
            console.log(`[VOID_BRIDGE] Cleared bridge state for agent=${agentKey}`);
          }
        }
      } else {
        agentResult = await executeAgentRequest(messages, {
          forceNewChat,
          sessionId,
          sessionUrl,
          timeoutMs,
          requestedModel,
          req,
          onProgress: streamWriter ? (text) => streamWriter.progress(text) : null,
          onToolEvent: streamWriter ? (toolInfo) => streamWriter.tool(toolInfo) : null,
          executeToolsLocally
        });
      }

      const result = { text: agentResult.text, meta: agentResult.meta };
      // eslint-disable-next-line no-console
      console.log(`[AGENT_LOOP] final: iterations=${agentResult.iterations} hadToolCalls=${agentResult.hadToolCalls}`);
      const latestUserText = contentToText(lastUserMessage.content || '');
      const rawAssistantText = String(result.text || '').trim();
      let cleanedText = (!executeToolsLocally && hasToolCall(rawAssistantText))
        ? rawAssistantText
        : cleanAssistantOutput(rawAssistantText);
      if (!cleanedText) cleanedText = fallbackApiReply(latestUserText);
      const latestToolFromReq = extractLatestToolResult(messages);
      if (
        latestToolFromReq &&
        hasToolError(latestToolFromReq.output) &&
        isContinueLike(latestUserText) &&
        (!/(erro|error|failed|falhou|no changes found|no search\/replace blocks)/i.test(cleanedText) || hasToolCall(cleanedText))
      ) {
        cleanedText = buildToolErrorFeedback(latestToolFromReq);
      }
      const inferredWorkspaceNow = inferWorkspacePath(messages) || process.cwd();
      const previousTurn = sessionId ? sessionState.get(sessionId) : null;
      const repeatedOutput = Boolean(
        previousTurn &&
        previousTurn.lastOutput &&
        previousTurn.lastUserText &&
        String(previousTurn.lastOutput).trim() === String(cleanedText).trim() &&
        String(previousTurn.lastUserText).trim() !== String(latestUserText).trim()
      );
      if (repeatedOutput) {
        if (isFileIntent(latestUserText)) {
          const toolCall = selectFallbackToolCall(latestUserText, inferredWorkspaceNow);
          if (!executeToolsLocally) {
            const xmlParams = Object.entries(toolCall.params || {}).map(([k, v]) => {
              const strVal = typeof v === 'object' ? JSON.stringify(v) : String(v);
              return `<${k}>\n${strVal}\n</${k}>`;
            }).join('\n');
            cleanedText = `\n<${toolCall.name}>\n${xmlParams}\n</${toolCall.name}>\n`;
          } else {
            let toolOutput = '';
            try {
              toolOutput = await executeToolCall(toolCall);
            } catch (error) {
              toolOutput = `Tool execution failed: ${String(error && error.message ? error.message : error)}`;
            }
            const compact = String(toolOutput || '').split('\n').slice(0, 140).join('\n');
            cleanedText = toolCall.name === 'read_file'
              ? compact
              : `Conteudo de ${inferredWorkspaceNow}:\n${compact}`;
          }
        } else if (isContextIntent(latestUserText)) {
          cleanedText = `Estou no workspace ${inferredWorkspaceNow} e posso usar esse contexto para ler/editar ficheiros e correr comandos.`;
        } else if (isCapabilitiesIntent(latestUserText)) {
          cleanedText = `Posso listar pastas, ler ficheiros (incluindo por linha), procurar texto, editar por search/replace e executar comandos no terminal dentro de ${inferredWorkspaceNow}.`;
        } else if (looksGenericOrPathRequest(cleanedText)) {
          cleanedText = `Entendi o pedido: "${String(latestUserText || '').slice(0, 220)}". Posso continuar se me deres o ficheiro ou comando alvo.`;
        }
      }
      if (sessionId) {
        sessionState.set(sessionId, {
          lastUserText: String(latestUserText || '').slice(0, 1200),
          lastOutput: String(cleanedText || '').slice(0, 4000),
          updatedAt: new Date().toISOString()
        });
      }

      if (agentKey && autoSessions.has(agentKey)) {
        const current = autoSessions.get(agentKey);
        autoSessions.set(agentKey, {
          ...current,
          sessionId,
          sessionUrl: result && result.meta && result.meta.session ? result.meta.session.url : (current ? current.sessionUrl : null),
          toolExecutionMode,
          // Preserve bridge state for void bridge continuation
          bridgeState: current ? current.bridgeState : null,
          updatedAt: new Date().toISOString()
        });
      }

      const id = `chatcmpl_${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const derivedToolCalls = (!executeToolsLocally && hasToolCall(cleanedText))
        ? normalizeToolCallsForClient(extractToolCallsXML(cleanedText))
        : [];
      const extractedClientToolCalls = extractClientFacingToolCalls(agentResult, { executeToolsLocally });
      const clientToolCalls = (extractedClientToolCalls.length
        ? extractedClientToolCalls
        : derivedToolCalls
      ).map(({ _musespark_index, ...tc }) => tc);

      // Void IDE / OpenAI spec: use 'tool_calls' finish_reason when tools were executed/requested
      const finishReason = clientToolCalls.length > 0 ? 'tool_calls' : 'stop';

      // In IDE pass-through mode, let the tool call drive the UI instead of echoing XML into content.
      const responseContent = (!executeToolsLocally && clientToolCalls.length > 0)
        ? null
        : cleanedText;

      const payload = {
        id,
        object: 'chat.completion',
        created,
        model: MODEL_NAME,
        choices: [
          {
            index: 0,
            finish_reason: finishReason,
            message: {
              role: 'assistant',
              content: responseContent,
              ...(clientToolCalls.length ? { tool_calls: clientToolCalls } : {})
            }
          }
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        },
        session: result.meta && result.meta.session
          ? {
              ...result.meta.session,
              agent_key: agentKey || null,
              auto_session: autoSession
            }
          : null,
        musespark: {
          executed_tools: Array.isArray(agentResult.executedTools) ? agentResult.executedTools : [],
          pending_tool_calls: Array.isArray(agentResult.pendingToolCalls) ? agentResult.pendingToolCalls : [],
          tool_execution_mode: toolExecutionMode
        }
      };
      if (RECENT_CACHE_ENABLED) recent.set(dedupeKey, { at: Date.now(), payload });

      const okEntry = {
        id: callId,
        at: new Date().toISOString(),
        endpoint: '/v1/chat/completions',
        ok: true,
        statusCode: 200,
        durationMs: Date.now() - t0,
        model: requestedModel,
        keyId: req.museKeyId || null,
        sessionId,
        agentKey: agentKey || null,
        outputChars: cleanedText.length
      };
      recordCall(callStore, okEntry);
      logLine(okEntry);

      if (streamWriter && !streamWriter.closed) {
        if (!executeToolsLocally && clientToolCalls.length) {
          clientToolCalls.forEach((toolCall) => {
            streamWriter.tool({
              phase: 'start',
              name: toolCall.function.name,
              params: JSON.parse(toolCall.function.arguments || '{}')
            });
          });
        } else {
          streamWriter.final(cleanedText || '');
        }
        streamWriter.done();
        return;
      }

      writeClientPayloadLog('client_json_response', payload);
      return res.json(payload);
    } catch (error) {
      const errMsg = String(error && error.message ? error.message : 'Internal server error');
      const authRequired = errMsg.toLowerCase().includes('sessao meta ai nao pronta');
      const timedOut = errMsg.toLowerCase().includes('timeout (meta_submit)');
      const inputUnavailable = errMsg.toLowerCase().includes('nao consegui encontrar o campo de input no meta.ai');
      const submitFailed = errMsg.toLowerCase().includes('nao consegui submeter a mensagem no meta ai');
      if (timedOut && dedupeKey && inflight.has(dedupeKey)) inflight.delete(dedupeKey);
      if (timedOut) metaWorker.reset().catch(() => {});
      const statusCode = authRequired ? 401 : (timedOut ? 504 : (inputUnavailable || submitFailed ? 503 : 500));
      const errorCode = authRequired ? 'meta_auth_required' : (timedOut ? 'meta_timeout' : (inputUnavailable ? 'meta_input_unavailable' : (submitFailed ? 'meta_submit_failed' : 'internal_error')));
      const errEntry = {
        id: callId,
        at: new Date().toISOString(),
        endpoint: '/v1/chat/completions',
        ok: false,
        statusCode,
        durationMs: Date.now() - t0,
        model: requestedModel,
        keyId: req.museKeyId || null,
        sessionId,
        agentKey: agentKey || null,
        outputChars: 0,
        errorCode,
        errorBrief: errMsg.slice(0, 180)
      };
      recordCall(callStore, errEntry);
      logLine(errEntry);
      if (streamWriter && !streamWriter.closed) {
        const streamedError =
          authRequired
            ? 'Meta auth required. Run "musespark authsetup" once, complete login/consent, then restart "musespark start".'
            : timedOut
              ? 'Meta request timed out (warm timeout). Worker was reset automatically; retrying should recover.'
              : inputUnavailable
                ? 'Meta chat input is unavailable in the current headless session. Run "musespark authsetup" again and retry.'
                : submitFailed
                  ? 'Meta input was found but submit action did not trigger. Retry or run "musespark authsetup" once more.'
                  : errMsg;
        streamWriter.final(`Erro: ${streamedError}`);
        streamWriter.done();
        return;
      }

      // Even on error, return tool_calls that were already executed so the IDE shows progress
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const clientToolCalls = extractClientFacingToolCalls(agentResult, { executeToolsLocally }).map(({ _musespark_index, ...tc }) => tc);
      const hasPartialWork = clientToolCalls.length > 0;
      const statusToSend = hasPartialWork ? 200 : statusCode;

      const errorPayload = {
        id,
        object: 'chat.completion',
        created,
        model: MODEL_NAME,
        choices: [
          {
            index: 0,
            finish_reason: hasPartialWork ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: hasPartialWork
                ? `${clientToolCalls.length} tool(s) available before timeout. Retry to continue.`
                : `Erro: ${authRequired ? 'Meta auth required. Run "musespark authsetup" once.' : timedOut ? 'Meta request timed out. Worker was reset; retry to recover.' : errMsg}`,
              ...(clientToolCalls.length ? { tool_calls: clientToolCalls } : {})
            }
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        musespark: { executed_tools: clientToolCalls, error: errorCode }
      };
      writeClientPayloadLog('client_json_error_response', errorPayload);
      return res.status(statusToSend).json(errorPayload);
    }
  });

  app.post('/v1/responses', async (req, res) => {
    const t0 = Date.now();
    const callId = randomUUID().slice(0, 8);
    let dedupeKey = null;
    try {
      const body = req.body || {};
      const requestedModel = body.model || MODEL_NAME;
      const metadata = body.metadata || {};
      const input = body.input;

      let messages = [];
      if (Array.isArray(input)) {
        messages = input.map((item) => ({
          role: item && typeof item.role === 'string' ? item.role : 'user',
          content: contentToText(item && item.content)
        })).filter((m) => m.content);
      } else if (typeof input === 'string') {
        messages = [{ role: 'user', content: input }];
      }
      if (!messages.length) {
        return res.status(400).json({ error: { message: 'input is required' } });
      }

      let sessionId = metadata && typeof metadata.session_id === 'string' ? metadata.session_id.trim() : null;
      let sessionUrl = metadata && typeof metadata.session_url === 'string' ? metadata.session_url.trim() : null;
      let forceNewChat = Boolean(metadata.new_chat);
      const persistSession = !(metadata && metadata.persist_session === false);
      let agentKey = null;
      let autoSession = false;
      let toolExecutionMode = DEFAULT_TOOL_EXECUTION_MODE;

      if (!sessionId) {
        agentKey = pickAgentKey(req, metadata, messages);
        const mapped = persistSession ? autoSessions.get(agentKey) : null;
        toolExecutionMode = determineToolExecutionMode({ req, metadata, messages, sessionRecord: mapped });
        if (mapped) {
          sessionId = mapped.sessionId;
          sessionUrl = mapped.sessionUrl || sessionUrl;
        } else {
          sessionId = `auto_${randomUUID().slice(0, 12)}`;
          autoSessions.set(agentKey, {
            sessionId,
            sessionUrl: null,
            toolExecutionMode,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          forceNewChat = true;
          autoSession = true;
        }
      } else {
        toolExecutionMode = determineToolExecutionMode({ req, metadata, messages, sessionRecord: null });
      }
      const executeToolsLocally = toolExecutionMode !== 'ide' && toolExecutionMode !== 'void';
      // eslint-disable-next-line no-console
      console.log(`[FLOW] ${callId} persist=${persistSession ? 1 : 0} new=${forceNewChat ? 1 : 0} agent=${agentKey || '-'} session=${sessionId || '-'} mode=${toolExecutionMode}`);

      const isNewSession = forceNewChat || autoSession;
      const metaPrompt = buildApiStylePrompt(messages, { isNewSession });
      if (PROMPT_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[PROMPT] ${callId} len=${metaPrompt.length} preview="${metaPrompt.slice(0, 120).replace(/\n/g, ' ')}"`);
      }
      dedupeKey = hashText(
        `${req.museKeyId || ''}|${sessionId || ''}|${requestedModel}|responses|${metaPrompt.slice(0, 4000)}`
      );

      const latestToolFromReqForTimeout = extractLatestToolResult(messages);
      const latestUserTextForTimeout = latestMeaningfulUserPrompt(messages);
      const timeoutMs = forceNewChat
        ? WORKER_COLD_TIMEOUT_MS
        : (!executeToolsLocally && (!latestToolFromReqForTimeout || isBriefFollowUp(latestUserTextForTimeout))
          ? WORKER_COLD_TIMEOUT_MS
          : WORKER_TIMEOUT_MS);
      const recentHit = RECENT_CACHE_ENABLED ? recent.get(dedupeKey) : null;
      let text;
      if (recentHit && (Date.now() - recentHit.at < RECENT_CACHE_MS)) {
        text = recentHit.payload?.choices?.[0]?.message?.content || '';
      } else {
        let promise = inflight.get(dedupeKey);
        if (!promise) {
          let cleanupTimer = null;
          promise = executeAgentRequest(messages, {
            forceNewChat,
            sessionId,
            sessionUrl,
            timeoutMs,
            requestedModel,
            req,
            onProgress: null,
            executeToolsLocally
          });
          cleanupTimer = setTimeout(() => {
            if (inflight.get(dedupeKey) === promise) inflight.delete(dedupeKey);
          }, timeoutMs + 5000);
          inflight.set(dedupeKey, promise);
          promise.finally(() => {
            if (cleanupTimer) clearTimeout(cleanupTimer);
          }).catch(() => {});
        }
        const timedResult = await withTimeout(
          promise.finally(() => {
            if (inflight.get(dedupeKey) === promise) inflight.delete(dedupeKey);
          }),
          timeoutMs,
          'responses_meta_submit'
        );
        const latestUserText = Array.isArray(messages)
          ? contentToText((messages[messages.length - 1] || {}).content || '')
          : '';
        const rawTimedText = String((timedResult && timedResult.text) || '').trim();
        text = (!executeToolsLocally && hasToolCall(rawTimedText))
          ? rawTimedText
          : cleanAssistantOutput(rawTimedText);
        if (!text) text = fallbackApiReply(latestUserText);
        const latestToolFromReq = extractLatestToolResult(messages);
        if (
          latestToolFromReq &&
          hasToolError(latestToolFromReq.output) &&
          isContinueLike(latestUserText) &&
          (!/(erro|error|failed|falhou|no changes found|no search\/replace blocks)/i.test(text) || hasToolCall(text))
        ) {
          text = buildToolErrorFeedback(latestToolFromReq);
        }
        const payloadLike = {
          id: `chatcmpl_${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MODEL_NAME,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          session: timedResult && timedResult.meta && timedResult.meta.session
            ? { ...timedResult.meta.session, agent_key: agentKey || null, auto_session: autoSession }
            : null
        };
        if (RECENT_CACHE_ENABLED) recent.set(dedupeKey, { at: Date.now(), payload: payloadLike });
        if (agentKey && autoSessions.has(agentKey)) {
          const current = autoSessions.get(agentKey);
          autoSessions.set(agentKey, {
              ...current,
              sessionId,
              sessionUrl: timedResult?.meta?.session?.url || current?.sessionUrl || null,
              toolExecutionMode,
              updatedAt: new Date().toISOString()
            });
        }
      }

      const okEntry = {
        id: callId,
        at: new Date().toISOString(),
        endpoint: '/v1/responses',
        ok: true,
        statusCode: 200,
        durationMs: Date.now() - t0,
        model: requestedModel,
        keyId: req.museKeyId || null,
        sessionId,
        agentKey: agentKey || null,
        outputChars: text.length
      };
      recordCall(callStore, okEntry);
      logLine(okEntry);

      return res.json({
        id: `resp_${randomUUID()}`,
        object: 'response',
        model: MODEL_NAME,
        output_text: text,
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
        ]
      });
    } catch (error) {
      const errMsg = String(error && error.message ? error.message : 'Internal server error');
      const authRequired = errMsg.toLowerCase().includes('sessao meta ai nao pronta');
      const timedOut = errMsg.toLowerCase().includes('timeout (responses_meta_submit)');
      const inputUnavailable = errMsg.toLowerCase().includes('nao consegui encontrar o campo de input no meta.ai');
      const submitFailed = errMsg.toLowerCase().includes('nao consegui submeter a mensagem no meta ai');
      if (timedOut && dedupeKey && inflight.has(dedupeKey)) inflight.delete(dedupeKey);
      if (timedOut) metaWorker.reset().catch(() => {});
      const statusCode = authRequired ? 401 : (timedOut ? 504 : (inputUnavailable || submitFailed ? 503 : 500));
      const errorCode = authRequired ? 'meta_auth_required' : (timedOut ? 'meta_timeout' : (inputUnavailable ? 'meta_input_unavailable' : (submitFailed ? 'meta_submit_failed' : 'internal_error')));
      const errEntry = {
        id: callId,
        at: new Date().toISOString(),
        endpoint: '/v1/responses',
        ok: false,
        statusCode,
        durationMs: Date.now() - t0,
        model: MODEL_NAME,
        keyId: req.museKeyId || null,
        sessionId: null,
        outputChars: 0,
        errorCode,
        errorBrief: errMsg.slice(0, 180)
      };
      recordCall(callStore, errEntry);
      logLine(errEntry);
      return res.status(statusCode).json({
        error: {
          code: errorCode,
          message: authRequired
            ? 'Meta auth required. Run "musespark authsetup" once, complete login/consent, then restart "musespark start".'
            : timedOut
              ? 'Meta request timed out (warm timeout). Worker was reset automatically; retrying should recover.'
              : inputUnavailable
                ? 'Meta chat input is unavailable in the current headless session. Run "musespark authsetup" again and retry.'
              : submitFailed
                ? 'Meta input was found but submit action did not trigger. Retry or run "musespark authsetup" once more.'
              : errMsg
        }
      });
    }
  });

  return app;
}

async function startGateway(options = {}) {
  const port = typeof options === 'number' ? options : (options.port || Number(process.env.PORT || 8787));
  const app = createGatewayApp();
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`MUSESPARK Gateway running at http://localhost:${port}/v1`);
    // eslint-disable-next-line no-console
    console.log(`Version: ${APP_VERSION}`);
    // eslint-disable-next-line no-console
    console.log(`Model: ${MODEL_NAME}`);
    // eslint-disable-next-line no-console
    console.log('API file: src/openai-api.js');
    // eslint-disable-next-line no-console
    console.log(`Live logs: ${META_PROMPT_LOG_ENABLED ? 'ON (no message content, only metadata)' : 'OFF'}`);
    // eslint-disable-next-line no-console
    console.log(`Worker timeout (warm): ${WORKER_TIMEOUT_MS}ms`);
    // eslint-disable-next-line no-console
    console.log(`Worker timeout (cold): ${WORKER_COLD_TIMEOUT_MS}ms`);
    // eslint-disable-next-line no-console
    console.log(`Recent cache: ${RECENT_CACHE_ENABLED ? `ON (${RECENT_CACHE_MS}ms)` : 'OFF'}`);
    // eslint-disable-next-line no-console
    console.log(`Tool execution mode: ${getDefaultToolExecutionMode()}`);
    const runtime = getMetaRuntimeConfig();
    // eslint-disable-next-line no-console
    console.log(`Worker profile: ${runtime.userDataDir}`);
    // eslint-disable-next-line no-console
    console.log(`Worker headless: ${runtime.headless}`);
    // eslint-disable-next-line no-console
    console.log('Health: /health | /healthz | /readyz | /v1/health');
  });

  if (WARMUP_ON_START) {
    workerDeepReadiness().then((status) => {
      // eslint-disable-next-line no-console
      console.log(`[WARMUP] ready=${status && status.ready ? 1 : 0} duration=${Number(status && status.durationMs || 0)}ms`);
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.log(`[WARMUP] ready=0 err=${String(err && err.message ? err.message : err)}`);
    });
  }

  process.on('SIGINT', async () => {
    // eslint-disable-next-line no-console
    console.log('\n[GATEWAY] Shutting down...');
    await metaWorker.reset().catch(() => {});
    server.close();
    process.exit(0);
  });

  return { app, server, port, model: MODEL_NAME };
}

module.exports = { createGatewayApp, startGateway, MODEL_NAME };

if (require.main === module) {
  startGateway();
}
