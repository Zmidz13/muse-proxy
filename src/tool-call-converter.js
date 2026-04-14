/**
 * Tool Call Converter — JSON first, XML fallback
 *
 * Meta AI outputs JSON tool calls directly in text:
 *   {"tool":"read_file","params":{"uri":"/path/to/file"}}
 *
 * Handles broken JSON: bare backslashes (c:\Users), unescaped quotes in HTML,
 * real newlines in content, trailing backslashes before quotes.
 */

const { randomUUID } = require('crypto');
const { getVoidToolNames } = require('./void-tools-schema');

const VOID_TOOL_NAMES = getVoidToolNames();

/**
 * Parse JSON tool calls from Meta AI text.
 */
function parseJSONToolCalls(text) {
  if (!text) return [];

  // Strategy 1: Try direct JSON parse
  try {
    const parsed = JSON.parse(text.trim());
    const toolCall = normalizeJSONToToolCall(parsed);
    if (toolCall) return [toolCall];
  } catch { /* skip */ }

  // Strategy 2: Find JSON code blocks ```json ... ```
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let codeMatch;
  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(codeMatch[1].trim());
      const toolCall = normalizeJSONToToolCall(parsed);
      if (toolCall) return [toolCall];
    } catch { /* skip */ }
  }

  // Strategy 3: Regex-based extraction for Meta AI's broken JSON
  const toolNameMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
  if (!toolNameMatch) return [];

  const toolName = toolNameMatch[1].trim().toLowerCase();
  if (!VOID_TOOL_NAMES.has(toolName)) return [];

  // Extract params using regex for each known key
  const params = extractParamsWithRegex(text, toolName);
  if (Object.keys(params).length === 0) return [];

  return [{ name: toolName, params }];
}

/**
 * Extract params from broken JSON using regex.
 * Handles: bare backslashes, unescaped quotes, multi-line content, trailing backslashes.
 */
function extractParamsWithRegex(text, toolName) {
  const params = {};

  // Content-heavy tools need special handling for multi-line string values
  if (toolName === 'rewrite_file') {
    params.uri = extractBarebackslashString(text, 'uri');
    params.new_content = extractMultiLineString(text, 'new_content');
  } else if (toolName === 'edit_file') {
    params.uri = extractBarebackslashString(text, 'uri');
    params.search_replace_blocks = extractMultiLineString(text, 'search_replace_blocks');
  } else {
    // Simple tools: extract single-line strings
    const keys = ['uri', 'query', 'command', 'cwd', 'is_regex', 'is_recursive',
      'persistent_terminal_id', 'include_pattern', 'search_in_folder', 'terminal_id',
      'page_number', 'start_line', 'end_line'];
    for (const key of keys) {
      const val = extractBarebackslashString(text, key);
      if (val) params[key] = val;
    }
  }

  return params;
}

/**
 * Extract a string value that may contain bare backslashes (like Windows paths).
 * Handles: \U, \F, \D, trailing \", etc.
 *
 * Key insight: Meta AI sends Windows paths with bare backslashes.
 * A trailing \ before " (like css\") means the \ is literal, not escaping the ".
 */
function extractBarebackslashString(text, key) {
  // Find the key and its value start
  const keyRegex = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
  const match = keyRegex.exec(text);
  if (!match) return null;

  // Value starts after the opening quote
  const startIdx = match.index + match[0].length;
  let value = '';
  let i = startIdx;

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === 'n') { value += '\n'; i += 2; continue; }
      if (next === 't') { value += '\t'; i += 2; continue; }
      if (next === 'r') { value += '\r'; i += 2; continue; }
      if (next === '"') {
        // Escaped quote — but is it REALLY escaped, or a trailing backslash in a path?
        // Heuristic: if value looks like a Windows path (contains :\ or \Users etc),
        // treat \" as literal backslash + end of string
        const isWindowsPath = value.length > 2 && (
          (value[1] === ':') ||
          value.includes(':\\') ||
          value.includes('\\\\') ||
          (value[0] === '\\' && value[1] === '\\')
        );
        if (isWindowsPath) {
          value += '\\';
          i += 2;
          break; // End of string value
        }
        value += '"'; i += 2; continue;
      }
      if (next === '\\') { value += '\\'; i += 2; continue; }
      // Bare backslash (e.g., \U in Windows path) — PRESERVE both chars
      value += '\\' + next;
      i += 2;
      continue;
    }
    if (text[i] === '"') break; // End of string value
    value += text[i];
    i++;
  }

  return value.length > 0 ? value : null;
}

/**
 * Extract a multi-line string value (for new_content, search_replace_blocks).
 * Finds the LAST unescaped " before the final } as the closing quote.
 */
