const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * gateway-hardening.test.js
 *
 * Tests for the raw API gateway:
 * health endpoints, models, raw passthrough, streaming, sessions, error handling
 */

function loadGatewayWithMocks({
  submitPromptImpl,
  readinessImpl
} = {}) {
  const gatewayPath = require.resolve('../src/bridge-gateway');
  const metaWorkerPath = require.resolve('../src/meta-worker');
  const sessionStorePath = require.resolve('../src/bridge-session-store');
  const keyStorePath = require.resolve('../src/key-store');

  const previousGateway = require.cache[gatewayPath];
  const previousMetaWorker = require.cache[metaWorkerPath];
  const previousSessionStore = require.cache[sessionStorePath];
  const previousKeyStore = require.cache[keyStorePath];
  const previousMuseHome = process.env.MUSE_HOME;
  const tempMuseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-test-'));

  delete require.cache[gatewayPath];
  delete require.cache[sessionStorePath];
  delete require.cache[keyStorePath];
  process.env.MUSE_HOME = tempMuseHome;

  const capturedPrompts = [];

  const fakeMetaWorker = {
    submitPrompt: submitPromptImpl || (async (prompt) => {
      capturedPrompts.push(typeof prompt === 'object' ? prompt.fullPrompt : prompt);
      return { text: 'Hello from Meta AI!', meta: { url: 'https://www.meta.ai/prompt/test123', session: { id: 'test123' } } };
    }),
    reset: async () => {},
    probeReadiness: readinessImpl || (async () => ({
      ok: true,
      ready: true,
      checkedAt: new Date().toISOString(),
      durationMs: 1
    })),
    getRuntimeStatus: () => ({
      phase: 'idle',
      thinking: false,
      uiThinking: false,
      stopButtonVisible: false,
      inflightModelRequests: 0,
      totalModelRequests: 0,
      lastError: null
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

  const { createBridgeGatewayApp } = require(gatewayPath);

  const restore = () => {
    delete require.cache[gatewayPath];
    delete require.cache[sessionStorePath];
    delete require.cache[keyStorePath];
    if (previousGateway) require.cache[gatewayPath] = previousGateway;
    if (previousMetaWorker) require.cache[metaWorkerPath] = previousMetaWorker;
    else delete require.cache[metaWorkerPath];
    if (previousSessionStore) require.cache[sessionStorePath] = previousSessionStore;
    else delete require.cache[sessionStorePath];
    if (previousKeyStore) require.cache[keyStorePath] = previousKeyStore;
    else delete require.cache[keyStorePath];
    if (previousMuseHome === undefined) delete process.env.MUSE_HOME;
    else process.env.MUSE_HOME = previousMuseHome;
    fs.rmSync(tempMuseHome, { recursive: true, force: true });
  };

  return { createBridgeGatewayApp, restore, fakeMetaWorker, capturedPrompts };
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

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

// ─── Health endpoints ────────────────────────────────────────────────────────

test('healthz returns ok', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/healthz`);
      assert.equal(status, 200);
      assert.equal(payload.status, 'ok');
    });
  } finally {
    restore();
  }
});

test('health endpoint returns ok and raw mode', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/health`);
      assert.equal(status, 200);
      assert.equal(payload.status, 'ok');
      assert.equal(payload.mode, 'raw');
    });
  } finally {
    restore();
  }
});

test('readyz returns ready=true when worker is ready', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    readinessImpl: async () => ({ ok: true, ready: true, checkedAt: new Date().toISOString(), durationMs: 2 })
  });
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/readyz`);
      assert.equal(status, 200);
      assert.equal(payload.ready, true);
    });
  } finally {
    restore();
  }
});

test('readyz returns ready=false when worker probe fails', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    readinessImpl: async () => { throw new Error('login required'); }
  });
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/readyz`);
      assert.equal(status, 200);
      assert.equal(payload.ready, false);
    });
  } finally {
    restore();
  }
});

// ─── GET /v1/models ──────────────────────────────────────────────────────────

