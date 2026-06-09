/**
 * Skill loader — discovers and loads custom skills from the workspace.
 *
 * Scans `.bandit/skills/` and registers any skills it finds with the
 * SkillRegistry. Two formats are supported:
 *
 *   1. Markdown (`.md`) — preferred. Matches Claude Code's shape. A skill is
 *      a context package: YAML frontmatter for metadata, markdown body for
 *      the prose instructions the agent reads when the skill activates.
 *      No `tools[]` — skills guide the agent on how to use tools it already
 *      has (run_command, git_*, write_file, …). This eliminates the nested
 *      JSON-in-JSON escaping trap that plagued the JSON format.
 *
 *   2. JSON (`.json`) — legacy. Still loads so existing `.bandit/skills/*.json`
 *      keep working, but new authoring should use markdown. Logs a one-time
 *      deprecation note in dev.
 *
 * Markdown layout (both `.bandit/skills/<name>.md` and
 * `.bandit/skills/<name>/SKILL.md` are supported — the folder variant lets
 * users bundle helper scripts next to the skill):
 *
 *     ---
 *     id: github
 *     name: GitHub CLI
 *     description: Use when the user mentions GitHub — PRs, issues, commits
 *     triggers: [gh, github, pr, "pull request"]
 *     ---
 *
 *     When the user asks about GitHub work, use `run_command` with `gh`:
 *
 *     - `gh pr create --title "<t>" --body "<b>"` — open a PR
 *     - `gh pr list` — list open PRs
 *     - `gh issue list` — list issues
 *
 *     Suggest `gh auth status` if commands fail.
 *
 * Frontmatter keys recognized: `id`, `name`, `description`, `version`,
 * `activation` (always|auto|on-demand — defaults to auto), `triggers`
 * (simple substring list — matched case-insensitive against the user
 * message), and `triggerPatterns` (explicit regex list — advanced).
 *
 * Legacy JSON schema (still supported, deprecated for new skills):
 *
 *     {
 *       "id": "custom/my-skill",
 *       "name": "My Custom Skill",
 *       "description": "…",
 *       "activation": "auto",
 *       "triggerPatterns": ["\\bmy-keyword\\b"],
 *       "tools": [
 *         { "name": "my_tool", "description": "…", "command": "node x.js {{arg}}" }
 *       ]
 *     }
 */

import type { SkillManifest } from './skill-types';
import type { AgentTool, ToolResult, ToolExecutionContext } from './tool-types';
import type { SkillRegistry } from './skill-registry';

const SKILLS_DIR = '.bandit/skills';

interface RawToolManifest {
  name: string;
  description: string;
  parameters?: Array<{ name: string; description: string; required?: boolean }>;
  command?: string;
}

interface RawSkillManifest {
  id: string;
  name: string;
  version?: string;
  description: string;
  instructions?: string;
  activation?: 'always' | 'auto' | 'on-demand';
  triggerPatterns?: string[];
  tools: RawToolManifest[];
}

interface MarkdownFrontmatter {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  activation?: 'always' | 'auto' | 'on-demand';
  triggers?: string[];
  triggerPatterns?: string[];
}

export function buildToolFromManifest(raw: RawToolManifest): AgentTool {
  const parameters = (raw.parameters ?? []).map((p) => ({
    name: p.name,
    description: p.description,
    required: p.required ?? false
  }));

  if (raw.command) {
    // Command-based tool — executes a shell command with parameter substitution.
    //
    // Split the template into base + args FIRST, then substitute params into
    // each token individually. The earlier "substitute then split on /\s+/"
    // shape let a param value containing whitespace explode into multiple
    // argv entries — e.g. command="git {{op}}" with op="log; touch /tmp/x"
    // resolved to ['git', 'log;', 'touch', '/tmp/x']. ctx.runCommand passes
    // args straight to spawn() so no shell interpretation occurred, but the
    // injected tokens still reached the binary as extra arguments — and for
    // commands that accept --exec-style flags (find, git, ssh), that's a
    // privilege escalation vector. Per-token substitution keeps each param
    // value as exactly one argv element regardless of its contents.
    const templateParts = raw.command.trim().split(/\s+/);
    return {
      name: raw.name,
      description: raw.description,
      parameters,
      async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
        const substitute = (token: string): string => {
          let out = token;
          for (const [key, value] of Object.entries(params)) {
            out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value ?? '');
          }
          return out;
        };
        const base = substitute(templateParts[0]);
        const args = templateParts.slice(1).map(substitute);

        try {
          const result = await ctx.runCommand(base, args, ctx.workspaceRoot);
          const output = [
            result.stdout.trim(),
            result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : ''
          ].filter(Boolean).join('\n');
          return { output: output || '(no output)', isError: result.exitCode !== 0 };
        } catch (err) {
          return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    };
  }

  // Placeholder tool — no command, just returns a message
  return {
    name: raw.name,
    description: raw.description,
    parameters,
    async execute(): Promise<ToolResult> {
      return { output: `Tool "${raw.name}" has no command configured.`, isError: true };
    }
  };
}

