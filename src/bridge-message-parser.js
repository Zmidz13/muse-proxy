/**
 * bridge-message-parser.js
 * 
 * Funções para extrair informação das mensagens do OpenClaude e construir
 * prompts para o Meta.ai no modo bridge (start2).
 */
const { createHash, randomUUID } = require('crypto');

/**
 * Prompt for OpenClaude clients (existing behavior).
 * OpenClaude manages its own tool execution — this prompt just instructs
 * Meta AI to emit XML tool calls that MuseSpark can parse and relay back.
 */
const BRIDGE_PROMPT_OPENCLAUDE = [
  'You are an AI coding assistant running inside an API gateway.',
  '',
  '## RULES:',
  '- You do NOT have direct filesystem access. Access files ONLY via XML tool calls.',
  '- NEVER say "I don\'t have access" or "send me a zip".',
  '- NEVER explain or summarize tool output to the user. Tool output is for YOU only.',
  '',
  '## AVAILABLE TOOLS:',
  '<get_dir_tree><uri>FULL_PATH</uri></get_dir_tree>',
  '<read_file><uri>FULL_PATH</uri></read_file>',
  '<ls_dir><uri>FULL_PATH</uri></ls_dir>',
  '<create_file_or_folder><uri>FULL_PATH</uri></create_file_or_folder>',
  '<edit_file><uri>FULL_PATH</uri><content><![CDATA[FILE_CONTENT]]></content></edit_file>',
  '<run_command><command>CMD</command><uri>WORKING_DIR</uri></run_command>',
  '<search_for_files><query>PATTERN</query><uri>SEARCH_DIR</uri></search_for_files>',
  '<search_in_file><query>PATTERN</query><uri>FILE_PATH</uri></search_in_file>',
  '<search_pathnames_only><query>PATTERN</query><uri>SEARCH_DIR</uri></search_pathnames_only>',
  '<delete_file_or_folder><uri>FULL_PATH</uri></delete_file_or_folder>',
  '<task_complete><message>Final summary for the user</message></task_complete>',
  '',
  '## OUTPUT FORMAT:',
  '- Use XML tool calls to interact with the filesystem.',
  '- One tool call per response.',
  '- When ALL work is done, end with <task_complete><message>Summary</message></task_complete>',
  '- NEVER output natural language summaries before or after tool calls.',
  '',
  '## WORKFLOW:',
  '1. Read files to understand the project.',
  '2. Create/edit files as needed.',
  '3. Use task_complete when finished with a brief summary.',
].join('\n');

/**
 * Prompt for Void IDE clients.
 * Void does NOT execute tools locally — MuseSpark intercepts the XML tool calls
 * from Meta AI, executes them on the local machine, and feeds results back.
 * Meta AI must output ONLY raw XML tool calls, nothing else.
 */
