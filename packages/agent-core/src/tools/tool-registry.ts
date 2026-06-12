import type { AgentTool, AgentToolParameter, AgentToolParameterSchema } from './tool-types';

/**
 * Registry of available agent tools.
 *
 * Builds XML-format tool definitions for text-based tool calling,
 * usable with models that don't support native function calling
 * (gemma3, bandit-core, most 7-27B models).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: AgentTool[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Builds the tool definitions block injected into the system prompt.
   *
   * Format used for text-based tool calling (XML, compatible with Gemma3/bandit-core):
   *
   * You have access to these tools:
   * <tool name="read_file">
   *   <description>...</description>
   *   <param name="path" required="true">...</param>
   * </tool>
   * ...
   * To use a tool, respond with ONLY:
   * <tool_call>{"name": "tool_name", "params": {"key": "value"}}</tool_call>
   *
   * When you have finished using tools and have a final answer, respond normally.
   */
  buildSystemPromptBlock(): string {
    if (this.tools.size === 0) {return '';}

    const toolDefs = this.getAll().map(tool => this.renderToolXml(tool)).join('\n\n');

    return [
      '## Available Tools',
      '',
      'You have access to the following tools to help you complete tasks:',
      '',
      toolDefs,
      '',
      ...TOOL_PROTOCOL_LINES
    ].join('\n');
  }

  /**
   * Compact variant of `buildSystemPromptBlock` for small-tier models.
   * The full XML block measures ~27 KB with the default CLI tool set —
   * the single largest component of a small model's prompt, and the
   * reason the default config used to overflow its own num_ctx on turn
   * one (Ollama then truncates the context HEAD, which is where the
   * identity + tool protocol live — producing narrated-instead-of-acted
   * tool calls and fabricated results).
   *
   * Edit-critical tools (where param discipline matters most) keep their
   * full XML definitions; everything else renders as a one-line
   * signature. The `## How to Use Tools` protocol envelope is IDENTICAL
   * to the full block — the loop's parsers and detectors key off it.
   */
  buildCompactSystemPromptBlock(fullDefinitionTools: ReadonlySet<string> = DEFAULT_FULL_DEFINITION_TOOLS): string {
    if (this.tools.size === 0) {return '';}

    const all = this.getAll();
    const fullDefs = all
      .filter(tool => fullDefinitionTools.has(tool.name))
      .map(tool => this.renderToolXml(tool));
    const compact = all
      .filter(tool => !fullDefinitionTools.has(tool.name))
      .map(tool => {
        const params = tool.parameters.map(p => {
          const type = p.schema?.type && p.schema.type !== 'string' ? `:${p.schema.type}` : '';
          return `${p.name}${p.required ? '' : '?'}${type}`;
        }).join(', ');
        return `- ${tool.name}(${params}) — ${firstSentence(tool.description)}`;
      });

    return [
      '## Available Tools',
      '',
      'You have access to the following tools to help you complete tasks:',
      '',
      ...fullDefs,
      '',
      'Additional tools — same call protocol. Params marked `?` are optional;',
      '`:object` / `:array` params take JSON values, not strings:',
      '',
      ...compact,
      '',
      ...TOOL_PROTOCOL_LINES
    ].join('\n');
  }

  /** Shared XML rendering for one tool — used by both prompt-block builders. */
  private renderToolXml(tool: AgentTool): string {
    const params = tool.parameters.map(p => {
      // Surface the JSON-Schema-derived type hint inline in the
      // description so the model knows when to emit a nested object
      // or an array instead of a bare string. Without this hint the
      // XML-prompt format describes every param as opaque text,
      // which is what produced the "Expected object, received
      // string" failures on createFilter / modifyMessageLabels.
      const typeHint = formatParamTypeHint(p.schema);
      const desc = typeHint ? `${typeHint} ${p.description}` : p.description;
      return `  <param name="${p.name}"${p.required ? ' required="true"' : ''}>${desc}</param>`;
    }).join('\n');
    return [
      `<tool name="${tool.name}">`,
      `  <description>${tool.description}</description>`,
      params,
      `</tool>`
    ].join('\n');
  }

  /**
   * Builds tool definitions in JSON schema format for models with native tool calling.
   * Compatible with Ollama's `tools: [...]` field.
   *
   * Parameter types: each AgentToolParameter may carry an optional
   * `schema` field that holds JSON-Schema type info. When present we
   * render the full shape (objects with properties, arrays with item
   * types, enums) so the provider tells the model "this param is an
   * object with these fields" instead of the legacy "every param is a
   * string" flattening. Tools without `schema` default to `type: string`
   * — matches every in-tree tool today and keeps the contract for
   * adapter-less consumers.
   */
  buildNativeToolsSchema(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: {
        type: 'object';
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };
    };
  }> {
    return this.getAll().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            tool.parameters.map(p => [p.name, renderParamForNativeSchema(p)])
          ),
          required: tool.parameters.filter(p => p.required).map(p => p.name)
        }
      }
    }));
  }
}

