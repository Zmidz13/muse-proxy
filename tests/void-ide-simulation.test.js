const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeToolCall } = require('../src/action-runner');

/**
 * void-ide-simulation.test.js
 *
 * Simulates EXACTLY what the Void IDE does with the unified bridge-gateway:
 * 1. Sends messages in OpenAI format
 * 2. Receives tool_calls in correct format
 * 3. Re-sends history with tool results
 * 4. Verifies tool_calls animations work (index: 0)
 *
 * Unlike the old gateway, bridge-gateway does one Meta AI submit per request.
 * The IDE must send follow-up requests with tool results.
 */

function loadBridgeGatewayWithMocks(submitPromptImpl) {
  const gatewayPath = require.resolve('../src/bridge-gateway');
  const metaWorkerPath = require.resolve('../src/meta-worker');

  const previousGateway = require.cache[gatewayPath];
  const previousMetaWorker = require.cache[metaWorkerPath];

  delete require.cache[gatewayPath];

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

async function postChat(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function postChatStream(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true })
  });
  const payload = await response.text();
  return { status: response.status, payload };
}

/**
 * Simulates the Void IDE: sends initial messages, handles tool_calls by executing them
 * and sending results back, repeating until a non-tool-call response.
 * This models the real IDE → Gateway → Meta AI → Gateway → IDE loop.
 */
async function runAsSimulatedVoidIde(baseUrl, initialMessages, { sessionHeader = 'void-ide-test', maxTurns = 10 } = {}) {
  let messages = [...initialMessages];
  const transcript = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await postChat(baseUrl, {
      model: 'muse',
      messages
    });
    transcript.push(response);
    assert.equal(response.status, 200, `turn ${turn + 1} must return 200`);

    const choice = response.payload.choices[0];
    const assistantMessage = choice.message;

    if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls?.length) {
      return { transcript, final: response, messages };
    }

    if (assistantMessage.tool_calls.some((tc) => tc?.function?.name === 'task_complete')) {
      return { transcript, final: response, messages };
    }

    // Execute each tool call and build tool result messages
    const toolResultMessages = [];
    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments || '{}');
      const result = await executeToolCall({ name: toolCall.function.name, params: args });
      toolResultMessages.push({
        role: 'tool',
        content: String(result || ''),
        tool_call_id: toolCall.id
      });
    }

    messages = [
      ...messages,
      {
        role: 'assistant',
        content: assistantMessage.content || null,
        tool_calls: assistantMessage.tool_calls
      },
      ...toolResultMessages
    ];
  }

  throw new Error(`simulated IDE exceeded ${maxTurns} turns without reaching a final answer`);
}

// ─── Test 1: tool_calls appear in non-streaming response ─────────────────────

test('void ide workflow: tool_calls appear in non-streaming response', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-ide-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'console.log("hello");\n', 'utf8');

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
    meta: { url: 'https://www.meta.ai/prompt/1', session: { id: 'meta-1' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [
          { role: 'system', content: `workspace contains these folders: ${workspace}` },
          { role: 'user', content: `analisa o projeto em ${workspace}` }
        ]
      });

      assert.equal(status, 200);

      // Void IDE expects tool_calls in the response
      const message = payload.choices[0].message;
      assert.ok(message.tool_calls, 'tool_calls must exist in response for Void IDE');
      assert.ok(Array.isArray(message.tool_calls), 'tool_calls must be an array');
      assert.ok(message.tool_calls.length > 0, 'tool_calls must not be empty');

      // Each tool call must have correct structure for Void animations
      message.tool_calls.forEach((tc, i) => {
        assert.ok(tc.id, `tool_call[${i}] must have id`);
        assert.equal(tc.type, 'function', `tool_call[${i}] must be type "function"`);
        assert.ok(tc.function, `tool_call[${i}] must have function`);
        assert.ok(tc.function.name, `tool_call[${i}] must have function.name`);
        assert.ok(tc.function.arguments, `tool_call[${i}] must have function.arguments`);
      });
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 2: Streaming must emit tool_calls with index 0 for Void animations ──

