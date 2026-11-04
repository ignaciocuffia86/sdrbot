// Servidor MCP del gateway: las mismas operaciones que la API REST, como tools, para que
// un bot de Grok Bot las use agregando un MCP remoto con su token en Authorization.
//
// Sin sesión (sessionIdGenerator: undefined), igual que ASCI: en una función serverless
// dos llamadas seguidas pueden caer en contenedores distintos.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { opsForScopes, opByMcp, runOp } from './ops.mjs';
import { VERSION } from './config.mjs';

export async function handleMcp(ctx, req, res, body) {
  const server = new Server({ name: 'sdrbot-mail-gateway', version: VERSION }, { capabilities: { tools: {} } });

  // El listado muestra sólo lo que el token puede usar: el modelo planifica con lo que ve.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opsForScopes(ctx.scopes).map((o) => ({ name: o.mcp, description: o.description, inputSchema: o.schema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const o = opByMcp(name);
    if (!o) return { content: [{ type: 'text', text: `Error: no existe la tool "${name}".` }], isError: true };
    try {
      const result = await runOp({ ...ctx }, o, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (e) {
      // isError con el código estable deja que el modelo corrija la llamada o decida parar.
      return { content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code, message: e.message, ...e.extra } }) }], isError: true };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