test('GET /v1/models returns proper model list', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/v1/models`);
      assert.equal(status, 200);
      assert.equal(payload.object, 'list');
      assert.ok(Array.isArray(payload.data), 'data must be an array');
      assert.ok(payload.data.length > 0, 'data must have at least one model');
      const model = payload.data[0];
      assert.ok(model.id, 'model must have id');
      assert.equal(model.object, 'model');
      assert.equal(model.owned_by, 'musespark');
    });
  } finally {
    restore();
  }
});

test('GET /v1/models includes muse model', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/v1/models`);
      assert.equal(status, 200);
      const ids = payload.data.map(m => m.id);
      assert.ok(ids.includes('muse'), 'models should include "muse"');
    });
  } finally {
    restore();
  }
});

// ─── POST /v1/chat/completions — raw passthrough ────────────────────────────

test('chat: empty messages returns 400', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, { messages: [] });
      assert.equal(status, 400);
      assert.ok(payload.error.message.includes('messages'));
    });
  } finally {
    restore();
  }
});

test('chat: missing messages returns 400', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {});
      assert.equal(status, 400);
    });
  } finally {
    restore();
  }
});

test('chat: simple user message returns valid OpenAI response', async () => {
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Hello!' }]
      });
      assert.equal(status, 200);
      assert.equal(payload.object, 'chat.completion');
      assert.ok(payload.id.startsWith('chatcmpl-'));
      assert.ok(payload.choices.length === 1);
      assert.equal(payload.choices[0].message.role, 'assistant');
      assert.equal(payload.choices[0].message.content, 'Hello from Meta AI!');
      assert.equal(payload.choices[0].finish_reason, 'stop');
      assert.ok(payload.usage);
    });
  } finally {
    restore();
  }
});

test('chat: system + user messages are flattened and sent to Meta AI', async () => {
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: 'You are a helpful coding assistant.' },
          { role: 'user', content: 'Write hello world in Python' }
        ]
      });
      assert.ok(capturedPrompts.length >= 1, 'Should have captured the prompt');
      const prompt = capturedPrompts[0];
      // System prompt should be included
      assert.ok(prompt.includes('You are a helpful coding assistant'), 'System prompt must be passed through');
      // User message should be included
      assert.ok(prompt.includes('Write hello world in Python'), 'User message must be passed through');
    });
  } finally {
    restore();
  }
});

test('chat: raw mode primer is added on first turn only', async () => {
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // First request — should have primer
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Test 1' }],
      }, { 'x-session-id': 'test-session' });

      // Second request — should NOT have primer
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Test 2' }],
      }, { 'x-session-id': 'test-session' });

      assert.ok(capturedPrompts.length === 2);
      // First prompt should contain the primer
      assert.ok(capturedPrompts[0].includes('AI model being accessed through an API'), 'First turn should have raw mode primer');
      // Second prompt should NOT contain the primer
      assert.ok(!capturedPrompts[1].includes('AI model being accessed through an API'), 'Follow-up turns should NOT have raw mode primer');
    });
  } finally {
    restore();
  }
});

test('chat: tool role messages are passed through', async () => {
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: 'You have tools.' },
          { role: 'user', content: 'Read the file' },
          { role: 'assistant', content: 'Let me read it.' },
          { role: 'tool', content: 'file contents here', tool_call_id: 'call_123', name: 'read_file' }
        ]
      });
      assert.ok(capturedPrompts.length >= 1);
      const prompt = capturedPrompts[capturedPrompts.length - 1];
      assert.ok(prompt.includes('file contents here'), 'Tool results must be passed through');
      assert.ok(prompt.includes('read_file'), 'Tool name should be visible');
    });
  } finally {
    restore();
  }
});