test('void ide streaming: tool_calls emitted with index 0 for animations', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-stream-'));

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
    meta: { url: 'https://www.meta.ai/prompt/s1', session: { id: 'meta-s1' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChatStream(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: `lista ficheiros em ${workspace}` }]
      });

      assert.equal(status, 200);

      // Parse SSE events
      const events = payload
        .split('\n\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .filter(line => line !== '[DONE]')
        .map(line => JSON.parse(line));

      assert.ok(events.length > 0, 'must have streaming events');

      // Find tool_call events
      const toolCallEvents = events.filter(e =>
        e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.tool_calls
      );

      assert.ok(toolCallEvents.length > 0, 'must have tool_call events in stream for Void animations');

      // The first tool call chunk must have index 0
      toolCallEvents.forEach((e, i) => {
        const toolCalls = e.choices[0].delta.tool_calls;
        assert.ok(Array.isArray(toolCalls), `tool_calls must be array in event ${i}`);
        toolCalls.forEach((tc, j) => {
          assert.ok(tc.index !== undefined, `tool_call[${i}][${j}] must have index`);
          assert.ok(tc.id, `tool_call[${i}][${j}] must have id`);
          assert.equal(tc.type, 'function', `tool_call[${i}][${j}] must be type "function"`);
        });
      });

      // First tool call chunk must have index 0
      const firstToolCallIndex = toolCallEvents[0].choices[0].delta.tool_calls[0].index;
      assert.equal(firstToolCallIndex, 0, 'first tool_call must have index 0 for Void compatibility');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 3: Tool results sent by the IDE are re-submitted correctly ──────────

test('void ide follow-up: tool results re-sent correctly with tool name', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-followup-'));
  fs.writeFileSync(path.join(workspace, 'test.txt'), 'hello world\n', 'utf8');

  const prompts = [];
  let callCount = 0;
  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt) => {
    prompts.push(String(prompt || ''));
    callCount++;
    if (callCount === 1) {
      return {
        text: `<read_file><uri>${path.join(workspace, 'test.txt')}</uri></read_file>`,
        meta: { url: 'https://www.meta.ai/prompt/f1', session: { id: 'meta-f1' } }
      };
    }
    return {
      text: `<task_complete><message>Ficheiro lido com sucesso</message></task_complete>`,
      meta: { url: 'https://www.meta.ai/prompt/f1', session: { id: 'meta-f1' } }
    };
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      // Turn 1: get tool call
      const first = await postChat(baseUrl, {
        model: 'muse',
        messages: [
          { role: 'system', content: `workspace contains these folders: ${workspace}` },
          { role: 'user', content: `le o ficheiro ${path.join(workspace, 'test.txt')}` }
        ]
      });
      assert.equal(first.status, 200);
      const toolCall = first.payload.choices[0].message.tool_calls[0];

      // Turn 2: send tool result
      const second = await postChat(baseUrl, {
        model: 'muse',
        messages: [
          { role: 'system', content: `workspace contains these folders: ${workspace}` },
          { role: 'user', content: `le o ficheiro ${path.join(workspace, 'test.txt')}` },
          { role: 'assistant', content: null, tool_calls: first.payload.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: 'hello world' }
        ]
      });
      assert.equal(second.status, 200);
      assert.match(second.payload.choices[0].message.tool_calls[0].function.name, /task_complete/i);

      // Second prompt must contain the tool result with correct name
      assert.ok(prompts.length >= 2, 'must have at least 2 prompts');
      assert.match(prompts[1], /TOOL_RESULT read_file/i, 'tool result must contain tool name');
      assert.match(prompts[1], /hello world/i, 'tool result must contain file content');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 4: Simulated IDE executes real tool calls end-to-end ────────────────

test('void ide pass-through: simulated IDE executes real tool calls end-to-end until final answer', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-e2e-'));
  const prompts = [];
  const modelReplies = [
    {
      text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      meta: { url: 'https://www.meta.ai/prompt/e2e', session: { id: 'meta-e2e' } }
    },
    {
      text: `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`,
      meta: { url: 'https://www.meta.ai/prompt/e2e', session: { id: 'meta-e2e' } }
    },
    {
      text: `<edit_file><uri>${path.join(workspace, 'index.html')}</uri><content><![CDATA[<!DOCTYPE html><html><body><h1>Bridge OK</h1></body></html>]]></content></edit_file>`,
      meta: { url: 'https://www.meta.ai/prompt/e2e', session: { id: 'meta-e2e' } }
    },
    {
      text: `<task_complete><message>Site criado pela bridge IDE.</message></task_complete>`,
      meta: { url: 'https://www.meta.ai/prompt/e2e', session: { id: 'meta-e2e' } }
    }
  ];

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt) => {
    prompts.push(String(prompt || ''));
    return modelReplies.shift();
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const result = await runAsSimulatedVoidIde(baseUrl, [
        { role: 'system', content: `workspace contains these folders: ${workspace}` },
        { role: 'user', content: `cria um site em ${workspace}` }
      ], { maxTurns: 8 });

      assert.ok(result.final.payload.choices[0].message.tool_calls);
      const finalToolName = result.final.payload.choices[0].message.tool_calls[0].function.name;
      assert.equal(finalToolName, 'task_complete');
      assert.ok(fs.existsSync(path.join(workspace, 'index.html')));
      const html = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
      assert.match(html, /Bridge OK/i);
      assert.ok(prompts.length >= 4, 'gateway must have talked to meta on each simulated IDE turn');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 5: tool_call_id mapping survives round-trip ────────────────────────

test('void ide pass-through: tool_call_id mapping preserved in simulated IDE history', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-idmap-'));
  const prompts = [];
  const modelReplies = [
    {
      text: `<read_file><uri>${path.join(workspace, 'app.js')}</uri></read_file>`,
      meta: { url: 'https://www.meta.ai/prompt/idmap', session: { id: 'meta-idmap' } }
    },
    {
      text: `<task_complete><message>Leitura concluida.</message></task_complete>`,
      meta: { url: 'https://www.meta.ai/prompt/idmap', session: { id: 'meta-idmap' } }
    }
  ];
  fs.writeFileSync(path.join(workspace, 'app.js'), 'console.log("id-map");\n', 'utf8');

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt) => {
    prompts.push(String(prompt || ''));
    return modelReplies.shift();
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const result = await runAsSimulatedVoidIde(baseUrl, [
        { role: 'user', content: `le ${path.join(workspace, 'app.js')}` }
      ], { maxTurns: 5 });

      const assistantToolMessage = result.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
      const toolResultMessage = result.messages.find((m) => m.role === 'tool' && m.tool_call_id);
      assert.ok(assistantToolMessage, 'simulated IDE history must include assistant tool call message');
      assert.ok(toolResultMessage, 'simulated IDE history must include tool result with tool_call_id');
      assert.equal(toolResultMessage.tool_call_id, assistantToolMessage.tool_calls[0].id);
      assert.match(prompts[1], /TOOL_RESULT read_file/i);
      assert.match(prompts[1], /id-map/i);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 6: Edit file workflow ───────────────────────────────────────────────

test('void ide edit workflow: create empty file then write content', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-edit-'));

  const modelReplies = [
    {
      text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      meta: { url: 'https://www.meta.ai/prompt/e1', session: { id: 'meta-e1' } }
    },
    {
      text: `<create_file_or_folder><uri>${path.join(workspace, 'index.html')}</uri></create_file_or_folder>`,
      meta: { url: 'https://www.meta.ai/prompt/e1', session: { id: 'meta-e1' } }
    },
    {
      text: `<edit_file><uri>${path.join(workspace, 'index.html')}</uri><content><![CDATA[<!DOCTYPE html><html><body>Hello</body></html>]]></content></edit_file>`,
      meta: { url: 'https://www.meta.ai/prompt/e1', session: { id: 'meta-e1' } }
    },
    {
      text: `<task_complete><message>Site criado</message></task_complete>`,
      meta: { url: 'https://www.meta.ai/prompt/e1', session: { id: 'meta-e1' } }
    }
  ];

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => modelReplies.shift());

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const result = await runAsSimulatedVoidIde(baseUrl, [
        { role: 'user', content: `cria um site em ${workspace}` }
      ], { maxTurns: 8 });

      // task_complete is the final tool call
      const finalChoice = result.final.payload.choices[0];
      assert.equal(finalChoice.finish_reason, 'tool_calls');
      assert.equal(finalChoice.message.tool_calls[0].function.name, 'task_complete');

      // Verify file was created and written
      const content = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
      assert.match(content, /Hello/i, 'file must contain written content');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 7: task_complete returns clean message ──────────────────────────────

test('void ide task_complete: is returned as a tool_call with parsed message', async () => {
  const modelReplies = [
    {
      text: `<task_complete><message>Operação concluída com sucesso!</message></task_complete>`,
      meta: { url: 'https://www.meta.ai/prompt/t1', session: { id: 'meta-t1' } }
    }
  ];

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => modelReplies.shift());

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChat(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: 'diz ola' }]
      });

      assert.equal(status, 200);
      assert.equal(payload.choices[0].finish_reason, 'tool_calls');
      const tc = payload.choices[0].message.tool_calls[0];
      assert.equal(tc.function.name, 'task_complete');
      const args = JSON.parse(tc.function.arguments);
      assert.equal(args.message, 'Operação concluída com sucesso!');
    });
  } finally {
    restore();
  }
});

