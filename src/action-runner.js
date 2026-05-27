const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const MAX_OUTPUT = 15000;
const MAX_WALK_ENTRIES = 2500;
const MAX_DIR_TREE_LINES = 600;
const MAX_FILE_SIZE_BYTES = 256 * 1024;
const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.pw-brave-profile',
  '.qwen'
]);

function normalizeGeneratedFileContent(raw) {
  let text = String(raw || '').replace(/\r/g, '').trim();
  // Strip CDATA wrappers — handle both wrapping and inline occurrences
  text = text.replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/g, '').trim();
  // Strip search/replace markers — handle both multiline and inline (single line)
  // IMPORTANT: order matters — strip markers BEFORE content
  text = text
    .replace(/<{6,7}\s*(?:ORIGINAL|SEARCH)[^\n]*/gi, '')
    .replace(/\>{6,7}\s*(?:UPDATED|REPLACE)\s*/gi, '')
    .replace(/>={3,}\s*/g, '')
    .replace(/^Code\s*\n?/gim, '')
    .replace(/^={3,}\s*$/gm, '')
    .replace(/^\s*(ORIGINAL|SEARCH|UPDATED|REPLACE)\s*$/gim, '')
    .trim();
  // If after stripping markers we have content that looks like HTML/code, keep it
  // Even if it's on a single line with leftover marker text
  if (!text || text.length === 0) {
    // Try extracting content between markers more aggressively
    const aggressiveMatch = String(raw || '').match(/<{6,7}\s*\w*\s*(.*?)\s*>{6,7}/i);
    if (aggressiveMatch && aggressiveMatch[1]) {
      text = aggressiveMatch[1].replace(/^Code\s*/i, '').trim();
    }
  }
  return text;
}

function execPromise(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { ...opts, timeout: 15000, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function toBool(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const source = String(glob || '*').replace(/\\/g, '/');
  const escaped = escapeRegExp(source)
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function isIgnoredDirName(name) {
  return IGNORED_DIR_NAMES.has(String(name || '').toLowerCase());
}

function isProbablyTextFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (!ext) return true;
  const binaryish = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.7z',
    '.rar', '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.mp3',
    '.mp4', '.avi', '.mov', '.webm'
  ]);
  return !binaryish.has(ext);
}

function walkPathEntries(root, options = {}) {
  const base = path.resolve(String(root || process.cwd()));
  const maxEntries = Number(options.maxEntries || MAX_WALK_ENTRIES);
  const includeDirs = Boolean(options.includeDirs);
  const results = [];
  const stack = [base];

  while (stack.length && results.length < maxEntries) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDirName(entry.name)) continue;
        if (includeDirs) results.push({ path: fullPath, isDirectory: true });
        if (results.length >= maxEntries) break;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push({ path: fullPath, isDirectory: false });
        if (results.length >= maxEntries) break;
      }
    }
  }

  return results.slice(0, maxEntries);
}

