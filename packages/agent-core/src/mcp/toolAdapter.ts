/**
 * Adapt MCP tool definitions to Bandit's AgentTool interface so the
 * existing tool-use loop can call them with no special-casing.
 *
 * server "slack" exposes tool "post_message" → AgentTool named
 * "slack.post_message" registered alongside read_file / apply_edit /
 * etc. The model invokes it via the same <tool_call>{...}</tool_call>
 * envelope it uses for native tools.
 *
 * Namespacing is non-negotiable: collisions with native tool names
 * (read_file, write_file, etc) would silently shadow Bandit's own
 * implementations. Always `<server>.<tool>`.
 */

import type { AgentTool, AgentToolParameter, AgentToolParameterSchema, ToolExecutionContext, ToolResult } from '../tools/tool-types';
import type { McpClientPool } from './clientPool';
import { shouldActivateServer, isServerMentioned } from './activation';

// MCP inputSchema is JSON Schema — recursive shape with type, properties,
// items, required, enum. We model just the fields that matter for our
// AgentToolParameterSchema render (which feeds both the native-tools
// provider schema AND the system-prompt block hint). Anything richer
// (oneOf / anyOf / format / pattern) gets dropped here — agents handle
// those poorly anyway and the round-trip would lose information.
interface JsonSchemaNode {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: Array<string | number | boolean>;
}

interface RemoteToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchemaNode;
}

/**
 * Translate one MCP JSON-Schema node into the slimmer
 * AgentToolParameterSchema shape. Recursive for object properties and
 * array items so a `createFilter` param like `criteria: { type: object,
 * properties: { from, to, subject, query } }` keeps its shape all the
 * way to the model — instead of getting flattened to a single opaque
 * "string" param the way the legacy converter did.
 */
function toAgentSchema(node: JsonSchemaNode | undefined): AgentToolParameterSchema | undefined {
  if (!node) {return undefined;}
  const t = node.type;
  const ALLOWED = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  if (t && !ALLOWED.has(t)) {return undefined;}
  const out: AgentToolParameterSchema = {};
  if (t) {out.type = t as AgentToolParameterSchema['type'];}
  if (node.description) {out.description = node.description;}
  if (node.enum) {out.enum = node.enum;}
  if (t === 'object' && node.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      const child = toAgentSchema(v);
      if (child) {
        out.properties[k] = child.description
          ? { ...child, description: child.description }
          : { ...child, description: v.description };
      }
    }
    if (node.required && node.required.length > 0) {out.required = node.required;}
  } else if (t === 'array' && node.items) {
    const child = toAgentSchema(node.items);
    if (child) {out.items = child;}
  }
  return out;
}

/**
 * Convert an MCP tool's JSON-Schema input to Bandit's AgentToolParameter[].
 * Each parameter now carries the original JSON Schema type info on the
 * optional `schema` field, so downstream renderers (native-tools
 * provider schema + system-prompt block) tell the model the real shape
 * (object/array/etc) instead of the legacy "every param is a string."
 * That's the fix for MCP tools whose backends reject string-encoded
 * objects with "Expected object, received string."
 */
function convertInputSchema(schema: RemoteToolDef['inputSchema']): AgentToolParameter[] {
  if (!schema || schema.type !== 'object' || !schema.properties) {return [];}
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => {
    const subSchema = toAgentSchema(prop);
    return {
      name,
      description: prop?.description ?? `(${prop?.type ?? 'any'})`,
      required: required.has(name),
      schema: subSchema
    };
  });
}

/**
 * Render an MCP tool result into the plaintext form Bandit's loop
 * expects. MCP results are an array of content blocks (text / image
 * / resource); for v1 we concatenate every text block and surface
 * non-text blocks as a one-line marker so the model knows it received
 * non-text data without us inlining bytes.
 */
function renderMcpResult(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): ToolResult {
  const blocks = result?.content ?? [];
  const textParts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else {
      textParts.push(`[mcp:${block.type}] (non-text content omitted)`);
    }
  }
  const output = textParts.join('\n').trim() || '(empty MCP response)';
  return { output, isError: Boolean(result?.isError) };
}

/**
 * Build an AgentTool that proxies through the pool to the named
 * server's named tool. Parameter list is derived from the MCP tool's
 * input schema; description is preserved verbatim with a small
 * "(via MCP server <name>)" suffix so the user reading their session
 * log can tell which server's tools the agent reached for.
 */