// ─── Test 8: Generated code has no CDATA or markers leaked ───────────────────

test('void ide edit: generated code has no CDATA or markers leaked', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-clean-'));
  fs.writeFileSync(path.join(workspace, 'index.html'), '<html></html>\n', 'utf8');

  const modelReplies = [
    {
      text: `<edit_file><uri>${path.join(workspace, 'index.html')}</uri><content><![CDATA[<<<<<<< SEARCH
<html></html>
=======
<html><body><h1>Clean</h1></body></html>
>>>>>>> REPLACE]]></content></edit_file>`,
      meta: { url: 'https://www.meta.ai/prompt/clean', session: { id: 'meta-clean' } }
    },
    {
      text: `<task_complete><message>Ficheiro atualizado</message></task_complete>`,
      meta: { url: 'https://www.meta.ai/prompt/clean', session: { id: 'meta-clean' } }
    }
  ];

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => modelReplies.shift());

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const result = await runAsSimulatedVoidIde(baseUrl, [
        { role: 'user', content: `edita o index.html em ${workspace}` }
      ], { maxTurns: 5 });

      assert.equal(result.final.status, 200);

      // File must NOT contain any of these markers
      const content = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
      assert.doesNotMatch(content, /<!\[CDATA\[/i, 'file must not contain CDATA opening');
      assert.doesNotMatch(content, /\]\]>/i, 'file must not contain CDATA closing');
      assert.doesNotMatch(content, /<{6,7}\s*(ORIGINAL|SEARCH)/i, 'file must not contain SEARCH marker');
      assert.doesNotMatch(content, />{6,7}\s*(UPDATED|REPLACE)/i, 'file must not contain UPDATED marker');
      assert.doesNotMatch(content, /={3,}/, 'file must not contain separator ===');
      // But MUST contain the actual code
      assert.match(content, /Clean/i, 'file must contain the actual code');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 9: Void-style messages (no "Primary working directory:" marker) ────

