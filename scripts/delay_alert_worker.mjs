#!/usr/bin/env node

// Detached delay-alert worker for Antigravity PreToolUse hooks.
// Waits delayMs, and if the pending marker was not cancelled by PostToolUse or Stop,
// logs a triggered event and invokes session_alarm.py PermissionRequest.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function getSessionAlarmHome() {
  return (
    process.env.SESSION_ALARM_HOME ||
    (process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "session-alarm")
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "session-alarm"))
  );
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function appendHistoryLog(entry) {
  try {
    const baseDir = getSessionAlarmHome();
    if (!baseDir) return;
    mkdirSync(baseDir, { recursive: true });
    const historyFile = join(baseDir, "history.jsonl");
    let lines = [];
    if (existsSync(historyFile)) {
      lines = readFileSync(historyFile, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
    }
    lines.push(JSON.stringify(entry));
    if (lines.length > 200) {
      lines = lines.slice(-200);
    }
    writeFileSync(historyFile, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Logging must never crash worker
  }
}

function findUvPythonCandidates() {
  const results = [];
  try {
    const uvDir = join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "uv",
      "python",
    );
    if (!existsSync(uvDir)) return results;
    const dirs = readdirSync(uvDir)
      .filter((name) => /^cpython-/i.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
    for (const dir of dirs) {
      const exe = join(uvDir, dir, "python.exe");
      if (existsSync(exe)) {
        results.push([exe, []]);
      }
    }
  } catch {
    // Ignore unreadable uv python directory
  }
  return results;
}

function triggerPermissionAlert() {
  const pythonScript = fileURLToPath(new URL("./session_alarm.py", import.meta.url));
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(...findUvPythonCandidates());
    candidates.push(["py", ["-3"]], ["python", []], ["python3", []]);
  } else {
    candidates.push(["python3", []], ["python", []]);
  }

  const stdinJson = JSON.stringify({ hook_event_name: "PermissionRequest" });
  for (const [cmd, prefixArgs] of candidates) {
    const result = spawnSync(cmd, [...prefixArgs, pythonScript, "hook", "--source", "agy"], {
      input: stdinJson,
      encoding: "utf8",
      timeout: 9000,
      windowsHide: true,
    });
    if (result.error?.code === "ENOENT") continue;
    return;
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) process.exit(0);

  if (arg === "--immediate") {
    triggerPermissionAlert();
    process.exit(0);
  }

  const pendingFile = arg;
  const meta = readJsonSafe(pendingFile);
  if (!meta || typeof meta.token !== "string" || !meta.token) {
    process.exit(0);
  }

  const delayMs = Number(meta.delayMs) > 0 ? Number(meta.delayMs) : 5000;
  const createdAtMs = Number(meta.createdAtMs) || Date.now();
  const remainingMs = Math.max(0, createdAtMs + delayMs - Date.now());

  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }

  const current = readJsonSafe(pendingFile);
  if (!current || current.token !== meta.token) {
    process.exit(0);
  }

  try {
    unlinkSync(pendingFile);
  } catch {
    process.exit(0);
  }

  appendHistoryLog({
    timestamp: new Date().toISOString(),
    conversationId: meta.conversationId || null,
    hookEventName: "PreToolUse",
    terminationReason: null,
    action: "triggered",
    reason: `delayed_approval_${meta.toolName || "tool"}`,
    mappedEvent: "PermissionRequest",
    toolName: meta.toolName || null,
    toolCallId: meta.toolCallId || null,
    delayMs,
  });

  triggerPermissionAlert();
}

await main();
