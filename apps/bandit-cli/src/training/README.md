# Training Studio — data side (`bandit train`)

Collects Bandit's own interaction data on the machine that has it, scrubs it locally
(scrub-v1) and writes a dataset in the canonical format (`types.ts`, contract v1:
OpenAI-style chat with native `tool_calls`, which maps 1:1 onto the Qwen3/Hermes tool
templates served by Ollama, vLLM and llama.cpp). Only the scrubbed dataset is uploaded.

```
bandit train collect --dry-run            # stats only
bandit train collect                      # → ~/.bandit/training/<datasetId>/
bandit train inspect <dir> --sample 5     # spot-check + self-check
bandit train upload <dir>                 # → training-api (refuses if the self-check fails)
bandit eval --trace-out ~/.bandit/training/banditbench-traces   # verifiable-reward traces
```

Sources: `~/.bandit/sessions` (CLI REPL, joined to host-kit turn logs for model/status/
labels), Stealth web turn logs (`.bandit/turns/<ISO>-<r5>.jsonl`; `provider: "import"`
sessions are never used), BanditBench traces. One example per user turn, with up to N
earlier turns of the session as compact history (prompt + final answer).

Scrub: agent-core `redactSecrets` + extra key/JWT/PEM/connection-string/URL-credential
patterns, high-entropy tokens, emails, phones, home paths, and the local denylist
(`~/.bandit/training/denylist.txt`, see `denylist.example.txt`). Reads of `.env`,
`appsettings*.json`, keys and credential files are replaced whole. Mail/calendar tool
use, client-document reads and secret-heavy turns drop the turn and the rest of its
session. Every run ends with a self-check over the raw strings that fails loudly.

Paths (`paths.ts`), before the scrub: everything under a trajectory's workspace root becomes
repo-relative (`src/a.ts`, `.`), another repo becomes `../<repo>/…`, eval sandboxes collapse
to their root, and other personal/temp paths become neutral placeholders (`~/files/…`,
`/tmp/<name>`; counted as `scrub.redactions.path_absolute`, or dropped with
`--external-paths drop`). `GitHub-<org>` checkouts are client work and drop the example. The
self-check fails on any leftover `~/Documents`, `/Users/<n>`, `~/projects/app` or temp-dir path —
a model trained on absolute paths writes to the collector's machine instead of its workspace.
