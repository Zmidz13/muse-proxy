'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Returns the configured prompt log directory.
 * Checks MUSE_PROMPT_LOG_DIR env var first, then falls back to default.
 * @returns {string}
 */
function getPromptLogDir() {
  return process.env.MUSE_PROMPT_LOG_DIR || path.join(process.cwd(), 'meta_inspector', 'prompt_logs');
}

/**
 * Rotates prompt log files in logDir, keeping at most maxFiles.
 * If the file count exceeds maxFiles, the oldest files (by mtime) are deleted.
 * Non-blocking and non-fatal: errors are logged as warnings and execution continues.
 *
 * @param {string} [logDir] - Path to the log directory (defaults to getPromptLogDir())
 * @param {number} [maxFiles=100] - Maximum number of log files to keep
 */
function rotatePromptLogs(logDir, maxFiles) {
  if (logDir === undefined || logDir === null) {
    logDir = getPromptLogDir();
  }
  if (typeof maxFiles !== 'number' || maxFiles < 1) {
    maxFiles = 100;
  }

  try {
    // Directory doesn't exist — nothing to rotate
    if (!fs.existsSync(logDir)) {
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(logDir);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[LOG_ROTATE] Cannot read log dir "${logDir}": ${String(err && err.message ? err.message : err)}`);
      return;
    }

    if (!entries || entries.length === 0) {
      return;
    }

    // Collect files with their mtime
    const files = [];
    for (const entry of entries) {
      const filePath = path.join(logDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          files.push({ filePath, mtimeMs: stat.mtimeMs });
        }
      } catch (_) {
        // Stat failed (race condition, permission) — skip this entry
      }
    }

    if (files.length <= maxFiles) {
      return;
    }

    // Sort ascending by mtime (oldest first)
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    const deleteCount = files.length - maxFiles;
    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < deleteCount; i++) {
      try {
        fs.unlinkSync(files[i].filePath);
        deleted++;
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.warn(`[LOG_ROTATE] Cannot delete "${files[i].filePath}": ${String(err && err.message ? err.message : err)}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[LOG_ROTATE] Rotated prompt logs: deleted=${deleted} failed=${failed} kept=${files.length - deleted} dir="${logDir}"`);

  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[LOG_ROTATE] Unexpected error during log rotation: ${String(err && err.message ? err.message : err)}`);
  }
}

const MUSE_HOME = process.env.MUSE_HOME || path.join(os.homedir(), '.musespark');
const LOGS_DIR = path.join(MUSE_HOME, 'logs');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Logs a chat turn to a global JSON log file AND a session-specific markdown file.
 */
function logChatTurn({ sessionId, clientType, messages, responseText, toolCalls = [], toolResults = [] }) {
  try {
    ensureLogsDir();
    const timestamp = new Date().toISOString();

    // 1. Write to global JSON log (NJSON)
    const jsonLogPath = path.join(LOGS_DIR, 'muse-global.json');
    const logEntry = {
      timestamp,
      sessionId,
      clientType,
      messages,
      responseText,
      toolCalls,
      toolResults
    };
    fs.appendFileSync(jsonLogPath, JSON.stringify(logEntry) + '\n', 'utf-8');

    // 2. Write to session-specific markdown log
    const mdLogPath = path.join(LOGS_DIR, `session-${sessionId}.md`);
    const fileExists = fs.existsSync(mdLogPath);
    
    const mdContent = [];
    if (!fileExists) {
      mdContent.push(`# Session ${sessionId}`);
      mdContent.push(`Created: ${timestamp}`);
      mdContent.push(`Type: ${clientType}`);
      mdContent.push(`---`);
      mdContent.push('');
    }

    mdContent.push(`### [${timestamp}] Turn`);
    mdContent.push('');
    
    // Add user prompt (last user message or messages list)
    const userMsgs = Array.isArray(messages) ? messages.filter(m => m.role === 'user') : [];
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    if (lastUserMsg) {
      mdContent.push(`**User:**`);
      mdContent.push('```');
      mdContent.push(lastUserMsg.content || '');
      mdContent.push('```');
      mdContent.push('');
    } else if (typeof messages === 'string') {
      mdContent.push(`**User (Prompt):**`);
      mdContent.push('```');
      mdContent.push(messages);
      mdContent.push('```');
      mdContent.push('');
    }

    // Add tool calls if any
    if (toolCalls && toolCalls.length > 0) {
      mdContent.push(`**AI Tool Calls:**`);
      for (const call of toolCalls) {
        mdContent.push('```json');
        mdContent.push(JSON.stringify(call, null, 2));
        mdContent.push('```');
      }
      mdContent.push('');
    }

    // Add tool results if any
    if (toolResults && toolResults.length > 0) {
      mdContent.push(`**Tool Results:**`);
      for (const res of toolResults) {
        mdContent.push(`*Tool: ${res.name}*`);
        mdContent.push('```');
        mdContent.push(res.output || '');
        mdContent.push('```');
        mdContent.push('');
      }
    }

    // Add final response
    mdContent.push(`**AI Response:**`);
    mdContent.push('```');
    mdContent.push(responseText || '');
    mdContent.push('```');
    mdContent.push('');
    mdContent.push('---');
    mdContent.push('');

    fs.appendFileSync(mdLogPath, mdContent.join('\n'), 'utf-8');

  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[LOGGER] Error writing chat logs:', err.message || err);
  }
}

module.exports = { rotatePromptLogs, getPromptLogDir, logChatTurn, LOGS_DIR };

const logLineListeners = new Set();
const MAX_LOG_BUFFER = 2000;
const logBuffer = [];

function captureLogLine(line) {
  const entry = { t: Date.now(), l: line };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.splice(0, logBuffer.length - MAX_LOG_BUFFER);
  for (const listener of logLineListeners) {
    try { listener(entry); } catch (_) { /* noop */ }
  }
}

function getLogBuffer() {
  return logBuffer.slice();
}

function addLogListener(fn) {
  logLineListeners.add(fn);
  return () => { logLineListeners.delete(fn); };
}

function removeLogListener(fn) {
  logLineListeners.delete(fn);
}

const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;

console.log = function (...args) {
  const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  captureLogLine(line);
  _origLog.apply(console, args);
};

console.error = function (...args) {
  const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  captureLogLine('[ERR] ' + line);
  _origErr.apply(console, args);
};

console.warn = function (...args) {
  const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  captureLogLine('[WRN] ' + line);
  _origWarn.apply(console, args);
};

module.exports = { rotatePromptLogs, getPromptLogDir, logChatTurn, LOGS_DIR, getLogBuffer, addLogListener, removeLogListener };
