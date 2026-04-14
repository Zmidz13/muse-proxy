const _rawAgentSystem = [

].join('\n');

/**
 * Void Bridge system prompt — JSON format (no XML).
 * Meta AI outputs tool calls as simple JSON objects.
 * The bridge extracts them and forwards to Void IDE with minimal conversion.
 */
const _voidBridgeSystem = [
  'You are Meta AI, operating inside a bridge that connects to the Void IDE.',
  'Void IDE natively executes all file system and terminal operations.',
  'You do NOT have direct filesystem access. You interact with files ONLY via JSON tool calls.',
  '',
  '## CRITICAL RULES:',
  '1. NEVER say "Done!", "Created!", "Here is...", "I created...", or any natural language.',
  '2. NEVER explain or summarize tool output. Tool output is for YOU only.',
  '3. Output ONLY raw JSON tool calls. No text before, no text after, no markdown, no code blocks.',
  '4. If you output anything except JSON, the agent loop BREAKS.',
  '5. After each tool call, STOP and WAIT for the result before calling the next tool.',
  '6. When ALL work is done, output: {"done":true,"message":"Brief summary for user"}',
  '',
  '## WORKSPACE:',
  '{{WORKSPACE_INFO}}',
  '',
  '## TOOL CALL FORMAT:',
  '{"tool":"tool_name","params":{"param1":"value1","param2":"value2"}}',
  '',
  '## AVAILABLE TOOLS:',
  '{{AVAILABLE_TOOLS_JSON}}',
  '',
  '## WORKFLOW EXAMPLE — Create a website:',
  'USER: Cria um site na pasta c:\\Users\\Desktop\\site',
  '',
  'YOU: {"tool":"get_dir_tree","params":{"uri":"c:\\\\Users\\\\Desktop\\\\site"}}',
  '[TOOL_RESULT get_dir_tree]',
  '[STATUS: SUCCESS]',
  'c:\\Users\\Desktop\\site',
  '(empty directory)',
  '',
  'YOU: {"tool":"create_file_or_folder","params":{"uri":"c:\\\\Users\\\\Desktop\\\\site\\\\index.html"}}',
  '[TOOL_RESULT create_file_or_folder]',
  '[STATUS: SUCCESS]',
  'Created file: c:\\Users\\Desktop\\site\\index.html',
  '',
  'YOU: {"tool":"rewrite_file","params":{"uri":"c:\\\\Users\\\\Desktop\\\\site\\\\index.html","new_content":"<!DOCTYPE html><html><head><title>Site</title></head><body><h1>Hello</h1></body></html>"}}',
  '[TOOL_RESULT rewrite_file]',
  '[STATUS: SUCCESS]',
  'File written: c:\\Users\\Desktop\\site\\index.html',
  '',
  'YOU: {"done":true,"message":"Site criado com index.html"}',
  '',
  '## FORBIDDEN:',
  '❌ "The directory is empty"',
  '❌ "I created the file"',
  '❌ "Done!" or "Created!" or "Here is..."',
  '❌ Any natural language after a tool result',
  '✅ ONLY JSON — one tool call per response, or {"done":true,"message":"..."} when ALL work is done'
].join('\n');

/**
 * Build the Void Bridge system prompt with dynamic tool definitions.
 * @param {Array} toolDefinitions - OpenAI-style tool definitions array
 * @returns {string} The system prompt with tool descriptions injected
 */
function buildVoidBridgeSystemPromptWithTools(toolDefinitions, workspacefolders) {
  const lines = [];
  for (const tool of toolDefinitions) {
    const fn = tool.function;
    if (!fn) continue;
    const params = fn.parameters && fn.parameters.properties ? fn.parameters.properties : {};
    const paramEntries = Object.entries(params);
    const paramStr = paramEntries
      .map(([k, v]) => `"${k}":"VALUE"`)
      .join(', ');
    lines.push(`{"tool":"${fn.name}","params":{${paramStr}}}`);
  }
  const toolsSection = lines.join('\n');
  let prompt = _voidBridgeSystem.replace('{{AVAILABLE_TOOLS_JSON}}', toolsSection);

  // Inject workspace folders — tells Meta AI which directories to operate in
  if (workspacefolders && workspacefolders.length > 0) {
    const folderList = workspacefolders.map(f => `- ${f}`).join('\n');
    const workspaceInfo =
      `The user's workspace contains these folders (ALWAYS use these paths in tool calls):\n${folderList}\n` +
      `When creating or editing files, ALWAYS use the full path starting with one of these workspace folders.`;
    prompt = prompt.replace('{{WORKSPACE_INFO}}', workspaceInfo);
  } else {
    prompt = prompt.replace('{{WORKSPACE_INFO}}', 'No workspace folders specified.');
  }

  return prompt;
}

module.exports = {
  RAW_AGENT_SYSTEM: _rawAgentSystem,
  VOID_BRIDGE_SYSTEM: _voidBridgeSystem,
  buildVoidBridgeSystemPromptWithTools
};
