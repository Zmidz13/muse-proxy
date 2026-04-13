const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeToolCall } = require('../src/action-runner');

function loadGatewayInVoidMode(submitPromptImpl) {
  const openaiPath = require.resolve('../src/openai-api');
  const metaWorkerPath = require.resolve('../src/meta-worker');
  const keyStorePath = require.resolve('../src/key-store');

  const previousOpenAi = require.cache[openaiPath];
  const previousMetaWorker = require.cache[metaWorkerPath];
  const previousKeyStore = require.cache[keyStorePath];
  const previousToolExecutionMode = process.env.MUSE_TOOL_EXECUTION_MODE;
  const previousWarmup = process.env.MUSE_WARMUP_ON_START;
  const previousPromptLog = process.env.MUSE_LOG_META_PROMPTS;

  delete require.cache[openaiPath];

  const fakeMetaWorker = {
    submitPrompt: submitPromptImpl,
    reset: async () => {},
    probeReadiness: async () => ({ ok: true, ready: true, checkedAt: new Date().toISOString(), durationMs: 1 }),
    getRuntimeStatus: () => ({
      phase: 'idle',
      thinking: false,
      uiThinking: false,
      stopButtonVisible: false,
      inflightModelRequests: 0,
      totalModelRequests: 0
    })
  };

  require.cache[metaWorkerPath] = {
    id: metaWorkerPath,
    filename: metaWorkerPath,
    loaded: true,
    exports: {
      metaWorker: fakeMetaWorker,
      getMetaRuntimeConfig: () => ({
        userDataDir: 'test-profile',
        headless: true,
        useBraveBinary: false,
        browserPath: null
      }),
      getMetaWorkerStatus: () => fakeMetaWorker.getRuntimeStatus()
    }
  };

  require.cache[keyStorePath] = {
    id: keyStorePath,
    filename: keyStorePath,
    loaded: true,
    exports: {
      listKeys: () => [{ id: 'key-1', name: 'test', prefix: 'muse_test' }],
      validateApiKey: (rawKey) => rawKey === 'test-key'
        ? { ok: true, key: { id: 'key-1', name: 'test', prefix: 'muse_test' } }
        : { ok: false, reason: 'invalid' },
      touchKeyUsage: () => {}
    }
  };

  process.env.MUSE_TOOL_EXECUTION_MODE = 'ide';
  process.env.MUSE_WARMUP_ON_START = 'false';
  process.env.MUSE_LOG_META_PROMPTS = '0';

  const openaiApi = require(openaiPath);

  const restore = () => {
    delete require.cache[openaiPath];
    if (previousOpenAi) require.cache[openaiPath] = previousOpenAi;
    else delete require.cache[openaiPath];
    if (previousMetaWorker) require.cache[metaWorkerPath] = previousMetaWorker;
    else delete require.cache[metaWorkerPath];
    if (previousKeyStore) require.cache[keyStorePath] = previousKeyStore;
    else delete require.cache[keyStorePath];
    if (previousToolExecutionMode === undefined) delete process.env.MUSE_TOOL_EXECUTION_MODE;
    else process.env.MUSE_TOOL_EXECUTION_MODE = previousToolExecutionMode;
    if (previousWarmup === undefined) delete process.env.MUSE_WARMUP_ON_START;
    else process.env.MUSE_WARMUP_ON_START = previousWarmup;
    if (previousPromptLog === undefined) delete process.env.MUSE_LOG_META_PROMPTS;
    else process.env.MUSE_LOG_META_PROMPTS = previousPromptLog;
  };

  return { ...openaiApi, restore };
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function postAsVoid(baseUrl, messages, { stream = false, metadata = {} } = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key'
    },
    body: JSON.stringify({
      model: 'muse',
      messages,
      stream,
      metadata
    })
  });

  if (stream) {
    const raw = await response.text();
    const events = raw
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .filter((line) => line !== '[DONE]')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { status: response.status, raw, events };
  }

  return { status: response.status, payload: await response.json() };
}

function parseStreamLikeVoidSdk(events) {
  let fullTextSoFar = '';
  let toolName = '';
  let toolId = '';
  let toolParamsStr = '';

  for (const chunk of events) {
    fullTextSoFar += chunk.choices?.[0]?.delta?.content ?? '';
    for (const tool of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = tool.index;
      if (index !== 0) continue;
      toolName += tool.function?.name ?? '';
      toolParamsStr += tool.function?.arguments ?? '';
      toolId += tool.id ?? '';
    }
  }

  return {
    fullText: fullTextSoFar,
    toolCall: !toolName
      ? null
      : {
          id: toolId,
          name: toolName,
          rawParams: JSON.parse(toolParamsStr),
          isDone: true
        }
  };
}

