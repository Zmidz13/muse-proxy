/**
 * Void IDE built-in tools schema — OpenAI-style tool definitions.
 * These are the exact tools that Void IDE natively executes when it receives tool_calls.
 * Source: void-main/src/vs/workbench/contrib/void/common/toolsServiceTypes.ts
 *
 * The gateway uses these to:
 * 1. Tell Void which tools are available (when Void connects)
 * 2. Generate XML instructions for Meta AI
 * 3. Validate and convert XML tool calls from Meta AI → OpenAI format for Void
 */

/**
 * OpenAI-style tool definitions for all Void IDE built-in tools.
 * Format matches what Void expects when specialToolFormat === 'openai-style'.
 */
const VOID_TOOLS_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Returns full contents of a given file.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file.' },
          start_line: { type: 'string', description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the beginning of the file.' },
          end_line: { type: 'string', description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the end of the file.' },
          page_number: { type: 'string', description: 'Optional. The page number of the result. Default is 1.' }
        },
        required: ['uri']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ls_dir',
      description: 'Lists all files and folders in the given URI.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'Optional. The FULL path to the folder. Leave this as empty or "" to search all folders.' },
          page_number: { type: 'string', description: 'Optional. The page number of the result. Default is 1.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dir_tree',
      description: 'This is a very effective way to learn about the user\'s codebase. Returns a tree diagram of all the files and folders in the given folder.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the folder.' }
        },
        required: ['uri']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_pathnames_only',
      description: 'Returns all pathnames that match a given query (searches ONLY file names). You should use this when looking for a file with a specific name or path.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Your query for the search.' },
          include_pattern: { type: 'string', description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
          page_number: { type: 'string', description: 'Optional. The page number of the result. Default is 1.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_for_files',
      description: 'Returns a list of file names whose content matches the given query. The query can be any substring or regex.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Your query for the search.' },
          is_regex: { type: 'string', description: 'Optional. Default is false. Whether the query is a regex.' },
          search_in_folder: { type: 'string', description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
          page_number: { type: 'string', description: 'Optional. The page number of the result. Default is 1.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_in_file',
      description: 'Returns an array of all the start line numbers where the content appears in the file.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file.' },
          query: { type: 'string', description: 'The string or regex to search for in the file.' },
          is_regex: { type: 'string', description: 'Optional. Default is false. Whether the query is a regex.' }
        },
        required: ['uri', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_lint_errors',
      description: 'Use this tool to view all the lint errors on a file.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file.' }
        },
        required: ['uri']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_file',
      description: 'Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file.' },
          new_content: { type: 'string', description: 'The new contents of the file. Must be a string.' }
        },
        required: ['uri', 'new_content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit the contents of a file. You must provide the file\'s URI as well as a SINGLE string of SEARCH/REPLACE block(s) that will be used to apply the edit.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file.' },
          search_replace_blocks: {
            type: 'string',
            description: [
              'A string of SEARCH/REPLACE block(s) which will be applied to the given file.',
              'Format:',
              '<<<<<<< ORIGINAL',
              '// ... original code goes here',
              '=======',
              '// ... final code goes here',
              '>>>>>>> UPDATED',
              '',
              'Rules:',
              '1. You may output multiple SEARCH/REPLACE blocks if needed.',
              '2. The ORIGINAL code must EXACTLY match lines in the original file.',
              '3. Each ORIGINAL text must be large enough to uniquely identify the change.',
              '4. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.',
              '5. This field is a STRING (not an array).'
            ].join('\n')
          }
        },
        required: ['uri', 'search_replace_blocks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_file_or_folder',
      description: 'Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file or folder.' }
        },
        required: ['uri']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file_or_folder',
      description: 'Delete a file or folder at the given path.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The FULL path to the file or folder.' },
          is_recursive: { type: 'string', description: 'Optional. Return true to delete recursively.' }
        },
        required: ['uri']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Runs a terminal command and waits for the result (times out after 8s of inactivity). You can use this tool to run any command: sed, grep, etc. Do not edit any files with this tool; use edit_file instead.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The terminal command to run.' },
          cwd: { type: 'string', description: 'Optional. The directory in which to run the command. Defaults to the first workspace folder.' },
          terminal_id: { type: 'string', description: 'Optional. The ID of the terminal to run the command in.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_persistent_terminal',
      description: 'Use this tool when you want to run a terminal command indefinitely, like a dev server (eg `npm run dev`), a background listener, etc. Opens a new terminal in the user\'s environment which will not awaited for or killed.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Optional. The directory in which to run the command. Defaults to the first workspace folder.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_persistent_command',
      description: 'Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after 5s are returned, and command continues running in background).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The terminal command to run.' },
          persistent_terminal_id: { type: 'string', description: 'The ID of the terminal created using open_persistent_terminal.' }
        },
        required: ['command', 'persistent_terminal_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'kill_persistent_terminal',
      description: 'Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.',
      parameters: {
        type: 'object',
        properties: {
          persistent_terminal_id: { type: 'string', description: 'The ID of the persistent terminal.' }
        },
        required: ['persistent_terminal_id']
      }
    }
  }
];

/**
 * Get all Void tool definitions.
 * @returns {Array} OpenAI-style tool definitions
 */
function getVoidToolsDefinitions() {
  return VOID_TOOLS_DEFINITIONS;
}

/**
 * Get a single tool definition by name.
 * @param {string} toolName
 * @returns {object|null}
 */
function getVoidToolByName(toolName) {
  return VOID_TOOLS_DEFINITIONS.find(t => t.function.name === toolName) || null;
}

/**
 * Get all tool names as a set for fast lookup.
 * @returns {Set<string>}
 */
function getVoidToolNames() {
  return new Set(VOID_TOOLS_DEFINITIONS.map(t => t.function.name));
}

/**
 * Convert Void tool definitions to XML format for Meta AI system prompt.
 * This generates the XML template that Meta AI should follow.
 * @returns {string}
 */
function generateVoidToolsXMLForPrompt() {
  const lines = ['    Available tools:\n'];
  VOID_TOOLS_DEFINITIONS.forEach((tool, i) => {
    const fn = tool.function;
    lines.push(`    ${i + 1}. ${fn.name}`);
    lines.push(`    Description: ${fn.description}`);
    lines.push(`    Format:`);
    lines.push(`    <${fn.name}>`);
    const params = fn.parameters && fn.parameters.properties ? fn.parameters.properties : {};
    for (const [paramName, paramDef] of Object.entries(params)) {
      const desc = paramDef.description || '';
      const optional = !(fn.parameters.required || []).includes(paramName) ? ' (Optional)' : '';
      lines.push(`    <${paramName}>${desc}${optional}</${paramName}>`);
    }
    lines.push(`    </${fn.name}>`);
    lines.push('');
  });

  lines.push('    Tool calling rules:');
  lines.push('    - To call a tool, write its name and parameters in the XML format specified above.');
  lines.push('    - After you write the tool call, you must STOP and WAIT for the result.');
  lines.push('    - All parameters are REQUIRED unless noted otherwise.');
  lines.push('    - You are only allowed to output ONE tool call, and it must be at the END of your response.');
  lines.push('    - Your tool call will be executed immediately, and the results will appear in the following user message.');

  return lines.join('\n');
}

module.exports = {
  getVoidToolsDefinitions,
  getVoidToolByName,
  getVoidToolNames,
  generateVoidToolsXMLForPrompt
};
