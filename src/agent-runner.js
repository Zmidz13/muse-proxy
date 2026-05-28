const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const { randomUUID } = require('crypto');
const { metaWorker } = require('./meta-worker');
const { logChatTurn } = require('./log-utils');

/**
 * System prompt to inject when running in Agent Mode.
 * Tells Meta AI about the local tools and the XML format it must use.
 */
const AGENT_SYSTEM_PROMPT = [
  'You are interacting with the user\'s local machine via an external browser gateway (bridge).',
  'Do NOT try to use your internal web tools (like your Python execution sandbox or search) to access the user\'s PC, and do NOT refuse saying you are in the cloud.',
  'Instead, you can execute terminal commands, create/modify files, read files, and manage directories on the user\'s local machine by simply WRITING XML tags in your chat text response.',
  'An external wrapper script reads your chat text in the web browser, detects these XML tags, executes the action locally on the user\'s physical machine, and feeds the results back to you in the next message inside <tool_response> tags.',
  '',
  'CRITICAL: Do NOT use your built-in web file downloader, do NOT ask the user to download files, and do NOT generate downloadable file widgets in the chat. You MUST output the "<write_file>" XML block to write files directly to the user\'s disk.',
  '',
  'To call a tool, you ONLY need to output the corresponding XML tag in your text response. The wrapper will handle execution and reply with the output.',
  '',
  'Available XML Tags:',
  '1. Run a terminal command (PowerShell on Windows, Bash on macOS/Linux):',
  '<execute_command>your command here</execute_command>',
  '',
  '2. Create or overwrite a file:',
  '<write_file path="relative/path/to/file.txt">',
  '<![CDATA[',
  'file content here',
  ']]>',
  '</write_file>',
  '',
  '3. Read a file:',
  '<read_file path="relative/path/to/file.txt"/>',
  '',
  '4. List files and folders in a directory:',
  '<list_dir path="relative/path"/>',
  '',
  '5. Get system environment details (OS, shell, node version, cwd):',
  '<get_env/>',
  '',
  'Rules:',
  '- You must explain what you are doing in plain text BEFORE calling a tool.',
  '- You can call multiple tools in a single response turn.',
  '- Always wrap file contents in CDATA when using <write_file> to prevent XML parsing issues with special symbols.',
  '- Once your task is completely finished and verified, write a final summary to the user without calling any more tools.',
  '',
  'NOTE (Portuguese): Você não executa os comandos diretamente. Um script externo lê o seu texto no chat da web, detecta as tags XML e executa as ações no PC do usuário, devolvendo o resultado na próxima mensagem. Por isso, você NÃO precisa usar as ferramentas internas da Meta AI (como sandbox Python ou busca) e NÃO deve recusar dizendo que está na nuvem. NÃO use o recurso de gerar arquivos para download do próprio site; você DEVE escrever as tags XML no próprio texto do chat para salvar os arquivos! Exemplo para criar pasta no desktop: <execute_command>mkdir "C:\\Users\\Foxli\\Desktop\\west saint"</execute_command>'
].join('\n');

/**
 * Helper to parse JSON strings with potentially unescaped nested double quotes.
 */
function parseLooseJson(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    const result = {};
    const keyRegex = /(?:^|{|,)\s*"([^"]+)"\s*:\s*/g;
    const keys = [];
    let match;
    while ((match = keyRegex.exec(str)) !== null) {
      keys.push({
        name: match[1],
        valueStartIdx: keyRegex.lastIndex
      });
    }
    
    for (let i = 0; i < keys.length; i++) {
      const currentKey = keys[i];
      const nextKey = keys[i + 1];
      
      const nextKeyStart = nextKey ? str.lastIndexOf('"' + nextKey.name + '"', nextKey.valueStartIdx) : str.length;
      
      let valueStr = str.slice(currentKey.valueStartIdx, nextKeyStart).trim();
      
      if (valueStr.endsWith(',')) {
        valueStr = valueStr.slice(0, -1).trim();
      }
      if (!nextKey && valueStr.endsWith('}')) {
        valueStr = valueStr.slice(0, -1).trim();
      }
      
      if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
        valueStr = valueStr.slice(1, -1);
      } else if (valueStr.startsWith("'") && valueStr.endsWith("'")) {
        valueStr = valueStr.slice(1, -1);
      }
      
      valueStr = valueStr
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      result[currentKey.name] = valueStr;
    }
    
    return result;
  }
}