/**
 * Compile activation hints into RegExp[]. Accepts both the simple `triggers`
 * list (substrings, matched case-insensitive with word-boundary sensitivity
 * where possible) and the advanced `triggerPatterns` list (explicit regex).
 * Invalid patterns are dropped with a warning rather than failing the whole
 * load — skills written by the model sometimes produce junk patterns and
 * the whole skill shouldn't vanish because of one.
 */
function compileTriggers(
  simple: string[] | undefined,
  patterns: string[] | undefined,
  filePath: string
): RegExp[] {
  const compiled: RegExp[] = [];

  for (const term of simple ?? []) {
    const trimmed = term.trim();
    if (!trimmed) {continue;}
    // Escape regex metachars in user-supplied substrings, then anchor at
    // word boundaries for single-word terms. Multi-word terms ("pull
    // request") keep internal whitespace flexible via `\s+`.
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const boundary = /\s/.test(trimmed) ? escaped : `\\b${escaped}\\b`;
    try {
      compiled.push(new RegExp(boundary, 'i'));
    } catch {
      console.warn(`[skill-loader] Could not compile trigger "${trimmed}" in ${filePath}`);
    }
  }

  for (const pattern of patterns ?? []) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      console.warn(`[skill-loader] Invalid regex "${pattern}" in ${filePath}`);
    }
  }

  return compiled;
}