test('void ide: messages without "Primary working directory:" use Void prompt strategy', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-nopwd-'));
  const promptsSent = [];

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async (prompt) => {
    promptsSent.push(String(prompt || ''));
    return {
      text: `<get_dir_tree><uri>${workspace}</uri></get_dir_tree>`,
      meta: { url: 'https://www.meta.ai/prompt/nopwd', session: { id: 'meta-nopwd' } }
    };
  });

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status } = await postChat(baseUrl, {
        model: 'muse',
        messages: [
          // Void-style: NO "Primary working directory:" in system message
          { role: 'system', content: 'You are a helpful coding assistant.' },
          { role: 'user', content: `show me what is in ${workspace}` }
        ]
      });
      assert.equal(status, 200);
    });

    assert.ok(promptsSent.length > 0, 'must have sent prompt to Meta AI');
    // Void prompt marker (not OpenClaude)
    assert.match(promptsSent[0], /IDE gateway/i, 'must use Void/IDE prompt (not OpenClaude API gateway)');
    assert.doesNotMatch(promptsSent[0], /Primary working directory/i, 'Void prompt must not reference OpenClaude workspace marker');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});

// ─── Test 10: Streaming tool_calls have correct OpenAI chunk format ───────────

test('void ide streaming: tool_calls have correct OpenAI streaming chunk format', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-void-stream-format-'));

  const { createBridgeGatewayApp, restore } = loadBridgeGatewayWithMocks(async () => ({
    text: `<read_file><uri>${path.join(workspace, 'app.js')}</uri></read_file>`,
    meta: { url: 'https://www.meta.ai/prompt/sf1', session: { id: 'meta-sf1' } }
  }));

  try {
    await withServer(createBridgeGatewayApp(), async (baseUrl) => {
      const { status, payload } = await postChatStream(baseUrl, {
        model: 'muse',
        messages: [{ role: 'user', content: `le o ficheiro em ${workspace}` }]
      });

      assert.equal(status, 200);

      const events = payload
        .split('\n\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .filter(line => line !== '[DONE]')
        .map(line => JSON.parse(line));

      // Every event must have correct structure
      events.forEach((e, i) => {
        assert.ok(e.id, `event[${i}] must have id`);
        assert.equal(e.object, 'chat.completion.chunk', `event[${i}] object must be chat.completion.chunk`);
        assert.ok(e.created, `event[${i}] must have created`);
        assert.ok(e.model, `event[${i}] must have model`);
        assert.ok(Array.isArray(e.choices), `event[${i}] must have choices array`);
      });

      // Find tool_call events and verify their format
      const toolCallEvents = events.filter(e =>
        e.choices[0]?.delta?.tool_calls
      );
      assert.ok(toolCallEvents.length > 0, 'must have at least one tool_call event');
      toolCallEvents.forEach((e, i) => {
        const tc = e.choices[0].delta.tool_calls[0];
        assert.ok(tc.id, `tool_call event[${i}] must have id`);
        assert.equal(tc.type, 'function', `tool_call event[${i}] type must be "function"`);
        assert.ok(tc.function?.name, `tool_call event[${i}] must have function.name`);
        assert.ok(typeof tc.function?.arguments === 'string', `tool_call event[${i}] arguments must be string`);
      });
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    restore();
  }
});
