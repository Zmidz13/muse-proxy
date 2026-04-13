/**
 * bridge-gateway.js
 * 
 * Unified gateway for both Void IDE and OpenClaude clients.
 * Auto-detects the connecting client from message content and applies
 * the correct prompt strategy for Meta AI.
 *
 * Fluxo:
 * 1. Recebe request do cliente (Void IDE ou OpenClaude)
 * 2. Deteta client type, extrai workspace, identifica sessão
 * 3. Constroi prompt adequado (Void ou OpenClaude) e envia ao Meta.ai
 * 4. Converte resposta XML para formato OpenAI e devolve ao cliente
 *
 * Modos suportados:
 *   1º turno OpenClaude: BRIDGE_PROMPT_OPENCLAUDE + system context + user query
 *   1º turno Void:       BRIDGE_PROMPT_VOID (com workspace) + user query
 *   Turnos seguintes:    apenas nova query
 *   Tool results:        formata como [TOOL_RESULT ...] e envia ao Meta.ai
 *   Compaction:          injeta resumo como novo 1º turno
 *
 * Start: musespark start  (or start1 / start2 — all aliases)
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { metaWorker } = require('./meta-worker');
const {
  extractWorkspaceFromSystemPrompt,
  extractOpenClaudeSystemPrompt,
  detectClientType,
  detectCompaction,
  extractUserQuery,
  extractCompactionContext,
  extractToolResultsFromMessages,
  hasMetaToolCallXML,
  parseMetaToolCallsXML,
  convertToolCallsToOpenAI,
  extractTextWithoutToolCalls,
  buildFirstTurnPrompt,
  buildFollowUpPrompt,
  isFirstTurn
} = require('./bridge-message-parser');
const { findBySessionId, findByWorkspace, upsertSession, listSessions, getSessionDetails, removeSession } = require('./bridge-session-store');

const MODEL_NAME = 'muse';

function truncateForAudit(value, maxLen = 240) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function buildSessionTimeline(session) {
  const history = Array.isArray(session && session.history) ? session.history : [];
  return history.map((entry, index) => ({
    index,
    at: entry.at,
    kind: entry.kind,
    promptKind: entry.promptKind,
    clientType: entry.clientType,
    isCompacted: !!entry.isCompacted,
    usedTools: !!entry.usedTools,
    userQueryPreview: entry.userQueryPreview || '',
    responsePreview: entry.responsePreview || '',
    error: entry.error || null,
    toolCalls: Array.isArray(entry.toolCalls)
      ? entry.toolCalls.map((tool) => ({
          name: tool.name,
          toolCallId: tool.toolCallId || null,
          argumentsPreview: tool.argumentsPreview || ''
        }))
      : [],
    toolResults: Array.isArray(entry.toolResults)
      ? entry.toolResults.map((tool) => ({
          toolName: tool.toolName,
          status: tool.status,
          toolCallId: tool.toolCallId || null,
          outputPreview: tool.outputPreview || ''
        }))
      : []
  }));
}

function buildSessionToolsSummary(session) {
  const timeline = buildSessionTimeline(session);
  const counts = {};
  const statuses = {};
  const orderedEvents = [];

  for (const entry of timeline) {
    for (const tool of entry.toolCalls) {
      counts[tool.name] = (counts[tool.name] || 0) + 1;
      orderedEvents.push({
        at: entry.at,
        direction: 'requested',
        promptKind: entry.promptKind,
        name: tool.name,
        toolCallId: tool.toolCallId || null
      });
    }
    for (const result of entry.toolResults) {
      counts[result.toolName] = (counts[result.toolName] || 0) + 1;
      statuses[result.toolName] = statuses[result.toolName] || { success: 0, error: 0, other: 0 };
      if (result.status === 'SUCCESS') statuses[result.toolName].success++;
      else if (result.status === 'ERROR') statuses[result.toolName].error++;
      else statuses[result.toolName].other++;
      orderedEvents.push({
        at: entry.at,
        direction: 'result',
        promptKind: entry.promptKind,
        name: result.toolName,
        status: result.status,
        toolCallId: result.toolCallId || null
      });
    }
  }

  return {
    sessionId: session.sessionId,
    clientType: session.clientType,
    totalHistoryEntries: timeline.length,
    tools: Object.keys(counts)
      .sort()
      .map((name) => ({
        name,
        count: counts[name],
        results: statuses[name] || { success: 0, error: 0, other: 0 }
      })),
    events: orderedEvents
  };
}

/**
 * Cria a aplicação Express para o modo bridge.
 */
function createBridgeGatewayApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Health endpoints
  app.get('/health', (req, res) => res.json({ status: 'ok', mode: 'bridge' }));
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    try {
      const status = await metaWorker.probeReadiness({ timeoutMs: 5000 });
      res.json({ ready: status.ready, mode: 'bridge' });
    } catch {
      res.json({ ready: false, mode: 'bridge' });
    }
  });

  // Models endpoint (no auth required - must be before auth middleware)
  app.get('/v1/models', (req, res) => {
    res.json({
      object: 'list',
      data: [{
        id: 'muse',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'musespark'
      }]
    });
  });

  // API key validation (simplified for bridge mode)
  app.use('/v1/', (req, res, next) => {
    req.museBridgeMode = true;
    next();
  });

  // Main endpoint: /v1/chat/completions
  app.post('/v1/chat/completions', async (req, res) => {
    const t0 = Date.now();
    const { messages, stream, model } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: { message: 'messages array is required' } });
    }

    const sessionId = req.headers['x-claude-code-session-id'] || 'anon';
    const clientType = detectClientType(messages);
    const firstTurn = isFirstTurn(messages);
    const streamOptions = req.body.stream_options || {};
    const includeUsage = !!(streamOptions.include_usage);

    try {
      // ─── 1. Identificar workspace ───
      // Pass request headers so X-Workspace-Path is honoured for Void clients
      const workspacePath = extractWorkspaceFromSystemPrompt(messages, req.headers);
      let sessionRecord = findBySessionId(sessionId);

      // Se nao existe por session_id, tenta por workspace
      if (!sessionRecord && workspacePath) {
        sessionRecord = findByWorkspace(workspacePath);
      }

      // ─── 2. Detetar tool results (Void envia role:'tool') ───
      const toolResultItems = extractToolResultsFromMessages(messages);
      const isToolResultTurn = toolResultItems.length > 0;

      // ─── 3. Detetar compactação ───
      const compaction = !isToolResultTurn ? detectCompaction(messages) : null;
      let needNewChat = false;

      if (compaction) {
        needNewChat = true;
        // eslint-disable-next-line no-console
        console.log(`[BRIDGE] Compaction detected for session ${sessionId.slice(0, 8)}`);
      }

      // ─── 4. Construir prompt ───
      let promptText;
      const promptKind = isToolResultTurn
        ? 'tool-result'
        : needNewChat && compaction
          ? 'compaction'
          : firstTurn
            ? 'first'
            : 'follow-up';

      if (isToolResultTurn) {
        // Tool result messages from Void (or OpenClaude in bridge mode):
        // Concatenate all tool results into one text block sent to Meta AI.
        promptText = toolResultItems.map((r) => r.formatted).join('\n\n---\n\n');
        // eslint-disable-next-line no-console
        console.log(`[BRIDGE] Tool result turn: ${toolResultItems.length} result(s) from client=${clientType}`);
      } else if (needNewChat && compaction) {
        // Pos-compactação: injeta resumo como primeira mensagem
        const ctx = extractCompactionContext(messages);
        const basePrompt = buildFirstTurnPrompt(messages, clientType, workspacePath);
        promptText = basePrompt.replace(
          '--- User Request ---',
          `--- Session Context (Compacted) ---\n${ctx.injectionText}`
        );
      } else if (firstTurn) {
        // 1º turno: prompt combinado com prompt correto para o cliente
        promptText = buildFirstTurnPrompt(messages, clientType, workspacePath);
      } else {
        // Turnos seguintes: apenas o novo input (Meta.ai tem contexto)
        promptText = extractUserQuery(messages);
      }

      if (!promptText) {
        return res.status(400).json({ error: { message: 'No user query found in messages' } });
      }

      // eslint-disable-next-line no-console
      console.log(`[BRIDGE] ${clientType} | ${promptKind} | prompt: ${promptText.slice(0, 100)}...`);

      // ─── 5. Enviar ao Meta.ai via metaWorker ───
      const result = await metaWorker.submitPrompt(promptText, {
        timeoutMs: Number(process.env.MUSE_RESPONSE_TIMEOUT_MS || 45000),
        forceNewChat: needNewChat,
        sessionId: sessionId,
        sessionUrl: sessionRecord ? sessionRecord.chatUrl : null
      });

      const responseText = String(result && result.text ? result.text : '').trim();
      const responseUrl =
        (result && result.meta && result.meta.url)
        || (result && result.meta && result.meta.session && result.meta.session.url)
        || '';

      // ─── 7. Parse tool calls se existirem ───
      const hasTools = hasMetaToolCallXML(responseText);
      const toolCalls = hasTools ? convertToolCallsToOpenAI(parseMetaToolCallsXML(responseText)) : [];
      const contentText = hasTools ? extractTextWithoutToolCalls(responseText) : responseText;

      // ─── 6. Atualizar session store ───
      upsertSession({
        sessionId,
        workspacePath,
        chatUrl: responseUrl,
        isCompacted: compaction !== null,
        clientType,
        historyEvent: {
          kind: 'turn',
          clientType,
          promptKind,
          chatUrl: responseUrl,
          isCompacted: compaction !== null,
          requestMessageCount: messages.length,
          userQueryPreview: extractUserQuery(messages),
          responsePreview: hasTools ? contentText || responseText : responseText,
          usedTools: hasTools || toolResultItems.length > 0,
          toolCalls: toolCalls.map((tc) => ({
            name: tc && tc.function ? tc.function.name : 'unknown',
            toolCallId: tc ? tc.id : null,
            argumentsPreview: tc && tc.function ? tc.function.arguments : ''
          })),
          toolResults: toolResultItems.map((item) => ({
            toolName: item.toolName,
            status: item.status,
            toolCallId: item.toolCallId,
            outputPreview: item.output
          }))
        }
      });

      // eslint-disable-next-line no-console
      console.log(`[BRIDGE] Session ${sessionId.slice(0, 8)} | client=${clientType} | workspace=${workspacePath.slice(0, 60)}`);

      // eslint-disable-next-line no-console
      console.log(`[BRIDGE] Response (${Date.now() - t0}ms): hasTools=${hasTools}, textLen=${contentText.length}, url=${responseUrl.slice(0, 80)}`);

      // ─── 8. Responder ───
      if (stream) {
        return streamResponse(res, {
          contentText,
          toolCalls,
          model: model || MODEL_NAME,
          url: responseUrl,
          includeUsage
        });
      }

      return res.json(buildOpenAIResponse({
        contentText,
        toolCalls,
        model: model || MODEL_NAME,
        url: responseUrl
      }));

    } catch (error) {
      const errMsg = String(error && error.message ? error.message : 'Internal server error');
      // eslint-disable-next-line no-console
      console.error(`[BRIDGE] Error (${Date.now() - t0}ms): ${errMsg.slice(0, 200)}`);
      try {
        upsertSession({
          sessionId,
          workspacePath: extractWorkspaceFromSystemPrompt(messages, req.headers),
          clientType,
          historyEvent: {
            kind: 'error',
            clientType,
            promptKind: firstTurn ? 'first' : 'follow-up',
            requestMessageCount: messages.length,
            userQueryPreview: extractUserQuery(messages),
            error: errMsg
          }
        });
      } catch (_) {
        // ignore store failures while surfacing the original error
      }
    
      const authRequired = errMsg.toLowerCase().includes('sessao meta ai nao pronta');
    
      if (stream && res.headersSent) {
        // Stream already started — send error chunk then close
        const errId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const errCreated = Math.floor(Date.now() / 1000);
        try {
          res.write(`data: ${JSON.stringify({
            id: errId,
            object: 'chat.completion.chunk',
            created: errCreated,
            model: model || MODEL_NAME,
            choices: [{ index: 0, delta: { content: `\n[Error: ${truncateForAudit(errMsg, 200)}]` }, finish_reason: 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (_) { /* ignore write errors */ }
        return res.end();
      }
    
      const statusCode = authRequired ? 401 : 500;
    
      return res.status(statusCode).json({
        error: {
          message: authRequired
            ? 'Meta auth required. Run "musespark authsetup" once, then restart "musespark start".'
            : errMsg.slice(0, 500),
          code: authRequired ? 'meta_auth_required' : 'internal_error'
        }
      });
    }
  });

  // Session management endpoints
  app.get('/v1/sessions', (req, res) => {
    const sessions = listSessions();
    res.json({ sessions });
  });

  app.get('/v1/sessions/:sessionId', (req, res) => {
    const session = getSessionDetails(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', code: 'session_not_found' } });
    }
    return res.json({ session });
  });

  app.get('/v1/sessions/:sessionId/timeline', (req, res) => {
    const session = getSessionDetails(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', code: 'session_not_found' } });
    }
    return res.json({
      sessionId: session.sessionId,
      clientType: session.clientType,
      timeline: buildSessionTimeline(session)
    });
  });

  app.get('/v1/sessions/:sessionId/tools', (req, res) => {
    const session = getSessionDetails(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', code: 'session_not_found' } });
    }
    return res.json(buildSessionToolsSummary(session));
  });

  app.delete('/v1/sessions/:sessionId', (req, res) => {
    const removed = removeSession(req.params.sessionId);
    res.json({ removed });
  });

  app.get('/v1/browser-status', async (req, res) => {
    try {
      const ws = require('./meta-worker').getMetaWorkerStatus();
      res.json({
        ready: ws && !ws.lastError,
        url: ws ? ws.pageUrl : null,
        thinking: ws ? ws.thinking : false,
        phase: ws ? ws.phase : 'idle'
      });
    } catch {
      res.json({ ready: false });
    }
  });

  return app;
}

/**
 * Streaming SSE response — fully OpenAI-compatible.
 */
function streamResponse(res, { contentText, toolCalls, model, url, includeUsage }) {
  // Generate a single consistent id and timestamp for ALL chunks in this response
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const created = Math.floor(Date.now() / 1000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  /** Helper: write one SSE chunk */
  function writeChunk(delta, finishReason) {
    const chunk = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason !== undefined ? finishReason : null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  // 1. Role chunk — always first, content must be empty string per spec
  writeChunk({ role: 'assistant', content: '' });

  // 2. Tool call chunks — one per tool call, finish_reason stays null
  if (toolCalls && toolCalls.length) {
    toolCalls.forEach((tc, idx) => {
      writeChunk({
        tool_calls: [{
          index: idx,
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            // arguments MUST be a JSON string, never an object
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments)
          }
        }]
      });
    });
  }

  // 3. Content chunk (if any text)
  if (contentText) {
    writeChunk({ content: contentText });
  }

  // 4. Final chunk — sets finish_reason; optionally includes usage
  const finish = toolCalls && toolCalls.length ? 'tool_calls' : 'stop';
  const finalDelta = includeUsage
    ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
    : {};
  writeChunk(finalDelta, finish);

  // 5. Stream termination
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Non-streaming OpenAI response.
 */
function buildOpenAIResponse({ contentText, toolCalls, model, url }) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const created = Math.floor(Date.now() / 1000);

  const message = { role: 'assistant' };
  if (contentText) message.content = contentText;
  if (toolCalls && toolCalls.length) message.tool_calls = toolCalls;

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls && toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    musespark: {
      mode: 'bridge',
      url
    }
  };
}

/**
 * Inicia o gateway bridge.
 */
async function startBridgeGateway(portOrOptions) {
  // Accept both numeric port and options object for backward compatibility
  const options = typeof portOrOptions === 'number'
    ? { port: portOrOptions }
    : (portOrOptions && typeof portOrOptions === 'object' ? portOrOptions : {});
  const port = options.port || 8787;
  const app = createBridgeGatewayApp();
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`MUSESPARK Unified Gateway running at http://localhost:${port}/v1`);
    // eslint-disable-next-line no-console
    console.log('Mode: UNIFIED (Void IDE + OpenClaude, pass-through to Meta AI)');
    // eslint-disable-next-line no-console
    console.log('Start with: musespark start  (or start1 / start2 — all aliases)');
    // eslint-disable-next-line no-console
    console.log('Health: /health | /healthz | /readyz');
    // eslint-disable-next-line no-console
    console.log('Sessions: GET /v1/sessions');
    // eslint-disable-next-line no-console
    console.log('Browser: GET /v1/browser-status');
  });

  // Cleanup on exit
  process.on('SIGINT', async () => {
    // eslint-disable-next-line no-console
    console.log('\n[BRIDGE] Shutting down...');
    await metaWorker.reset().catch(() => {});
    server.close();
    process.exit(0);
  });

  return { app, server, port, model: MODEL_NAME };
}

module.exports = { createBridgeGatewayApp, startBridgeGateway };
