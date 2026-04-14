'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = { rotatePromptLogs, getPromptLogDir };