function extractMultiLineString(text, key) {
  const keyRegex = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
  const match = keyRegex.exec(text);
  if (!match) return null;

  const startIdx = match.index + match[0].length;

  // Find the LAST " in the text that's NOT followed by more content
  // Work backwards from the end to find the closing quote
  let endQuote = -1;
  for (let i = text.length - 1; i > startIdx; i--) {
    if (text[i] === '"') {
      // Check if this is an escaped quote
      let backslashCount = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashCount++;
      if (backslashCount % 2 === 0) {
        // Not escaped — this is the real closing quote
        endQuote = i;
        break;
      }
    }
  }

  if (endQuote <= startIdx) return null;

  // Extract and unescape the content
  let content = text.slice(startIdx, endQuote);
  content = content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  // Also fix bare backslashes (e.g., \U → \\U for proper handling)
  // But only if they're not already valid escape sequences
  content = content.replace(/\\([^ntr"\\])/g, '\\\\$1');

  return content.length > 0 ? content : null;
}

/**
 * Normalize a parsed JSON object to a tool call format.
 */
function normalizeJSONToToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Format 1: { tool, params }
  if (obj.tool && typeof obj.tool === 'string') {
    const toolName = obj.tool.trim().toLowerCase();
    if (!VOID_TOOL_NAMES.has(toolName)) return null;
    const params = obj.params || {};
    const stringParams = {};
    for (const [k, v] of Object.entries(params)) {
      stringParams[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return { name: toolName, params: stringParams };
  }

  // Format 2: { name, arguments } (OpenAI style)
  if (obj.name && typeof obj.name === 'string') {
    const toolName = obj.name.trim().toLowerCase();
    if (!VOID_TOOL_NAMES.has(toolName)) return null;
    const args = obj.arguments || obj.params || {};
    const stringParams = {};
    for (const [k, v] of Object.entries(typeof args === 'string' ? JSON.parse(args) : args)) {
      stringParams[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return { name: toolName, params: stringParams };
  }

  return null;
}

// ============================================================
// XML parsing (legacy fallback)
// ============================================================

function parseAllXMLToolCalls(text) {
  if (!text) return [];
  const results = [];

  for (const toolName of VOID_TOOL_NAMES) {
    const escapedName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escapedName}>([\\s\\S]*?)</${escapedName}>`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const body = match[1];
      const params = {};

      const paramRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/gi;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(body)) !== null) {
        let value = paramMatch[2].trim();
        const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
        if (cdataMatch) value = cdataMatch[1].trim();
        params[paramMatch[1]] = value;
      }

      results.push({ name: toolName, params });
    }
  }

  return results;
}

function parseAllToolCalls(text) {
  if (!text) return [];

  // Try JSON first
  const jsonCalls = parseJSONToolCalls(text);
  if (jsonCalls.length > 0) return jsonCalls;

  // Fallback to XML
  return parseAllXMLToolCalls(text);
}

// ============================================================
// Convert to OpenAI tool_call format for Void IDE
// ============================================================

function toOpenAIToolCall(parsedToolCall, toolCallId) {
  const id = toolCallId || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  return {
    id,
    type: 'function',
    function: {
      name: parsedToolCall.name,
      arguments: JSON.stringify(parsedToolCall.params)
    }
  };
}

function buildStreamingToolChunk(parsedToolCall, toolCallId) {
  const toolCall = toOpenAIToolCall(parsedToolCall, toolCallId);
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments
          }
        }]
      },
      finish_reason: null
    }]
  };
}

function buildNonStreamingToolCallsResponse(parsedCalls, content) {
  const toolCalls = parsedCalls.map(tc => toOpenAIToolCall(tc));
  return {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls
      },
      finish_reason: null
    }]
  };
}

function hasToolCall(text) {
  if (!text) return false;
  if (/"tool"\s*:\s*"/.test(text)) return true;
  for (const toolName of VOID_TOOL_NAMES) {
    const escapedName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`<${escapedName}>`, 'i').test(text)) return true;
  }
  return false;
}

function formatToolResultForMetaAI(toolName, result, status) {
  const statusStr = status === 'ERROR' ? '[STATUS: ERROR]' : '[STATUS: SUCCESS]';
  return (
    `[TOOL_RESULT ${toolName}]\n` +
    `${statusStr}\n` +
    `${result}\n\n` +
    `REMINDER: Respond ONLY with the next tool call in JSON format: {"tool":"tool_name","params":{"param":"value"}}. ` +
    `Do NOT explain, summarize, or describe what you did. ` +
    `If you are done with ALL tools, output: {"done":true,"message":"Summary for user"}. ` +
    `Any text other than JSON or the done object will BREAK the agent loop.`
  );
}

module.exports = {
  parseJSONToolCalls,
  normalizeJSONToToolCall,
  parseAllToolCalls,
  parseAllXMLToolCalls,
  toOpenAIToolCall,
  buildStreamingToolChunk,
  buildNonStreamingToolCallsResponse,
  hasToolCall,
  formatToolResultForMetaAI
};
