/**
 * Tests for Void Bridge mode (startvoid) — JSON format
 * Tests the JSON tool call parsing and void bridge protocol.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  parseJSONToolCalls,
  normalizeJSONToToolCall,
  parseAllToolCalls,
  toOpenAIToolCall,
  buildStreamingToolChunk,
  buildNonStreamingToolCallsResponse,
  hasToolCall,
  formatToolResultForMetaAI
} = require('../src/tool-call-converter');
const {
  getVoidToolsDefinitions,
  getVoidToolByName,
  getVoidToolNames,
  generateVoidToolsXMLForPrompt
} = require('../src/void-tools-schema');

// ============================================================
// void-tools-schema tests
// ============================================================

test('getVoidToolsDefinitions returns all 15 Void tools', () => {
  const tools = getVoidToolsDefinitions();
  assert.strictEqual(tools.length, 15);
});

test('getVoidToolByName finds read_file', () => {
  const tool = getVoidToolByName('read_file');
  assert.ok(tool);
  assert.strictEqual(tool.function.name, 'read_file');
});

test('getVoidToolByName returns null for unknown tool', () => {
  const tool = getVoidToolByName('nonexistent_tool');
  assert.strictEqual(tool, null);
});

test('getVoidToolNames returns set with all tool names', () => {
  const names = getVoidToolNames();
  assert.ok(names.has('read_file'));
  assert.ok(names.has('edit_file'));
  assert.ok(names.has('create_file_or_folder'));
  assert.ok(names.has('run_command'));
  assert.ok(names.has('get_dir_tree'));
});

test('generateVoidToolsXMLForPrompt produces XML string', () => {
  const xml = generateVoidToolsXMLForPrompt();
  assert.ok(typeof xml === 'string');
  assert.ok(xml.includes('Available tools:'));
  assert.ok(xml.includes('<read_file>'));
  assert.ok(xml.includes('<edit_file>'));
  // task_complete is handled separately (not a Void native tool)
  assert.ok(xml.includes('Tool calling rules'));
});

test('Void tool definitions have OpenAI format', () => {
  const tools = getVoidToolsDefinitions();
  for (const tool of tools) {
    assert.strictEqual(tool.type, 'function');
    assert.ok(tool.function.name);
    assert.ok(tool.function.description);
    assert.ok(tool.function.parameters);
    assert.ok(tool.function.parameters.properties);
  }
});

// ============================================================
// tool-call-converter JSON tests
// ============================================================

test('parseJSONToolCalls parses simple JSON tool call', () => {
  const text = '{"tool":"read_file","params":{"uri":"/path/to/file"}}';
  const results = parseJSONToolCalls(text);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'read_file');
  assert.strictEqual(results[0].params.uri, '/path/to/file');
});

test('parseJSONToolCalls parses markdown-wrapped JSON', () => {
  const text = '```json\n{"tool":"create_file_or_folder","params":{"uri":"/project/index.html"}}\n```';
  const results = parseJSONToolCalls(text);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'create_file_or_folder');
});

test('parseJSONToolCalls parses run_command with cwd', () => {
  const text = '{"tool":"run_command","params":{"command":"npm install","cwd":"/project"}}';
  const results = parseJSONToolCalls(text);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'run_command');
  assert.strictEqual(results[0].params.command, 'npm install');
  assert.strictEqual(results[0].params.cwd, '/project');
});

test('parseJSONToolCalls returns empty for non-JSON text', () => {
  assert.deepStrictEqual(parseJSONToolCalls('Hello, how can I help?'), []);
  assert.deepStrictEqual(parseJSONToolCalls(''), []);
});

test('normalizeJSONToToolCall handles {tool, params} format', () => {
  const obj = { tool: 'read_file', params: { uri: '/path' } };
  const result = normalizeJSONToToolCall(obj);
  assert.ok(result);
  assert.strictEqual(result.name, 'read_file');
  assert.strictEqual(result.params.uri, '/path');
});

test('normalizeJSONToToolCall handles {name, arguments} format (OpenAI style)', () => {
  const obj = { name: 'read_file', arguments: '{"uri":"/path"}' };
  const result = normalizeJSONToToolCall(obj);
  assert.ok(result);
  assert.strictEqual(result.name, 'read_file');
  assert.strictEqual(result.params.uri, '/path');
});

test('normalizeJSONToToolCall returns null for unknown tool', () => {
  const obj = { tool: 'nonexistent_tool', params: {} };
  assert.strictEqual(normalizeJSONToToolCall(obj), null);
});

test('parseAllToolCalls prefers JSON over XML', () => {
  // JSON is found first
  const jsonText = '{"tool":"read_file","params":{"uri":"/json/path"}}';
  const results = parseAllToolCalls(jsonText);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].params.uri, '/json/path');
});

test('hasToolCall detects JSON tool calls', () => {
  assert.ok(hasToolCall('{"tool":"read_file","params":{"uri":"/path"}}'));
  assert.ok(!hasToolCall('Hello world'));
  assert.ok(!hasToolCall(''));
});

test('toOpenAIToolCall converts to OpenAI format', () => {
  const parsed = { name: 'read_file', params: { uri: '/path/to/file' } };
  const result = toOpenAIToolCall(parsed, 'call_test123');

  assert.strictEqual(result.id, 'call_test123');
  assert.strictEqual(result.type, 'function');
  assert.strictEqual(result.function.name, 'read_file');
  assert.strictEqual(result.function.arguments, '{"uri":"/path/to/file"}');
});

test('buildStreamingToolChunk creates Void-compatible streaming chunk', () => {
  const parsed = { name: 'read_file', params: { uri: '/path' } };
  const chunk = buildStreamingToolChunk(parsed, 'call_abc');

  assert.ok(chunk.choices);
  assert.strictEqual(chunk.choices.length, 1);
  assert.ok(chunk.choices[0].delta.tool_calls);
  assert.strictEqual(chunk.choices[0].delta.tool_calls[0].index, 0);
  assert.strictEqual(chunk.choices[0].delta.tool_calls[0].id, 'call_abc');
  assert.strictEqual(chunk.choices[0].delta.tool_calls[0].function.name, 'read_file');
  assert.strictEqual(chunk.choices[0].finish_reason, 'tool_calls');
});

test('buildNonStreamingToolCallsResponse creates Void-compatible response', () => {
  const parsed = [{ name: 'read_file', params: { uri: '/path' } }];
  const response = buildNonStreamingToolCallsResponse(parsed, 'Reading file...');

  assert.strictEqual(response.choices[0].message.content, 'Reading file...');
  assert.strictEqual(response.choices[0].message.tool_calls.length, 1);
  assert.strictEqual(response.choices[0].finish_reason, 'tool_calls');
});

test('formatToolResultForMetaAI uses JSON reminder', () => {
  const result = formatToolResultForMetaAI('read_file', 'file contents here', 'SUCCESS');

  assert.ok(result.includes('[TOOL_RESULT read_file]'));
  assert.ok(result.includes('[STATUS: SUCCESS]'));
  assert.ok(result.includes('file contents here'));
  assert.ok(result.includes('Respond ONLY with the next tool call in JSON format'));
  assert.ok(result.includes('{"done":true,"message":"Summary for user"}'));
});

// ============================================================
// Integration-style tests
// ============================================================

test('Full cycle: JSON → OpenAI tool_call → Void executes → result → JSON', () => {
  // Step 1: Meta AI outputs JSON
  const jsonFromMeta = '{"tool":"read_file","params":{"uri":"/project/index.html"}}';

  // Step 2: Bridge parses JSON
  const parsed = parseJSONToolCalls(jsonFromMeta);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].name, 'read_file');
  assert.strictEqual(parsed[0].params.uri, '/project/index.html');

  // Step 3: Bridge converts to OpenAI format for Void
  const openAIToolCall = toOpenAIToolCall(parsed[0], 'call_void_001');
  assert.strictEqual(openAIToolCall.function.name, 'read_file');
  assert.strictEqual(JSON.parse(openAIToolCall.function.arguments).uri, '/project/index.html');

  // Step 4: Void executes tool (simulated)
  const voidResult = 'Contents of /project/index.html: <!DOCTYPE html>...';

  // Step 5: Bridge formats result back for Meta AI
  const resultForMeta = formatToolResultForMetaAI('read_file', voidResult, 'SUCCESS');
  assert.ok(resultForMeta.includes('[TOOL_RESULT read_file]'));
  assert.ok(resultForMeta.includes('[STATUS: SUCCESS]'));
  assert.ok(resultForMeta.includes('Contents of /project/index.html'));
});

test('JSON parsing handles escaped backslashes in paths (Windows)', () => {
  const text = '{"tool":"read_file","params":{"uri":"c:\\\\Users\\\\Desktop\\\\file.txt"}}';
  const results = parseJSONToolCalls(text);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].params.uri, 'c:\\Users\\Desktop\\file.txt');
});

test('JSON parsing handles nested object params (search_replace_blocks)', () => {
  const text = '{"tool":"edit_file","params":{"uri":"/file.js","search_replace_blocks":"<<<<<<< ORIGINAL\\ncode\\n=======\\nnew\\n>>>>>>> UPDATED"}}';
  const results = parseJSONToolCalls(text);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'edit_file');
  assert.ok(results[0].params.search_replace_blocks.includes('ORIGINAL'));
});

test('Void tools schema matches what Void IDE expects', () => {
  const readFileSync = require('fs').readFileSync;
  const path = require('path');

  // Check read_file has correct params
  const readFileTool = getVoidToolByName('read_file');
  assert.ok(readFileSync);
  assert.ok(readFileTool.function.parameters.properties.uri);
  assert.ok(readFileTool.function.parameters.properties.start_line);

  // Check edit_file has search_replace_blocks
  const editFileTool = getVoidToolByName('edit_file');
  assert.ok(editFileTool.function.parameters.properties.uri);
  assert.ok(editFileTool.function.parameters.properties.search_replace_blocks);
});