function buildTreeLines(root, options = {}) {
  const base = path.resolve(String(root || process.cwd()));
  const maxLines = Number(options.maxLines || MAX_DIR_TREE_LINES);
  const lines = [base];
  let count = 1;

  const visit = (current, prefix) => {
    if (count >= maxLines) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      lines.push(`${prefix}[error reading directory]`);
      count += 1;
      return;
    }

    entries = entries
      .filter((entry) => !(entry.isDirectory() && isIgnoredDirName(entry.name)))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < entries.length; i += 1) {
      if (count >= maxLines) return;
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const branch = isLast ? '└─ ' : '├─ ';
      const childPrefix = prefix + (isLast ? '   ' : '│  ');
      lines.push(`${prefix}${branch}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      count += 1;
      if (entry.isDirectory()) {
        visit(path.join(current, entry.name), childPrefix);
      }
    }
  };

  visit(base, '');
  if (count >= maxLines) lines.push('... truncated ...');
  return lines;
}

function findNearestEslint(startPath) {
  let current = path.resolve(startPath || process.cwd());
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = process.cwd();
  }

  while (true) {
    const candidates = [
      path.join(current, 'node_modules', '.bin', 'eslint.cmd'),
      path.join(current, 'node_modules', '.bin', 'eslint')
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function runReadFile(uri, options = {}) {
  const resolved = path.resolve(uri);
  if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return `Error: Not a file: ${resolved}`;
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    const lines = content.split(/\r?\n/);
    const total = lines.length;
    const opts = options && typeof options === 'object' ? options : {};
    const oneLine = toInt(opts.line);
    let start = toInt(opts.start_line);
    let end = toInt(opts.end_line);

    if (oneLine) {
      start = oneLine;
      end = oneLine;
    }

    if (start && !end) end = start;
    if (!start) start = 1;
    if (!end) end = Math.min(total, 300);

    start = Math.max(1, Math.min(start, total || 1));
    end = Math.max(start, Math.min(end, total || start));
    const excerpt = lines.slice(start - 1, end);
    const body = excerpt.map((line, i) => `${start + i}| ${line}`).join('\n').slice(0, MAX_OUTPUT);

    // If the file is empty or only whitespace, tell the model explicitly.
    if (!content.trim()) {
      return `${resolved}\n(lines ${start}-${end} of ${total})\n\`\`\`\n${body}\n\`\`\`\n\n[FILE IS EMPTY] Use edit_file to write the full content directly (no ORIGINAL block needed for empty files — just put the full content in the UPDATED block, or omit markers entirely and send the raw content inside search_replace_blocks).`;
    }

    return `${resolved}\n(lines ${start}-${end} of ${total})\n\`\`\`\n${body}\n\`\`\``;
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

async function runLsDir(uri) {
  const target = String(uri || '').trim() || process.cwd();
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return `Error: Directory not found: ${resolved}`;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return `Error: Not a directory: ${resolved}`;
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return `${resolved}\n(empty directory — no files or subfolders found)`;
    const lines = entries.map((entry) => `${entry.isDirectory() ? '[DIR]  ' : '[FILE] '}${entry.name}`);
    return `${resolved}\n${lines.join('\n')}`;
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
}

async function runGetDirTree(uri) {
  const target = String(uri || '').trim() || process.cwd();
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return `Error: Directory not found: ${resolved}`;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return `Error: Not a directory: ${resolved}`;
  const lines = buildTreeLines(resolved);
  // If only 1 line, the directory is empty (only root path returned).
  // Return an explicit message so the model knows it's empty, not inaccessible.
  if (lines.length <= 1) {
    return `${resolved}\n(empty directory — no files or subfolders found)`;
  }
  return lines.join('\n').slice(0, MAX_OUTPUT);
}

async function runSearchPathnames(query, includePattern, searchRoot = process.cwd()) {


  const q = String(query || '').trim().toLowerCase();
  if (!q) return 'Error: search_pathnames_only requires a query.';
  const root = path.resolve(searchRoot || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return `Error: Search root not found: ${root}`;
  }
  const pattern = String(includePattern || '*').trim() || '*';
  const patternRx = globToRegExp(pattern);
  const entries = walkPathEntries(root, { maxEntries: MAX_WALK_ENTRIES, includeDirs: true });
  const matches = entries
    .filter((entry) => {
      const relative = path.relative(root, entry.path).replace(/\\/g, '/');
      const name = path.basename(entry.path).toLowerCase();
      return (relative.toLowerCase().includes(q) || name.includes(q)) && patternRx.test(relative);
    })
    .slice(0, 100)
    .map((entry) => entry.path);
  return matches.length ? matches.join('\n') : 'No matches found.';
}

async function runSearchForFiles(query, searchInFolder, isRegex = false) {
  const root = path.resolve(String(searchInFolder || process.cwd()).trim() || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return `Error: Directory not found: ${root}`;
  }
  const q = String(query || '');
  if (!q.trim()) return 'Error: search_for_files requires a query.';

  let matcher = null;
  if (isRegex) {
    try {
      matcher = new RegExp(q, 'i');
    } catch (err) {
      return `Error: Invalid regex: ${err.message}`;
    }
  }

  const matches = [];
  const entries = walkPathEntries(root, { maxEntries: MAX_WALK_ENTRIES });
  for (const entry of entries) {
    if (entry.isDirectory || !isProbablyTextFile(entry.path)) continue;
    try {
      const stat = fs.statSync(entry.path);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      const content = fs.readFileSync(entry.path, 'utf8');
      const hit = matcher ? matcher.test(content) : content.toLowerCase().includes(q.toLowerCase());
      if (hit) matches.push(entry.path);
    } catch {
      // skip unreadable/binary files
    }
    if (matches.length >= 100) break;
  }

  return matches.length ? matches.join('\n') : 'No matches found.';
}

async function runSearchInFile(uri, query, isRegex = false) {
  const resolved = path.resolve(uri);
  if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    const lines = content.split(/\r?\n/);
    const matches = [];
    let regex = null;
    const needle = String(query || '');

    if (isRegex) {
      try {
        regex = new RegExp(needle, 'i');
      } catch (err) {
        return `Error: Invalid regex: ${err.message}`;
      }
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const hit = regex ? regex.test(line) : line.toLowerCase().includes(needle.toLowerCase());
      if (hit) matches.push(`${i + 1}: ${line.trim()}`);
      if (matches.length >= 100) break;
    }
    return matches.length ? matches.join('\n') : 'No matches found.';
  } catch (err) {
    return `Error searching file: ${err.message}`;
  }
}