/**
 * Translate an AgentToolParameter to the JSON-Schema-shaped fragment
 * Ollama (and other OpenAI-compatible native-tools providers) want in
 * the `parameters.properties[<name>]` slot. When the param carries a
 * `schema` field, expand it into a real typed declaration; otherwise
 * fall back to the legacy `{ type: "string", description }` shape so
 * existing in-tree tools render identically.
 *
 * Recursive: nested object properties and array item shapes are
 * expanded the same way, so a `createFilter` param with `criteria:
 * { type: object, properties: { from, to, subject, query, ... } }`
 * renders correctly all the way through.
 */
function renderParamForNativeSchema(p: AgentToolParameter): Record<string, unknown> {
  const baseDescription = p.description;
  if (!p.schema) {
    return { type: 'string', description: baseDescription };
  }
  const rendered = renderSchemaFragment(p.schema);
  // Top-level description from the AgentToolParameter wins so the
  // agent sees the rich human-readable description we wrote at the
  // tool definition (which often summarizes the whole param), not
  // a nested per-property blurb.
  rendered.description = baseDescription;
  return rendered;
}

/**
 * Build a short inline hint like "(object: {from, to, subject})" or
 * "(array of string)" that prefixes the param description in the
 * non-native system prompt block. Without a hint the model treats
 * every param as opaque text. With it the model knows which params
 * need JSON-encoded objects/arrays vs bare strings — which is the
 * difference between createFilter working and Google rejecting the
 * request with "Expected object, received string."
 */
/**
 * The tool-call protocol envelope. MUST stay byte-identical between the
 * full and compact prompt blocks — the loop's stream parser, the
 * fabrication detectors, and several eval fixtures key off this text.
 */
const TOOL_PROTOCOL_LINES: readonly string[] = [
  '## How to Use Tools',
  '',
  'To call a tool, respond with ONLY a tool call on its own line:',
  '<tool_call>{"name": "tool_name", "params": {"param1": "value1"}}</tool_call>',
  '',
  'Wait for the tool result before continuing.',
  'When you have all the information needed and are ready to give your final response,',
  'respond normally without any <tool_call> tags.',
];

/**
 * Tools that keep full XML definitions in the compact block — the ones
 * where param discipline (exact-match find strings, line ranges, hashes)
 * is the difference between a clean edit and a corrupted file.
 */
const DEFAULT_FULL_DEFINITION_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'apply_edit',
  'replace_range',
  'write_file',
  'run_command',
  'search_code'
]);

/** First sentence of a tool description, capped so one tool = one line. */
function firstSentence(description: string): string {
  const period = description.indexOf('. ');
  const sentence = period === -1 ? description : description.slice(0, period + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

function formatParamTypeHint(schema: AgentToolParameterSchema | undefined): string {
  if (!schema || !schema.type || schema.type === 'string') {return '';}
  if (schema.type === 'object') {
    const keys = schema.properties ? Object.keys(schema.properties).slice(0, 6) : [];
    const more = schema.properties && Object.keys(schema.properties).length > 6 ? ', …' : '';
    return keys.length > 0
      ? `(object — pass JSON like {"${keys.join('": …, "')}": …}${more})`
      : '(object — pass a JSON object)';
  }
  if (schema.type === 'array') {
    const itemType = schema.items?.type ?? 'value';
    return `(array of ${itemType} — pass JSON like ["..."])`;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return `(${schema.type})`;
  }
  if (schema.type === 'boolean') {
    return '(boolean — true or false)';
  }
  return `(${schema.type})`;
}

function renderSchemaFragment(s: AgentToolParameterSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.type) {out.type = s.type;}
  if (s.description) {out.description = s.description;}
  if (s.enum) {out.enum = s.enum;}
  if (s.type === 'object' && s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, renderSchemaFragment(v)])
    );
    if (s.required && s.required.length > 0) {
      out.required = s.required;
    }
    // Defaulting additionalProperties:false here would be safer but
    // some MCP servers depend on extra fields passing through; leave
    // unset so the provider doesn't reject valid calls.
  } else if (s.type === 'array' && s.items) {
    out.items = renderSchemaFragment(s.items);
  }
  return out;
}
