# Changelog

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
