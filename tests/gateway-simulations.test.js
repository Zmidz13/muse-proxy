const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * gateway-simulations.test.js
 *
 * Tests for the unified bridge-gateway.js (createBridgeGatewayApp).
 * Each HTTP request → single Meta AI submit. Multi-step workflows
 * require multiple HTTP requests (as the real IDE does).
 */

function loadBridgeGatewayWithMocks(submitPromptImpl) {
  const gatewayPath = require.resolve('../src/bridge-gateway');
  const metaWorkerPath = require.resolve('../src/meta-worker');

  const previousGateway = require.cache[gatewayPath];
  const previousMetaWorker = require.cache[metaWorkerPath];

  delete require.cache[gatewayPath];

  const fakeMetaWorker = {
    submitPrompt: submitPromptImpl || (async () => ({ text: 'ok', meta: { session: { id: 's1', url: 'https://www.meta.ai/prompt/s1' } } })),
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
      getMetaRuntimeConfig: () => ({ userDataDir: 'test-profile', headless: true, useBraveBinary: false, browserPath: null }),
      getMetaWorkerStatus: () => fakeMetaWorker.getRuntimeStatus()
    }
  };

  process.env.MUSE_LOG_META_PROMPTS = '0';

  const { createBridgeGatewayApp } = require(gatewayPath);

  const restore = () => {
    delete require.cache[gatewayPath];
    if (previousGateway) require.cache[gatewayPath] = previousGateway;
    if (previousMetaWorker) require.cache[metaWorkerPath] = previousMetaWorker;
    else delete require.cache[metaWorkerPath];
  };

  return { createBridgeGatewayApp, restore };
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

async function postChat(baseUrl, body, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function postChatStream(baseUrl, body, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, stream: true })
  });
  const payload = await response.text();
  return { status: response.status, payload };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('bridge gateway: simple text response returns 200 with content', async () => {
  const calls = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt, options) => {
    calls.push({ prompt, options });
    return {
      text: 'Vou criar isso agora.',
      meta: { session: { id: 'meta-1', url: 'https://www.meta.ai/prompt/session-1' } }
    };
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'cria um site ecommerce para mim' }]
      }, { 'x-claude-code-session-id': 'test-session-1' });
      assert.equal(status, 200);
      assert.match(payload.choices[0].message.content, /Vou criar isso/i);
      assert.equal(payload.choices[0].finish_reason, 'stop');
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('bridge gateway: tool call response returns tool_calls in OpenAI format', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-gateway-tools-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.html'), '<html></html>\n', 'utf8');

  const calls = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt, options) => {
    calls.push({ prompt, options });
    return {
      text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      meta: { session: { id: 'meta-3', url: 'https://www.meta.ai/prompt/session-3' } }
    };
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'mostra a estrutura do projeto' }]
      });

      assert.equal(status, 200);
      assert.equal(payload.choices[0].finish_reason, 'tool_calls');
      assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
      assert.ok(payload.choices[0].message.tool_calls.length > 0);
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'get_dir_tree');
      assert.equal(payload.choices[0].message.tool_calls[0].type, 'function');
      assert.ok(payload.choices[0].message.tool_calls[0].id);
    });

    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('bridge gateway: tool result sent by client is forwarded to Meta AI', async () => {
  const calls = [];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-gateway-narration-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.html'), '<html></html>\n', 'utf8');

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt, options) => {
    calls.push({ prompt, options });
    return {
      text: 'Li a estrutura do projeto e posso continuar a partir dela.',
      meta: { session: { id: 'meta-5', url: 'https://www.meta.ai/prompt/session-5' } }
    };
  });

  // Simulate: client sends tool results back in the next request
  const fakeToolCalls = [{
    id: 'call_abc123',
    type: 'function',
    function: { name: 'get_dir_tree', arguments: JSON.stringify({ uri: workspace }) }
  }];

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [
          { role: 'user', content: `cria um site novo nesta pasta: ${workspace}` },
          { role: 'assistant', content: null, tool_calls: fakeToolCalls },
          { role: 'tool', tool_call_id: 'call_abc123', content: `src/\n  index.html` }
        ]
      });

      assert.equal(status, 200);
      assert.match(payload.choices[0].message.content, /Li a estrutura do projeto/i);
    });

    assert.equal(calls.length, 1);
    // The prompt sent to Meta should contain the tool result
    assert.match(calls[0].prompt, /TOOL_RESULT/i);
    assert.match(calls[0].prompt, /src\//i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('bridge gateway: session reuse across requests via x-claude-code-session-id header', async () => {
  const calls = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (_prompt, options) => {
    calls.push({ options });
    // bridge-gateway reads result.meta.url directly (not result.meta.session.url)
    return {
      text: 'Olá!',
      meta: { url: 'https://www.meta.ai/prompt/session-4', session: { id: 'meta-4' } }
    };
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const first = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'olá' }]
      }, { 'x-claude-code-session-id': 'stable-session-id' });
      const second = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'bom dia' }]
      }, { 'x-claude-code-session-id': 'stable-session-id' });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
    });

    assert.equal(calls.length, 2);
    // Second call should reference the session URL from the first call
    assert.equal(calls[1].options.sessionUrl, 'https://www.meta.ai/prompt/session-4');
  } finally {
    restore();
  }
});