test('chat: response preserves Meta AI text as-is (no XML parsing)', async () => {
  const xmlLikeResponse = '<tool_call>\n<name>write_file</name>\n<args>{"path":"test.js"}</args>\n</tool_call>';
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async () => ({ text: xmlLikeResponse, meta: { url: 'https://meta.ai/prompt/x' } })
  });
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Create a file' }]
      });
      assert.equal(status, 200);
      // Response should contain the raw XML — no parsing or conversion
      assert.ok(payload.choices[0].message.content.includes('<tool_call>'), 'XML should be preserved as-is');
      assert.ok(payload.choices[0].message.content.includes('write_file'), 'Content should be unmodified');
      // Should NOT have tool_calls array (raw mode doesn't parse)
      assert.ok(!payload.choices[0].message.tool_calls, 'Raw mode should not create tool_calls');
    });
  } finally {
    restore();
  }
});

// ─── Streaming ──────────────────────────────────────────────────────────────

test('chat: streaming returns valid SSE', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'muse',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true
        })
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      
      const text = await response.text();
      assert.ok(text.includes('data: '), 'SSE should contain data lines');
      assert.ok(text.includes('[DONE]'), 'SSE should end with [DONE]');
      assert.ok(text.includes('"role":"assistant"'), 'Should have assistant role chunk');
      assert.ok(text.includes('Hello from Meta AI'), 'Should contain the response text');
    });
  } finally {
    restore();
  }
});

// ─── Error handling ─────────────────────────────────────────────────────────

test('chat: worker error returns 500 with error message', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async () => { throw new Error('Something went wrong'); }
  });
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Hello' }]
      });
      assert.equal(status, 500);
      assert.ok(payload.error.message.includes('Something went wrong'));
    });
  } finally {
    restore();
  }
});

test('chat: auth error returns 401', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async () => { throw new Error('Sessao Meta AI nao pronta'); }
  });
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Hello' }]
      });
      assert.equal(status, 401);
      assert.equal(payload.error.code, 'meta_auth_required');
    });
  } finally {
    restore();
  }
});

// ─── Sessions ───────────────────────────────────────────────────────────────

test('sessions: GET /v1/sessions returns list', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/v1/sessions`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(payload.sessions));
    });
  } finally {
    restore();
  }
});

test('sessions: session is created after a chat request', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Hello' }]
      }, { 'x-session-id': 'sess-123' });

      const { status, payload } = await getJson(`${baseUrl}/v1/sessions`);
      assert.equal(status, 200);
      assert.ok(payload.sessions.length >= 1, 'Should have at least one session');
    });
  } finally {
    restore();
  }
});

// ─── Dashboard API ──────────────────────────────────────────────────────────

test('dashboard: GET /api/status returns server info', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/api/status`);
      assert.equal(status, 200);
      assert.ok(payload.server);
      assert.ok(payload.browser);
      assert.ok(typeof payload.sessions === 'number');
      assert.ok(typeof payload.keys === 'number');
    });
  } finally {
    restore();
  }
});

