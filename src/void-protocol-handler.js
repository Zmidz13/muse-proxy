/**
 * Void Protocol Handler
 *
 * Manages the bidirectional communication between Void IDE and Meta AI through the bridge.
 * This module handles the FULL cycle:
 *
 * 1. Void IDE sends request with tool definitions → Gateway receives
 * 2. Gateway builds XML prompt with tool definitions for Meta AI
 * 3. Gateway sends prompt to Meta AI via Playwright
 * 4. Meta AI responds with XML tool call
 * 5. Gateway parses XML → converts to OpenAI tool_call → sends to Void IDE
 * 6. Void IDE executes tool → sends result back as role:'tool' message
 * 7. Gateway receives tool result → formats as XML → sends to Meta AI
 * 8. Repeat until Meta AI outputs <task_complete>
 * 9. Gateway returns final response to Void IDE
 *
 * USAGE:
 *   The handler exposes a single function: runVoidBridgeLoop
 *   This replaces runAgentLoop when in startvoid mode.
 */

const { randomUUID } = require('crypto');
const { metaWorker } = require('./meta-worker');
const {
  getVoidToolsDefinitions,
  generateVoidToolsXMLForPrompt
} = require('./void-tools-schema');
const {
  parseAllToolCalls,
  toOpenAIToolCall,
  hasToolCall,
  formatToolResultForMetaAI
} = require('./tool-call-converter');
const { buildVoidBridgeSystemPromptWithTools } = require('./system-prompt');

/**
 * Extract workspace folder paths from Void IDE's system message.
 * Void sends a system message containing a <system_info> block with workspace folder paths.
 * Example: <system_info>\nworkspace folders:\nC:\Projects\my-site\n</system_info>
 * @param {Array} messages - The messages array from Void IDE
 * @returns {Array<string>} Array of workspace folder paths
 */
function extractWorkspaceFolders(messages) {
  if (!Array.isArray(messages)) return [];
  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    // Void IDE sends workspace folders inside <system_info> under "The user's workspace contains these folders:"
    // or "workspaceFolders" or simply listed after a label
    // Try multiple patterns to be robust
    // Pattern 1: explicit list under a label
    const wsMatch = content.match(/workspace (?:contains these|folders)[:\s]*\n([\s\S]*?)(?:\n<\/|\n[A-Z]|\n\n|$)/i);
    if (wsMatch) {
      const folders = wsMatch[1].split('\n').map(s => s.trim()).filter(Boolean);
      if (folders.length > 0) return folders;
    }
    // Pattern 2: lines that look like absolute paths after "workspace" mention
    const lines = content.split('\n');
    const folderLines = [];
    let inWorkspace = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/workspace.*folder/i.test(trimmed)) { inWorkspace = true; continue; }
      if (inWorkspace) {
        if (/^[A-Z]:\\|^\/\w/.test(trimmed)) {
          folderLines.push(trimmed);
        } else if (trimmed === '' || /<\//.test(trimmed)) {
          break;
        }
      }
    }
    if (folderLines.length > 0) return folderLines;
    // Pattern 3: direct system_info block with path lines
    const sysInfoMatch = content.match(/<system_info>([\s\S]*?)<\/system_info>/i);
    if (sysInfoMatch) {
      const infoBlock = sysInfoMatch[1];
      const pathLines = infoBlock.split('\n')
        .map(l => l.trim())
        .filter(l => /^[A-Z]:\\/i.test(l) || /^\/[\w]/.test(l));
      if (pathLines.length > 0) return pathLines;
    }
  }
  return [];
}

const { rotatePromptLogs, getPromptLogDir } = require('./log-utils');
const path = require('path');
const fs = require('fs');

const MODEL_NAME = 'muse';
// Generous safety cap so a model that never emits {"done":true} (or keeps
// replying without a tool call) cannot loop forever. Normal turns return on the
// first tool call, so this only bites pathological spins. Override for very long
// sessions with MUSE_MAX_AGENT_ITERATIONS.
const MAX_AGENT_ITERATIONS = Math.max(1, Number(process.env.MUSE_MAX_AGENT_ITERATIONS) || 200);

