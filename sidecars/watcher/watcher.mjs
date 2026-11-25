#!/usr/bin/env node

// Antigravity Sidecar watcher for Session Alarm.
// Polls the local language server's GetAllCascadeTrajectories RPC for real waitingSteps
// and falls back gracefully to hooks when the RPC is unavailable.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTrajectories, parseLsEndpoint, WaitingTracker } from "./lib/waiting.mjs";

const SERVICE_PATH = "/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories";
const watcherDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(watcherDir, "sidecar.json");
const sessionAlarmPy = resolve(watcherDir, "..", "..", "scripts", "session_alarm.py");

function getSessionAlarmHome() {
  return (
    process.env.SESSION_ALARM_HOME ||
    (process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "session-alarm")
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "session-alarm"))
  );
}

function getDataDir() {
  return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || getSessionAlarmHome();
}

// Move CWD out of the plugin directory so Windows never locks it during updates/uninstalls.
try {
  mkdirSync(getDataDir(), { recursive: true });
  process.chdir(getDataDir());
} catch {
  // Continue even if chdir fails
}

function parseIntSetting(raw, fallback, min) {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

const activePollMs = parseIntSetting(process.env.SESSION_ALARM_SIDECAR_ACTIVE_POLL_MS, 500, 100);
const idlePollMs = parseIntSetting(process.env.SESSION_ALARM_SIDECAR_IDLE_POLL_MS, 2000, 200);
const graceMs = parseIntSetting(process.env.SESSION_ALARM_SIDECAR_WAIT_GRACE_MS, 0, 0);
const heartbeatIntervalMs = 5000;
const maxConsecutiveFailures = 3;

function writeSidecarState(healthy, extra = {}) {
  try {
    const home = getSessionAlarmHome();
    if (!home) return;
    mkdirSync(home, { recursive: true });
    const stateFile = join(home, "sidecar-state.json");
    const tmpFile = join(home, `.sidecar-state-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
    const body = `${JSON.stringify({
      pid: process.pid,
      mode: "sidecar",
      healthy,
      updatedAtMs: Date.now(),
      ...extra,
    })}\n`;
    writeFileSync(tmpFile, body, "utf8");
    try {
      renameSync(tmpFile, stateFile);
    } catch {
      rmSync(tmpFile, { force: true });
      writeFileSync(stateFile, body, "utf8");
    }
  } catch {
    // Heartbeat failures must never crash the watcher
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
    lines.push(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        hookEventName: "SidecarWaiting",
        terminationReason: null,
        action: "triggered",
        reason: "sidecar_waiting_step",
        mappedEvent: "PermissionRequest",
        ...entry,
      }),
    );
    if (lines.length > 200) {
      lines = lines.slice(-200);
    }
    writeFileSync(historyFile, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Logging must never break the watcher
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

let cachedPythonCandidate = null;

function getPythonCandidates() {
  if (cachedPythonCandidate) {
    return [cachedPythonCandidate];
  }
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(...findUvPythonCandidates());
    candidates.push(["py", ["-3"]], ["python", []], ["python3", []]);
  } else {
    candidates.push(["python3", []], ["python", []]);
  }
  return candidates;
}

function triggerPermissionAlertAsync() {
  const candidates = getPythonCandidates();
  const stdinJson = JSON.stringify({ hook_event_name: "PermissionRequest" });

  function trySpawn(index) {
    if (index >= candidates.length) {
      cachedPythonCandidate = null;
      return;
    }
    const [cmd, prefixArgs] = candidates[index];
    let retried = false;
    try {
      const child = spawn(cmd, [...prefixArgs, sessionAlarmPy, "hook", "--source", "agy"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        env: process.env,
      });
      child.on("error", (err) => {
        if (!retried && err?.code === "ENOENT") {
          retried = true;
          cachedPythonCandidate = null;
          trySpawn(index + 1);
        }
      });
      child.on("spawn", () => {
        cachedPythonCandidate = [cmd, prefixArgs];
      });
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(stdinJson);
      }
    } catch {
      trySpawn(index + 1);
    }
  }

  trySpawn(0);
}

function callGetAllCascadeTrajectories(endpoint, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const body = JSON.stringify({ excludeSubtrajectories: false });
    const requester = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        method: "POST",
        path: SERVICE_PATH,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": endpoint.csrf,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            rejectPromise(new Error(`RPC status ${res.statusCode}`));
            return;
          }
          try {
            resolvePromise(text ? JSON.parse(text) : {});
          } catch {
            rejectPromise(new Error("RPC malformed JSON"));
          }
        });
      },
    );
    req.on("error", rejectPromise);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("RPC timeout"));
    });
    req.end(body);
  });
}

let stopping = false;
let pollTimer = null;
let keepAlive = null;

function shutdown(reason = "shutdown") {
  if (stopping) return;
  stopping = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (keepAlive) clearInterval(keepAlive);
  writeSidecarState(false, { reason });
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => shutdown(signal.toLowerCase()));
}

const orphanCheck = setInterval(() => {
  if (!existsSync(manifestPath)) {
    shutdown("plugin_removed");
  }
}, 5000);
orphanCheck.unref?.();

const disabled = process.env.SESSION_ALARM_DISABLE_SIDECAR === "1";
const endpoint = disabled
  ? null
  : parseLsEndpoint(
      process.env.ANTIGRAVITY_LS_ADDRESS,
      process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN,
    );

if (disabled || !endpoint) {
  writeSidecarState(false, { reason: disabled ? "disabled_by_env" : "missing_ls_endpoint" });
  keepAlive = setInterval(() => {}, 1 << 30);
} else {
  const tracker = new WaitingTracker({ graceMs });
  let consecutiveFailures = 0;
  let lastHealthy = null;
  let lastHeartbeatMs = 0;

  function scheduleNext(delayMs) {
    if (stopping) return;
    pollTimer = setTimeout(pollOnce, delayMs);
  }

  async function pollOnce() {
    if (stopping) return;
    let nextDelay = idlePollMs;
    try {
      const response = await callGetAllCascadeTrajectories(endpoint);
      const { anyRunning, waitingByConv } = extractTrajectories(response);
      const now = Date.now();
      const alerts = tracker.update(waitingByConv, now);

      consecutiveFailures = 0;
      if (lastHealthy !== true || now - lastHeartbeatMs >= heartbeatIntervalMs) {
        writeSidecarState(true);
        lastHealthy = true;
        lastHeartbeatMs = now;
      }

      for (const alert of alerts) {
        appendHistoryLog({
          conversationId: alert.conversationId,
          waitingCount: alert.waitingCount,
          waitingKey: alert.waitingKeys[0] || null,
        });
        triggerPermissionAlertAsync();
      }

      nextDelay = anyRunning ? activePollMs : idlePollMs;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures && lastHealthy !== false) {
        writeSidecarState(false, { reason: "rpc_unavailable", consecutiveFailures });
        lastHealthy = false;
        lastHeartbeatMs = Date.now();
      }
      nextDelay = Math.min(10000, idlePollMs * consecutiveFailures);
    }
    scheduleNext(nextDelay);
  }

  pollOnce();
}