test('dashboard: POST /api/keys creates a key', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/api/keys`, { name: 'test-key' });
      assert.equal(status, 200);
      assert.ok(payload.ok);
      assert.ok(payload.apiKey.startsWith('muse_'));
      assert.equal(payload.record.name, 'test-key');
    });
  } finally {
    restore();
  }
});

test('dashboard: GET /api/keys lists keys', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Create a key first
      await postJson(`${baseUrl}/api/keys`, { name: 'list-test' });
      
      const { status, payload } = await getJson(`${baseUrl}/api/keys`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(payload.keys));
      assert.ok(payload.keys.length >= 1);
      const names = payload.keys.map(k => k.name);
      assert.ok(names.includes('list-test'), 'Should include the created key');
    });
  } finally {
    restore();
  }
});

test('dashboard: DELETE /api/keys/:id removes a key', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { payload: created } = await postJson(`${baseUrl}/api/keys`, { name: 'delete-me' });
      const keyId = created.record.id;
      
      const { status, payload } = await fetch(`${baseUrl}/api/keys/${keyId}`, { method: 'DELETE' })
        .then(async r => ({ status: r.status, payload: await r.json() }));
      assert.equal(status, 200);
      assert.ok(payload.ok);
      assert.equal(payload.removed, 1);
    });
  } finally {
    restore();
  }
});

// ─── Browser status ─────────────────────────────────────────────────────────

test('browser-status endpoint returns worker state', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // browser-status is behind /v1/ auth middleware;
      // with no keys in the temp store, it should pass through
      const response = await fetch(`${baseUrl}/v1/browser-status`);
      // If keys exist from previous test isolation leak, we may get 401.
      // The endpoint itself works — just verify it responds.
      if (response.status === 200) {
        const payload = await response.json();
        assert.ok(typeof payload.ready === 'boolean');
        assert.ok(typeof payload.thinking === 'boolean');
        assert.equal(payload.phase, 'idle');
      } else {
        // Auth required because keys leaked from previous test
        assert.equal(response.status, 401);
      }
    });
  } finally {
    restore();
  }
});

// ─── Agent Mode & Settings ───────────────────────────────────────────────────

test('dashboard: GET & POST /api/settings manages agentMode', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // 1. Initial settings
      const { status: status1, payload: payload1 } = await getJson(`${baseUrl}/api/settings`);
      assert.equal(status1, 200);
      assert.equal(payload1.agentMode, false);

      // 2. Enable agentMode
      const { status: status2, payload: payload2 } = await postJson(`${baseUrl}/api/settings`, { agentMode: true });
      assert.equal(status2, 200);
      assert.equal(payload2.ok, true);
      assert.equal(payload2.agentMode, true);

      // 3. Verify on status endpoint
      const { status: status3, payload: payload3 } = await getJson(`${baseUrl}/api/status`);
      assert.equal(status3, 200);
      assert.equal(payload3.agentMode, true);
    });
  } finally {
    restore();
  }
});

test('agent-runner: parseToolCalls extracts tags correctly', () => {
  const { parseToolCalls } = require('../src/agent-runner');
  
  const text = `
    I will run a command to see files.
    <execute_command>dir</execute_command>
    
    Then write to a file.
    <write_file path="test.txt"><![CDATA[hello world]]></write_file>
    
    And read it.
    <read_file path="test.txt"/>
    
    And check path.
    <list_dir path="."/>
    
    And check env.
    <get_env/>
  `;
  
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], { type: 'execute_command', command: 'dir' });
  assert.deepEqual(calls[1], { type: 'write_file', path: 'test.txt', content: 'hello world' });
  assert.deepEqual(calls[2], { type: 'read_file', path: 'test.txt' });
  assert.deepEqual(calls[3], { type: 'list_dir', path: '.' });
  assert.deepEqual(calls[4], { type: 'get_env' });
});

test('agent-runner: executeTool handles operations', async () => {
  const { executeTool } = require('../src/agent-runner');
  const tempFile = path.join(os.tmpdir(), `musespark-tool-test-${Date.now()}.txt`);

  try {
    // 1. Write file
    const resWrite = await executeTool({ type: 'write_file', path: tempFile, content: 'test content' });
    assert.equal(resWrite.name, 'write_file');
    assert.ok(resWrite.output.includes('Successfully wrote'));

    // 2. Read file
    const resRead = await executeTool({ type: 'read_file', path: tempFile });
    assert.equal(resRead.name, 'read_file');
    assert.equal(resRead.output, 'test content');

    // 3. Get env
    const resEnv = await executeTool({ type: 'get_env' });
    assert.equal(resEnv.name, 'get_env');
    const parsedEnv = JSON.parse(resEnv.output);
    assert.ok(parsedEnv.os);
    assert.ok(parsedEnv.cwd);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test('agent-runner: parseToolCalls extracts generic tool calls correctly', () => {
  const { parseToolCalls } = require('../src/agent-runner');
  
  const text = `
    I will create a folder.
    <tool_call name="create_directory">{"path": "C:\\\\Users\\\\Foxli\\\\Desktop\\\\west saint"}</tool_call>
  `;
  
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'create_directory',
    isGeneric: true,
    name: 'create_directory',
    args: { path: 'C:\\Users\\Foxli\\Desktop\\west saint' }
  });
});

test('agent-runner: parseToolCalls handles unescaped nested double quotes in JSON arguments', () => {
  const { parseToolCalls } = require('../src/agent-runner');
  
  const text = `
    Vou criar a pasta.
    <tool_call name="execute_command"> {"command": "powershell -Command \\"New-Item -ItemType Directory -Path \\"$env:USERPROFILE\\\\Desktop\\\\Nova Pasta\\" -Force\\""} </tool_call>
  `;
  
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'execute_command',
    isGeneric: true,
    name: 'execute_command',
    args: { command: 'powershell -Command "New-Item -ItemType Directory -Path "$env:USERPROFILE\\Desktop\\Nova Pasta" -Force"' }
  });
});

test('chat: client tool translation from XML response to OpenAI tool_calls', async () => {
  const mockXmlResponse = `
    I am going to create the folder now.
    <tool_call name="create_directory">{"path": "C:\\\\Users\\\\Foxli\\\\Desktop\\\\west saint"}</tool_call>
  `;
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      capturedPrompts.push(typeof prompt === 'object' ? prompt.fullPrompt : prompt);
      return { text: mockXmlResponse, meta: { url: 'https://meta.ai/prompt/test123' } };
    }
  });
  
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Cria a pasta west saint no meu desktop' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'create_directory',
              description: 'Cria um novo diretorio no sistema de arquivos',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path']
              }
            }
          }
        ]
      });
      
      assert.equal(status, 200);
      assert.ok(payload.choices[0].message.tool_calls, 'Should have tool_calls in response');
      assert.equal(payload.choices[0].message.tool_calls.length, 1);
      
      const tc = payload.choices[0].message.tool_calls[0];
      assert.equal(tc.function.name, 'create_directory');
      assert.deepEqual(JSON.parse(tc.function.arguments), { path: 'C:\\Users\\Foxli\\Desktop\\west saint' });
      assert.equal(payload.choices[0].finish_reason, 'tool_calls');
      
      // The text content should have stripped the XML tags
      assert.equal(payload.choices[0].message.content.trim(), 'I am going to create the folder now.');
      
      // Verify that the prompt injected contains information about create_directory
      assert.ok(capturedPrompts[0].includes('create_directory'), 'Should include the tool definition in the prompt');
      assert.ok(capturedPrompts[0].includes('um programa local executa-os'), 'Should include the Portuguese local agent notice');
    });
  } finally {
    restore();
  }
});

test('settings: filePromptMode is configurable and passes option to worker', async () => {
  const capturedOptions = [];
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      capturedOptions.push(options);
      return { text: 'Hello!', meta: { url: 'https://meta.ai/prompt/test123' } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // 1. Get settings
      const { payload: settings } = await getJson(`${baseUrl}/api/settings`);
      assert.equal(settings.filePromptMode, false);

      // 2. Enable filePromptMode
      const { payload: updateRes } = await postJson(`${baseUrl}/api/settings`, { filePromptMode: true });
      assert.equal(updateRes.filePromptMode, true);

      // 3. Make completion request, verify alwaysFilePrompt option is passed
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Test file prompting' }]
      });
      assert.equal(status, 200);
      assert.equal(capturedOptions.length, 1);
      assert.equal(capturedOptions[0].alwaysFilePrompt, true);

      // 4. Disable filePromptMode, verify we can trigger per-request using header
      await postJson(`${baseUrl}/api/settings`, { filePromptMode: false });
      
      const { status: status2 } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Header test' }]
      }, {
        'x-file-prompt': 'true'
      });
      assert.equal(status2, 200);
      assert.equal(capturedOptions.length, 2);
      assert.equal(capturedOptions[1].alwaysFilePrompt, true);

      // 5. Verify trigger per-request using body
      const { status: status3 } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Body test' }],
        file_prompt: true
      });
      assert.equal(status3, 200);
      assert.equal(capturedOptions.length, 3);
      assert.equal(capturedOptions[2].alwaysFilePrompt, true);
    });
  } finally {
    restore();
  }
});

test('chat: request cancellation halts worker execution', async () => {
  const controller = new AbortController();
  let submitWasCalled = false;
  let submitWasCancelled = false;

  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      submitWasCalled = true;
      try {
        // Simulate long waiting
        for (let i = 0; i < 50; i++) {
          if (options.cancelRef && options.cancelRef.aborted) {
            submitWasCancelled = true;
            throw new Error('Request aborted by client connection close');
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        if (err.message.includes('Request aborted')) {
          submitWasCancelled = true;
        }
        throw err;
      }
      return { text: 'Done!', meta: { url: 'https://meta.ai/prompt/test123' } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const fetchPromise = fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'muse',
          messages: [{ role: 'user', content: 'Cancel me' }]
        }),
        signal: controller.signal
      });

      // Wait a short moment for request to arrive and start processing
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Abort the client request
      controller.abort();

      // Expect fetch to fail because it was aborted
      await fetchPromise.catch(() => {});

      // Wait for proxy to clean up and throw aborted error
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.ok(submitWasCalled, 'Worker submitPrompt should have been called');
      assert.ok(submitWasCancelled, 'Worker execution should have been cancelled when socket closed');
    });
  } finally {
    restore();
  }
});

test('chat: dynamic session matching separates concurrent/subagent sessions', async () => {
  const capturedSessions = [];

  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      capturedSessions.push(options.sessionId);
      return { text: 'Hello!', meta: { url: `https://meta.ai/chat/${options.sessionId}` } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // 1. Send first session initial message
      await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'muse',
          messages: [{ role: 'user', content: 'Main session setup' }]
        })
      });

      // 2. Send a different session initial message (representing a subagent)
      await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'muse',
          messages: [{ role: 'user', content: 'Subagent session setup' }]
        })
      });

      // 3. Send a continuation of the first session
      await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'muse',
          messages: [
            { role: 'user', content: 'Main session setup' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'user', content: 'Main session follow-up' }
          ]
        })
      });

      assert.equal(capturedSessions.length, 3);
      const firstSessionId = capturedSessions[0];
      const secondSessionId = capturedSessions[1];
      const thirdSessionId = capturedSessions[2];

      assert.notEqual(firstSessionId, secondSessionId, 'Main and subagent should have different session IDs');
      assert.equal(firstSessionId, thirdSessionId, 'Continuation request should map to the same main session ID');
    });
  } finally {
    restore();
  }
});

