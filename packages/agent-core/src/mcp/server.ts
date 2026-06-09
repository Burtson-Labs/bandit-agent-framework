/**
 * Bandit-as-MCP-server. Exposes Bandit's native tool surface
 * (read_file, write_file, apply_edit, replace_range, list_files, ls, search_code,
 * find_directory, run_command, etc.) over MCP stdio so other clients
 * — Claude Desktop, Cursor, Cline, Continue, any MCP-speaking host —
 * can drive Bandit the same way Bandit drives external servers.
 *
 * Mirror of the client code path: SDK is required lazily so a missing
 * dep can never crash module load (matters because this module ships
 * inside the same agent-core dist that the IDE extension imports
 * eagerly). Failures during tool calls return a structured error
 * result with isError: true rather than throwing.
 */

import type { AgentTool, ToolExecutionContext } from '../tools/tool-types';

interface ServeOptions {
  /** Tools to expose. Hosts pass a ToolRegistry's contents — usually
   *  the core skill's tools plus run_command. read-only mode skips
   *  write_file / apply_edit / replace_range / run_command. */
  tools: AgentTool[];
  /** ToolExecutionContext for tool invocations. The host owns this
   *  so it can wire up filesystem access, language adapters, etc.,
   *  exactly the way Bandit's own loop wires them. */
  toolCtx: ToolExecutionContext;
  /** Server name advertised in the MCP handshake. Defaults to
   *  "bandit". MCP clients show this in their UI. */
  name?: string;
  /** Server version advertised in the handshake. Defaults to the
   *  agent-core package version. */
  version?: string;
  /** Optional logger. Defaults to console.error. Stdout is reserved
   *  for the JSON-RPC stream — never log there. */
  log?: (line: string) => void;
}

/**
 * Convert a Bandit AgentTool's flat parameter list into MCP's
 * JSON-Schema input shape. Best-effort — every parameter is typed as
 * `string` since AgentTool doesn't carry richer type info, with the
 * description preserved verbatim. MCP clients that strict-validate
 * input still get a clean schema; clients that don't validate just
 * see a documented set of fields.
 */
function toolInputSchema(tool: AgentTool): {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const p of tool.parameters) {
    properties[p.name] = { type: 'string', description: p.description };
    if (p.required) {required.push(p.name);}
  }
  return { type: 'object', properties, required };
}

/**
 * Coerce the MCP arguments object into the flat Record<string,string>
 * shape Bandit's AgentTool.execute expects. Non-string values get
 * JSON.stringify'd back to text so an MCP client passing a number /
 * boolean / nested object still reaches our tool with a usable
 * representation — matches the equivalent coercion done client-side
 * in toolAdapter.ts when going the other direction.
 */
function coerceArgs(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return {};}
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {out[k] = v;}
    else if (v === null || v === undefined) {continue;}
    else {out[k] = JSON.stringify(v);}
  }
  return out;
}

/**
 * Spin up an MCP server that exposes Bandit's native tools over
 * stdio. Returns a promise that resolves when the transport closes
 * (typically when the parent client disconnects). The caller
 * controls the process lifetime — typical usage is a CLI subcommand
 * that just awaits this promise then exits.
 */
export async function serveBanditMcp(options: ServeOptions): Promise<void> {
  // SDK loaded lazily — same pattern as clientPool.ts. A dep
  // resolution failure inside the SDK never trips at module load,
  // only when an actual host tries to start the server. Means
  // `import { serveBanditMcp }` is safe in code paths that may or
  // may not actually run the server.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const serverMod = require('@modelcontextprotocol/sdk/server/index.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stdioMod = require('@modelcontextprotocol/sdk/server/stdio.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const typesMod = require('@modelcontextprotocol/sdk/types.js');
  const { Server } = serverMod;
  const { StdioServerTransport } = stdioMod;
  const { ListToolsRequestSchema, CallToolRequestSchema } = typesMod;

  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const tools = options.tools;
  const toolByName = new Map<string, AgentTool>();
  for (const t of tools) {toolByName.set(t.name, t);}

  const server = new Server(
    { name: options.name ?? 'bandit', version: options.version ?? '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // tools/list — return every registered tool's metadata.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toolInputSchema(t)
    }))
  }));

  // tools/call — dispatch into the AgentTool's execute. Errors
  // surface as MCP isError results rather than thrown exceptions so
  // the calling client gets a clean, parseable response.
  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
    const tool = toolByName.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }]
      };
    }
    try {
      const args = coerceArgs(request.params.arguments);
      const result = await tool.execute(args, options.toolCtx);
      return {
        isError: Boolean(result.isError),
        content: [{ type: 'text', text: result.output }]
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`tool call ${request.params.name} threw: ${msg}`);
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${msg}` }]
      };
    }
  });

  log(`bandit MCP server: ready on stdio with ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect returns once the transport is wired but stays
  // alive on stdio reads. Hook close so the host's await resolves.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