function buildVoidPrompt(workspacePath) {
  const ws = workspacePath || 'WORKSPACE';
  return [
    'You are an AI coding agent running inside an IDE gateway that executes tools on the user\'s local machine.',
    '',
    '## CRITICAL RULE — READ CAREFULLY:',
    'You do NOT have direct filesystem access. You access files ONLY via XML tool calls.',
    'NEVER say "I don\'t have access", "send me a zip", or "upload to /mnt/data".',
    'NEVER explain or summarize tool output to the user. Tool output is for YOU only.',
    'NEVER say "Done!", "Created!", "Here is...", "I created...", "Now I will..." or any natural language.',
    '',
    '## OUTPUT FORMAT — MANDATORY:',
    'Output ONLY raw XML. No text before, no text after, no markdown, no explanations.',
    'If you output anything except XML, the agent loop BREAKS and the user sees an error.',
    '',
    `## WORKSPACE: ${ws}`,
    '',
    '## AVAILABLE TOOLS:',
    `<get_dir_tree><uri>${ws}</uri></get_dir_tree>  — list full directory tree`,
    `<read_file><uri>FULL_PATH</uri></read_file>  — read file contents`,
    `<ls_dir><uri>FULL_PATH</uri></ls_dir>  — list directory contents`,
    `<create_file_or_folder><uri>FULL_PATH</uri></create_file_or_folder>  — create file or folder`,
    `<edit_file><uri>FULL_PATH</uri><content><![CDATA[FILE_CONTENT]]></content></edit_file>  — write/overwrite file`,
    `<run_command><command>CMD</command><uri>WORKING_DIR</uri></run_command>  — run shell command`,
    `<search_for_files><query>PATTERN</query><uri>${ws}</uri></search_for_files>  — search files by content`,
    `<search_in_file><query>PATTERN</query><uri>FILE_PATH</uri></search_in_file>  — search inside one file`,
    `<search_pathnames_only><query>PATTERN</query><uri>${ws}</uri></search_pathnames_only>  — search by filename/path`,
    `<delete_file_or_folder><uri>FULL_PATH</uri></delete_file_or_folder>  — delete file or folder`,
    `<task_complete><message>Final summary for the user</message></task_complete>  — signal completion`,
    '',
    '## WORKFLOW FOR CREATE REQUESTS:',
    `1. <get_dir_tree><uri>${ws}</uri></get_dir_tree>`,
    `2. <create_file_or_folder><uri>${ws}/index.html</uri></create_file_or_folder>`,
    `3. <edit_file><uri>${ws}/index.html</uri><content><![CDATA[<!DOCTYPE html>...]]></content></edit_file>`,
    '4. Repeat 2-3 for each additional file.',
    '5. <task_complete><message>Brief summary of what was created</message></task_complete>',
    '6. NEVER output natural language after any tool result.',
    '',
    '## FORBIDDEN:',
    '\u274c "The directory is empty"',
    '\u274c "I created the file"',
    '\u274c "Done!" or "Created!" or "Here is..."',
    '\u274c Any natural language before or after a tool call',
    '\u2705 ONLY XML — one tool call per response, or task_complete when ALL work is done',
  ].join('\n');
}

/**
 * Static export — used when workspace path is not yet known.
 * For runtime injection use getPromptForClient() or buildVoidPrompt().
 */
const BRIDGE_PROMPT_VOID = buildVoidPrompt();

/**
 * Backward-compat alias — existing code that imports BRIDGE_AGENT_PROMPT keeps working.
 */
const BRIDGE_AGENT_PROMPT = BRIDGE_PROMPT_OPENCLAUDE;

// ─── Extração de workspace ───

/**
 * Ordered list of regex patterns that may encode a workspace path inside a
 * system message.  Each pattern must have one capturing group that returns
 * the raw path string (before trimming).
 */
const WORKSPACE_PATTERNS = [
  // OpenClaude canonical
  /Primary working directory:\s*(.+)/i,
  // Simple CWD line
  /^CWD:\s*(.+)/im,
  // Generic "Working directory:" label
  /Working directory:\s*(.+)/i,
  // "Working in <path>" (common Void phrasing)
  /Working in\s+([A-Za-z]:[\\/][^\n\r]+)/i,
  /Working in\s+(\/[^\n\r]+)/i,
  // "workspace: <path>" key-value style
  /\bworkspace(?:\s+path)?:\s*([A-Za-z]:[\\/][^\n\r]+)/i,
  /\bworkspace(?:\s+path)?:\s*(\/[^\n\r]+)/i,
  // "project:" or "project_root:"
  /\bproject(?:_root)?:\s*([A-Za-z]:[\\/][^\n\r]+)/i,
  /\bproject(?:_root)?:\s*(\/[^\n\r]+)/i,
  // "root:" label
  /\broot:\s*([A-Za-z]:[\\/][^\n\r]+)/i,
  /\broot:\s*(\/[^\n\r]+)/i,
  // Bare Windows absolute path anywhere on its own line
  /^([A-Za-z]:[\\/][^\n\r]{2,})/m,
];

/**
 * Extract workspace path from messages, supporting both OpenClaude and
 * Void IDE message formats.
 *
 * Priority order:
 *  1. System message patterns (WORKSPACE_PATTERNS)
 *  2. First user message if it contains an absolute path reference
 *  3. Hash-based fallback derived from system prompt content
 *
 * @param {Array}  messages           OpenAI-format messages array
 * @param {Object} [headers]          Optional request headers (checked for X-Workspace-Path)
 * @returns {string}  Workspace path, or hash-fallback id, or ''
 */