export function mcpToolToAgentTool(
  serverName: string,
  remote: RemoteToolDef,
  pool: McpClientPool
): AgentTool {
  const namespacedName = `${serverName}.${remote.name}`;
  const description = remote.description
    ? `${remote.description} (via MCP server "${serverName}")`
    : `MCP tool "${remote.name}" exposed by server "${serverName}".`;
  const parameters = convertInputSchema(remote.inputSchema);
  return {
    name: namespacedName,
    description,
    parameters,
    async execute(params: Record<string, string>, _ctx: ToolExecutionContext): Promise<ToolResult> {
      try {
        // Bandit's tool-use loop hands us params as Record<string, string>
        // (the tool-call parser stringifies nested objects/arrays before
        // they reach execute()) — we reverse that here so MCP tools
        // whose backends actually validate object/array shapes receive
        // the original structure.
        //
        // Critical bug shipped pre-1.7.282: the prior `\[|\{` regex
        // only matched a SINGLE literal `[` or `{` character, NOT a
        // full JSON array/object string starting with those. So
        // `{"from":"npm"}` failed the test, JSON.parse never ran,
        // and the MCP server got the raw string — zod rejected with
        // "Expected object, received string." The schema-passthrough
        // fix in v1.7.281 made the MODEL emit objects correctly but
        // they were still being stringified on the way through Bandit's
        // parser AND this regex never put them back. Fix: detect
        // start-of-JSON characters with `^[{[]`, not the broken
        // single-char alternatives.
        const args: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params)) {
          if (typeof v !== 'string') {
            args[k] = v;
            continue;
          }
          const trimmed = v.trim();
          if (trimmed === '') {
            args[k] = v;
            continue;
          }
          const looksLikeJson =
            trimmed.startsWith('{') ||
            trimmed.startsWith('[') ||
            /^"[\s\S]*"$/.test(trimmed) ||
            /^(-?\d+(?:\.\d+)?|true|false|null)$/.test(trimmed);
          if (looksLikeJson) {
            try { args[k] = JSON.parse(trimmed); } catch { args[k] = v; }
          } else {
            args[k] = v;
          }
        }
        const result = await pool.callTool(serverName, remote.name, args);
        return renderMcpResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          output: `Error invoking ${namespacedName}: ${msg}`,
          isError: true
        };
      }
    }
  };
}

/**
 * Convenience: enumerate every connected server's tools and return
 * AgentTool wrappers ready to register with the existing
 * ToolRegistry. Call from the host (extension or CLI) after the user's
 * mcp-servers.json has been loaded into the pool.
 *
 * The optional `prompt` argument enables activation filtering: when
 * provided, servers configured with `activation: "on-mention"` are
 * only included if their trigger keywords match the prompt. Servers
 * with `activation: "always"` (the default) always contribute their
 * tools regardless of prompt. Pass `undefined` (or omit) to register
 * every server's tools — the -and-earlier behavior.
 *
 * Each server's discoverTools() will lazily spawn the process — so
 * the first call per server after session start does pay the spawn
 * cost. With on-mention activation, that cost only fires for prompts
 * that actually trigger the server.
 */
export async function getAllMcpAgentTools(
  pool: McpClientPool,
  prompt?: string
): Promise<AgentTool[]> {
  const out: AgentTool[] = [];
  for (const snap of pool.snapshot()) {
    if (!shouldActivateServer(snap.name, snap.config, prompt)) {continue;}
    // Defer the FIRST-TIME spawn for `always`-mode servers without a
    // cached tool list. Without this gate, every "hi" triggers
    // `discoverTools` → `ensureConnected` → `spawnAndHandshake` →
    // trust prompt, even though the agent has no MCP intent. With
    // the gate: skip enumeration unless either (a) the user's prompt
    // mentions the server / one of its triggers, or (b) we already
    // have a cached tool list and the spawn is therefore not needed
    // for this enumeration call. After the first successful spawn
    // the cache populates and subsequent prompts never re-spawn.
    const cached = pool.hasCachedTools(snap.name);
    if (!cached && !isServerMentioned(snap.name, snap.config, prompt)) {continue;}
    const tools = await pool.discoverTools(snap.name);
    for (const remote of tools) {
      out.push(mcpToolToAgentTool(snap.name, remote, pool));
    }
  }
  return out;
}