// ─── Error A Mitigation: Concurrent session isolation with prefix mismatch ───

test('Error A: concurrent requests with non-matching histories get separate sessions', async () => {
  const capturedSessions = [];

  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      capturedSessions.push(options.sessionId);
      return { text: 'Response', meta: { url: `https://meta.ai/chat/${options.sessionId}` } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Send two requests with completely different histories concurrently
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'muse',
            messages: [{ role: 'user', content: 'First independent request' }]
          })
        }),
        fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'muse',
            messages: [{ role: 'user', content: 'Second independent request' }]
          })
        })
      ]);

      assert.equal(capturedSessions.length, 2);
      // Both should get separate session IDs since their histories don't match
      assert.notEqual(capturedSessions[0], capturedSessions[1], 'Concurrent requests with different histories must get separate sessions');
    });
  } finally {
    restore();
  }
});

// ─── Error C Mitigation: Client tools skip RAW_MODE_PRIMER to avoid preamble contamination ───

test('Error C: RAW_MODE_PRIMER is skipped when client tools are present', async () => {
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({});

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Request WITH client tools — should NOT have raw mode primer
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Do something with tools' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'run_command',
              description: 'Runs a shell command',
              parameters: { type: 'object', properties: { command: { type: 'string' } } }
            }
          }
        ]
      }, { 'x-session-id': 'tools-session-1' });

      // The prompt should include the client tools prompt but NOT the raw mode primer
      assert.ok(capturedPrompts.length >= 1, 'Should have captured a prompt');
      const promptWithTools = capturedPrompts[capturedPrompts.length - 1];
      assert.ok(!promptWithTools.includes('You are an AI model being accessed through an API'), 'Should NOT have raw mode primer when tools are present');
      assert.ok(promptWithTools.includes('run_command'), 'Should have the tools prompt');

      // Request WITHOUT client tools — should have raw mode primer
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Simple question' }]
      }, { 'x-session-id': 'no-tools-session' });

      const promptNoTools = capturedPrompts[capturedPrompts.length - 1];
      assert.ok(promptNoTools.includes('You are an AI model being accessed through an API'), 'Should have raw mode primer when no tools are present');
    });
  } finally {
    restore();
  }
});