function extractWorkspaceFromSystemPrompt(messages, headers) {
  if (!Array.isArray(messages)) return '';

  // 0. Honour X-Workspace-Path header (convention for advanced Void users)
  if (headers) {
    const headerPath = headers['x-workspace-path'] || headers['X-Workspace-Path'] || '';
    if (headerPath && headerPath.trim()) return headerPath.trim();
  }

  let systemContent = '';

  // 1. Scan system messages
  for (const msg of messages) {
    if (!msg || msg.role !== 'system') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    systemContent = content; // save for fallback hash

    for (const pattern of WORKSPACE_PATTERNS) {
      const m = content.match(pattern);
      if (m && m[1]) {
        const candidate = m[1].trim().split('\n')[0].trim();
        if (candidate.length > 2) return candidate;
      }
    }
  }

  // 2. Check first user message for an absolute path hint
  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) break; // only first user message
    // Windows absolute path
    const winMatch = content.match(/([A-Za-z]:[\\/][^\s,;"'\n\r]{3,})/);
    if (winMatch && winMatch[1]) return winMatch[1].trim();
    // Unix absolute path (at least 4 chars deep, e.g. /home/x)
    const unixMatch = content.match(/((?:\/[A-Za-z0-9_.\-]+){2,})/);
    if (unixMatch && unixMatch[1]) return unixMatch[1].trim();
    break;
  }

  // 3. Hash-based fallback: stable session ID derived from system prompt content
  if (systemContent && systemContent.length > 10) {
    const hash = createHash('sha256').update(systemContent).digest('hex').slice(0, 16);
    return `__hash_${hash}`;
  }

  return '';
}

function extractOpenClaudeSystemPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (!msg || msg.role !== 'system') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > 50) return content;
  }
  return '';
}

// ─── Detecção de compactação ───

function detectCompaction(messages) {
  if (!Array.isArray(messages)) return null;
  const markers = [
    'This session is being continued from a previous conversation that ran out of context',
    'The summary below covers the earlier portion of the conversation',
    '<!-- conversation compacted -->',
    'session is being continued from a previous conversation'
  ];
  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    for (const marker of markers) {
      if (content.includes(marker)) {
        return { detected: true, summaryText: content.slice(0, 8000), marker, messageIndex: messages.indexOf(msg) };
      }
    }
    const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch && summaryMatch[1] && summaryMatch[1].length > 200) {
      return { detected: true, summaryText: summaryMatch[1].slice(0, 8000), marker: '<summary> XML tag', messageIndex: messages.indexOf(msg) };
    }
  }
  return null;
}

// ─── Extração de query do user ───

function extractUserQuery(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    if (content.startsWith('[TOOL_RESULT') || content.startsWith('Error:')) continue;
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter(c => c && c.type === 'text').map(c => c.text);
      const text = textParts.join('\n').trim();
      if (text) return text;
      continue;
    }
    return content.trim();
  }
  return '';
}

function extractCompactionContext(messages) {
  if (!Array.isArray(messages)) return null;
  const compaction = detectCompaction(messages);
  if (!compaction) return null;
  let latestUserQuery = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    if (content.includes('This session is being continued from a previous conversation')) continue;
    latestUserQuery = content.trim();
    break;
  }
  return {
    summary: compaction.summaryText,
    latestQuery: latestUserQuery,
    injectionText: compaction.summaryText + (latestUserQuery ? `\n\n---\n\n${latestUserQuery}` : '')
  };
}

// ─── Tool calls XML ↔ OpenAI ───

function parseToolXMLParams(innerContent) {
  const params = {};
  const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = paramRegex.exec(innerContent)) !== null) {
    params[match[1]] = match[2].trim();
  }
  return params;
}

function hasMetaToolCallXML(text) {
  if (!text || typeof text !== 'string') return false;
  const tools = ['read_file','ls_dir','get_dir_tree','run_command','search_for_files','search_in_file','edit_file','create_file_or_folder','delete_file_or_folder','task_complete'];
  return tools.some(name => new RegExp(`<${name}>`, 'i').test(text));
}

