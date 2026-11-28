# Shared helpers for the ops CronJob scripts. Sourced, not executed.

REPO=/work
CLI_DIR="$REPO/apps/bandit-cli"

# ~/.bandit/config.json for the headless CLI runs (provider bandit, mode auto).
write_cli_config() {
  : "${BANDIT_API_KEY:?BANDIT_API_KEY is not set (secret bandit-eval-secrets)}"
  mkdir -p "$HOME/.bandit"
  printf '{"provider":"bandit","model":"bandit-core-2","mode":"auto","bandit":{"apiKey":"%s"}}' \
    "$BANDIT_API_KEY" > "$HOME/.bandit/config.json"
  chmod 600 "$HOME/.bandit/config.json"
}

# Exit 75 (EX_TEMPFAIL) with one clear line when the gateway refused the run
# for billing (402 insufficient_credits). Every fixture then "fails" in a few
# milliseconds, and before this check the nightly emailed a brief reporting
# 21 regressions and self-improve proposed fixes for them (Nov 2026).
credits_guard() {
  local file
  for file in "$@"; do
    [ -f "$file" ] || continue
    if grep -qE '402 Payment Required|"failure":"insufficient_credits"' "$file"; then
      local resets
      resets="$(grep -oE '"includedResetsAt":"[^"]+"' "$file" | head -1 | cut -d'"' -f4)"
      echo "OUT OF CREDITS: the Bandit API key in bandit-eval-secrets was refused with 402 insufficient_credits${resets:+ (included credits reset ${resets})}. No scores were produced; nothing was emailed or proposed. Top up the key's wallet or point the secret at a funded key." >&2
      exit 75
    fi
  done
}