function parseSkillManifest(json: string, filePath: string): SkillManifest | null {
  try {
    const raw: RawSkillManifest = JSON.parse(json);

    if (!raw.id || !raw.name || !Array.isArray(raw.tools) || raw.tools.length === 0) {
      console.warn(`[skill-loader] Invalid manifest at ${filePath}: missing id, name, or tools`);
      return null;
    }

    const tools = raw.tools
      .filter((t) => t.name && t.description)
      .map(buildToolFromManifest);

    if (tools.length === 0) {
      console.warn(`[skill-loader] No valid tools in ${filePath}`);
      return null;
    }

    const triggerPatterns = compileTriggers(undefined, raw.triggerPatterns, filePath);

    return {
      id: raw.id,
      name: raw.name,
      version: raw.version ?? '0.0.0',
      description: raw.description,
      instructions: raw.instructions,
      activation: raw.activation ?? 'auto',
      triggerPatterns: triggerPatterns.length > 0 ? triggerPatterns : undefined,
      tools
    };
  } catch (err) {
    console.warn(`[skill-loader] Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Split a markdown skill file into (frontmatter object, body string).
 * The frontmatter block is `---\n…\n---` at the top of the file. If it's
 * missing, treat the entire file as the body and return an empty front-
 * matter object — the caller decides whether that's fatal (it is: a skill
 * needs at minimum an `id`).
 *
 * We parse just enough YAML to cover the supported keys (string scalars,
 * quoted strings, inline `[a, b, "c d"]` arrays, and block-style dash
 * lists). Full YAML is deliberately avoided — it's a heavy dep for a
 * format we control, and richer YAML features would invite new ways for
 * model-authored skills to silently corrupt.
 */
function splitFrontmatter(source: string): { frontmatter: MarkdownFrontmatter; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source.trim() };
  }
  return { frontmatter: parseYamlFrontmatter(match[1]), body: match[2].trim() };
}

function parseYamlFrontmatter(block: string): MarkdownFrontmatter {
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) {continue;}

    // Block-style list item (continuation of the current key).
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentList) {
      currentList.push(stripYamlScalar(listMatch[1]));
      continue;
    }

    // A new top-level `key:` line ends any block list we were building.
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kvMatch) {continue;}

    currentList = null;
    currentKey = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value === '') {
      // Block list follows on subsequent lines.
      const list: string[] = [];
      out[currentKey] = list;
      currentList = list;
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[currentKey] = parseYamlInlineArray(value);
      continue;
    }
    out[currentKey] = stripYamlScalar(value);
  }

  return out as MarkdownFrontmatter;
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // Minimal escape decoding — \" and \\ only. Good enough for the keys
    // we support; anything fancier is a red flag the author should know about.
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseYamlInlineArray(source: string): string[] {
  const inner = source.slice(1, -1).trim();
  if (!inner) {return [];}
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && i + 1 < inner.length) {
        buf += inner[++i];
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      const trimmed = buf.trim();
      if (trimmed) {out.push(trimmed);}
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) {out.push(tail);}
  return out;
}

function parseMarkdownSkill(source: string, filePath: string): SkillManifest | null {
  const { frontmatter, body } = splitFrontmatter(source);

  if (!frontmatter.id || !frontmatter.name) {
    console.warn(`[skill-loader] Markdown skill ${filePath} missing id or name in frontmatter — skipping`);
    return null;
  }

  const triggerPatterns = compileTriggers(frontmatter.triggers, frontmatter.triggerPatterns, filePath);
  const activation = frontmatter.activation ?? 'auto';

  // 'auto' activation with no triggers would silently never fire. Catch
  // that at load time rather than leaving the author confused later.
  if (activation === 'auto' && triggerPatterns.length === 0) {
    console.warn(`[skill-loader] ${filePath}: activation=auto but no triggers — skill will never auto-activate`);
  }

  return {
    id: frontmatter.id,
    name: frontmatter.name,
    version: frontmatter.version ?? '0.0.0',
    description: frontmatter.description ?? body.split('\n', 1)[0] ?? frontmatter.name,
    instructions: body || undefined,
    activation,
    triggerPatterns: triggerPatterns.length > 0 ? triggerPatterns : undefined,
    tools: []
  };
}

/**
 * Load custom skills from `.bandit/skills/` in the workspace.
 *
 * Discovers markdown skills first (preferred), then JSON skills (legacy).
 * When a JSON skill has the same id as a markdown one already loaded, the
 * markdown version wins and the JSON one is skipped — that's the migration
 * path: drop a `.md` next to the old `.json` and the new format takes over.
 *
 * @param listFiles     lists files matching a glob pattern relative to cwd
 * @param readFile      reads a file's text content at an absolute path
 * @param workspaceRoot absolute workspace root
 */
export async function loadWorkspaceSkills(
  listFiles: (pattern: string, cwd?: string) => Promise<string[]>,
  readFile: (path: string) => Promise<string>,
  workspaceRoot: string
): Promise<SkillManifest[]> {
  const skills: SkillManifest[] = [];
  const loadedIds = new Set<string>();

  const tryLoad = async (file: string, parse: (text: string, path: string) => SkillManifest | null) => {
    try {
      // Cross-platform absolute-path detection: POSIX `/`, tilde,
      // Windows drive (`C:\`), or UNC (`\\srv\share`). Without the
      // Windows checks, an absolute path like `C:\Users\…\skill.json`
      // gets concatenated onto workspaceRoot.
      const absPath =
        file.startsWith('/') ||
        file.startsWith('~') ||
        /^[A-Za-z]:[\\/]/.test(file) ||
        file.startsWith('\\\\')
          ? file
          : `${workspaceRoot}/${file}`;
      const content = await readFile(absPath);
      const skill = parse(content, file);
      if (!skill) {return;}
      if (loadedIds.has(skill.id)) {
        console.warn(`[skill-loader] Duplicate skill id "${skill.id}" in ${file} — ignoring (already loaded)`);
        return;
      }
      loadedIds.add(skill.id);
      skills.push(skill);
    } catch {
      // Unreadable file — silent skip, same as the JSON-era behavior.
    }
  };

  // Markdown first — new format wins when ids collide.
  try {
    const mdFiles = await listFiles(`${SKILLS_DIR}/*.md`, workspaceRoot);
    const nestedMd = await listFiles(`${SKILLS_DIR}/*/SKILL.md`, workspaceRoot);
    for (const file of [...mdFiles, ...nestedMd]) {
      await tryLoad(file, parseMarkdownSkill);
    }
  } catch {
    // No markdown skills — fine.
  }

  try {
    const jsonFiles = await listFiles(`${SKILLS_DIR}/*.json`, workspaceRoot);
    for (const file of jsonFiles) {
      await tryLoad(file, parseSkillManifest);
    }
  } catch {
    // No json skills either — also fine.
  }

  return skills;
}

/**
 * Load workspace skills and register them with the given registry.
 */
export async function registerWorkspaceSkills(
  registry: SkillRegistry,
  listFiles: (pattern: string, cwd?: string) => Promise<string[]>,
  readFile: (path: string) => Promise<string>,
  workspaceRoot: string
): Promise<number> {
  const skills = await loadWorkspaceSkills(listFiles, readFile, workspaceRoot);
  for (const skill of skills) {
    registry.register(skill);
  }
  return skills.length;
}

/**
 * A ready-to-save markdown skill scaffold. Used by the CLI's `/skill new`
 * slash command so users (and the agent) never have to hand-write the YAML
 * frontmatter from scratch. Kept here so there's one canonical template
 * and it can't drift from what the parser expects.
 */
export function scaffoldMarkdownSkill(id: string, displayName?: string): string {
  const safeId = id.trim() || 'my-skill';
  const name = (displayName ?? safeId).trim();
  return [
    '---',
    `id: ${safeId}`,
    `name: ${name}`,
    `description: One line explaining WHEN the agent should reach for this skill.`,
    `activation: auto`,
    `triggers: [${safeId}]`,
    '---',
    '',
    `# ${name}`,
    '',
    'Describe the playbook the agent should follow when this skill activates.',
    'Prefer prose + fenced examples over rigid schemas — the body is fed straight',
    'into the system prompt when a trigger matches.',
    '',
    '- When the user asks …, run `…`',
    '- If … fails, suggest `…`',
    ''
  ].join('\n');
}