/**
 * Parses XML-style tool calls from the model's text response.
 */
function parseToolCalls(text) {
  const calls = [];
  
  // 1. Parse execute_command
  const cmdRegex = /<execute_command>([\s\S]*?)<\/execute_command>/g;
  let match;
  while ((match = cmdRegex.exec(text)) !== null) {
    calls.push({ type: 'execute_command', command: match[1].trim() });
  }

  // 2. Parse write_file
  const writeRegex = /<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/g;
  while ((match = writeRegex.exec(text)) !== null) {
    let content = match[2];
    if (content.includes('<![CDATA[')) {
      const cdataMatch = /<!\[CDATA\[([\s\S]*?)\]\]>/g.exec(content);
      if (cdataMatch) content = cdataMatch[1];
    }
    // Unescape literal \n \t \r that Meta AI sometimes outputs instead of real newlines
    if (!content.includes('\n') && content.includes('\\n')) {
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
    }
    calls.push({ type: 'write_file', path: match[1].trim(), content });
  }

  // 3. Parse read_file
  const readRegex = /<read_file\s+path=["']([^"']+)["']\s*(?:\/>|<\/read_file>)/g;
  while ((match = readRegex.exec(text)) !== null) {
    calls.push({ type: 'read_file', path: match[1].trim() });
  }

  // 4. Parse list_dir
  const listRegex = /<list_dir\s+path=["']([^"']+)["']\s*(?:\/>|<\/list_dir>)/g;
  while ((match = listRegex.exec(text)) !== null) {
    calls.push({ type: 'list_dir', path: match[1].trim() });
  }

  // 5. Parse get_env
  const envRegex = /<get_env\s*(?:\/>|<\/get_env>)/g;
  while ((match = envRegex.exec(text)) !== null) {
    calls.push({ type: 'get_env' });
  }

  // 6. Parse generic tool_call blocks
  const genericRegex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/g;
  while ((match = genericRegex.exec(text)) !== null) {
    const name = match[1].trim();
    let args = {};
    try {
      let jsonContent = match[2].trim();
      if (jsonContent.includes('<![CDATA[')) {
        const cdataMatch = /<!\[CDATA\[([\s\S]*?)\]\]>/g.exec(jsonContent);
        if (cdataMatch) {
          jsonContent = cdataMatch[1].trim();
        }
      }
      args = parseLooseJson(jsonContent);
    } catch (err) {
      // Ignore JSON parsing errors
    }
    calls.push({ type: name, isGeneric: true, name, args });
  }

  return calls;
}

/**
 * Executes a single tool call locally on the user's system.
 */
async function executeTool(call) {
  const t0 = Date.now();
  let output = '';

  try {
    switch (call.type) {
      case 'get_env':
        output = JSON.stringify({
          os: os.type(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          cwd: process.cwd(),
          nodeVersion: process.version,
          shell: process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash')
        }, null, 2);
        break;

      case 'list_dir': {
        const dirPath = path.resolve(call.path || '.');
        if (!fs.existsSync(dirPath)) {
          output = `Error: Path does not exist: ${call.path}`;
          break;
        }
        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory()) {
          output = `Error: Path is not a directory: ${call.path}`;
          break;
        }
        const files = fs.readdirSync(dirPath);
        const list = files.map(file => {
          const fp = path.join(dirPath, file);
          const fstat = fs.statSync(fp);
          return {
            name: file,
            isDirectory: fstat.isDirectory(),
            size: fstat.isFile() ? fstat.size : null,
            mtime: fstat.mtime
          };
        });
        output = JSON.stringify(list, null, 2);
        break;
      }

      case 'read_file': {
        const filePath = path.resolve(call.path);
        if (!fs.existsSync(filePath)) {
          output = `Error: File does not exist: ${call.path}`;
          break;
        }
        const fstat = fs.statSync(filePath);
        if (!fstat.isFile()) {
          output = `Error: Path is not a file: ${call.path}`;
          break;
        }
        output = fs.readFileSync(filePath, 'utf-8');
        break;
      }

      case 'write_file': {
        const filePath = path.resolve(call.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, call.content || '', 'utf-8');
        output = `Successfully wrote ${call.content?.length || 0} characters to ${call.path}`;
        break;
      }

      case 'execute_command': {
        output = await new Promise((resolve) => {
          exec(call.command, { timeout: 60000 }, (error, stdout, stderr) => {
            let res = '';
            if (error) {
              res += `Exit Code: ${error.code || 1}\nError: ${error.message}\n`;
            } else {
              res += `Exit Code: 0\n`;
            }
            if (stdout) res += `--- STDOUT ---\n${stdout}\n`;
            if (stderr) res += `--- STDERR ---\n${stderr}\n`;
            resolve(res);
          });
        });
        break;
      }

      default:
        output = `Error: Unknown tool type: ${call.type}`;
    }
  } catch (err) {
    output = `Error executing tool: ${err.message}`;
  }

  // eslint-disable-next-line no-console
  console.log(`[AGENT] Executed ${call.type} (${Date.now() - t0}ms)`);

  return { name: call.type, output };
}