async function runCommand(command, cwd) {
  const workDir = cwd || process.cwd();
  try {
    const { stdout, stderr } = await execPromise(command, { cwd: workDir });
    const out = (stdout || '').slice(0, MAX_OUTPUT);
    const err = (stderr || '').slice(0, 2000);
    let result = out;
    if (err) result += `\n[stderr]\n${err}`;
    return result || '(command completed with no output)';
  } catch (err) {
    const out = (err.stdout || '').slice(0, MAX_OUTPUT);
    const errMsg = (err.stderr || err.message || '').slice(0, 2000);
    return `Command failed: ${errMsg}\n${out}`;
  }
}

async function runCreateFileOrFolder(uri, kind = '') {
  const raw = String(uri || '').trim();
  const resolved = path.resolve(raw);
  const explicitFolder = /^(folder|dir|directory)$/i.test(String(kind || '').trim());
  const endsWithSlash = raw.endsWith('\\') || raw.endsWith('/');
  const base = path.basename(raw.replace(/[\\\/]+$/, ''));
  const hasExt = base.includes('.');
  const isFolder = explicitFolder || endsWithSlash || !hasExt;
  try {
    if (isFolder) {
      fs.mkdirSync(resolved, { recursive: true });
      return `Created directory: ${resolved}`;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, '', 'utf8');
    return `Created file: ${resolved}`;
  } catch (err) {
    return `Error creating: ${err.message}`;
  }
}

async function runDeleteFileOrFolder(uri, isRecursive = false) {
  const resolved = path.resolve(String(uri || '').trim());
  if (!fs.existsSync(resolved)) return `Error: Path not found: ${resolved}`;
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      if (!isRecursive) return `Error: Refusing to delete directory without is_recursive=true: ${resolved}`;
      fs.rmSync(resolved, { recursive: true, force: false });
      return `Deleted directory: ${resolved}`;
    }
    fs.rmSync(resolved, { force: false });
    return `Deleted file: ${resolved}`;
  } catch (err) {
    return `Error deleting path: ${err.message}`;
  }
}

