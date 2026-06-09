/**
 * No-LLM smoke test for the CLI pieces that don't require a model:
 *   - session persistence (init / append / replace / resume)
 *   - memory auto-load
 *   - mention expansion
 *   - slash command parsing
 *   - hook settings parsing
 *
 * Run with: `npm run smoke` (see package.json).
 * Exits 0 on success, non-zero + stderr on failure.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionStore } from '../session';
import { CliToolExecutionContext } from '../cliToolContext';
import {
  loadMemory,
  expandMentions,
  loadHookSettings,
  TodoStore,
  buildTaskTool,
  evaluatePermission,
  mergePolicies,
  emptyPolicy,
  SessionPermissionStore
} from '@burtson-labs/host-kit';
import {
  ToolRegistry,
  loadWorkspaceSkills,
  scaffoldMarkdownSkill,
  applyEditTool,
  gitStatusTool,
  type ToolExecutionContext
} from '@burtson-labs/agent-core';
import { findSlashCommand, slashCommands, type SlashContext } from '../slashCommands';
import { loadConfigFiles, resolveConfig, describeConfig } from '../config';

async function main(): Promise<void> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bandit-cli-smoke-'));
  const oldHome = process.env.HOME;
  process.env.HOME = tmp; // redirect ~/.bandit/sessions into tmp

  try {
    const failures: string[] = [];

    // 1. Session persistence
    const store = new SessionStore();
    await store.init();
    const id = await store.startNew();
    assert(failures, id.length > 0, 'session id should be non-empty');
    await store.append([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
    const readBack = await store.readConversation();
    assert(failures, readBack.length === 2, `expected 2 messages, got ${readBack.length}`);
    assert(failures, readBack[0].role === 'user' && readBack[0].content === 'hello', 'first message round-trip');

    const freshStore = new SessionStore();
    const ok = await freshStore.resume(id);
    assert(failures, ok, 'resume should find prior session');
    const listed = await freshStore.list();
    assert(failures, listed.includes(id), 'list should include new id');

    // 2. Memory auto-load
    const memProject = await fs.promises.mkdtemp(path.join(tmp, 'proj-'));
    await fs.promises.writeFile(path.join(memProject, 'BANDIT.md'), '# Memory\n- Rule A\n');
    await fs.promises.writeFile(path.join(memProject, 'AGENTS.md'), '# Agents memory\n- Rule B\n');
    const memory = await loadMemory(memProject);
    assert(failures, memory.sources.includes('BANDIT.md'), 'BANDIT.md should be picked up');
    assert(failures, memory.sources.includes('AGENTS.md'), 'AGENTS.md should be picked up');
    assert(failures, memory.content.includes('Rule A'), 'memory content should include BANDIT body');
    assert(failures, memory.content.includes('Rule B'), 'memory content should include AGENTS body');

    const emptyProject = await fs.promises.mkdtemp(path.join(tmp, 'empty-'));
    const emptyMem = await loadMemory(emptyProject);
    assert(failures, emptyMem.sources.length === 0, 'empty project should have no memory sources');

    // 3. Mentions
    await fs.promises.writeFile(path.join(memProject, 'hello.txt'), 'hello world');
    const expanded = await expandMentions('look at @hello.txt please', memProject);
    assert(failures, expanded.mentions.length === 1 && expanded.mentions[0].ok, 'mention should resolve');
    assert(failures, expanded.prompt.includes('hello world'), 'prompt should contain file body');

    const bogus = await expandMentions('ignore @does-not-exist', memProject);
    assert(failures, bogus.mentions.length === 1 && !bogus.mentions[0].ok, 'missing mention should be marked !ok');

    // 4. Slash commands
    assert(failures, findSlashCommand('/help')?.cmd.name === 'help', '/help resolves');
    assert(failures, findSlashCommand('/model gpt-oss')?.args === 'gpt-oss', '/model args parsed');
    assert(failures, findSlashCommand('/trace list')?.cmd.name === 'trace', '/trace resolves');
    assert(failures, findSlashCommand('/profile qwen3.6')?.args === 'qwen3.6', '/profile args parsed');
    assert(failures, findSlashCommand('hello world') === null, 'non-slash line returns null');
    assert(failures, slashCommands.every(c => typeof c.run === 'function'), 'every slash command has a run fn');

    const traceProject = await fs.promises.mkdtemp(path.join(tmp, 'trace-'));
    await fs.promises.mkdir(path.join(traceProject, '.bandit', 'turns'), { recursive: true });
    await fs.promises.writeFile(path.join(traceProject, '.bandit', 'turns', 'turn-2026-05-24T17-00-00-000Z-smoke.jsonl'), [
      '{"t":"2026-05-24T17:00:00.000Z","type":"user-prompt","prompt":"inspect smoke trace"}',
      '{"t":"2026-05-24T17:00:01.000Z","type":"tool-execute","name":"read_file","iteration":0}',
      '{"t":"2026-05-24T17:00:02.000Z","type":"final-response","iterations":1,"finalPreview":"done"}'
    ].join('\n'));
    const slashCtx = {
      cwd: traceProject,
      model: { current: 'bandit-logic', set: () => undefined },
      notifications: {
        get: () => ({ desktop: false, sound: false, minTurnMs: 30000 }),
        set: () => undefined
      }
    } as unknown as SlashContext;
    const traceOut = await findSlashCommand('/trace list')?.cmd.run('list', slashCtx);
    assert(failures, String(traceOut).includes('turn-2026-05-24T17-00-00-000Z-smoke'), '/trace list renders turn id');
    const profileOut = await findSlashCommand('/profile')?.cmd.run('', slashCtx);
    assert(failures, String(profileOut).includes('Model behavior profile'), '/profile renders active model profile');
    const notifyOut = await findSlashCommand('/notify')?.cmd.run('status', slashCtx);
    assert(failures, String(notifyOut).includes('CLI notifications'), '/notify status renders notification state');

    // 5. Hooks settings
    const hookProject = await fs.promises.mkdtemp(path.join(tmp, 'hooks-'));
    await fs.promises.mkdir(path.join(hookProject, '.bandit'), { recursive: true });
    await fs.promises.writeFile(
      path.join(hookProject, '.bandit/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ match: 'run_command', command: 'true' }] } })
    );
    const hooks = await loadHookSettings(hookProject);
    assert(failures, (hooks.hooks?.PreToolUse ?? []).length === 1, 'hook settings round-trip');
    assert(failures, hooks.hooks?.PreToolUse?.[0].match === 'run_command', 'hook match survived parse');

    // 6. TodoStore
    const todos = new TodoStore();
    todos.upsert('first task');
    todos.upsert('[{"content":"second","status":"in_progress"}]');
    const snapshot = todos.snapshot();
    assert(failures, snapshot.length === 1 && snapshot[0].content === 'second', 'JSON array replaces todos');
    assert(failures, snapshot[0].status === 'in_progress', 'status parsed');

    // 7. Task tool — construction, param validation, recursion block (all without LLM)
    const parentRegistry = new ToolRegistry();
    const fakeChat = async function* () { yield 'never called'; };
    const taskTool = buildTaskTool({
      chat: fakeChat,
      parentRegistry,
      ctx: { workspaceRoot: tmp, readFile: async () => '', writeFile: async () => {}, listFiles: async () => [], searchCode: async () => '', runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }
    });
    assert(failures, taskTool.name === 'task', 'task tool has expected name');
    assert(failures, taskTool.parameters.some(p => p.name === 'goal' && p.required), 'goal param is required');

    const missingGoal = await taskTool.execute({}, { workspaceRoot: tmp } as never);
    assert(failures, missingGoal.isError === true, 'missing goal returns error');
    assert(failures, missingGoal.output.includes('goal parameter is required'), 'error message mentions goal');

    parentRegistry.register(taskTool);
    assert(failures, parentRegistry.get('task') !== undefined, 'task is registered in parent registry');

    // 8. Permission policy — evaluator, defaults, session grants, merge semantics.
    assert(failures, evaluatePermission('read_file', 'src/x.ts', emptyPolicy()) === 'allow', 'read_file defaults to allow');
    assert(failures, evaluatePermission('write_file', 'src/x.ts', emptyPolicy()) === 'ask', 'write_file defaults to ask');
    assert(failures, evaluatePermission('replace_range', 'src/x.ts', emptyPolicy()) === 'ask', 'replace_range defaults to ask');
    assert(failures, evaluatePermission('run_command', 'rm -rf /', emptyPolicy()) === 'ask', 'run_command defaults to ask');

    const policyWithDeny = { allow: ['run_command'], deny: ['run_command:rm *'], ask: [] };
    assert(failures, evaluatePermission('run_command', 'rm -rf /', policyWithDeny) === 'deny', 'deny wins over allow');
    assert(failures, evaluatePermission('run_command', 'npm test', policyWithDeny) === 'allow', 'allow matches when deny does not');

    const globPolicy = { allow: ['write_file:docs/**'], deny: [], ask: [] };
    assert(failures, evaluatePermission('write_file', 'docs/readme.md', globPolicy) === 'allow', 'glob pattern matches nested path');
    assert(failures, evaluatePermission('write_file', 'src/foo.ts', globPolicy) === 'ask', 'glob pattern rejects non-matching path');

    const permStore = new SessionPermissionStore();
    permStore.grant('write_file', 'src/foo.ts');
    const merged = mergePolicies(emptyPolicy(), permStore.toPolicy());
    assert(failures, evaluatePermission('write_file', 'src/foo.ts', merged) === 'allow', 'session grant flips ask to allow');
    assert(failures, evaluatePermission('write_file', 'src/bar.ts', merged) === 'ask', 'session grant is primary-specific');
    permStore.clear();
    assert(failures, permStore.size() === 0, 'session permission store clears');

    // 9. Config resolver — workspace config, precedence, headers round-trip.
    const cfgProject = await fs.promises.mkdtemp(path.join(tmp, 'cfg-'));
    await fs.promises.mkdir(path.join(cfgProject, '.bandit'), { recursive: true });
    await fs.promises.writeFile(
      path.join(cfgProject, '.bandit/config.json'),
      JSON.stringify({
        provider: 'ollama',
        model: 'gemma4:e4b',
        ollama: {
          url: 'https://ollama.example.com',
          headers: { Authorization: 'Bearer testtoken', 'X-Team': 'core' }
        }
      })
    );
    const loaded = await loadConfigFiles(cfgProject);
    assert(failures, loaded.model === 'gemma4:e4b', 'workspace config model loaded');
    assert(failures, loaded.ollama?.url === 'https://ollama.example.com', 'workspace ollama url loaded');
    assert(failures, loaded.ollama?.headers?.Authorization === 'Bearer testtoken', 'custom header round-trips');

    const resolvedCfg = resolveConfig(loaded, {});
    assert(failures, resolvedCfg.model === 'gemma4:e4b', 'resolver respects file model');
    assert(failures, resolvedCfg.ollamaHeaders['X-Team'] === 'core', 'resolver exposes headers map');

    const overridden = resolveConfig(loaded, { model: 'gemma4:26b' });
    assert(failures, overridden.model === 'gemma4:26b', 'CLI flag overrides file config');

    const described = describeConfig(resolvedCfg);
    assert(failures, !described.includes('testtoken'), 'describeConfig redacts header values');
    assert(failures, described.includes('Authorization, X-Team'), 'describeConfig lists header names');

    // 10. Skill loader — markdown format with YAML frontmatter, legacy JSON,
    //     folder-style SKILL.md, trigger compilation, dedupe by id.
    const skillRoot = await fs.promises.mkdtemp(path.join(tmp, 'skills-'));
    const skillsDir = path.join(skillRoot, '.bandit', 'skills');
    await fs.promises.mkdir(skillsDir, { recursive: true });

    const scaffold = scaffoldMarkdownSkill('github', 'GitHub CLI');
    assert(failures, scaffold.startsWith('---\n'), 'scaffold starts with frontmatter');
    assert(failures, scaffold.includes('id: github'), 'scaffold sets id');
    assert(failures, scaffold.includes('triggers: [github]'), 'scaffold seeds trigger');

    // Markdown skill — note the unescaped quotes inside code-block fences.
    // This is exactly the content the model could never produce reliably
    // in JSON format. In markdown it's just text.
    await fs.promises.writeFile(path.join(skillsDir, 'github.md'), [
      '---',
      'id: github',
      'name: GitHub CLI',
      'description: Use when the user mentions GitHub work',
      'activation: auto',
      'triggers: [gh, github, "pull request"]',
      '---',
      '',
      '# GitHub CLI',
      '',
      'Use `gh pr create --title "<t>" --body "<b>"` to open a PR.'
    ].join('\n'), 'utf8');

    // Folder-style skill.
    await fs.promises.mkdir(path.join(skillsDir, 'deploy'), { recursive: true });
    await fs.promises.writeFile(path.join(skillsDir, 'deploy', 'SKILL.md'), [
      '---',
      'id: deploy',
      'name: Deploy Playbook',
      'description: Guidance for ship-days',
      'activation: always',
      '---',
      'Run the deploy script and watch the latency graph for 10 minutes.'
    ].join('\n'), 'utf8');

    // Legacy JSON skill (back-compat).
    await fs.promises.writeFile(path.join(skillsDir, 'legacy.json'), JSON.stringify({
      id: 'legacy',
      name: 'Legacy Skill',
      description: 'Old JSON format still loads',
      activation: 'auto',
      triggerPatterns: ['\\blegacy\\b'],
      tools: [
        { name: 'legacy_tool', description: 'Does a legacy thing', command: 'echo legacy' }
      ]
    }), 'utf8');

    // JSON skill that collides with github.md — markdown must win.
    await fs.promises.writeFile(path.join(skillsDir, 'github.json'), JSON.stringify({
      id: 'github',
      name: 'SHOULD NOT APPEAR',
      description: 'JSON fallback — should be skipped',
      tools: [{ name: 'bogus', description: 'ignored', command: 'false' }]
    }), 'utf8');

    const loadedSkills = await loadWorkspaceSkills(
      async (pattern: string, cwd?: string) => {
        const root = cwd ?? skillRoot;
        // Minimal glob just for the smoke test — enough to cover the
        // patterns the loader actually uses.
        const match = pattern.match(/^(.*?)\/(\*|\*\.md|\*\.json|\*\/SKILL\.md)$/);
        if (!match) return [];
        const [, relDir, leaf] = match;
        const absDir = path.join(root, relDir);
        try {
          if (leaf === '*/SKILL.md') {
            const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
            const results: string[] = [];
            for (const e of entries) {
              if (e.isDirectory()) {
                const candidate = path.join(relDir, e.name, 'SKILL.md');
                try {
                  await fs.promises.access(path.join(root, candidate));
                  results.push(candidate);
                } catch { /* not every dir has a SKILL.md */ }
              }
            }
            return results;
          }
          const entries = await fs.promises.readdir(absDir);
          const ext = leaf.replace('*', '');
          return entries.filter(n => n.endsWith(ext)).map(n => path.join(relDir, n));
        } catch {
          return [];
        }
      },
      (abs: string) => fs.promises.readFile(abs, 'utf8'),
      skillRoot
    );

    const byId = new Map(loadedSkills.map(s => [s.id, s]));
    assert(failures, byId.size === 3, `expected 3 skills loaded, got ${byId.size}`);
    assert(failures, byId.get('github')?.name === 'GitHub CLI', 'markdown skill wins over legacy JSON on id collision');
    assert(failures, byId.get('deploy')?.activation === 'always', 'folder-style SKILL.md loads');
    assert(failures, byId.get('legacy')?.tools.length === 1, 'legacy JSON still loads its tools');

    const gh = byId.get('github')!;
    const ghTriggers = gh.triggerPatterns ?? [];
    assert(failures, ghTriggers.some(p => p.test('check github status')), 'markdown trigger matches word');
    assert(failures, ghTriggers.some(p => p.test('open a pull request')), 'multi-word trigger matches');
    assert(failures, !ghTriggers.some(p => p.test('ghost writing')), 'word-boundary prevents false positive on "gh"');
    assert(failures, gh.tools.length === 0, 'markdown skill has no tools (guidance only)');
    assert(failures, (gh.instructions ?? '').includes('gh pr create'), 'markdown body is preserved as instructions');

    // 11. apply_edit — unique-match, ambiguous-match rejection, replace_all,
    //     and graceful failure when `find` is absent.
    const editRoot = await fs.promises.mkdtemp(path.join(tmp, 'edit-'));
    const targetFile = path.join(editRoot, 'sample.ts');
    const initial = [
      'export function greet(name: string): string {',
      '  // TODO',
      '  return `hello, ${name}`;',
      '}',
      '',
      'export function greetLoudly(name: string): string {',
      '  // TODO',
      '  return `HELLO, ${name}`;',
      '}'
    ].join('\n');
    await fs.promises.writeFile(targetFile, initial, 'utf8');

    const editCtx: ToolExecutionContext = {
      workspaceRoot: editRoot,
      readFile: (p: string) => fs.promises.readFile(p, 'utf8'),
      writeFile: (p: string, c: string) => fs.promises.writeFile(p, c, 'utf8').then(() => undefined),
      listFiles: async () => [],
      searchCode: async () => '',
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 })
    };

    // Unique-match replacement that turns the top function's body comment
    // into a real one. This is the canonical "small change" apply_edit targets.
    const editOne = await applyEditTool.execute(
      { path: 'sample.ts', find: '  return `hello, ${name}`;', replace: '  return `Hello, ${name}!`;' },
      editCtx
    );
    assert(failures, !editOne.isError, `apply_edit unique match should succeed: ${editOne.output}`);
    const afterOne = await fs.promises.readFile(targetFile, 'utf8');
    assert(failures, afterOne.includes('return `Hello, ${name}!`;'), 'edit landed on disk');
    assert(failures, afterOne.includes('return `HELLO, ${name}`;'), 'other function left untouched');

    // Ambiguous match without replace_all must refuse rather than pick one.
    const editAmbiguous = await applyEditTool.execute(
      { path: 'sample.ts', find: '  // TODO', replace: '  // done' },
      editCtx
    );
    assert(failures, editAmbiguous.isError === true, 'ambiguous match should be rejected');
    assert(failures, /matches 2 places/.test(editAmbiguous.output), 'error message reports occurrence count');

    // replace_all must replace every copy.
    const editAll = await applyEditTool.execute(
      { path: 'sample.ts', find: '  // TODO', replace: '  // done', replace_all: 'true' },
      editCtx
    );
    assert(failures, !editAll.isError, `replace_all should succeed: ${editAll.output}`);
    const afterAll = await fs.promises.readFile(targetFile, 'utf8');
    assert(failures, !afterAll.includes('// TODO'), 'all TODOs replaced');
    assert(failures, /2 occurrences/.test(editAll.output), 'result message reports 2 occurrences');

    // find-not-found must leave the file alone and point at the next step.
    const editMiss = await applyEditTool.execute(
      { path: 'sample.ts', find: 'this string is not present', replace: 'whatever' },
      editCtx
    );
    assert(failures, editMiss.isError === true, 'missing find should be rejected');
    assert(failures, /not found/.test(editMiss.output), 'error names the failure mode');

    // 12. git_status repo_path — runs git in an override cwd when provided,
    //     rather than the workspace root the tool context was built with.
    const altRepo = await fs.promises.mkdtemp(path.join(tmp, 'altrepo-'));
    let lastCwd = '';
    const gitCtx: ToolExecutionContext = {
      workspaceRoot: editRoot,                  // NOT the repo we care about
      readFile: async () => '',
      writeFile: async () => {},
      listFiles: async () => [],
      searchCode: async () => '',
      runCommand: async (_cmd, _args, cwd) => {
        lastCwd = cwd ?? '';
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    };

    await gitStatusTool.execute({}, gitCtx);
    assert(failures, lastCwd === editRoot, `without repo_path git runs in workspace root (got ${lastCwd})`);

    await gitStatusTool.execute({ repo_path: altRepo }, gitCtx);
    assert(failures, lastCwd === altRepo, `with absolute repo_path git runs in that repo (got ${lastCwd})`);

    await gitStatusTool.execute({ repo_path: 'nested-project' }, gitCtx);
    assert(failures, lastCwd === `${editRoot}/nested-project`, `relative repo_path is anchored to workspace (got ${lastCwd})`);

    // 13. runCommand handles platform-specific binary resolution. The
    //     bug we're guarding against: on Windows, npm-shipped tools
    //     are `.cmd` shims (`npm.cmd`, `npx.cmd`) which `cp.spawn(...,
    //     { shell: false })` can't resolve. CliToolExecutionContext now
    //     sets `shell: process.platform === 'win32'`. We invoke `npm
    //     --version` here because:
    //       - it exercises the .cmd shim path on Windows runners
    //       - on POSIX it stays a normal exec and still works
    //       - npm is preinstalled on every GHA runner image
    //     Skip if npm isn't on PATH at all (some sandboxed environments)
    //     so this stays a smoke test, not a flaky external dependency.
    const npmCheckCtx = new CliToolExecutionContext(tmp);
    const npmRes = await npmCheckCtx.runCommand('npm', ['--version'], tmp);
    const npmAvailable = npmRes.exitCode === 0 && /\d+\.\d+/.test(npmRes.stdout);
    if (process.env.BANDIT_SMOKE_REQUIRE_NPM === '1') {
      assert(failures, npmAvailable, `runCommand('npm', ['--version']) failed (exit=${npmRes.exitCode}, stderr=${npmRes.stderr.slice(0, 200)})`);
    } else if (!npmAvailable) {
      process.stdout.write(`  · runCommand('npm', ['--version']) skipped (npm not on PATH or non-zero exit)\n`);
    }

    if (failures.length > 0) {
      process.stderr.write(`\n${failures.length} assertion(s) failed:\n`);
      for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
      process.exit(1);
    }

    process.stdout.write(`✓ smoke test passed (session + memory + mentions + slash + hooks + todos + task + permissions + config + skills + apply_edit + git_repo_path)\n`);
  } finally {
    process.env.HOME = oldHome;
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function assert(failures: string[], cond: boolean, label: string): void {
  if (!cond) failures.push(label);
}

main().catch((err) => {
  process.stderr.write(`smoke test crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