function convertVoidToolArgsToMuseParams(name, args) {
  const p = args || {};
  if (name === 'edit_file') {
    return {
      uri: p.uri,
      content: p.search_replace_blocks || ''
    };
  }
  if (name === 'rewrite_file') {
    return {
      uri: p.uri,
      content: p.new_content || ''
    };
  }
  if (name === 'search_for_files') {
    return {
      query: p.query,
      searchInFolder: p.search_in_folder || '',
      isRegex: p.is_regex || 'false'
    };
  }
  if (name === 'search_in_file') {
    return {
      uri: p.uri,
      query: p.query,
      isRegex: p.is_regex || 'false'
    };
  }
  if (name === 'search_pathnames_only') {
    return {
      query: p.query,
      includePattern: p.include_pattern || '*'
    };
  }
  if (name === 'run_command') {
    return {
      command: p.command,
      cwd: p.cwd
    };
  }
  return { ...p };
}

async function executeVoidToolCall(toolCall) {
  const args = JSON.parse(toolCall.function.arguments || '{}');
  return executeToolCall({
    name: toolCall.function.name,
    params: convertVoidToolArgsToMuseParams(toolCall.function.name, args)
  });
}

test('startvoid: real Void-style tool loop uses assistant.tool_calls and role=tool results', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-startvoid-'));
  const prompts = [];
  const replies = [
    {
      text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      meta: { session: { id: 'void-1', url: 'https://meta.ai/prompt/void-1' } }
    },
    {
      text: `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`,
      meta: { session: { id: 'void-1', url: 'https://meta.ai/prompt/void-1' } }
    },
    {
      text: `<edit_file><uri>${path.join(workspace, 'index.html')}</uri><content><![CDATA[<!DOCTYPE html>
<html lang="pt-PT">
  <head><title>Void Start</title></head>
  <body><h1>Void OK</h1></body>
</html>]]></content></edit_file>`,
      meta: { session: { id: 'void-1', url: 'https://meta.ai/prompt/void-1' } }
    },
    {
      text: `<task_complete><message>Site criado via tools reais do Void.</message></task_complete>`,
      meta: { session: { id: 'void-1', url: 'https://meta.ai/prompt/void-1' } }
    }
  ];

  const { createGatewayApp, restore } = loadGatewayInVoidMode(async (prompt) => {
    prompts.push(String(prompt || ''));
    return replies.shift();
  });

  const wrappedFirstPrompt = [
    '<SYSTEM_MESSAGE>',
    'You are an AI coding agent running inside Void.',
    'Use tools to inspect and modify the workspace.',
    '</SYSTEM_MESSAGE>',
    '',
    `<WORKSPACE>${workspace}</WORKSPACE>`,
    '',
    '<USER_REQUEST>',
    `cria um site profissional nesta pasta: ${workspace}`,
    '</USER_REQUEST>'
  ].join('\n');

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const first = await postAsVoid(baseUrl, [
        { role: 'user', content: wrappedFirstPrompt }
      ], { metadata: { new_chat: true } });

      assert.equal(first.status, 200);
      assert.equal(first.payload.choices[0].finish_reason, 'tool_calls');
      assert.equal(first.payload.choices[0].message.content, null);
      const firstToolCall = first.payload.choices[0].message.tool_calls[0];
      assert.equal(firstToolCall.function.name, 'get_dir_tree');
      assert.deepEqual(JSON.parse(firstToolCall.function.arguments), { uri: workspace });

      const firstToolResult = await executeVoidToolCall(firstToolCall);

      const second = await postAsVoid(baseUrl, [
        { role: 'user', content: wrappedFirstPrompt },
        { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: firstToolCall.id, content: String(firstToolResult) }
      ]);

      assert.equal(second.status, 200);
      assert.equal(second.payload.choices[0].finish_reason, 'tool_calls');
      const secondToolCall = second.payload.choices[0].message.tool_calls[0];
      assert.equal(secondToolCall.function.name, 'create_file_or_folder');
      assert.deepEqual(JSON.parse(secondToolCall.function.arguments), {
        uri: path.join(workspace, 'index.html')
      });

      const secondToolResult = await executeVoidToolCall(secondToolCall);

      const third = await postAsVoid(baseUrl, [
        { role: 'user', content: wrappedFirstPrompt },
        { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: firstToolCall.id, content: String(firstToolResult) },
        { role: 'assistant', content: null, tool_calls: second.payload.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: secondToolCall.id, content: String(secondToolResult) }
      ]);

      assert.equal(third.status, 200);
      assert.equal(third.payload.choices[0].finish_reason, 'tool_calls');
      const thirdToolCall = third.payload.choices[0].message.tool_calls[0];
      assert.equal(thirdToolCall.function.name, 'edit_file');
      const thirdArgs = JSON.parse(thirdToolCall.function.arguments);
      assert.equal(thirdArgs.uri, path.join(workspace, 'index.html'));
      assert.match(thirdArgs.search_replace_blocks, /<!DOCTYPE html>/i);
      assert.ok(!('content' in thirdArgs), 'Void should receive search_replace_blocks, not content');

      const thirdToolResult = await executeVoidToolCall(thirdToolCall);

      const fourth = await postAsVoid(baseUrl, [
        { role: 'user', content: wrappedFirstPrompt },
        { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: firstToolCall.id, content: String(firstToolResult) },
        { role: 'assistant', content: null, tool_calls: second.payload.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: secondToolCall.id, content: String(secondToolResult) },
        { role: 'assistant', content: null, tool_calls: third.payload.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: thirdToolCall.id, content: String(thirdToolResult) }
      ]);

      assert.equal(fourth.status, 200);
      assert.equal(fourth.payload.choices[0].finish_reason, 'stop');
      assert.match(fourth.payload.choices[0].message.content, /Site criado via tools reais do Void/i);
      assert.ok(fs.existsSync(path.join(workspace, 'index.html')));
      assert.match(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), /Void OK/i);
    });

    assert.equal(prompts.length, 4, 'gateway must keep talking to Meta on every real Void turn');
    assert.match(prompts[0], /<latest_user_query>/i);
    assert.match(prompts[1], /latest_tool_result/i);
    assert.match(prompts[2], /create_file_or_folder/i);
    assert.match(prompts[3], /edit_file/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('startvoid: streaming emits Void-compatible tool chunks with exact parameter names', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-startvoid-stream-'));

  const { createGatewayApp, restore } = loadGatewayInVoidMode(async () => ({
    text: `<edit_file><uri>${path.join(workspace, 'index.html')}</uri><content><![CDATA[<!DOCTYPE html><html><body>stream</body></html>]]></content></edit_file>`,
    meta: { session: { id: 'void-stream', url: 'https://meta.ai/prompt/void-stream' } }
  }));

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoid(baseUrl, [
        { role: 'user', content: `cria ou edita ${path.join(workspace, 'index.html')}` }
      ], { stream: true, metadata: { new_chat: true } });

      assert.equal(result.status, 200);
      const toolEvents = result.events.filter((event) => event.choices?.[0]?.delta?.tool_calls);
      assert.ok(toolEvents.length > 0, 'stream must include tool_calls for Void animations');
      const firstTool = toolEvents[0].choices[0].delta.tool_calls[0];
      assert.equal(firstTool.index, 0);
      assert.equal(firstTool.function.name, 'edit_file');
      const args = JSON.parse(firstTool.function.arguments);
      assert.ok(args.search_replace_blocks, 'edit_file stream chunk must use search_replace_blocks');
      assert.ok(!('content' in args), 'stream chunk must not leak internal content param');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('startvoid: streaming matches Void SDK parser exactly', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-startvoid-sdk-'));

  const { createGatewayApp, restore } = loadGatewayInVoidMode(async () => ({
    text: `<read_file><uri>${path.join(workspace, 'index.html')}</uri></read_file>`,
    meta: { session: { id: 'void-sdk', url: 'https://meta.ai/prompt/void-sdk' } }
  }));

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoid(baseUrl, [
        { role: 'user', content: `lê ${path.join(workspace, 'index.html')}` }
      ], { stream: true, metadata: { new_chat: true } });

      assert.equal(result.status, 200);
      assert.ok(result.events.length >= 3, 'stream should include role chunk, tool chunk and final chunk');

      const firstEvent = result.events[0];
      assert.equal(firstEvent.choices?.[0]?.delta?.role, 'assistant');

      const lastEvent = result.events[result.events.length - 1];
      assert.equal(lastEvent.choices?.[0]?.finish_reason, 'tool_calls');

      const parsed = parseStreamLikeVoidSdk(result.events);
      assert.equal(parsed.fullText, '');
      assert.ok(parsed.toolCall, 'Void parser must reconstruct a toolCall from the stream');
      assert.equal(parsed.toolCall.name, 'read_file');
      assert.equal(parsed.toolCall.rawParams.uri, path.join(workspace, 'index.html'));
      assert.match(parsed.toolCall.id, /^call_/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});
