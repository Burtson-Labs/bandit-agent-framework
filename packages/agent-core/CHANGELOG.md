# Changelog

## 1.6.93

- Serialize same-file writes within a parallel tool batch. Two `apply_edit` calls on one file in one turn used to race: both reported success but only the last write survived. Writes to different files and all reads still run concurrently; `apply_patch` locks every file it names.

## 1.6.91

- Let longer tasks use their full iteration budget when tools run in parallel. Productive extensions also extend the default tool budget; explicit tool caps remain firm.
- Keep artifact links out of file-edit completion checks.
- Stop flagging optional follow-up offers ending in “let me know” as unfinished actions.
