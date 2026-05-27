const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Simulates EXACTLY what the Void IDE sends and expects.
 * Void uses OpenAI SDK which streams by default.
 * These tests verify the full round-trip: IDE → Gateway → Meta AI → Gateway → IDE
 */

function loadGatewayWithMocks(submitPromptImpl) {
  const openaiPath = require.resolve('../src/openai-api');
  const metaWorkerPath = require.resolve('../src/meta-worker');
  const keyStorePath = require.resolve('../src/key-store');

  const previousOpenAi = require.cache[openaiPath];
  const previousMetaWorker = require.cache[metaWorkerPath];
  const previousKeyStore = require.cache[keyStorePath];
  const previousToolExecutionMode = process.env.MUSE_TOOL_EXECUTION_MODE;

  delete require.cache[openaiPath];

  const fakeMetaWorker = {
    submitPrompt: submitPromptImpl,
    reset: async () => {},
    getRuntimeStatus: () => ({
      phase: 'idle', thinking: false, uiThinking: false,
      stopButtonVisible: false, inflightModelRequests: 0, totalModelRequests: 0
    })
  };

  require.cache[metaWorkerPath] = {
    id: metaWorkerPath, filename: metaWorkerPath, loaded: true,
    exports: {
      metaWorker: fakeMetaWorker,
      getMetaRuntimeConfig: () => ({
        userDataDir: 'test-profile', headless: true, useBraveBinary: false, browserPath: null
      }),
      getMetaWorkerStatus: () => fakeMetaWorker.getRuntimeStatus()
    }
  };

  require.cache[keyStorePath] = {
    id: keyStorePath, filename: keyStorePath, loaded: true,
    exports: {
      listKeys: () => [{ id: 'key-1', name: 'test', prefix: 'muse_test' }],
      validateApiKey: (rawKey) => rawKey === 'test-key'
        ? { ok: true, key: { id: 'key-1', name: 'test', prefix: 'muse_test' } }
        : { ok: false, reason: 'invalid' },
      touchKeyUsage: () => {}
    }
  };

  process.env.MUSE_LOG_META_PROMPTS = '0';
  process.env.MUSE_WARMUP_ON_START = 'false';
  process.env.MUSE_TOOL_EXECUTION_MODE = 'local';

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

/**
 * Simulates Void IDE sending a request via OpenAI SDK.
 * Void sends: { model, messages, stream: true/false }
 * And expects back: { choices: [{ message: { content, tool_calls }, finish_reason }] }
 */
async function postAsVoidIde(baseUrl, messages, opts = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
    body: JSON.stringify({ model: 'muse', messages, stream: opts.stream ?? false, metadata: opts.metadata || {} })
  });
  
  if (opts.stream) {
    const text = await response.text();
    // Parse SSE events - this is what Void's OpenAI SDK does internally
    const events = text
      .split('\n\n')
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6))
      .filter(line => line !== '[DONE]')
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    return { status: response.status, events, raw: text };
  }
  
  return { status: response.status, payload: await response.json() };
}

