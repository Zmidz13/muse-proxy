const test = require('node:test');
const assert = require('node:assert/strict');

test('setInputText writes multiline prompts atomically without keyboard.type', async () => {
  const metaWorkerPath = require.resolve('../src/meta-worker');
  const previous = require.cache[metaWorkerPath];
  delete require.cache[metaWorkerPath];

  const { metaWorker } = require('../src/meta-worker');

  const calls = [];
  metaWorker._debugLog = () => {};
  metaWorker.getInputText = async () => {
    const insert = calls.find((entry) => entry.kind === 'insertText');
    return insert ? insert.text : '';
  };
  metaWorker.page = {
    locator() {
      return {
        first() {
          return {
            click: async () => {},
            focus: async () => {}
          };
        }
      };
    },
    keyboard: {
      press: async (key) => {
        calls.push({ kind: 'press', key });
      },
      insertText: async (text) => {
        calls.push({ kind: 'insertText', text });
      },
      type: async (text) => {
        calls.push({ kind: 'type', text });
      }
    },
    evaluate: async () => true
  };

  try {
    const prompt = 'linha 1\nlinha 2\nlinha 3';
    await metaWorker.setInputText('[data-lexical-editor="true"]', prompt);

    assert.equal(calls.some((entry) => entry.kind === 'type'), false);
    assert.equal(calls.some((entry) => entry.kind === 'insertText' && entry.text === prompt), true);
  } finally {
    if (previous) {
      require.cache[metaWorkerPath] = previous;
    } else {
      delete require.cache[metaWorkerPath];
    }
  }
});
