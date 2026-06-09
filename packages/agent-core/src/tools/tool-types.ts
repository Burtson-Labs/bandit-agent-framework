/**
 * Core types for the Bandit agent tool system.
 *
 * ToolExecutionContext is a host-provided interface — it must be implemented
 * by the VS Code extension, web host, or test harness. The tools themselves
 * have no direct dependency on Node.js APIs or VS Code.
 */

export interface ToolResult {
  output: string;
  /** True when the tool encountered an error (output contains the error message). */
  isError?: boolean;
}

/**
 * Host-provided execution environment for tools.
 * All paths passed to these methods are absolute.
 */
export interface ToolExecutionContext {
  /** Absolute path to the workspace/repo root. */
  workspaceRoot: string;
  /** Read the full text content of a file. */
  readFile(absolutePath: string): Promise<string>;
  /** Write (create or overwrite) a file. */
  writeFile(absolutePath: string, content: string): Promise<void>;
  /**
   * Permanently remove a file from disk. Optional — hosts that don't
   * implement it cause `apply_patch` delete actions to fall back to
   * blanking the file (`writeFile('')`) and emit a clear warning so
   * the model knows a hard delete didn't happen.
   *
   * Why optional: there was no way to actually remove a
   * file via the tool surface — `apply_patch` `kind: 'delete'` quietly
   * left a 0-byte file behind. Adding a real primitive here without
   * forcing every host (CLI, extension, future web host) to implement
   * it on the same release lets the upgrade ride out gradually.
   * Implementations should resolve relative paths against `workspaceRoot`
   * and reject paths outside the workspace.
   */
  deleteFile?(absolutePath: string): Promise<void>;
  /**
   * List files matching a glob pattern.
   * @param pattern Glob relative to cwd (e.g. "src/**\/*.ts")
   * @param cwd Absolute directory to resolve the pattern from (default: workspaceRoot)
   */
  listFiles(pattern: string, cwd?: string): Promise<string[]>;
  /**
   * List direct children (files AND directories, non-recursive) of a
   * directory. Separate from listFiles because listFiles is glob-based
   * and file-only — it can't see subdirectories, only recurses into
   * them. Used by the `ls` tool so "what's in ~/Desktop" returns both
   * files and folders at that level. Hosts that don't implement it
   * fall back to listFiles('*'), which misses folders entirely —
   * when the CLI couldn't find "client engament
   * drafts" on the user's Desktop because it's a directory.
   *
   * Entries end with `/` if the entry is a directory so the caller can
   * distinguish without a follow-up stat. Symlinks are included and
   * resolved against the target type.
   */
  listDirectoryEntries?(cwd: string): Promise<string[]>;
  /**
   * Search file contents for a regex pattern.
   * Returns a human-readable matches string (path:line: content).
   * @param pattern Regex or literal string to search for
   * @param cwd Directory to search in (default: workspaceRoot)
   * @param fileGlob Optional file filter, e.g. "*.ts"
   */
  searchCode(pattern: string, cwd?: string, fileGlob?: string): Promise<string>;
  /** Run a shell command and capture stdout/stderr. */
  runCommand(
    cmd: string,
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Spawn a process and capture its output for `durationMs`, then send
   * SIGTERM if it's still running. Used by the `watch_command` tool so
   * the agent can run a long-lived process (dev server, --watch test
   * runner, log tail) for a bounded window and react to what came out.
   * Distinct from runCommand — runCommand expects the process to exit
   * on its own; watchCommand assumes it might not.
   *
   * Optional. Hosts that don't implement it cause watch_command to
   * gracefully fall back to runCommand with a note in the result.
   */
  watchCommand?(
    cmd: string,
    args: string[],
    cwd: string | undefined,
    durationMs: number
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    /** True when the process exited on its own before the timer ran out. */
    endedEarly: boolean;
  }>;
  /** Optional pre-write language validation. When present, write_file validates before touching disk. */
  languageAdapters?: ILanguageAdapterRegistry;
  /**
   * Read-before-edit tracking. When present, read_file calls
   * `markFileRead(path)` after a successful read; apply_edit,
   * replace_range, and write_file (overwriting) call `hasFileBeenRead(path)` and reject
   * with a clear error if the model is editing blind. Prevents the
   * "model writes without reading first" failure mode where it
   * fabricates content or breaks indentation it never inspected.
   * Hosts that don't implement these methods skip the check (the
   * tools fall through to current behavior).
   */
  markFileRead?(absolutePath: string): void;
  hasFileBeenRead?(absolutePath: string): boolean;
  /** User-configured extra locations the `find_directory` tool should
   * scan in addition to the built-in clone parents (`~/Documents/GitHub`,
   * `~/Projects`, `~/code`, …). Hosts populate this from their config
   * surface (CLI: `repos.roots` in `~/.bandit/config.json`; extension:
   * `banditStealth.repos.roots` workspace setting). Tilde-prefixed
   * paths are expected — hosts that resolve them in `listDirectoryEntries`
   * can leave them as-is. */
  customRepoRoots?: string[];
  /**
   * Ask the user one or more clarifying questions mid-task and await their
   * answer(s). Optional — hosts that can render an interactive prompt (the
   * CLI's ink form, the extension's webview card) implement it. The
   * `ask_user` tool is only offered to the model when a host provides this
   * (and degrades to "ask in plain text" when it's absent), so a host with
   * no interactive surface never strands the model on a question it can't
   * answer. Implementations should resolve with the user's answers keyed by
   * question id, or `{ answers: {}, cancelled: true }` if dismissed.
   */
  requestUserInput?(request: UserInputRequest): Promise<UserInputResponse>;
}

/** One question posed to the user by the `ask_user` tool. */
export interface UserInputQuestion {
  /** Stable key the answer is returned under. */
  id: string;
  /** The question text shown to the user. */
  question: string;
  /** Short tab label (≈≤12 chars) shown when there are multiple questions. */
  header?: string;
  /** Suggested answers the user can pick from. */
  options?: Array<{ label: string; description?: string }>;
  /** Whether the user may type a free-text answer instead of (or in
   *  addition to) picking an option. Defaults to true. */
  allowFreeform?: boolean;
}

export interface UserInputRequest {
  questions: UserInputQuestion[];
}

export interface UserInputResponse {
  /** Map of question id → the user's answer. Skipped questions are omitted. */
  answers: Record<string, string>;
  /** True when the user dismissed the prompt without answering. */
  cancelled?: boolean;
}

/**
 * Optional JSON-Schema fragment describing the shape of an
 * AgentToolParameter. Native (in-tree) tools historically declared
 * every param as `type: string` because Bandit's tool-use loop hands
 * arguments to `execute()` as `Record<string, string>` — fine for the
 * read_file / apply_edit / run_command surface where all args are
 * stringy. But MCP-bridged tools (Gmail filters, structured forms,
 * batched operations) often need `object` or `array<string>` params
 * to round-trip correctly: without a type hint, the model gets told
 * every param is a string and emits strings, which the MCP server's
 * zod validators reject with "expected object, received string."
 *
 * Adapters populate this field from the source schema (MCP's
 * inputSchema, OpenAPI parameter type, etc.) and the registry plumbs
 * it through to (a) the native-tools schema sent to providers that
 * support function calling natively (Ollama, OpenAI, etc.), and (b)
 * the system-prompt block rendered for providers that don't.
 *
 * Kept intentionally narrow — only the fields that materially change
 * how the model serializes a value. Nested object properties /
 * array item shapes / enums all matter; default values and exotic
 * constraint keywords (multipleOf, etc.) don't.
 */
export interface AgentToolParameterSchema {
  /** JSON Schema "type" keyword: "object", "array", "string", "number",
   *  "boolean", "integer", or "null". Omitting it (or passing "string")
   *  preserves the legacy behavior. */
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  /** When type === "object": fields and their schemas. */
  properties?: Record<string, AgentToolParameterSchema & { description?: string }>;
  /** When type === "object": required field names. */
  required?: string[];
  /** When type === "array": item shape. */
  items?: AgentToolParameterSchema & { description?: string };
  /** Enum constraint — surfaces as a fixed-choice param when present. */
  enum?: Array<string | number | boolean>;
  /** Free-form description embedded in nested-property schemas. */
  description?: string;
}

export interface AgentToolParameter {
  name: string;
  description: string;
  required?: boolean;
  /** Optional JSON-Schema-shaped type info. When omitted the param is
   *  treated as a string (the legacy default) — matches every in-tree
   *  tool today. Populated by adapter layers (e.g. the MCP→AgentTool
   *  bridge) when the source defines a richer shape. */
  schema?: AgentToolParameterSchema;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: AgentToolParameter[];
  execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * A chat message as seen by the tool use loop.
 * Intentionally minimal — adapters convert to/from provider-specific formats.
 */
export interface ToolLoopMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * JSON-Schema-shaped tool definition used by Ollama's native tool-calling
 * `tools: [...]` field. Matches what `ToolRegistry.buildNativeToolsSchema()`
 * returns and what Ollama's OpenAPI contract expects. Declared here
 * (rather than imported from stealth-core-runtime) so agent-core stays
 * host-agnostic.
 */
export interface NativeToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      // Each property is a JSON Schema fragment. The minimal shape is
      // `{ type: "string", description }` (legacy default), but rich
      // params can carry full nested `type: "object"` with properties
      // / required / items / enum etc — needed for MCP-bridged tools
      // whose backends actually validate object/array shapes. Typed
      // loose-ly (Record<string, unknown>) so the registry's renderer
      // can emit either shape without a type narrowing dance at every
      // call site.
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
  };
}