/**
 * Runs the local agent execution loop.
 * Continues sending prompts to Meta AI and executing tools until no tools are called.
 */
async function runAgentLoop(flatPrompt, options = {}) {
  const sessionId = options.sessionId || `agent-${randomUUID().slice(0, 8)}`;
  
  // Inject the agent system prompt on the very first turn
  let turnPrompt = `${AGENT_SYSTEM_PROMPT}\n\n[User Request]\n${flatPrompt}`;
  
  let loopCount = 0;
  const maxLoops = options.maxLoops || 15;
  let finalResponseText = '';
  let finalUrl = '';
  
  const allToolCalls = [];
  const allToolResults = [];

  while (loopCount < maxLoops) {
    if (options.cancelRef && options.cancelRef.aborted) {
      throw new Error('Agent loop aborted by client connection close');
    }
    loopCount++;
    
    // eslint-disable-next-line no-console
    console.log(`[AGENT] Loop ${loopCount}/${maxLoops} | session=${sessionId.slice(0, 8)} | prompt=${turnPrompt.length} chars`);

    // Submit prompt to Meta AI
    const result = await metaWorker.submitPrompt(turnPrompt, {
      sessionId,
      forceNewChat: loopCount === 1,
      sessionUrl: options.sessionUrl,
      alwaysFilePrompt: options.alwaysFilePrompt,
      cancelRef: options.cancelRef
    });

    const text = String(result && result.text ? result.text : '').trim();
    finalUrl =
      (result && result.meta && result.meta.url) ||
      (result && result.meta && result.meta.session && result.meta.session.url) ||
      '';

    // Parse any XML tool calls in the response text
    const toolCalls = parseToolCalls(text);
    
    if (toolCalls.length === 0) {
      // No tool calls were made in this turn. We have the final text!
      finalResponseText = text;
      break;
    }

    // Inform user in terminal output
    // eslint-disable-next-line no-console
    console.log(`[AGENT] Intercepted ${toolCalls.length} tool call(s) from Meta AI response.`);
    allToolCalls.push(...toolCalls);

    // Execute all tool calls
    const toolResults = [];
    for (const call of toolCalls) {
      const res = await executeTool(call);
      toolResults.push(res);
      allToolResults.push(res);
    }

    // Build the follow-up prompt containing tool results
    const followUpParts = toolResults.map(r => [
      `<tool_response name="${r.name}">`,
      r.output,
      `</tool_response>`
    ].join('\n'));

    // Feed the results back as the next user prompt
    turnPrompt = [
      ...followUpParts,
      '',
      'Now analyze the tool output(s) above and continue or finalize the task.'
    ].join('\n');
  }

  if (loopCount >= maxLoops) {
    finalResponseText = [
      finalResponseText,
      '\n\n[Warning: Agent loop limit reached. Not all tasks may have completed.]'
    ].join('\n');
  }

  // Log the final accumulated agent transaction
  logChatTurn({
    sessionId,
    clientType: 'agent',
    messages: [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      { role: 'user', content: flatPrompt }
    ],
    responseText: finalResponseText,
    toolCalls: allToolCalls,
    toolResults: allToolResults
  });

  return {
    text: finalResponseText,
    sessionId,
    chatUrl: finalUrl
  };
}

module.exports = { runAgentLoop, parseToolCalls, executeTool, AGENT_SYSTEM_PROMPT };