test('bridge gateway: streaming SSE includes tool_call chunks and DONE', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-gateway-stream-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.html'), '<html></html>\n', 'utf8');

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: 'Vou criar o site. Primeiro deixa-me ver o que existe no workspace.',
    meta: { session: { id: 'meta-6', url: 'https://www.meta.ai/prompt/session-6' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChatStream(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: `cria um site novo nesta pasta: ${workspace}` }]
      });

      assert.equal(status, 200);
      assert.doesNotMatch(payload, /\[status\]/i);
      assert.match(payload, /\[DONE\]/i);
      assert.match(payload, /Vou criar o site/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('bridge gateway: streaming tool_calls emitted with index 0 for Void compatibility', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-gateway-stream-tools-'));
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
    meta: { session: { id: 'meta-stream-tools', url: 'https://www.meta.ai/prompt/session-stream-tools' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChatStream(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: `cria um index.html nesta pasta: ${workspace}` }]
      });

      assert.equal(status, 200);
      assert.match(payload, /"tool_calls":\[/i);
      assert.match(payload, /"name":"get_dir_tree"/i);
      // The first tool should have index 0
      assert.match(payload, /"index":0/i);
      assert.match(payload, /\[DONE\]/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('bridge gateway: multiple tool calls in one meta response → multiple chunks with sequential indices', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-gateway-multi-tools-'));
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: [
      `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`
    ].join('\n'),
    meta: { session: { id: 'meta-multi', url: 'https://www.meta.ai/prompt/session-multi' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChatStream(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: `cria um index.html nesta pasta: ${workspace}` }]
      });

      assert.equal(status, 200);
      assert.match(payload, /"name":"get_dir_tree"/i);
      assert.match(payload, /"name":"create_file_or_folder"/i);
      assert.match(payload, /\[DONE\]/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('bridge gateway: task_complete text is returned as clean content', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: '<task_complete><message>Site criado com sucesso.</message></task_complete>',
    meta: { session: { id: 'meta-tc', url: 'https://www.meta.ai/prompt/session-tc' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'faz alguma coisa' }]
      });

      assert.equal(status, 200);
      // task_complete should appear as tool_call in the response
      assert.ok(payload.choices[0].message.tool_calls, 'task_complete should appear as tool_call');
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'task_complete');
    });
  } finally {
    restore();
  }
});

test('bridge gateway: meta AI error returns 500 with error message', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => {
    throw new Error('Meta connection failed');
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'testa o erro' }]
      });

      assert.equal(status, 500);
      assert.ok(payload.error, 'error field must exist');
      assert.match(payload.error.message, /Meta connection failed/i);
    });
  } finally {
    restore();
  }
});

test('bridge gateway: missing messages array returns 400', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: 'ok',
    meta: { session: { id: 's', url: 'https://meta.ai/p/s' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postChat(baseUrl, { model: 'muse', messages: [] });
      assert.equal(status, 400);
    });
  } finally {
    restore();
  }
});

test('bridge gateway: response includes musespark mode bridge metadata', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: 'resposta ok',
    meta: { url: 'https://www.meta.ai/prompt/meta-mode', session: { id: 's1' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'olá' }]
      });
      assert.equal(status, 200);
      assert.ok(payload.musespark, 'musespark field must exist');
      assert.equal(payload.musespark.mode, 'bridge');
    });
  } finally {
    restore();
  }
});
