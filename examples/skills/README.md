<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.burtson.ai/logos/burtson-labs-logo.png" />
    <img src="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" alt="Burtson Labs" width="150" />
  </picture>

  # Example Skills

  **Drop-in skill manifests that auto-activate when the agent sees matching prompts.**

  Drop these JSON files into `.bandit/skills/` in any project and Bandit (CLI or VS Code extension) will load them when the user prompt mentions the language.
</div>

---

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> Available skills

| File | Triggers on | Tools |
|------|-------------|-------|
| [go.json](./go.json) | `.go` files, `go test/vet/build/fmt`, `golang`, `goroutine` | `go_vet`, `go_test`, `go_fmt`, `go_build` |
| [rust.json](./rust.json) | `.rs` files, `cargo *`, `clippy`, `rustfmt`, `rust` | `cargo_check`, `cargo_test`, `cargo_clippy`, `cargo_fmt_check` |
| [python.json](./python.json) | `.py` files, `pytest`, `mypy`, `ruff`, `python` | `py_ruff`, `py_mypy`, `py_pytest`, `py_black_check` |

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
mkdir -p .bandit/skills
cp path/to/bandit-agent-framework/examples/skills/go.json .bandit/skills/
```

Restart the agent / reload the window and ask something like *"run go vet on ./..."* — the skill activates and the agent calls `go_vet` for you.

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23a60ee5&width=22" align="absmiddle"> Authoring your own

A skill manifest is a JSON file with:

```jsonc
{
  "id": "lang/haskell",
  "name": "Haskell Toolchain",
  "version": "1.0.0",
  "description": "One-line shown in the system prompt when active.",
  "instructions": "Multi-line guidance the model sees when this skill activates.",
  "activation": "auto",             // "always" | "auto" | "on-demand"
  "triggerPatterns": ["\\.hs\\b"],  // regex strings, case-insensitive
  "tools": [
    {
      "name": "ghc_build",
      "description": "Build with GHC.",
      "parameters": [
        { "name": "target", "description": "Module path", "required": false }
      ],
      "command": "ghc --make {{target}}"
    }
  ]
}
```

`{{param}}` placeholders in `command` are replaced with parameter values at call time. Command tools run through the agent's `runCommand` with a 30-second timeout and 32 KB output cap.

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
