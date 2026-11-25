# Privacy

Session Alarm runs entirely locally and does not include analytics, telemetry, accounts,
advertising, or network requests.

## Data used by lifecycle hooks

The lifecycle hooks receive event payloads from Antigravity, Codex, or Claude Code. Session Alarm
uses only:

- the hook event name and termination reason;
- the tool name and target command/path metadata in `PreToolUse` (solely to check whether user
  approval is needed);
- the final assistant message tail (evaluated in memory and discarded) to detect error indicators;
  and
- whether background tasks or subagents are still active.

To respect your Antigravity permission presets and "Always Allow" rules, `scripts/agy_hook.mjs`
reads `~/.gemini/config/config.json` and matching `~/.gemini/config/projects/*.json` files locally
in read-only mode.

Conversation text, prompts, and file contents are never stored or transmitted.

## Local Sidecar communication

In Antigravity Desktop App, `sidecars/watcher/watcher.mjs` communicates strictly over the local loopback interface (`ANTIGRAVITY_LS_ADDRESS`, e.g., `127.0.0.1` / `localhost`) using the host-injected `ANTIGRAVITY_CSRF_TOKEN` (kept strictly in memory and never logged or written to disk) solely to poll `GetAllCascadeTrajectories` for `waitingSteps` and run status. No external network requests are ever made.

## Local files created

Configuration and runtime data are stored locally:

- macOS and Linux: `~/.config/session-alarm/` (or `$XDG_CONFIG_HOME/session-alarm/`)
- Windows: `%APPDATA%\session-alarm\`
- Tests and advanced setups may override the directory with `SESSION_ALARM_HOME`.

Files stored in that directory:

- `config.json`: your selected sounds, volume, notification toggle, and quiet hours;
- `sounds/` and `custom/`: locally rendered volume-adjusted WAV cache and user-imported WAVs;
- `runtime.json`: a small deduplication timestamp;
- `sidecar-state.json`: local Sidecar watcher PID, health flag, and heartbeat timestamp (used by `agy_hook.mjs` for automatic fallback; never stores `ANTIGRAVITY_CSRF_TOKEN`);
- `pending/`: short-lived per-tool-call timer marker JSON files (Hook fallback mode only; storing tool call ID, conversation ID, tool name, and delay threshold — never prompts or file contents — deleted on `PostToolUse`, `Stop`, or after triggering);
- `history.jsonl`: up to 200 recent hook/sidecar trigger/skip metadata entries (timestamp, conversation ID,
  hook event name, tool name, and trigger/skip reason — never prompts or file contents).

Desktop notifications contain only generic status text such as "Antigravity needs your input."
