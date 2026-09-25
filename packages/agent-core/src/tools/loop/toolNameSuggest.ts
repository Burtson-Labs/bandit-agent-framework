/**
 * What to tell a model that called a tool that does not exist.
 *
 * Models trained on other agents' tool sets reach for those names:
 * `edit_file`, `str_replace`, `create_file`, `bash`. A bare "not
 * registered" reads to them as "this environment cannot edit files": a
 * small local model gave up on a one-line README change with exactly that
 * explanation, and the next model in the same conversation repeated it
 * from history. Naming the registered tool that does the job turns a dead
 * end into one retry. Suggestion only: aliases are never executed, because
 * their parameters differ from ours.
 */

/** Common foreign tool names → our tools that do the same job, best first. */
const COMMON_ALIASES: Record<string, readonly string[]> = {
  edit_file: ['apply_edit', 'replace_range'],
  edit: ['apply_edit', 'replace_range'],
  str_replace: ['apply_edit'],
  str_replace_editor: ['apply_edit'],
  str_replace_based_edit_tool: ['apply_edit'],
  replace_in_file: ['apply_edit'],
  search_replace: ['apply_edit'],
  modify_file: ['apply_edit', 'replace_range'],
  update_file: ['apply_edit', 'replace_range'],
  patch: ['apply_patch'],
  patch_file: ['apply_patch'],
  create_file: ['write_file'],
  new_file: ['write_file'],
  save_file: ['write_file'],
  read: ['read_file'],
  view: ['read_file'],
  view_file: ['read_file'],
  open_file: ['read_file'],
  cat: ['read_file'],
  list_dir: ['ls', 'list_files'],
  list_directory: ['ls', 'list_files'],
  dir: ['ls', 'list_files'],
  find_files: ['list_files'],
  glob: ['list_files'],
  file_search: ['list_files'],
  grep: ['search_code'],
  grep_search: ['search_code'],
  search: ['search_code'],
  codebase_search: ['search_code'],
  bash: ['run_command'],
  shell: ['run_command'],
  run: ['run_command'],
  execute_command: ['run_command'],
  run_terminal_cmd: ['run_command'],
  run_shell_command: ['run_command'],
  delete: ['delete_file'],
  remove_file: ['delete_file'],
};

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * Registered tools to suggest for `wanted`, best first (at most 2): a known
 * alias first, else a near-miss spelling (`read_files`, `apply-edit`).
 */
export function suggestToolNames(wanted: string, registered: readonly string[]): string[] {
  const key = wanted.trim().toLowerCase().replace(/-/g, '_');
  const byLower = new Map(registered.map((n) => [n.toLowerCase(), n]));
  const aliased = (COMMON_ALIASES[key] ?? [])
    .map((n) => byLower.get(n))
    .filter((n): n is string => Boolean(n));
  if (aliased.length > 0) {return aliased.slice(0, 2);}
  const limit = key.length <= 5 ? 1 : 2;
  return registered
    .map((n) => ({ n, d: editDistance(key, n.toLowerCase()) }))
    .filter(({ d }) => d > 0 && d <= limit)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map(({ n }) => n);
}

/** The tool result for an unknown tool name. */
export function unknownToolMessage(wanted: string, registered: readonly string[]): string {
  const suggestions = suggestToolNames(wanted, registered);
  if (suggestions.length > 0) {
    const names = suggestions.map((s) => `"${s}"`).join(' or ');
    return `Error: tool "${wanted}" is not registered. Use ${names} instead — it is available in this environment. Call it with its own parameters.`;
  }
  const shown = registered.filter((n) => !n.includes('.') && !n.includes('__')).slice(0, 16);
  return `Error: tool "${wanted}" is not registered. Available tools include: ${shown.join(', ')}.`;
}
