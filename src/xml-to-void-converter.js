/**
 * XML to Void Tool Call Converter
 *
 * Converts XML tool calls from Meta AI into OpenAI-style tool_calls that Void IDE expects.
 *
 * Meta AI outputs XML like:
 *   <read_file>
 *   <uri>/path/to/file</uri>
 *   </read_file>
 *
 * Void IDE expects:
 *   {
 *     tool_calls: [{
 *       index: 0,
 *       id: "call_abc123",
 *       type: "function",
 *       function: {
 *         name: "read_file",
 *         arguments: '{"uri":"/path/to/file"}'
 *       }
 *     }]
 *   }
 *
 * This module handles the conversion.
 */

const { randomUUID } = require('crypto');
const { getVoidToolNames } = require('./void-tools-schema');

const VOID_TOOL_NAMES = getVoidToolNames();

/**
 * Parse a single XML tool call from Meta AI response.
 * Handles both self-closing and body tags.
 *
 * @param {string} text - The Meta AI response text
 * @returns {{ name: string, params: Record<string, string> }|null}
 */
function parseXMLToolCall(text) {
  if (!text) return null;
  const source = text.trim();

  // Try to match any known Void tool XML pattern
  for (const toolName of VOID_TOOL_NAMES) {
    const escapedName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escapedName}>([\\s\\S]*?)</${escapedName}>`, 'i');
    const match = source.match(regex);

    if (match) {
      const body = match[1];
      const params = {};

      // Extract all child tags as parameters
      const paramRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/gi;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(body)) !== null) {
        let value = paramMatch[2].trim();
        // Strip CDATA if present
        const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
        if (cdataMatch) {
          value = cdataMatch[1].trim();
        }
        params[paramMatch[1]] = value;
      }

      return { name: toolName, params };
    }
  }

  // Also handle <tool_call name="..."> wrapper format
  const toolCallMatch = source.match(/<tool_call\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/tool_call>/i);
  if (toolCallMatch) {
    const name = toolCallMatch[1].trim();
    const body = toolCallMatch[2];
    const params = {};

    const paramRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/gi;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      let value = paramMatch[2].trim();
      const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
      if (cdataMatch) {
        value = cdataMatch[1].trim();
      }
      params[paramMatch[1]] = value;
    }

    return { name, params };
  }

  return null;
}

/**
 * Parse ALL tool calls from Meta AI response (supports multiple consecutive tool calls).
 *
 * @param {string} text - The Meta AI response text
 * @returns {Array<{ name: string, params: Record<string, string> }>}
 */
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
        if (cdataMatch) {
          value = cdataMatch[1].trim();
        }
        params[paramMatch[1]] = value;
      }

      results.push({ name: toolName, params });
    }
  }

  return results;
}

/**
 * Convert a parsed XML tool call to OpenAI-style tool_call format for Void IDE.
 *
 * @param {{ name: string, params: Record<string, string> }} parsedToolCall
 * @param {string} [toolCallId] - Optional tool call ID (auto-generated if not provided)
 * @returns {{ id: string, type: 'function', function: { name: string, arguments: string } }}
 */
function xmlToOpenAIToolCall(parsedToolCall, toolCallId) {
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

/**
 * Convert ALL parsed XML tool calls to an array of OpenAI-style tool_calls.
 *
 * @param {Array<{ name: string, params: Record<string, string> }> | string} parsedCalls - Parsed tool calls or raw text to parse
 * @returns {Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>}
 */
function xmlToOpenAIToolCalls(parsedCalls) {
  if (typeof parsedCalls === 'string') {
    parsedCalls = parseAllXMLToolCalls(parsedCalls);
  }
  return parsedCalls.map(tc => xmlToOpenAIToolCall(tc));
}

/**
 * Build the full streaming chunk for a tool call (what Void IDE expects during streaming).
 * Void specifically checks `chunk.choices[0]?.delta?.tool_calls[0]?.index === 0`.
 *
 * @param {{ name: string, params: Record<string, string> }} parsedToolCall
 * @param {string} [toolCallId]
 * @returns {object} Streaming chunk
 */
function buildStreamingToolChunk(parsedToolCall, toolCallId) {
  const toolCall = xmlToOpenAIToolCall(parsedToolCall, toolCallId);
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
      finish_reason: 'tool_calls'
    }]
  };
}

/**
 * Build the non-streaming response with tool_calls (what Void IDE expects when not streaming).
 *
 * @param {Array<{ name: string, params: Record<string, string> }>} parsedCalls
 * @param {string} [content] - Optional assistant text before the tool call
 * @returns {object}
 */
function buildNonStreamingToolCallsResponse(parsedCalls, content) {
  const toolCalls = xmlToOpenAIToolCalls(parsedCalls);
  return {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls
      },
      finish_reason: 'tool_calls'
    }]
  };
}

/**
 * Check if a text contains any XML tool call.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasXMLToolCall(text) {
  if (!text) return false;
  for (const toolName of VOID_TOOL_NAMES) {
    const escapedName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escapedName}>`, 'i');
    if (regex.test(text)) return true;
  }
  return false;
}

/**
 * Convert a tool result from Void IDE back to XML format for Meta AI.
 * Void sends back results as `role: 'tool'` messages with content.
 * We need to format this as XML that Meta AI understands.
 *
 * @param {string} toolName
 * @param {string} result - The tool execution result
 * @param {string} status - 'SUCCESS' or 'ERROR'
 * @returns {string} Formatted tool result for Meta AI
 */
function formatToolResultForMetaAI(toolName, result, status) {
  const statusStr = status === 'ERROR' ? '[STATUS: ERROR]' : '[STATUS: SUCCESS]';
  return (
    `[TOOL_RESULT ${toolName}]\n` +
    `${statusStr}\n` +
    `${result}\n\n` +
    `REMINDER: Respond ONLY with the next XML tool call. Do NOT explain, summarize, or describe what you did. ` +
    `If you are done with ALL tools, output <task_complete><message>...</message></task_complete>. ` +
    `Any text other than XML or task_complete will BREAK the agent loop.`
  );
}

module.exports = {
  parseXMLToolCall,
  parseAllXMLToolCalls,
  xmlToOpenAIToolCall,
  xmlToOpenAIToolCalls,
  buildStreamingToolChunk,
  buildNonStreamingToolCallsResponse,
  hasXMLToolCall,
  formatToolResultForMetaAI
};
