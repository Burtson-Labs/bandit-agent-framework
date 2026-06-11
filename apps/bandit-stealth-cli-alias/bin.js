#!/usr/bin/env node
// Forwards to the real CLI. The scoped package's entry runs main() on import,
// so this stays in-process — same TTY, signals, and exit codes.
import '@burtson-labs/bandit-stealth-cli';