function parseMetaToolCallsXML(text) {
  if (!text || typeof text !== 'string') return [];
  const toolNames = ['read_file','ls_dir','get_dir_tree','run_command','search_for_files','search_in_file','edit_file','create_file_or_folder','delete_file_or_folder','task_complete'];
  const toolCalls = [];
  for (const toolName of toolNames) {
    const regex = new RegExp(`<${toolName}>([\\s\\S]*?)</${toolName}>`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      toolCalls.push({ name: toolName, params: parseToolXMLParams(match[1].trim()), rawXML: match[0] });
    }
  }

  // Pattern 2: <tool_call name="xxx">...
  const tcRegex = /<tool_call\s+name="(\w+)"[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let tcMatch;
  while ((tcMatch = tcRegex.exec(text)) !== null) {
    toolCalls.push({ name: tcMatch[1], params: parseToolXMLParams(tcMatch[2].trim()), rawXML: tcMatch[0] });
  }

  return toolCalls;
}

/**
 * Converte tool calls parseados para formato OpenAI.
 */
function convertToolCallsToOpenAI(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  return toolCalls.map((tc, idx) => ({
    id: `call_${createHash('sha1').update(`${tc.name}:${JSON.stringify(tc.params)}:${idx}`).digest('hex').slice(0, 24)}`,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.params || {})
    }
  }));
}

/**
 * Extrai texto sem tool calls XML (para enviar ao cliente).
 */
function extractTextWithoutToolCalls(text) {
  if (!text || typeof text !== 'string') return '';
  const t = ['read_file','ls_dir','get_dir_tree','run_command','search_for_files','search_in_file','edit_file','create_file_or_folder','delete_file_or_folder','task_complete'];
  let cleaned = text;
  for (const n of t) {
    const regex = new RegExp(`<${n}>[\\s\\S]*?</${n}>`, 'gi');
    cleaned = cleaned.replace(regex, '').trim();
  }
  return cleaned.trim();
}

// ─── Client detection ───

/**
 * Detect whether the connecting client is OpenClaude or Void IDE.
 *
 * OpenClaude markers:
 *   - System message containing "Primary working directory:"
 *   - System message containing "claude" (case-insensitive)
 *   - Anthropic-style x-claude headers (checked externally, but we look at content)
 *
 * Void markers:
 *   - Absence of OpenClaude markers
 *   - System message containing "void" (case-insensitive)
 *
 * Default: 'void'
 *
 * @param {Array} messages  OpenAI-format messages array
 * @returns {'openclaude'|'void'}
 */
function detectClientType(messages) {
  if (!Array.isArray(messages)) return 'void';

  for (const msg of messages) {
    if (!msg || msg.role !== 'system') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;

    // Strong OpenClaude signals
    if (/primary working directory:/i.test(content)) return 'openclaude';
    if (/\bclaude\b/i.test(content)) return 'openclaude';
    if (/anthropic/i.test(content)) return 'openclaude';

    // Explicit Void signal
    if (/\bvoid\b/i.test(content)) return 'void';
  }

  // Also check first user message for OpenClaude identity hints
  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    if (/\bclaude\b/i.test(content)) return 'openclaude';
    break; // only check first user message
  }

  return 'void'; // default
}

/**
 * Return the appropriate bridge prompt for the detected client type.
 *
 * @param {'openclaude'|'void'} clientType
 * @param {string} [workspacePath]  injected into the Void prompt at runtime
 * @returns {string}
 */
function getPromptForClient(clientType, workspacePath) {
  if (clientType === 'openclaude') return BRIDGE_PROMPT_OPENCLAUDE;
  return buildVoidPrompt(workspacePath || '');
}

/**
 * Constroi o prompt combinado para o 1º turno.
 * BRIDGE_PROMPT + OpenClaude system prompt + user query
 *
 * @param {Array}  messages
 * @param {'openclaude'|'void'} [clientType]  auto-detected when omitted
 * @param {string} [workspacePath]  used to inject workspace path into Void prompt
 */