async function runReadLintErrors(uri) {
  const resolved = path.resolve(String(uri || '').trim());
  if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
  const eslintBin = findNearestEslint(resolved);
  if (!eslintBin) {
    return `No local ESLint installation found for: ${resolved}`;
  }
  const quotedBin = eslintBin.replace(/"/g, '""');
  const quotedFile = resolved.replace(/"/g, '""');
  try {
    const { stdout, stderr } = await execPromise(`"${quotedBin}" --format unix "${quotedFile}"`, {
      cwd: path.dirname(eslintBin)
    });
    const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
    return output || 'No lint errors found.';
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim();
    return output || `Error reading lint errors: ${err.message}`;
  }
}

async function runFullFileWrite(uri, content) {
  const resolved = path.resolve(uri);
  const cleaned = normalizeGeneratedFileContent(content);

  if (!cleaned || cleaned.length < 10) {
    return `Error: No valid content for file write: ${resolved}`;
  }

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, cleaned, 'utf8');
    return `File written: ${resolved} (${cleaned.length} bytes)`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

async function runEditFile(uri, content) {
  const resolved = path.resolve(uri);

  const parseSearchReplaceBlocks = (raw) => {
    const text = String(raw || '').replace(/\r/g, '');
    const blocks = [];
    const removeCdata = (str) => String(str || '').replace(/<\!\[CDATA\[/gi, '').replace(/\]\]>/g, '').trim();

    const rxFull = /<{6,7}\s*\w*\s*\n([\s\S]*?)\n={3,}\s*\n([\s\S]*?)\n>{6,7}\s*\w*/gi;
    let match = null;
    while ((match = rxFull.exec(text)) !== null) {
      const original = removeCdata(match[1].replace(/^Code\s*\n?/i, ''));
      const updated = removeCdata(match[2]);
      if (original && updated && original !== updated) {
        blocks.push({ original, updated });
      }
    }

    if (!blocks.length) {
      const rxSimple = /<{6,7}\s*\w*\s*\n([\s\S]*?)\n>{6,7}\s*\w*/gi;
      while ((match = rxSimple.exec(text)) !== null) {
        const fullBlock = match[1].trim();
        const parts = fullBlock.split(/\n={3,}\s*\n/);
        if (parts.length >= 2) {
          const original = removeCdata(parts[0].replace(/^Code\s*\n?/i, ''));
          const updated = removeCdata(parts.slice(1).join('\n'));
          if (original && updated && original !== updated) {
            blocks.push({ original, updated });
          }
        } else {
          const cleaned = normalizeGeneratedFileContent(fullBlock);
          if (cleaned && cleaned.length > 10) {
            blocks.push({ original: null, updated: cleaned, isFullReplace: true });
          }
        }
      }
    }

    if (!blocks.length) {
      const sanitized = normalizeGeneratedFileContent(text);
      if (sanitized && sanitized.length > 0) {
        blocks.push({ original: null, updated: sanitized, isFullReplace: true });
      }
    }

    // Fallback: handle inline CDATA with broken markers on a single line
    if (!blocks.length) {
      const inlineMatch = text.match(/<!\[CDATA\[\s*<{6,7}\s*\w*\s*(.*?)\s*>{6,7}\s*\w*\s*\]\]>/i);
      if (inlineMatch && inlineMatch[1]) {
        const cleaned = inlineMatch[1]
          .replace(/^Code\s*\n?/gi, '')
          .replace(/^(ORIGINAL|SEARCH|UPDATED|REPLACE)\s*$/gim, '')
          .trim();
        if (cleaned && cleaned.length > 0) {
          blocks.push({ original: null, updated: cleaned, isFullReplace: true });
        }
      }
    }

    return blocks;
  };

  const applySearchReplaceBlocks = (source, blocks) => {
    let out = String(source || '').replace(/\r\n/g, '\n');
    for (const block of blocks) {
      if (block.isFullReplace || !block.original) {
        return { ok: true, text: block.updated, isFullReplace: true };
      }
      const original = String(block.original || '').replace(/\r\n/g, '\n');
      const updated = String(block.updated || '').replace(/\r\n/g, '\n');
      const idx = out.indexOf(original);
      if (idx < 0) {
        return { ok: false, error: `Original block not found in file (${Math.min(80, original.length)} chars).` };
      }
      out = out.slice(0, idx) + updated + out.slice(idx + original.length);
    }
    return { ok: true, text: out };
  };

  try {
    if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return `Error: Not a file: ${resolved}`;

    const raw = fs.readFileSync(resolved, 'utf8');

    if (!raw || raw.trim().length === 0) {
      const contentToWrite = normalizeGeneratedFileContent(content);
      // Write content even if small (minimum 1 byte)
      if (contentToWrite.length > 0) {
        fs.writeFileSync(resolved, contentToWrite, 'utf8');
        return `File written (was empty): ${resolved}`;
      }
      return `Error: No content provided for empty file: ${resolved}`;
    }

    const blocks = parseSearchReplaceBlocks(content);

    if (!blocks.length) {
      return `Error: No valid search/replace blocks were received! Content length: ${content?.length || 0}. Ensure format uses <<<<<<< SEARCH / ======= / >>>>>>> REPLACE markers, or use create_file_or_folder for full file rewrites.`;
    }

    const applied = applySearchReplaceBlocks(raw, blocks);
    if (!applied.ok) return `Error applying search/replace: ${applied.error}`;

    const useCrlf = /\r\n/.test(raw);
    const finalText = useCrlf ? applied.text.replace(/\n/g, '\r\n') : applied.text;
    fs.writeFileSync(resolved, finalText, 'utf8');

    if (applied.isFullReplace) {
      return `File updated (full replacement): ${resolved}`;
    }
    return `File updated: ${resolved} (applied ${blocks.length} block(s))`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

function parseToolCallXML(text) {
  if (!text) return null;
  const source = String(text || '').trim();

  const parseAttrs = (attrText) => {
    const attrs = {};
    const rx = /([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"/g;
    let match = null;
    while ((match = rx.exec(attrText)) !== null) {
      attrs[match[1]] = match[2];
    }
    return attrs;
  };

  const readTag = (body, tag) => {
    const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!match) return '';
    const value = match[1].trim();
    const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdataMatch ? cdataMatch[1] : value;
  };

  const toolCallWithBody = source.match(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/i);
  const toolCallSelfClosing = source.match(/<tool_call\b([^>]*)\/>/i);
  if (toolCallWithBody || toolCallSelfClosing) {
    const attrText = toolCallWithBody ? toolCallWithBody[1] : toolCallSelfClosing[1];
    const body = toolCallWithBody ? toolCallWithBody[2] : '';
    const attrs = parseAttrs(attrText || '');
    const name = String(attrs.name || '').trim();
    if (name) {
      const params = { ...attrs };
      delete params.name;
      const uri = readTag(body, 'uri');
      const query = readTag(body, 'query');
      const command = readTag(body, 'command');
      const cwd = readTag(body, 'cwd');
      const line = readTag(body, 'line');
      const startLine = readTag(body, 'start_line');
      const endLine = readTag(body, 'end_line');
      const content = readTag(body, 'search_replace_blocks');
      const kind = readTag(body, 'kind');
      const includePattern = readTag(body, 'include_pattern') || readTag(body, 'include');
      const searchInFolder = readTag(body, 'search_in_folder');
      const isRegex = readTag(body, 'is_regex');
      const isRecursive = readTag(body, 'is_recursive');
      if (uri && !params.uri) params.uri = uri;
      if (query && !params.query) params.query = query;
      if (command && !params.command) params.command = command;
      if (cwd && !params.cwd) params.cwd = cwd;
      if (line && !params.line) params.line = line;
      if (startLine && !params.start_line) params.start_line = startLine;
      if (endLine && !params.end_line) params.end_line = endLine;
      if (kind && !params.kind) params.kind = kind;
      if (content && !params.content) params.content = content;
      if (includePattern && !params.includePattern) params.includePattern = includePattern;
      if (searchInFolder && !params.searchInFolder) params.searchInFolder = searchInFolder;
      if (isRegex && !params.isRegex) params.isRegex = isRegex;
      if (isRecursive && !params.isRecursive) params.isRecursive = isRecursive;
      return { name, params };
    }
  }

  const readFileMatch = source.match(/<read_file>([\s\S]*?)<\/read_file>/i);
  if (readFileMatch) {
    const uriMatch = readFileMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    const lineMatch = readFileMatch[1].match(/<line>([\s\S]*?)<\/line>/i);
    const startLineMatch = readFileMatch[1].match(/<start_line>([\s\S]*?)<\/start_line>/i);
    const endLineMatch = readFileMatch[1].match(/<end_line>([\s\S]*?)<\/end_line>/i);
    if (uriMatch) {
      const params = { uri: uriMatch[1].trim() };
      if (lineMatch) params.line = lineMatch[1].trim();
      if (startLineMatch) params.start_line = startLineMatch[1].trim();
      if (endLineMatch) params.end_line = endLineMatch[1].trim();
      return { name: 'read_file', params };
    }
  }

  const lsDirMatch = source.match(/<ls_dir>([\s\S]*?)<\/ls_dir>/i);
  if (lsDirMatch) {
    const uriMatch = lsDirMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    return { name: 'ls_dir', params: { uri: uriMatch ? uriMatch[1].trim() : '' } };
  }

  const dirTreeMatch = source.match(/<get_dir_tree>([\s\S]*?)<\/get_dir_tree>/i);
  if (dirTreeMatch) {
    const uriMatch = dirTreeMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    if (uriMatch) return { name: 'get_dir_tree', params: { uri: uriMatch[1].trim() } };
  }

  const searchPathMatch = source.match(/<search_pathnames_only>([\s\S]*?)<\/search_pathnames_only>/i);
  if (searchPathMatch) {
    const queryMatch = searchPathMatch[1].match(/<query>([\s\S]*?)<\/query>/i);
    const includeMatch = searchPathMatch[1].match(/<include_pattern>([\s\S]*?)<\/include_pattern>/i) ||
      searchPathMatch[1].match(/<include>([\s\S]*?)<\/include>/i);
    if (queryMatch) {
      return {
        name: 'search_pathnames_only',
        params: {
          query: queryMatch[1].trim(),
          includePattern: includeMatch ? includeMatch[1].trim() : '*'
        }
      };
    }
  }

  const searchForFilesMatch = source.match(/<search_for_files>([\s\S]*?)<\/search_for_files>/i);
  if (searchForFilesMatch) {
    const queryMatch = searchForFilesMatch[1].match(/<query>([\s\S]*?)<\/query>/i);
    const folderMatch = searchForFilesMatch[1].match(/<search_in_folder>([\s\S]*?)<\/search_in_folder>/i);
    const regexMatch = searchForFilesMatch[1].match(/<is_regex>([\s\S]*?)<\/is_regex>/i);
    if (queryMatch) {
      return {
        name: 'search_for_files',
        params: {
          query: queryMatch[1].trim(),
          searchInFolder: folderMatch ? folderMatch[1].trim() : '',
          isRegex: regexMatch ? regexMatch[1].trim() : 'false'
        }
      };
    }
  }

  const runCmdMatch = source.match(/<run_command>([\s\S]*?)<\/run_command>/i);
  if (runCmdMatch) {
    const cmdMatch = runCmdMatch[1].match(/<command>([\s\S]*?)<\/command>/i);
    const cwdMatch = runCmdMatch[1].match(/<cwd>([\s\S]*?)<\/cwd>/i);
    if (cmdMatch) {
      return {
        name: 'run_command',
        params: {
          command: cmdMatch[1].trim(),
          cwd: cwdMatch ? cwdMatch[1].trim() : process.cwd()
        }
      };
    }
  }

  const searchFileMatch = source.match(/<search_in_file>([\s\S]*?)<\/search_in_file>/i);
  if (searchFileMatch) {
    const uriMatch = searchFileMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    const queryMatch = searchFileMatch[1].match(/<query>([\s\S]*?)<\/query>/i);
    const regexMatch = searchFileMatch[1].match(/<is_regex>([\s\S]*?)<\/is_regex>/i);
    if (uriMatch && queryMatch) {
      return {
        name: 'search_in_file',
        params: {
          uri: uriMatch[1].trim(),
          query: queryMatch[1].trim(),
          isRegex: regexMatch ? regexMatch[1].trim() : 'false'
        }
      };
    }
  }

  const readLintErrorsMatch = source.match(/<read_lint_errors>([\s\S]*?)<\/read_lint_errors>/i);
  if (readLintErrorsMatch) {
    const uriMatch = readLintErrorsMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    if (uriMatch) return { name: 'read_lint_errors', params: { uri: uriMatch[1].trim() } };
  }

  const editFileMatch = source.match(/<edit_file>([\s\S]*?)<\/edit_file>/i);
  if (editFileMatch) {
    const uriMatch = editFileMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    // Try search_replace_blocks first, then content (both formats are valid)
    const blocksMatch = editFileMatch[1].match(/<search_replace_blocks>([\s\S]*?)<\/search_replace_blocks>/i);
    const contentMatch = editFileMatch[1].match(/<content>([\s\S]*?)<\/content>/i);
    if (uriMatch) {
      let content = '';
      if (blocksMatch) {
        content = blocksMatch[1];
      } else if (contentMatch) {
        // Content may be CDATA-wrapped or raw
        content = contentMatch[1].replace(/<!\[CDATA\[/gi, '').replace(/\]\]>/g, '');
      }
      return {
        name: 'edit_file',
        params: {
          uri: uriMatch[1].trim(),
          content
        }
      };
    }
  }

  const createMatch = source.match(/<create_file_or_folder>([\s\S]*?)<\/create_file_or_folder>/i);
  if (createMatch) {
    const uriMatch = createMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    const kindMatch = createMatch[1].match(/<kind>([\s\S]*?)<\/kind>/i);
    if (uriMatch) {
      const params = { uri: uriMatch[1].trim() };
      if (kindMatch) params.kind = kindMatch[1].trim();
      return { name: 'create_file_or_folder', params };
    }
  }

  const deleteMatch = source.match(/<delete_file_or_folder>([\s\S]*?)<\/delete_file_or_folder>/i);
  if (deleteMatch) {
    const uriMatch = deleteMatch[1].match(/<uri>([\s\S]*?)<\/uri>/i);
    const recursiveMatch = deleteMatch[1].match(/<is_recursive>([\s\S]*?)<\/is_recursive>/i);
    if (uriMatch) {
      return {
        name: 'delete_file_or_folder',
        params: {
          uri: uriMatch[1].trim(),
          isRecursive: recursiveMatch ? recursiveMatch[1].trim() : 'false'
        }
      };
    }
  }

  const completeMatch = source.match(/<task_complete>([\s\S]*?)<\/task_complete>/i);
  if (completeMatch) {
    const msgMatch = completeMatch[1].match(/<message>([\s\S]*?)<\/message>/i);
    return {
      name: 'task_complete',
      params: { message: msgMatch ? msgMatch[1].trim() : completeMatch[1].trim() }
    };
  }

  return null;
}

function extractToolCallsXML(text) {
  const source = String(text || '').trim();
  if (!source) return [];

  const blocks = source.match(
    /<tool_call\b[\s\S]*?<\/tool_call>|<tool_call\b[^>]*\/>|<(read_file|ls_dir|get_dir_tree|run_command|search_pathnames_only|search_for_files|search_in_file|read_lint_errors|edit_file|create_file_or_folder|delete_file_or_folder|task_complete)\b[\s\S]*?<\/\1>/ig
  ) || [];

  const parsed = blocks
    .map((block) => parseToolCallXML(block))
    .filter((entry) => entry && entry.name);

  if (parsed.length > 0) return parsed;

  const single = parseToolCallXML(source);
  return single && single.name ? [single] : [];
}

async function executeToolCall(toolCall) {
  const { name, params = {} } = toolCall || {};
  // eslint-disable-next-line no-console
  console.log(`[TOOL] executing: ${name} ${JSON.stringify(params).slice(0, 200)}`);

  switch (name) {
    case 'read_file':
      return runReadFile(params.uri, params);
    case 'ls_dir':
      return runLsDir(params.uri);
    case 'get_dir_tree':
      return runGetDirTree(params.uri);
    case 'run_command':
      return runCommand(params.command, params.cwd);
    case 'search_pathnames_only':
      return runSearchPathnames(params.query, params.includePattern);
    case 'search_for_files':
      return runSearchForFiles(params.query, params.searchInFolder, toBool(params.isRegex));
    case 'search_in_file':
      return runSearchInFile(params.uri, params.query, toBool(params.isRegex));
    case 'read_lint_errors':
      return runReadLintErrors(params.uri);
    case 'edit_file':
      return runEditFile(params.uri, params.content);
    case '__full_file_write__':
      return runFullFileWrite(params.uri, params.content);
    case 'create_file_or_folder':
      return runCreateFileOrFolder(params.uri, params.kind || params.type);
    case 'delete_file_or_folder':
      return runDeleteFileOrFolder(params.uri, toBool(params.isRecursive));
    case 'task_complete':
      return `__TASK_COMPLETE__:${params.message || 'Done'}`;
    default:
      return `Unknown tool: ${name}`;
  }
}

function hasToolCall(text) {
  return /<(tool_call|read_file|ls_dir|get_dir_tree|run_command|search_pathnames_only|search_for_files|search_in_file|read_lint_errors|edit_file|create_file_or_folder|delete_file_or_folder|__full_file_write__|task_complete)\b/i.test(String(text || ''));
}

module.exports = { parseToolCallXML, extractToolCallsXML, executeToolCall, hasToolCall };