/**
 * Write prompt log for debugging
 */
function writeMetaPromptLog(kind, payload) {
  try {
    const logDir = getPromptLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    const id = randomUUID().slice(0, 8);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(logDir, `${stamp}_${kind}_${id}.log.txt`);
    fs.writeFileSync(file, String(payload || ''), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[PROMPT_LOG] ${kind} ${file}`);
  } catch {
    // ignore log failures
  }
}

/**
 * Extract the latest non-system, non-tool user message for context.
 */
function getLatestUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      return String(messages[i].content);
    }
  }
  return '';
}

/**
 * Extract the last tool result from Void IDE messages.
 * Void IDE sends tool results as role:'tool' messages with tool_call_id.
 * We find the last one and extract the tool name and content.
 * @param {Array} messages - The messages array from Void IDE
 * @returns {{toolName: string, content: string, isError: boolean}|null}
 */
function extractLastToolResult(messages) {
  if (!Array.isArray(messages)) return null;
  // Walk backwards to find the last role:'tool' message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      // Only trust the explicit status marker. Substring matches on "error"/"failed"
      // wrongly flag successful results whose payload merely mentions those words.
      const isError = typeof msg.content === 'string'
        && msg.content.trimStart().startsWith('[STATUS: ERROR]');
      // Try to extract the tool name from the tool_call_id
      // Void uses format like "call_abc123" which doesn't contain the tool name
      // We'll derive it from the preceding assistant message's tool_calls
      let toolName = 'unknown';
      // Look backwards for the assistant message with tool_calls that matches
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
          // Find the tool call matching this tool_call_id
          const matching = prev.tool_calls.find(tc => tc.id === msg.tool_call_id);
          if (matching && matching.function && matching.function.name) {
            toolName = matching.function.name;
          } else if (prev.tool_calls[0] && prev.tool_calls[0].function && prev.tool_calls[0].function.name) {
            // Fallback: use first tool call name
            toolName = prev.tool_calls[0].function.name;
          }
          break;
        }
      }
      return { toolName, content, isError };
    }
  }
  return null;
}

/**
 * Build the JSON system prompt for Meta AI with Void tool definitions.
 * Meta AI outputs JSON tool calls directly: {"tool":"read_file","params":{"uri":"/path"}}
 * @param {Array} messages - Conversation messages (unused but kept for API compat)
 * @param {Array} toolDefinitions - OpenAI-style tool definitions to include in the prompt
 * @returns {string} The system prompt with tool descriptions
 */
function buildVoidBridgeSystemPrompt(messages, toolDefinitions) {
  const tools = toolDefinitions && toolDefinitions.length > 0
    ? toolDefinitions
    : getVoidToolsDefinitions();
  const workspaceFolders = extractWorkspaceFolders(messages);
  if (workspaceFolders.length > 0) {
    console.log('[VOID_BRIDGE] Extracted workspace folders:', workspaceFolders);
  }
  return buildVoidBridgeSystemPromptWithTools(tools, workspaceFolders);
}

/**
 * Build the XML prompt for a single iteration (including history).
 */
function buildIterationPrompt(messages, systemPrompt, iterationHistory) {
  // Build conversation history in XML-friendly format
  let historyStr = '';

  for (const msg of messages) {
    if (msg.role === 'system') continue; // Already in system prompt
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        historyStr += `USER: ${msg.content}\n\n`;
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        historyStr += `ASSISTANT: ${msg.content}\n\n`;
      }
    } else if (msg.role === 'tool') {
      // Tool results are already formatted by formatToolResultForMetaAI
      historyStr += `${msg.content}\n\n`;
    }
  }

  // Add iteration history for context
  if (iterationHistory.length > 0) {
    historyStr += '## PREVIOUS ITERATIONS:\n';
    for (const h of iterationHistory) {
      historyStr += h + '\n';
    }
    historyStr += '\n';
  }

  return `${systemPrompt}\n\n## CONVERSATION HISTORY:\n${historyStr}`;
}

/**
 * Main Void Bridge Loop.
 * This replaces runAgentLoop when in startvoid mode.
 *
 * @param {Array} messages - The messages array from Void IDE
 * @param {object} opts - Options
 * @param {boolean} opts.forceNewChat - Force a new chat session
 * @param {string} opts.sessionId - Session ID
 * @param {string} opts.sessionUrl - Session URL
 * @param {number} opts.timeoutMs - Timeout in ms
 * @param {object} opts.req - Express request object
 * @param {function} opts.onProgress - Progress callback
 * @param {function} opts.onToolEvent - Tool event callback
 * @param {Array} opts.voidToolDefinitions - Tool definitions from Void IDE (if provided)
 * @returns {Promise<object>} The final result
 */
async function runVoidBridgeLoop(messages, opts) {
  const {
    forceNewChat,
    sessionId,
    sessionUrl,
    timeoutMs,
    req,
    onProgress,
    onToolEvent,
    voidToolDefinitions
  } = opts || {};

  const history = Array.isArray(messages) ? [...messages] : [];
  const iterationHistory = [];
  let currentSessionUrl = sessionUrl || null;
  let isNewSession = Boolean(forceNewChat || (!sessionId && !sessionUrl));
  let hadToolCalls = false;
  let pendingToolCall = null; // Single pending tool call (Void only accepts one at a time)
  let executedTools = [];
  let lastMeta = null;
  let lastText = '';

  // Build system prompt
  const systemPrompt = buildVoidBridgeSystemPrompt(history, voidToolDefinitions);

  // eslint-disable-next-line no-console
  console.log('[VOID_BRIDGE] Starting bridge loop with', history.length, 'messages');

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    if (typeof onProgress === 'function') {
      onProgress(i === 0
        ? 'A preparar a sessão Void Bridge...'
        : (hadToolCalls ? 'A continuar com o resultado da tool...' : 'A pedir próxima tool call ao Meta AI...'));
    }

    // Build full prompt for this iteration
    const fullPrompt = buildIterationPrompt(history, systemPrompt, iterationHistory);

    // Log the prompt
    writeMetaPromptLog('send',
      `[VOID_BRIDGE ITERATION ${i + 1}]\nSession: ${currentSessionUrl || 'new'}\n\n${fullPrompt}`);

    // Submit to Meta AI
    let result;
    try {
      result = await metaWorker.submitPrompt(fullPrompt, {
        forceNewChat: i === 0 ? Boolean(forceNewChat) : false,
        sessionId: sessionId || null,
        sessionUrl: currentSessionUrl,
        timeoutMs: timeoutMs || 90000
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[VOID_BRIDGE] Meta AI submission error:', err.message);
      return {
        text: `Error communicating with Meta AI: ${err.message}`,
        meta: lastMeta,
        iterations: i + 1,
        hadToolCalls,
        executedTools,
        pendingToolCalls: pendingToolCall ? [pendingToolCall] : []
      };
    }

    const assistantText = String(result?.text || '').trim();
    lastMeta = result?.meta || null;
    lastText = assistantText;

    // Update session URL if Meta AI returned a new one
    if (result?.meta?.session?.url) {
      currentSessionUrl = result.meta.session.url;
    }

    // Log the response
    writeMetaPromptLog('recv',
      `[VOID_BRIDGE ITERATION ${i + 1}]\n${assistantText}`);

    // eslint-disable-next-line no-console
    console.log(`[VOID_BRIDGE] Iteration ${i + 1}: ${assistantText.slice(0, 200)}...`);

    // Check for empty response
    if (!assistantText) {
      // eslint-disable-next-line no-console
      console.log(`[VOID_BRIDGE] Empty response — returning`);
      return {
        text: '',
        meta: lastMeta,
        iterations: i + 1,
        hadToolCalls,
        executedTools,
        pendingToolCalls: pendingToolCall ? [pendingToolCall] : []
      };
    }

    // Check for task_complete (JSON: {"done":true,"message":"..."})
    let isDone = false;
    let finalMessage = '';
    try {
      const parsed = JSON.parse(assistantText);
      if (parsed.done === true) {
        isDone = true;
        finalMessage = parsed.message || 'Tarefa concluída.';
      }
    } catch {
      // Not JSON - check for XML task_complete fallback
      const taskCompleteMatch = assistantText.match(/<task_complete>([\s\S]*?)<\/task_complete>/i);
      if (taskCompleteMatch) {
        const messageMatch = taskCompleteMatch[1].match(/<message>([\s\S]*?)<\/message>/i);
        isDone = true;
        finalMessage = messageMatch ? messageMatch[1].trim() : 'Tarefa concluída.';
      }
    }

    if (isDone) {
      // eslint-disable-next-line no-console
      console.log(`[VOID_BRIDGE] Task complete detected — returning: ${finalMessage}`);
      return {
        text: finalMessage,
        meta: lastMeta,
        iterations: i + 1,
        hadToolCalls,
        executedTools,
        pendingToolCalls: [],
        isTaskComplete: true
      };
    }

    // Parse tool calls (JSON first, XML fallback)
    const toolCalls = parseAllToolCalls(assistantText);

    // DEBUG: log exactly what parseAllToolCalls found
    // eslint-disable-next-line no-console
    console.log(`[VOID_BRIDGE] parseAllToolCalls returned: ${toolCalls.length} tool(s) — raw: ${JSON.stringify(toolCalls)}`);

    if (toolCalls.length === 0) {
      // No tool call found — this is an error in bridge mode
      // Meta AI should ALWAYS output a tool call or done in JSON
      // eslint-disable-next-line no-console
      console.log(`[VOID_BRIDGE] WARNING: No tool call found! Full response (${assistantText.length} chars):`);
      // eslint-disable-next-line no-console
      console.log(`[VOID_BRIDGE] RESPONSE_START\n${assistantText}\n[VOID_BRIDGE] RESPONSE_END`);
      // Continue — Meta AI will be reminded in next iteration
      iterationHistory.push(
        `ITERATION ${i + 1}: Meta AI responded without a tool call or done object.\n` +
        `Response: ${assistantText.slice(0, 300)}\n` +
        `REMINDER: You MUST output exactly ONE JSON tool call {"tool":"tool_name","params":{...}}, or {"done":true,"message":"..."} when done.`
      );

      // Add to history to give Meta AI context
      history.push({ role: 'assistant', content: assistantText });
      history.push({
        role: 'system',
        content: 'ERROR: You did not output a valid JSON tool call. You MUST call exactly ONE tool as {"tool":"tool_name","params":{"param":"value"}}, or {"done":true,"message":"..."} if all work is done. Review the tool list and try again.'
      });

      if (typeof onProgress === 'function') {
        onProgress('Meta AI não enviou tool call válida, a pedir novamente...');
      }
      continue;
    }

    // We got a valid tool call
    // Void IDE only supports ONE tool call at a time
    const toolCall = toolCalls[0];
    hadToolCalls = true;
    pendingToolCall = {
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: toolCall.name,
      params: toolCall.params
    };

    if (typeof onProgress === 'function') {
      onProgress(`Meta AI pediu: ${toolCall.name}`);
    }

    if (typeof onToolEvent === 'function') {
      onToolEvent({
        phase: 'start',
        name: toolCall.name,
        params: toolCall.params
      });
    }

    // eslint-disable-next-line no-console
    console.log(`[VOID_BRIDGE] Tool call parsed (JSON): ${toolCall.name}`, toolCall.params);

    // Convert to OpenAI tool_call format for Void IDE (minimal mapping)
    const openAIToolCall = toOpenAIToolCall(toolCall, pendingToolCall.id);

    // Return the tool call to Void IDE
    // The caller (openai-api.js) will handle sending this to Void
    // and then calling this function again with the result
    return {
      text: null, // No text response — we're returning a tool call
      meta: lastMeta,
      iterations: i + 1,
      hadToolCalls,
      executedTools,
      pendingToolCalls: [pendingToolCall],
      openAIToolCall, // This is what Void IDE expects
      needsToolResult: true, // Signal that we need the tool result from Void
      // Bridge state for continuation across HTTP requests
      bridgeState: {
        iterationHistory,
        sessionUrl: currentSessionUrl,
        iterations: i + 1,
        hadToolCalls: true,
        executedTools,
        meta: lastMeta
      }
    };
  }

  // Max iterations reached
  return {
    text: 'O limite máximo de iterações foi atingido. A finalizar.',
    meta: lastMeta,
    iterations: MAX_AGENT_ITERATIONS,
    hadToolCalls,
    executedTools,
    pendingToolCalls: pendingToolCall ? [pendingToolCall] : []
  };
}

/**
 * Continue the Void Bridge Loop after receiving a tool result from Void IDE.
 *
 * @param {Array} messages - Updated messages with tool result
 * @param {object} state - Previous state from runVoidBridgeLoop
 * @param {object} opts - Same options as runVoidBridgeLoop
 * @returns {Promise<object>}
 */
async function continueVoidBridgeLoop(messages, state, opts) {
  const history = Array.isArray(messages) ? [...messages] : [];
  const iterationHistory = state?.iterationHistory || [];
  let currentSessionUrl = state?.sessionUrl || opts?.sessionUrl || null;
  let hadToolCalls = state?.hadToolCalls ?? true;
  let executedTools = state?.executedTools || [];
  let lastMeta = state?.meta || null;

  // Build system prompt
  const voidToolDefinitions = opts?.voidToolDefinitions || getVoidToolsDefinitions();
  const systemPrompt = buildVoidBridgeSystemPrompt(history, voidToolDefinitions);

  // Extract tool results from messages and format them for Meta AI
  // Void IDE sends tool results as role:'tool' messages with tool_call_id
  // We need to find the last tool result and format it as Meta AI expects
  const lastToolResult = extractLastToolResult(messages);
  if (lastToolResult) {
    // Prepend the formatted tool result to the iteration history
    const formattedResult = formatToolResultForMetaAI(
      lastToolResult.toolName,
      lastToolResult.content,
      lastToolResult.isError ? 'ERROR' : 'SUCCESS'
    );
    iterationHistory.push(formattedResult);
    // eslint-disable-next-line no-console
    console.log(`[VOID_BRIDGE] Injected tool result for ${lastToolResult.toolName}: ${lastToolResult.isError ? 'ERROR' : 'SUCCESS'}`);
  }

  // eslint-disable-next-line no-console
  console.log('[VOID_BRIDGE] Continuing bridge loop with tool result');

  for (let i = (state?.iterations || 0) + 1; i <= MAX_AGENT_ITERATIONS; i++) {
    if (typeof opts?.onProgress === 'function') {
      opts.onProgress('A continuar com o resultado da tool...');
    }

    // Build full prompt
    const fullPrompt = buildIterationPrompt(history, systemPrompt, iterationHistory);

    // Log the prompt
    writeMetaPromptLog('send',
      `[VOID_BRIDGE CONTINUE ITERATION ${i}]\nSession: ${currentSessionUrl || 'continuation'}\n\n${fullPrompt}`);

    // Submit to Meta AI
    let result;
    try {
      result = await metaWorker.submitPrompt(fullPrompt, {
        forceNewChat: false,
        sessionId: opts?.sessionId || null,
        sessionUrl: currentSessionUrl,
        timeoutMs: opts?.timeoutMs || 90000
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[VOID_BRIDGE] Meta AI submission error (continue):', err.message);
      return {
        text: `Error communicating with Meta AI: ${err.message}`,
        meta: lastMeta,
        iterations: i,
        hadToolCalls,
        executedTools,
        pendingToolCalls: []
      };
    }

    const assistantText = String(result?.text || '').trim();
    lastMeta = result?.meta || null;

    if (result?.meta?.session?.url) {
      currentSessionUrl = result.meta.session.url;
    }

    // Log the response
    writeMetaPromptLog('recv',
      `[VOID_BRIDGE CONTINUE ITERATION ${i}]\n${assistantText}`);

    // eslint-disable-next-line no-console
    console.log(`[VOID_BRIDGE] Continue iteration ${i}: ${assistantText.slice(0, 200)}...`);

    if (!assistantText) {
      return {
        text: '',
        meta: lastMeta,
        iterations: i,
        hadToolCalls,
        executedTools,
        pendingToolCalls: []
      };
    }

    // Check for task_complete (JSON: {"done":true,"message":"..."})
    let isDone = false;
    let finalMessage = '';
    try {
      const parsed = JSON.parse(assistantText);
      if (parsed.done === true) {
        isDone = true;
        finalMessage = parsed.message || 'Tarefa concluída.';
      }
    } catch {
      // Not JSON - check XML fallback
      const taskCompleteMatch = assistantText.match(/<task_complete>([\s\S]*?)<\/task_complete>/i);
      if (taskCompleteMatch) {
        const messageMatch = taskCompleteMatch[1].match(/<message>([\s\S]*?)<\/message>/i);
        isDone = true;
        finalMessage = messageMatch ? messageMatch[1].trim() : 'Tarefa concluída.';
      }
    }

    if (isDone) {
      return {
        text: finalMessage,
        meta: lastMeta,
        iterations: i,
        hadToolCalls,
        executedTools,
        pendingToolCalls: [],
        isTaskComplete: true
      };
    }

    // Parse tool calls (JSON first, XML fallback)
    const toolCalls = parseAllToolCalls(assistantText);

    if (toolCalls.length === 0) {
      // No tool call — add reminder
      iterationHistory.push(
        `CONTINUE ITERATION ${i}: No valid tool call.\n` +
        `Response: ${assistantText.slice(0, 300)}`
      );

      history.push({ role: 'assistant', content: assistantText });
      history.push({
        role: 'system',
        content: 'ERROR: You did not output a valid JSON tool call. You MUST call exactly ONE tool as {"tool":"tool_name","params":{"param":"value"}}, or {"done":true,"message":"..."} if done.'
      });
      continue;
    }

    // Valid tool call
    const toolCall = toolCalls[0];
    const toolCallId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    if (typeof opts?.onToolEvent === 'function') {
      opts.onToolEvent({
        phase: 'start',
        name: toolCall.name,
        params: toolCall.params
      });
    }

    const openAIToolCall = toOpenAIToolCall(toolCall, toolCallId);

    return {
      text: null,
      meta: lastMeta,
      iterations: i,
      hadToolCalls: true,
      executedTools,
      pendingToolCalls: [{ id: toolCallId, name: toolCall.name, params: toolCall.params }],
      openAIToolCall,
      needsToolResult: true,
      // Bridge state for next continuation
      bridgeState: {
        iterationHistory,
        sessionUrl: currentSessionUrl,
        iterations: i,
        hadToolCalls: true,
        executedTools,
        meta: lastMeta
      }
    };
  }

  return {
    text: 'O limite máximo de iterações foi atingido. A finalizar.',
    meta: lastMeta,
    iterations: MAX_AGENT_ITERATIONS,
    hadToolCalls,
    executedTools,
    pendingToolCalls: []
  };
}

module.exports = {
  runVoidBridgeLoop,
  continueVoidBridgeLoop,
  buildVoidBridgeSystemPrompt,
  extractLastToolResult,
  extractWorkspaceFolders,
  formatToolResultForMetaAI,
  hasJSONToolCall: hasToolCall,
  parseAllToolCalls,
  toOpenAIToolCall,
  MAX_AGENT_ITERATIONS
};