// Test 1: Void IDE workflow - complete site creation
test('real void ide: complete site creation with multiple tools', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-site-'));

  // Simulate Meta AI responding like it does in real usage
  const modelReplies = [
    // 1. First: explore workspace
    { text: '<get_dir_tree><uri>' + workspace + '</uri></get_dir_tree>', meta: { session: { id: 's1', url: 'https://meta.ai/prompt/s1' } } },
    // 2. Create index.html
    { text: '<create_file_or_folder><uri>' + path.join(workspace, 'index.html') + '</uri></create_file_or_folder>', meta: { session: { id: 's1', url: 'https://meta.ai/prompt/s1' } } },
    // 3. Write content to index.html
    { text: '<edit_file><uri>' + path.join(workspace, 'index.html') + '</uri><content><![CDATA[<!DOCTYPE html><html><head><title>My Site</title></head><body><h1>Hello World</h1></body></html>]]></content></edit_file>', meta: { session: { id: 's1', url: 'https://meta.ai/prompt/s1' } } },
    // 4. Create style.css
    { text: '<create_file_or_folder><uri>' + path.join(workspace, 'style.css') + '</uri></create_file_or_folder>', meta: { session: { id: 's1', url: 'https://meta.ai/prompt/s1' } } },
    // 5. Write CSS
    { text: '<edit_file><uri>' + path.join(workspace, 'style.css') + '</uri><content><![CDATA[body { font-family: sans-serif; margin: 0; padding: 20px; background: #f5f5f5; } h1 { color: #333; }]]></content></edit_file>', meta: { session: { id: 's1', url: 'https://meta.ai/prompt/s1' } } },
    // 6. Done!
    { text: '<task_complete><message>Site created with index.html and style.css</message></task_complete>', meta: { session: { id: 's1', url: 'https://meta.ai/prompt/s1' } } }
  ];

  const prompts = [];
  const { createGatewayApp, restore } = loadGatewayWithMocks(async (prompt) => {
    prompts.push(String(prompt || ''));
    return modelReplies.shift();
  });

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      // Void IDE sends exactly like this
      const result = await postAsVoidIde(baseUrl, [
        { role: 'system', content: `workspace contains these folders: ${workspace}` },
        { role: 'user', content: `create a professional website in ${workspace}` }
      ], { metadata: { new_chat: true } });

      assert.equal(result.status, 200);

      // Void expects tool_calls in the response
      const msg = result.payload.choices[0].message;
      
      // All tools should have been executed
      assert.ok(msg.tool_calls, 'response must have tool_calls');
      assert.ok(msg.tool_calls.length >= 5, `expected at least 5 tool calls, got ${msg.tool_calls.length}`);
      
      // Each tool call must have correct OpenAI format
      msg.tool_calls.forEach((tc, i) => {
        assert.ok(tc.id, `tool_call[${i}] must have id`);
        assert.equal(tc.type, 'function', `tool_call[${i}] type must be "function"`);
        assert.ok(tc.function, `tool_call[${i}] must have function`);
        assert.ok(tc.function.name, `tool_call[${i}] must have function.name`);
        assert.ok(tc.function.arguments, `tool_call[${i}] must have function.arguments`);
        // Arguments must be parseable JSON
        const args = JSON.parse(tc.function.arguments);
        assert.ok(typeof args === 'object', `tool_call[${i}] arguments must be JSON object`);
      });

      // finish_reason must be 'tool_calls' when tools were executed
      assert.equal(result.payload.choices[0].finish_reason, 'tool_calls');

      // Files must actually exist on disk
      assert.ok(fs.existsSync(path.join(workspace, 'index.html')), 'index.html must exist');
      assert.ok(fs.existsSync(path.join(workspace, 'style.css')), 'style.css must exist');
      
      // Files must have clean content (no CDATA/markers)
      const html = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
      assert.match(html, /Hello World/i, 'index.html must contain written content');
      assert.doesNotMatch(html, /<!\[CDATA\[/i, 'index.html must not have CDATA');
      assert.doesNotMatch(html, /<{6,7}\s*(ORIGINAL|SEARCH)/i, 'index.html must not have SEARCH markers');

      // Final message should contain the task_complete text
      assert.match(msg.content, /Site created/i, 'final message should contain completion text');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// Test 2: Void IDE streaming - tool_calls appear in real-time
test('real void ide: streaming emits tool_calls with index 0', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-stream-'));

  const { createGatewayApp, restore } = loadGatewayWithMocks(async () => {
    return {
      text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      meta: { session: { id: 's2', url: 'https://meta.ai/prompt/s2' } }
    };
  });

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `list files in ${workspace}` }
      ], { stream: true, metadata: { new_chat: true } });

      assert.equal(result.status, 200);
      assert.ok(result.events.length > 0, 'must have streaming events');

      // Find events with tool_calls (Void looks for chunk.choices[0]?.delta?.tool_calls)
      const toolCallEvents = result.events.filter(e =>
        e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.tool_calls
      );

      assert.ok(toolCallEvents.length > 0, 'must have tool_call events in stream for Void animations');

      // Arguments stream across multiple deltas (OpenAI SDK style). Every delta must
      // target index 0 (Void checks: if (index !== 0) continue), the opening delta
      // carries id/type/name, and the concatenated arguments must be valid JSON.
      const deltas = toolCallEvents.flatMap(e => e.choices[0].delta.tool_calls);
      deltas.forEach((tc, i) => {
        assert.equal(tc.index, 0, `delta[${i}] must have index 0 for Void`);
      });
      const head = deltas.find(tc => tc.function?.name);
      assert.ok(head, 'an opening delta must carry the function name');
      assert.ok(head.id, 'opening tool_call delta must have id');
      assert.equal(head.type, 'function', 'opening tool_call delta must be type function');
      const argsString = deltas.map(tc => tc.function?.arguments ?? '').join('');
      const args = JSON.parse(argsString);
      assert.ok(args && typeof args === 'object', 'reconstructed arguments must be a JSON object');

      // Final event should have finish_reason
      const lastEvent = result.events[result.events.length - 1];
      assert.ok(lastEvent.choices[0].finish_reason, 'last event must have finish_reason');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// Test 3: Void IDE follow-up - tool results are correctly re-sent
test('real void ide: follow-up request includes previous tool results', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-followup-'));
  fs.writeFileSync(path.join(workspace, 'app.js'), 'console.log("test");\n', 'utf8');

  const prompts = [];
  let callCount = 0;
  const { createGatewayApp, restore } = loadGatewayWithMocks(async (prompt, opts) => {
    prompts.push({ prompt: String(prompt || ''), opts });
    callCount++;
    if (callCount === 1) {
      return { text: `<read_file><uri>${path.join(workspace, 'app.js')}</uri></read_file>`, meta: { session: { id: 's3', url: 'https://meta.ai/prompt/s3' } } };
    }
    return { text: '<task_complete><message>File read successfully</message></task_complete>', meta: { session: { id: 's3', url: 'https://meta.ai/prompt/s3' } } };
  });

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      // First request
      const first = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `read ${path.join(workspace, 'app.js')}` }
      ], { metadata: { new_chat: true } });

      assert.equal(first.status, 200);
      assert.ok(first.payload.choices[0].message.tool_calls, 'first response must have tool_calls');

      // Second request - Void re-sends the full conversation history including tool results
      const second = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `read ${path.join(workspace, 'app.js')}` },
        { role: 'assistant', content: '', tool_calls: first.payload.choices[0].message.tool_calls },
        { role: 'tool', content: 'console.log("test");\n', tool_call_id: first.payload.choices[0].message.tool_calls[0].id }
      ], { metadata: {} });

      assert.equal(second.status, 200);
      assert.match(second.payload.choices[0].message.content, /File read/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// Test 4: Real-world scenario - Meta AI gives broken edit_file format
test('real void ide: handles broken edit_file format from Meta AI', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-broken-'));
  fs.writeFileSync(path.join(workspace, 'test.txt'), 'old content\n', 'utf8');

  // Meta AI often sends broken format: <<<<<<< SEARCH ... >>>>>>> REPLACE (no =======)
  const { createGatewayApp, restore } = loadGatewayWithMocks(async () => {
    return {
      text: `<edit_file><uri>${path.join(workspace, 'test.txt')}</uri><content><![CDATA[<<<<<<< SEARCH
old content
>>>>>>> REPLACE
new content]]></content></edit_file>`,
      meta: { session: { id: 's4', url: 'https://meta.ai/prompt/s4' } }
    };
  });

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `update ${path.join(workspace, 'test.txt')}` }
      ], { metadata: { new_chat: true } });

      assert.equal(result.status, 200);
      
      // File should be written despite broken format
      const content = fs.readFileSync(path.join(workspace, 'test.txt'), 'utf8');
      assert.doesNotMatch(content, /<!\[CDATA\[/i, 'file must not contain CDATA');
      assert.doesNotMatch(content, /<{6,7}/i, 'file must not contain markers');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// Test 5: Timeout - gateway returns partial results
test('real void ide: gateway handles timeout gracefully', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-timeout-'));

  let callCount = 0;
  const { createGatewayApp, restore } = loadGatewayWithMocks(async () => {
    callCount++;
    if (callCount === 1) {
      return { text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`, meta: { session: { id: 's5', url: 'https://meta.ai/prompt/s5' } } };
    }
    // On second call, return tool call that will be executed
    return { text: `<create_file_or_folder><uri>${path.join(workspace, 'test.txt')}</uri></create_file_or_folder>`, meta: { session: { id: 's5', url: 'https://meta.ai/prompt/s5' } } };
  });

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `create file in ${workspace}` }
      ], { metadata: { new_chat: true } });

      // Should complete successfully
      assert.equal(result.status, 200);
      assert.ok(result.payload.choices[0].message.tool_calls, 'response must have tool_calls');
      assert.ok(result.payload.choices[0].message.tool_calls.length >= 2, 'must have at least 2 tool calls');
      assert.equal(result.payload.choices[0].finish_reason, 'tool_calls');
      
      // File must have been created
      assert.ok(fs.existsSync(path.join(workspace, 'test.txt')), 'test.txt must exist');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('real void ide: continues after useless bare path reply following get_dir_tree', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-bare-path-'));
  const replies = [
    { text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`, meta: { session: { id: 's6', url: 'https://meta.ai/prompt/s6' } } },
    { text: workspace, meta: { session: { id: 's6', url: 'https://meta.ai/prompt/s6' } } },
    { text: `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`, meta: { session: { id: 's6', url: 'https://meta.ai/prompt/s6' } } },
    { text: `<task_complete><message>Criei o index.html</message></task_complete>`, meta: { session: { id: 's6', url: 'https://meta.ai/prompt/s6' } } }
  ];

  const { createGatewayApp, restore } = loadGatewayWithMocks(async () => replies.shift());

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `cria um site em ${workspace}` }
      ], { metadata: { new_chat: true } });

      assert.equal(result.status, 200);
      assert.match(result.payload.choices[0].message.content, /index\.html/i);
      assert.ok(result.payload.choices[0].message.tool_calls.some((tc) => tc.function?.name === 'create_file_or_folder'));
      assert.ok(fs.existsSync(path.join(workspace, 'index.html')));
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('real void ide: executes multiple tool blocks returned in one meta response', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-batched-tools-'));
  const { createGatewayApp, restore } = loadGatewayWithMocks(async () => ({
    text: [
      `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`,
      `<edit_file><uri>${path.join(workspace, 'index.html')}</uri><content><![CDATA[<!DOCTYPE html><html><body>Batch OK</body></html>]]></content></edit_file>`,
      `<task_complete><message>Batch completo</message></task_complete>`
    ].join('\n'),
    meta: { session: { id: 's7', url: 'https://meta.ai/prompt/s7' } }
  }));

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const result = await postAsVoidIde(baseUrl, [
        { role: 'user', content: `cria um index em ${workspace}` }
      ], { metadata: { new_chat: true } });

      assert.equal(result.status, 200);
      assert.match(result.payload.choices[0].message.content, /Batch completo/i);
      assert.ok(result.payload.choices[0].message.tool_calls.some((tc) => tc.function?.name === 'create_file_or_folder'));
      assert.ok(result.payload.choices[0].message.tool_calls.some((tc) => tc.function?.name === 'edit_file'));
      assert.match(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), /Batch OK/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('real void ide: wrapped system prompt plus "continua" follow-up still advances in local agent mode', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'void-real-wrapped-followup-'));
  const wrappedPrompt = [
    '<SYSTEM_MESSAGE>',
    'You are an expert coding agent whose job is to help the user develop, run, and make changes to their codebase.',
    'Use tools when needed and keep working until the task is complete.',
    '</SYSTEM_MESSAGE>',
    '',
    `<WORKSPACE>${workspace}</WORKSPACE>`,
    '',
    '<USER_REQUEST>',
    `cria um site profissional nesta pasta: ${workspace}`,
    '</USER_REQUEST>'
  ].join('\n');

  const replies = [
    { text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`, meta: { session: { id: 'wrapped1', url: 'https://meta.ai/prompt/wrapped1' } } },
    { text: `<task_complete><message>Analisei a pasta e estou pronto para continuar.</message></task_complete>`, meta: { session: { id: 'wrapped1', url: 'https://meta.ai/prompt/wrapped1' } } },
    { text: `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`, meta: { session: { id: 'wrapped1', url: 'https://meta.ai/prompt/wrapped1' } } },
    { text: `<task_complete><message>Continuei e criei o index.html.</message></task_complete>`, meta: { session: { id: 'wrapped1', url: 'https://meta.ai/prompt/wrapped1' } } }
  ];

  const prompts = [];
  const { createGatewayApp, restore } = loadGatewayWithMocks(async (prompt) => {
    prompts.push(String(prompt || ''));
    return replies.shift() || replies[replies.length - 1];
  });

  try {
    await withServer(createGatewayApp(), async (baseUrl) => {
      const first = await postAsVoidIde(baseUrl, [
        { role: 'user', content: wrappedPrompt }
      ], { metadata: { new_chat: true } });

      assert.equal(first.status, 200);
      assert.equal(first.payload.choices[0].finish_reason, 'tool_calls');
      assert.ok(first.payload.choices[0].message.tool_calls.some((tc) => tc.function?.name === 'get_dir_tree'));
      assert.ok(!fs.existsSync(path.join(workspace, 'index.html')), 'first request should only inspect, not create file yet');

      const second = await postAsVoidIde(baseUrl, [
        { role: 'user', content: wrappedPrompt },
        { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
        { role: 'user', content: 'continua' }
      ], { metadata: {} });

      assert.equal(second.status, 200);
      assert.equal(second.payload.choices[0].finish_reason, 'tool_calls');
      assert.ok(second.payload.choices[0].message.tool_calls.some((tc) => tc.function?.name === 'create_file_or_folder'));
      assert.ok(fs.existsSync(path.join(workspace, 'index.html')), 'index.html must be created even when client only says continua');
      assert.match(second.payload.musespark.executed_tools.map((tool) => tool.function?.name || tool.name).join(','), /get_dir_tree|create_file_or_folder/i);
    });

    assert.equal(prompts.length, 4, 'agent loop should keep progressing across the wrapped follow-up flow');
    assert.match(prompts[0], /<latest_user_query>/i);
    assert.match(prompts[1], /latest_tool_result/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});