/**
 * Per-call chat options. Optional bag the loop may pass for specific
 * iterations — the chat function should treat it as a soft override of
 * its closure-captured defaults, NOT a permanent change.
 */
export interface ChatCallOptions {
  /**
   * Per-call override for thinking mode. The loop sets `false` on the
   * "thinking-off recovery" attempt — when reasoning-only retries have
   * exhausted, we make ONE final attempt with thinking forced off so
   * the model is collapsed into the regular content channel where its
   * tool-call sampling is more deterministic. with
   * qwen3.6:27b on a remote Ollama: with thinking ON, the model would
   * sometimes get stuck emitting reasoning-only responses; flipping
   * thinking off on retry consistently produced a real tool call.
   */
  think?: boolean;
}

/**
 * Chat function signature accepted by ToolUseLoop.
 * Returns an async iterable of text chunks (streaming). When `tools` is
 * populated, the provider is expected to forward those schemas to
 * Ollama's native `tools` field — any tool-call intents the model emits
 * come back as structured data which the provider should translate back
 * into inline `<tool_call>{...}</tool_call>` markup in the yielded text
 * stream so the loop's existing parser keeps working. The optional
 * `options` bag supports per-call overrides (see ChatCallOptions).
 */
export type ChatFn = (
  messages: ToolLoopMessage[],
  tools?: NativeToolSchema[],
  options?: ChatCallOptions
) => AsyncIterable<string>;

/** Result of a language adapter validation. */
export interface ValidationResult {
  ok: boolean;
  /** Human-readable error for the model to self-correct. Only set when ok is false. */
  error?: string;
}

/**
 * Minimal contract for a language adapter registry.
 * Implemented by LanguageAdapterRegistry in language-adapters.ts.
 * Declared here to allow ToolExecutionContext to reference it without a circular import.
 */
export interface ILanguageAdapterRegistry {
  validate(filePath: string, content: string, ctx: ToolExecutionContext): Promise<ValidationResult>;
}