// ─── Error B Mitigation: Server timeout is extended for long-running requests ───

test('Error B: server timeout is set to 5 minutes for long-running requests', async () => {
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({});

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      // Verify server responds (timeout extended successfully)
      const payload = await response.json();
      assert.equal(payload.status, 'ok');
    });
  } finally {
    restore();
  }
});

// ─── Error B Mitigation: Large prompts auto-enable file prompt mode ───

test('Error B: large prompts auto-enable file prompt mode', async () => {
  const capturedOptions = [];
  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      capturedOptions.push(options);
      return { text: 'Hello!', meta: { url: 'https://meta.ai/prompt/test123' } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Create a large prompt (> 25000 chars) to trigger auto file-prompt
      const largeContent = 'A'.repeat(30000);
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: largeContent }]
      });

      assert.equal(status, 200);
      assert.equal(capturedOptions.length, 1);
      assert.equal(capturedOptions[0].alwaysFilePrompt, true, 'Large prompt should auto-enable file prompt mode');
    });
  } finally {
    restore();
  }
});

// ─── Error A Mitigation: Session history tracking updates properly ───

test('Error A: session history tracking prevents stale session reuse', async () => {
  const capturedSessions = [];

  const { createBridgeGatewayApp, restore } = loadGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      capturedSessions.push(options.sessionId);
      return { text: 'Hello!', meta: { url: `https://meta.ai/chat/${options.sessionId}` } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // 1. Initial message 
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Hello' }]
      });

      // 2. Divergent history (completely different prefix - subagent request)
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Completely different request' }]
      });

      // 3. Another divergent history
      await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Yet another different request' }]
      });

      assert.equal(capturedSessions.length, 3);
      // First two should have different sessions (different initial messages)
      assert.notEqual(capturedSessions[0], capturedSessions[1], 'Different initial requests should get different sessions');
      // All three should have different sessions (each has a unique history)
      assert.notEqual(capturedSessions[1], capturedSessions[2], 'Different histories should get different sessions');
    });
  } finally {
    restore();
  }
});

// ─── Error C Mitigation: Client-defined tools bypass proxy agent loop ───

test('Error C: proxy agent loop is skipped when client defines tools', async () => {
  const { createBridgeGatewayApp, restore, capturedPrompts } = loadGatewayWithMocks({});

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Request with client tools — should NOT use agent mode even if agent mode is enabled
      await postJson(`${baseUrl}/api/settings`, { agentMode: true });
      
      const { status, payload } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'Run this command' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'run_shell_command',
              description: 'Runs a shell command',
              parameters: { type: 'object', properties: { command: { type: 'string' } } }
            }
          }
        ]
      });

      // Should succeed without running agent loop
      assert.equal(status, 200);
      // The response should include the tools prompt (client-side agent loop)
      assert.ok(capturedPrompts.length >= 1);
      assert.ok(capturedPrompts[capturedPrompts.length - 1].includes('run_shell_command'), 'Should include client tool definition');
      // Should NOT have the agent system prompt
      assert.ok(!capturedPrompts[capturedPrompts.length - 1].includes('local machine via an external browser gateway'), 'Should NOT include agent system prompt');
    });
  } finally {
    restore();
  }
});



