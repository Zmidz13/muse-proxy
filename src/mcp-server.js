const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod/v4');
const { metaWorker } = require('./meta-worker');

const server = new McpServer({
  name: 'meta-ai-bridge',
  version: '0.1.0'
});

server.registerTool(
  'meta_chat',
  {
    description: 'Envia um prompt para o meta.ai via browser e devolve o texto da resposta.',
    inputSchema: {
      prompt: z.string().min(1).describe('Texto para enviar ao chat'),
      new_chat: z.boolean().optional().describe('Se true, tenta abrir nova conversa antes de enviar')
    }
  },
  async ({ prompt, new_chat }) => {
    try {
      const result = await metaWorker.submitPrompt(prompt, { forceNewChat: Boolean(new_chat) });
      return {
        content: [
          {
            type: 'text',
            text: result.text
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Erro: ${error.message || 'falha desconhecida'}`
          }
        ],
        isError: true
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error('MCP meta-ai-bridge em execucao via stdio.');
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Erro fatal no MCP server:', error);
  process.exit(1);
});