function buildFirstTurnPrompt(messages, clientType, workspacePath) {
  const detectedType = clientType || detectClientType(messages);
  const resolvedWorkspace = workspacePath || extractWorkspaceFromSystemPrompt(messages);
  const bridgePrompt = getPromptForClient(detectedType, resolvedWorkspace);
  const ocSystem = detectedType === 'openclaude' ? extractOpenClaudeSystemPrompt(messages) : '';
  const userQuery = extractUserQuery(messages);

  const parts = [bridgePrompt];
  if (ocSystem) parts.push('', '--- OpenClaude System Context ---', ocSystem);
  if (userQuery) parts.push('', '--- User Request ---', userQuery);

  return parts.join('\n');
}

/**
 * Constroi o prompt para turnos seguintes (pos-tool execution).
 * Apenas o contexto relevante + tool results.
 */
function buildFollowUpPrompt(messages) {
  return extractUserQuery(messages);
}

/**
 * Check whether the last messages in the conversation are tool result messages
 * (role: 'tool'). Returns an array of formatted strings for each tool result,
 * or an empty array if the latest non-assistant message is not a tool result.
 *
 * Void IDE sends tool results as:
 *   { role: 'tool', tool_call_id: '...', content: '...' }
 *
 * We format them as:
 *   [TOOL_RESULT tool_name]\n[STATUS: SUCCESS/ERROR]\n<output>
 *
 * @param {Array} messages
 * @returns {{ formatted: string, toolName: string, status: string, output: string }[]}
 */
function extractToolResultsFromMessages(messages) {
  if (!Array.isArray(messages)) return [];

  // Collect a contiguous run of tool-result messages at the end of the array
  const toolResults = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'tool') {
      toolResults.unshift(msg); // preserve order
    } else if (msg.role === 'assistant') {
      // The assistant message that triggered these tool calls — stop here
      break;
    } else {
      // Any other role (user, system) terminates the run
      break;
    }
  }

  if (!toolResults.length) return [];

  return toolResults.map((msg) => {
    const rawOutput = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    const output = rawOutput.slice(0, 15000);
    // Infer tool name from tool_call_id if possible (call_<name>_... or call_<hex>)
    const toolCallId = msg.tool_call_id || '';
    // Try to find the matching assistant tool_call to get the function name
    let toolName = 'unknown';
    for (const m of messages) {
      if (!m || m.role !== 'assistant') continue;
      if (!Array.isArray(m.tool_calls)) continue;
      const tc = m.tool_calls.find((t) => t && t.id === toolCallId);
      if (tc && tc.function && tc.function.name) {
        toolName = tc.function.name;
        break;
      }
    }
    const hasError = /error:/i.test(output) || /\bfailed\b/i.test(output) || /exception:/i.test(output);
    const status = hasError ? 'ERROR' : 'SUCCESS';
    const formatted = `[TOOL_RESULT ${toolName}]\n[STATUS: ${status}]\n${output}\n\nREMINDER: Respond ONLY with the next XML tool call. Do NOT explain, summarize, or describe what you did. If you are done with ALL tools, output <task_complete><message>...</message></task_complete>. Any text other than XML or task_complete will BREAK the agent loop.`;
    return { formatted, toolName, status, output, toolCallId };
  });
}

/**
 * Determina se e o 1º turno (sem historico de tool calls).
 */
function isFirstTurn(messages) {
  if (!Array.isArray(messages)) return true;
  // Se ha tool_calls ou role=tool, nao e o 1º turno
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'tool') return false;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) return false;
  }
  return true;
}

module.exports = {
  // Prompts
  BRIDGE_AGENT_PROMPT,          // backward-compat alias → BRIDGE_PROMPT_OPENCLAUDE
  BRIDGE_PROMPT_OPENCLAUDE,
  BRIDGE_PROMPT_VOID,
  buildVoidPrompt,
  // Client detection & prompt selection
  detectClientType,
  getPromptForClient,
  // Message extraction
  extractWorkspaceFromSystemPrompt,
  extractOpenClaudeSystemPrompt,
  detectCompaction,
  extractUserQuery,
  extractCompactionContext,
  extractToolResultsFromMessages,
  // XML tool call parsing
  parseToolXMLParams,
  hasMetaToolCallXML,
  parseMetaToolCallsXML,
  convertToolCallsToOpenAI,
  extractTextWithoutToolCalls,
  // Prompt builders
  buildFirstTurnPrompt,
  buildFollowUpPrompt,
  isFirstTurn
};