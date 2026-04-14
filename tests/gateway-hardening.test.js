const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * gateway-hardening.test.js
 *
 * Tests for the unified bridge-gateway.js robustness:
 * health endpoints, error handling, workflow correctness,
 * /v1/models, client auto-detection, tool result handling.
 */

function loadBridgeGatewayWithMocks({
  submitPromptImpl,
  readinessImpl
} = {}) {
  const gatewayPath = require.resolve('../src/bridge-gateway');
  const metaWorkerPath = require.resolve('../src/meta-worker');
  const sessionStorePath = require.resolve('../src/bridge-session-store');

  const previousGateway = require.cache[gatewayPath];
  const previousMetaWorker = require.cache[metaWorkerPath];
  const previousSessionStore = require.cache[sessionStorePath];
  const previousMuseHome = process.env.MUSE_HOME;
  const tempMuseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-bridge-store-'));

  delete require.cache[gatewayPath];
  delete require.cache[sessionStorePath];
  process.env.MUSE_HOME = tempMuseHome;

  const fakeMetaWorker = {
    submitPrompt: submitPromptImpl || (async () => ({ text: 'ok', meta: { url: 'https://www.meta.ai/prompt/s1', session: { id: 's1' } } })),
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

  process.env.MUSE_LOG_META_PROMPTS = '0';

  const { createBridgeGatewayApp } = require(gatewayPath);

  const restore = () => {
    delete require.cache[gatewayPath];
    delete require.cache[sessionStorePath];
    if (previousGateway) require.cache[gatewayPath] = previousGateway;
    if (previousMetaWorker) require.cache[metaWorkerPath] = previousMetaWorker;
    else delete require.cache[metaWorkerPath];
    if (previousSessionStore) require.cache[sessionStorePath] = previousSessionStore;
    else delete require.cache[sessionStorePath];
    if (previousMuseHome === undefined) delete process.env.MUSE_HOME;
    else process.env.MUSE_HOME = previousMuseHome;
    fs.rmSync(tempMuseHome, { recursive: true, force: true });
  };

  return { createBridgeGatewayApp, restore, fakeMetaWorker };
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

test('healthz returns ok without auth', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({});
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

test('health endpoint returns ok status', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/health`);
      assert.equal(status, 200);
      assert.equal(payload.status, 'ok');
      assert.equal(payload.mode, 'bridge');
    });
  } finally {
    restore();
  }
});

test('readyz returns ready=true when worker is ready', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
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
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
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
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({});
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

test('GET /v1/models returns "muse" as the model id', async () => {
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({});
  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await getJson(`${baseUrl}/v1/models`);
      assert.equal(status, 200);
      assert.ok(payload.data.some((m) => m.id === 'muse'), 'muse model must be listed');
    });
  } finally {
    restore();
  }
});

// ─── Client auto-detection ───────────────────────────────────────────────────

test('client auto-detection: OpenClaude-style messages are detected as openclaude', async () => {
  const detectedTypes = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      // Check if prompt contains OpenClaude bridge prompt markers
      if (/You are an AI coding assistant running inside an API gateway/i.test(prompt)) {
        detectedTypes.push('openclaude');
      } else {
        detectedTypes.push('other');
      }
      return { text: 'ok', meta: { url: 'https://meta.ai/p/s1', session: { id: 's1' } } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: 'Primary working directory: /home/user/project\nYou are claude, a helpful AI.' },
          { role: 'user', content: 'list files' }
        ]
      });
      assert.equal(status, 200);
    });
    assert.ok(detectedTypes.includes('openclaude'), 'OpenClaude prompt must be used for openclaude client');
  } finally {
    restore();
  }
});

test('client auto-detection: Void-style messages (no "Primary working directory") are detected as void', async () => {
  const detectedTypes = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      if (/You are an AI coding agent running inside an IDE gateway/i.test(prompt)) {
        detectedTypes.push('void');
      } else {
        detectedTypes.push('other');
      }
      return { text: 'ok', meta: { url: 'https://meta.ai/p/s2', session: { id: 's2' } } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          // No "Primary working directory:" marker — Void-style
          { role: 'system', content: 'You are a helpful assistant in the Void IDE.' },
          { role: 'user', content: 'list files' }
        ]
      });
      assert.equal(status, 200);
    });
    assert.ok(detectedTypes.includes('void'), 'Void prompt must be used for void client');
  } finally {
    restore();
  }
});

test('client auto-detection: messages with no system prompt default to void client', async () => {
  const detectedTypes = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      if (/You are an AI coding agent running inside an IDE gateway/i.test(prompt)) {
        detectedTypes.push('void');
      } else {
        detectedTypes.push('other');
      }
      return { text: 'ok', meta: { url: 'https://meta.ai/p/s3', session: { id: 's3' } } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: 'hello' }]
      });
      assert.equal(status, 200);
    });
    assert.ok(detectedTypes.includes('void'), 'Default (no system) must use void client prompt');
  } finally {
    restore();
  }
});

// ─── Tool result handling ────────────────────────────────────────────────────

test('tool result turn: messages with role "tool" are recognized as tool result turn', async () => {
  const prompts = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      prompts.push(String(prompt || ''));
      return { text: 'ok', meta: { url: 'https://meta.ai/p/s4', session: { id: 's4' } } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_test1',
              type: 'function',
              function: { name: 'get_dir_tree', arguments: '{"uri":"/tmp"}' }
            }]
          },
          { role: 'tool', tool_call_id: 'call_test1', content: '/tmp/\n  file.txt' }
        ]
      });
      assert.equal(status, 200);
    });
    assert.equal(prompts.length, 1, 'must have sent one prompt to Meta AI');
    // The prompt must contain the tool result, not the full first-turn prompt
    assert.match(prompts[0], /TOOL_RESULT/i, 'prompt must contain TOOL_RESULT marker');
    assert.match(prompts[0], /get_dir_tree/i, 'prompt must contain tool name');
    assert.match(prompts[0], /file\.txt/i, 'prompt must contain tool output');
  } finally {
    restore();
  }
});

test('tool result turn: multiple tool results are all forwarded to Meta AI', async () => {
  const prompts = [];
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      prompts.push(String(prompt || ''));
      return { text: 'done', meta: { url: 'https://meta.ai/p/s5', session: { id: 's5' } } };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'user', content: 'read files' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"uri":"/a.txt"}' } },
              { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"uri":"/b.txt"}' } }
            ]
          },
          { role: 'tool', tool_call_id: 'call_a', content: 'contents of a' },
          { role: 'tool', tool_call_id: 'call_b', content: 'contents of b' }
        ]
      });
      assert.equal(status, 200);
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /contents of a/i, 'first tool result must be in prompt');
    assert.match(prompts[0], /contents of b/i, 'second tool result must be in prompt');
  } finally {
    restore();
  }
});

// ─── Workflow tests ───────────────────────────────────────────────────────────

test('workflow: tool call → execute → send result → final answer', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-ide-flow-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.html'), '<html><body>old</body></html>\n', 'utf8');

  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt) => {
      callCount++;
      if (callCount === 1) {
        return {
          text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
          meta: { url: 'https://www.meta.ai/prompt/meta-flow', session: { id: 'meta-flow' } }
        };
      }
      return {
        text: 'Atualizei o ficheiro principal do projeto.',
        meta: { url: 'https://www.meta.ai/prompt/meta-flow', session: { id: 'meta-flow' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Turn 1: gateway returns tool call
      const first = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `cria uma homepage nova nesta pasta: ${workspace}` }
        ]
      });

      assert.equal(first.status, 200);
      assert.equal(first.payload.choices[0].finish_reason, 'tool_calls');
      assert.ok(Array.isArray(first.payload.choices[0].message.tool_calls));
      const toolCall = first.payload.choices[0].message.tool_calls[0];
      assert.equal(toolCall.function.name, 'get_dir_tree');

      // Turn 2: client sends tool result back
      const second = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `cria uma homepage nova nesta pasta: ${workspace}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: `src/\n  index.html` }
        ]
      });

      assert.equal(second.status, 200);
      assert.match(second.payload.choices[0].message.content, /Atualizei o ficheiro principal/i);
    });

    assert.equal(callCount, 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('workflow: session sticky — second request reuses prior Meta AI chat session', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-ide-followup-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.html'), '<html><body>sticky</body></html>\n', 'utf8');

  const prompts = [];
  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      prompts.push({ prompt: String(prompt || ''), options });
      callCount++;
      if (callCount === 1) {
        return {
          text: `<read_file><uri>${path.join(workspace, 'src', 'index.html')}</uri></read_file>`,
          meta: { url: 'https://www.meta.ai/prompt/meta-sticky', session: { id: 'meta-sticky' } }
        };
      }
      return {
        text: 'O ficheiro index.html contém o texto sticky.',
        meta: { url: 'https://www.meta.ai/prompt/meta-sticky', session: { id: 'meta-sticky' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const first = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [{ role: 'user', content: `l\u00ea o index nesta pasta: ${workspace}` }]
      }, { 'x-claude-code-session-id': 'sticky-sess' });
      assert.equal(first.status, 200);

      const toolCall = first.payload.choices[0].message.tool_calls[0];

      // Simulate IDE sending tool result
      const second = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'user', content: `l\u00ea o index nesta pasta: ${workspace}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: '<html><body>sticky</body></html>' }
        ]
      }, { 'x-claude-code-session-id': 'sticky-sess' });
      assert.equal(second.status, 200);
      assert.match(second.payload.choices[0].message.content, /sticky/i);
    });

    assert.equal(callCount, 2);
    // Second prompt should have been sent to the existing session URL
    assert.equal(prompts[1].options.sessionUrl, 'https://www.meta.ai/prompt/meta-sticky');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('workflow: codebase discovery chains multiple tool calls correctly', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-codebase-stress-'));
  fs.mkdirSync(path.join(workspace, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src', 'styles'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'stress-app' }, null, 2), 'utf8');

  const cssFile = path.join(workspace, 'src', 'styles', 'app.css');
  fs.writeFileSync(cssFile, '.header { background: white; }\n', 'utf8');

  const replies = [
    { text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`, meta: { url: 'https://meta.ai/p/stress', session: { id: 'stress' } } },
    { text: `<read_file><uri>${cssFile}</uri></read_file>`, meta: { url: 'https://meta.ai/p/stress', session: { id: 'stress' } } },
    { text: 'Analisei a codebase e localizei o CSS do header.', meta: { url: 'https://meta.ai/p/stress', session: { id: 'stress' } } }
  ];

  let callIdx = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async () => replies[callIdx++] || replies[replies.length - 1]
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Turn 1
      const t1 = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `Analisa esta codebase em ${workspace}.` }
        ]
      }, { 'x-claude-code-session-id': 'stress-thread' });
      assert.equal(t1.status, 200);
      assert.equal(t1.payload.choices[0].finish_reason, 'tool_calls');
      const tc1 = t1.payload.choices[0].message.tool_calls[0];
      assert.equal(tc1.function.name, 'get_dir_tree');

      // Turn 2: send tree result, get read_file call
      const t2 = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `Analisa esta codebase em ${workspace}.` },
          { role: 'assistant', content: null, tool_calls: t1.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: tc1.id, content: 'src/\n  styles/\n    app.css' }
        ]
      }, { 'x-claude-code-session-id': 'stress-thread' });
      assert.equal(t2.status, 200);
      assert.equal(t2.payload.choices[0].finish_reason, 'tool_calls');
      const tc2 = t2.payload.choices[0].message.tool_calls[0];
      assert.equal(tc2.function.name, 'read_file');

      // Turn 3: send file result, get final answer
      const t3 = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `Analisa esta codebase em ${workspace}.` },
          { role: 'assistant', content: null, tool_calls: t1.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: tc1.id, content: 'src/\n  styles/\n    app.css' },
          { role: 'assistant', content: null, tool_calls: t2.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: tc2.id, content: '.header { background: white; }' }
        ]
      }, { 'x-claude-code-session-id': 'stress-thread' });
      assert.equal(t3.status, 200);
      assert.equal(t3.payload.choices[0].finish_reason, 'stop');
      assert.match(t3.payload.choices[0].message.content, /Analisei a codebase/i);
    });

    assert.equal(callIdx, 3, 'must have called Meta AI 3 times');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('sessions endpoint exposes bridge history with tool calls and tool results for a real IDE-like flow', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-bridge-history-'));
  const filePath = path.join(workspace, 'src', 'index.html');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '<html><body>bridge history</body></html>\n', 'utf8');

  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: `<read_file><uri>${filePath}</uri></read_file>`,
          meta: { url: 'https://meta.ai/prompt/history-flow', session: { id: 'history-flow' } }
        };
      }
      return {
        text: '<task_complete><message>Li o ficheiro com sucesso.</message></task_complete>',
        meta: { url: 'https://meta.ai/prompt/history-flow', session: { id: 'history-flow' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const sessionId = 'history-sess';
      const first = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `lê o ficheiro ${filePath}` }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(first.status, 200);
      const toolCall = first.payload.choices[0].message.tool_calls[0];
      assert.equal(toolCall.function.name, 'read_file');

      const second = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `lê o ficheiro ${filePath}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: '<html><body>bridge history</body></html>' }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(second.status, 200);
      assert.equal(second.payload.choices[0].finish_reason, 'tool_calls');
      assert.equal(second.payload.choices[0].message.tool_calls[0].function.name, 'task_complete');

      const sessions = await getJson(`${baseUrl}/v1/sessions`);
      assert.equal(sessions.status, 200);
      const listed = sessions.payload.sessions.find((s) => s.sessionId === sessionId);
      assert.ok(listed, 'session must be visible in session list');
      assert.equal(listed.clientType, 'void');
      assert.equal(listed.historyCount, 2);
      assert.ok(listed.lastAction, 'session summary must include lastAction');
      assert.equal(listed.lastAction.promptKind, 'tool-result');
      assert.equal(listed.lastAction.usedTools, true);

      const details = await getJson(`${baseUrl}/v1/sessions/${sessionId}`);
      assert.equal(details.status, 200);
      assert.equal(details.payload.session.history.length, 2);
      assert.equal(details.payload.session.history[0].promptKind, 'first');
      assert.deepEqual(details.payload.session.history[0].toolCalls.map((tool) => tool.name), ['read_file']);
      assert.equal(details.payload.session.history[0].usedTools, true);
      assert.equal(details.payload.session.history[1].promptKind, 'tool-result');
      assert.deepEqual(details.payload.session.history[1].toolResults.map((tool) => tool.toolName), ['read_file']);
      assert.equal(details.payload.session.history[1].toolResults[0].status, 'SUCCESS');
      assert.deepEqual(details.payload.session.history[1].toolCalls.map((tool) => tool.name), ['task_complete']);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('sessions endpoint exposes openclaude history and tool usage across follow-up turns', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-openclaude-history-'));
  const filePath = path.join(workspace, 'README.md');
  fs.writeFileSync(filePath, '# test\n', 'utf8');

  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (_prompt, options) => {
      callCount++;
      if (callCount === 1) {
        assert.equal(options.forceNewChat, false);
        return {
          text: `<read_file><uri>${filePath}</uri></read_file>`,
          meta: { url: 'https://meta.ai/prompt/openclaude-history', session: { id: 'openclaude-history' } }
        };
      }
      assert.equal(options.forceNewChat, false);
      return {
        text: '<task_complete><message>Leitura concluída no follow-up.</message></task_complete>',
        meta: { url: 'https://meta.ai/prompt/openclaude-history', session: { id: 'openclaude-history' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const sessionId = 'openclaude-sess';
      const first = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Primary working directory: ${workspace}\nYou are claude, a helpful AI.` },
          { role: 'user', content: `abre ${filePath}` }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(first.status, 200);
      const toolCall = first.payload.choices[0].message.tool_calls[0];
      assert.equal(toolCall.function.name, 'read_file');

      const compacted = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Primary working directory: ${workspace}\nYou are claude, a helpful AI.` },
          { role: 'user', content: `abre ${filePath}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: '# test\n' }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(compacted.status, 200);
      assert.equal(compacted.payload.choices[0].finish_reason, 'tool_calls');
      assert.equal(compacted.payload.choices[0].message.tool_calls[0].function.name, 'task_complete');

      const details = await getJson(`${baseUrl}/v1/sessions/${sessionId}`);
      assert.equal(details.status, 200);
      assert.equal(details.payload.session.clientType, 'openclaude');
      assert.equal(details.payload.session.compactionCount, 0);
      assert.equal(details.payload.session.history.length, 2);
      assert.equal(details.payload.session.history[0].promptKind, 'first');
      assert.equal(details.payload.session.history[1].promptKind, 'tool-result');
      assert.equal(details.payload.session.history[1].isCompacted, false);
      assert.deepEqual(details.payload.session.history[1].toolResults.map((tool) => tool.toolName), ['read_file']);
      assert.equal(details.payload.session.lastAction.usedTools, true);
      assert.deepEqual(details.payload.session.history[1].toolCalls.map((tool) => tool.name), ['task_complete']);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('sessions endpoint records openclaude compaction turns when they arrive as a fresh context handoff', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-openclaude-compaction-'));

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async (prompt, options) => {
      assert.equal(options.forceNewChat, true);
      assert.match(String(prompt || ''), /Session Context \(Compacted\)/i);
      return {
        text: '<task_complete><message>Contexto compactado recebido.</message></task_complete>',
        meta: { url: 'https://meta.ai/prompt/openclaude-compaction', session: { id: 'openclaude-compaction' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const sessionId = 'openclaude-compaction-sess';
      const compacted = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Primary working directory: ${workspace}\nYou are claude, a helpful AI.` },
          { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.\n\n<summary>Já exploraste o projeto e fizeste várias leituras de ficheiros.</summary>' }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(compacted.status, 200);
      assert.equal(compacted.payload.choices[0].message.tool_calls[0].function.name, 'task_complete');

      const details = await getJson(`${baseUrl}/v1/sessions/${sessionId}`);
      assert.equal(details.status, 200);
      assert.equal(details.payload.session.clientType, 'openclaude');
      assert.equal(details.payload.session.compactionCount, 1);
      assert.equal(details.payload.session.history.length, 1);
      assert.equal(details.payload.session.history[0].promptKind, 'compaction');
      assert.equal(details.payload.session.history[0].isCompacted, true);
      assert.deepEqual(details.payload.session.history[0].toolCalls.map((tool) => tool.name), ['task_complete']);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('session timeline endpoint returns ordered history entries for IDE-like flow', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-bridge-timeline-'));
  const filePath = path.join(workspace, 'index.js');
  fs.writeFileSync(filePath, 'console.log("timeline");\n', 'utf8');

  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: `<read_file><uri>${filePath}</uri></read_file>`,
          meta: { url: 'https://meta.ai/prompt/timeline-flow', session: { id: 'timeline-flow' } }
        };
      }
      return {
        text: '<task_complete><message>Timeline pronto.</message></task_complete>',
        meta: { url: 'https://meta.ai/prompt/timeline-flow', session: { id: 'timeline-flow' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const sessionId = 'timeline-sess';
      const first = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `lê ${filePath}` }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      const toolCall = first.payload.choices[0].message.tool_calls[0];

      const second = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Void IDE session\nworkspace contains these folders: ${workspace}` },
          { role: 'user', content: `lê ${filePath}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: 'console.log("timeline");\n' }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(second.status, 200);

      const timeline = await getJson(`${baseUrl}/v1/sessions/${sessionId}/timeline`);
      assert.equal(timeline.status, 200);
      assert.equal(timeline.payload.sessionId, sessionId);
      assert.equal(timeline.payload.clientType, 'void');
      assert.equal(timeline.payload.timeline.length, 2);
      assert.equal(timeline.payload.timeline[0].promptKind, 'first');
      assert.equal(timeline.payload.timeline[0].toolCalls[0].name, 'read_file');
      assert.equal(timeline.payload.timeline[1].promptKind, 'tool-result');
      assert.equal(timeline.payload.timeline[1].toolResults[0].toolName, 'read_file');
      assert.equal(timeline.payload.timeline[1].toolCalls[0].name, 'task_complete');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

test('session tools endpoint summarizes requested tools and returned results', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-bridge-tools-'));
  const filePath = path.join(workspace, 'app.js');
  fs.writeFileSync(filePath, 'console.log("tools");\n', 'utf8');

  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks({
    submitPromptImpl: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: `<read_file><uri>${filePath}</uri></read_file>`,
          meta: { url: 'https://meta.ai/prompt/tools-flow', session: { id: 'tools-flow' } }
        };
      }
      return {
        text: '<task_complete><message>Ferramentas resumidas.</message></task_complete>',
        meta: { url: 'https://meta.ai/prompt/tools-flow', session: { id: 'tools-flow' } }
      };
    }
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const sessionId = 'tools-sess';
      const first = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Primary working directory: ${workspace}\nYou are claude, a helpful AI.` },
          { role: 'user', content: `abre ${filePath}` }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      const toolCall = first.payload.choices[0].message.tool_calls[0];

      const second = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: 'muse',
        messages: [
          { role: 'system', content: `Primary working directory: ${workspace}\nYou are claude, a helpful AI.` },
          { role: 'user', content: `abre ${filePath}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: 'console.log("tools");\n' }
        ]
      }, { 'x-claude-code-session-id': sessionId });
      assert.equal(second.status, 200);

      const tools = await getJson(`${baseUrl}/v1/sessions/${sessionId}/tools`);
      assert.equal(tools.status, 200);
      assert.equal(tools.payload.sessionId, sessionId);
      assert.equal(tools.payload.clientType, 'openclaude');
      assert.ok(Array.isArray(tools.payload.tools));
      assert.deepEqual(tools.payload.tools.map((tool) => tool.name), ['read_file', 'task_complete']);
      const readFileSummary = tools.payload.tools.find((tool) => tool.name === 'read_file');
      assert.equal(readFileSummary.count, 2);
      assert.equal(readFileSummary.results.success, 1);
      const taskCompleteSummary = tools.payload.tools.find((tool) => tool.name === 'task_complete');
      assert.equal(taskCompleteSummary.count, 1);
      assert.equal(taskCompleteSummary.results.success, 0);
      assert.ok(Array.isArray(tools.payload.events));
      assert.ok(tools.payload.events.some((event) => event.direction === 'requested' && event.name === 'read_file'));
      assert.ok(tools.payload.events.some((event) => event.direction === 'result' && event.name === 'read_file' && event.status === 'SUCCESS'));
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});
