# Changelog

## 1.6.99

- With a compaction target set, old tool calls with large arguments are shortened too, once older tool results are not enough: the assistant's words stay, and each call becomes one line naming the tool and the path it touched (`[earlier call: write_file games/g0.html — its 412-line arguments are elided from history; read games/g0.html for its current content]`). Plain text, no `<tool_call>` tags, so a placeholder never parses or gets copied as a call. The newest `keepRecentToolResults` calls stay whole. In a long building session the written files outweighed the results, so results alone could not reach the target and compaction still fired on nearly every call. Replaying a real 466-call session with a 100K budget and a 50K target: 3 compactions instead of 61, and 32% fewer input tokens than the old 196K budget. No change without a target.

## 1.6.98

- Compaction can leave headroom: `messageTokenTarget` (ToolUseLoop) / `targetTokens` (`compactToolMessages`) is where history is trimmed to once `messageTokenBudget` is exceeded. It defaults to the budget, which is the old behaviour. Compacting only to just under the budget meant the next tool result crossed it again, so compaction fired on nearly every iteration, and each pass rewrote an earlier message; a provider's prompt cache covers only the unchanged prefix, so each pass re-billed the rest of the conversation at the uncached rate. In a 60-iteration simulation with a 12K budget, a 7.2K target cuts the number of compactions by more than two-thirds. The last-resort step that drops whole messages still only runs to fit the budget, never to reach the target.

## 1.6.97

- The tool-error recovery nudge no longer fires when the model's reply already explains the failure (it repeats a distinctive token from the error output, or plainly says the step failed). Before, a blocked `web_fetch` the model had already explained got nudged, the model restated the same answer, and the terminal showed it twice. Short replies that drop the task are still nudged.
- `search_code` with no matches names concrete next queries (lowercase, one word or an alternation, drop the glob, `list_files`) instead of a bare "No matches", which models read as "it isn't there".
- `git_stash` is described as git's working-tree stash and says it is not the Bandit Stash; the always-on git skill says "git stash entries". The web/artifact skill is named "Web Page", talks about pages and the Bandit Stash, and triggers on "Bandit Stash" and "save … to my stash" (not a bare "stash"); `wantsArtifactDeliverable` treats "save it to my Stash" as a deliverable. Skill id, exports and tool names are unchanged.
- The Web Page skill asks for a page title and a one-sentence description, which become the link preview when a published page is pasted into Slack, Teams or iMessage.

## 1.6.96

- `@modelcontextprotocol/sdk` is required at `^1.32.2` (was `^1.0.0`, which let a consumer's lockfile keep 1.30.1 and its high-severity advisories: OAuth credentials sent to a server-chosen authorization server, bearer tokens issued for another service accepted, auth headers replayed across a cross-origin redirect). The HTTP client transport now follows a redirect only within the endpoint's origin; a remote server entry that legitimately redirects elsewhere sets `redirectPolicy: 'follow'` in `mcp-servers.json`, and opting in re-asks for trust.

## 1.6.95

- Workspace skill tools (`.bandit/skills/*.json`) carry `origin: 'manifest'`. The registry keeps an existing non-manifest tool over a manifest tool of the same name, so a repository can no longer ship a tool named `read_file` that replaces the built-in; a manifest tool's command goes through the same allow-list and blocked patterns as `run_command` (`runCommandRefusal`), so `sh` is not available under another name.
- `run_tests` accepts only a known test runner for `runner` (vitest, jest, mocha, pytest, playwright, bun, deno) instead of spawning whatever was named.
- The Python syntax check runs `python3 -I`, so a repository file named `ast.py` or `base64.py` is not what it imports.

## 1.6.94

- Local models: tool history is replayed in the provider's native tool-call format on the native-tools path (`stealth-core-runtime` 1.4.85), so Qwen3 no longer answers with empty replies and Gemma no longer copies the text form and stops early. Measured on BanditBench (78 runs): gemma4:31b 61 → 73 with early stops 11 → 0, qwen3-coder:30b 33 → 69, qwen3.6:27b unchanged at 75.
- `apply_patch` applies every file of a multi-file unified diff, and applies a whole hunk even when its `@@` line counts are wrong; before, the rest of the diff or hunk was silently dropped while the call reported success.
- A reply that is only a status line ("Reading the project structure…") is treated as a stall and retried, not taken as the final answer.
- The loop reads Qwen3-Coder's `<function=…>` tool calls; a bare `<tool_call>` at the end of an answer is no longer flagged as a malformed call.
- C# edit validation no longer rejects an edit for diagnostics a lone-file compile cannot resolve (missing package or project references); real syntax errors are still rejected.
- `search_code` honours a path in `file_glob` without ripgrep; `replace_range` no longer turns a trailing newline into a blank line; `semantic_search` uses the configured Ollama URL and keeps one index per workspace.
- The per-reply tool-call cap note names the calls that did not run.

## 1.6.93

- Serialize same-file writes within a parallel tool batch. Two `apply_edit` calls on one file in one turn used to race: both reported success but only the last write survived. Writes to different files and all reads still run concurrently; `apply_patch` locks every file it names.

## 1.6.91

- Let longer tasks use their full iteration budget when tools run in parallel. Productive extensions also extend the default tool budget; explicit tool caps remain firm.
- Keep artifact links out of file-edit completion checks.
- Stop flagging optional follow-up offers ending in “let me know” as unfinished actions.
