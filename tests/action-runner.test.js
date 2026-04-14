const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseToolCallXML, executeToolCall, hasToolCall } = require('../src/action-runner');

test('action-runner covers the IDE tool surface safely', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'musespark-action-runner-'));
  const oldCwd = process.cwd();

  try {
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.html'), '<html><body>shop</body></html>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'nested', 'note.txt'), 'hello [world]\nneedle inside file\n', 'utf8');
    fs.writeFileSync(path.join(root, 'app.js'), 'const message = "needle";\n', 'utf8');
    fs.writeFileSync(path.join(root, 'delete-me.txt'), 'delete\n', 'utf8');

    process.chdir(root);

    assert.equal(hasToolCall('<get_dir_tree><uri>C:\\tmp</uri></get_dir_tree>'), true);

    const parsedTree = parseToolCallXML(`<get_dir_tree><uri>${root}</uri></get_dir_tree>`);
    assert.deepEqual(parsedTree, { name: 'get_dir_tree', params: { uri: root } });

    const parsedSearchFiles = parseToolCallXML([
      '<search_for_files>',
      '<query>needle</query>',
      `<search_in_folder>${root}</search_in_folder>`,
      '<is_regex>false</is_regex>',
      '</search_for_files>'
    ].join(''));
    assert.equal(parsedSearchFiles.name, 'search_for_files');
    assert.equal(parsedSearchFiles.params.searchInFolder, root);

    const treeResult = await executeToolCall({ name: 'get_dir_tree', params: { uri: root } });
    assert.match(treeResult, /src\//i);
    assert.match(treeResult, /nested\//i);

    const pathnameResult = await executeToolCall({
      name: 'search_pathnames_only',
      params: { query: 'index', includePattern: 'src/*' }
    });
    assert.match(pathnameResult, /index\.html/i);
    const pathnameLines = pathnameResult.split(/\r?\n/).filter(Boolean);
    assert.ok(pathnameLines.every((line) => line.startsWith(root)));

    const searchLiteral = await executeToolCall({
      name: 'search_in_file',
      params: {
        uri: path.join(root, 'src', 'nested', 'note.txt'),
        query: '[',
        isRegex: 'false'
      }
    });
    assert.match(searchLiteral, /1: hello \[world\]/i);

    const searchFiles = await executeToolCall({
      name: 'search_for_files',
      params: {
        query: 'needle',
        searchInFolder: root,
        isRegex: 'false'
      }
    });
    assert.match(searchFiles, /app\.js/i);
    assert.match(searchFiles, /note\.txt/i);

    const lintResult = await executeToolCall({
      name: 'read_lint_errors',
      params: { uri: path.join(root, 'app.js') }
    });
    assert.match(lintResult, /eslint|lint/i);

    const brokenEdit = await executeToolCall({
      name: 'edit_file',
      params: {
        uri: path.join(root, 'src', 'index.html'),
        content: '<<<<<<< ORIGINAL\n<html><body>updated</body></html>\nUPDATED'
      }
    });
    assert.match(brokenEdit, /updated/i);
    assert.match(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8'), /updated/);

    fs.writeFileSync(path.join(root, 'src', 'index.html'), '', 'utf8');
    const cdataInlineEdit = await executeToolCall({
      name: 'edit_file',
      params: {
        uri: path.join(root, 'src', 'index.html'),
        content: '<![CDATA[<<<<<<< ORIGINAL <html><body>clean replacement</body></html> >>>>>>> UPDATED]]>'
      }
    });
    const finalInline = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
    assert.match(cdataInlineEdit, /written|updated/i);
    assert.equal(finalInline.includes('<![CDATA['), false);
    assert.equal(finalInline.includes('<<<<<<<'), false);
    assert.match(finalInline, /clean replacement/i);

    const deleteResult = await executeToolCall({
      name: 'delete_file_or_folder',
      params: { uri: path.join(root, 'delete-me.txt'), isRecursive: 'false' }
    });
    assert.match(deleteResult, /Deleted file/i);
    assert.equal(fs.existsSync(path.join(root, 'delete-me.txt')), false);
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
