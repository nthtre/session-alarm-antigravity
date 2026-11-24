#!/usr/bin/env node

// Antigravity lifecycle hook adapter for Session Alarm.
// Translates Antigravity camelCase hook payloads into session_alarm.py hook events
// and returns valid Antigravity hook JSON on stdout.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let rawInput = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  rawInput += chunk;
}

let payload = {};
try {
  payload = rawInput.trim() ? JSON.parse(rawInput) : {};
} catch {
  payload = {};
}

const hookEvent = payload.hookEventName || "";
const ASYNC_DELEGATION_TOOLS = new Set(["invoke_subagent", "send_message", "schedule"]);
const WRITE_TOOLS = new Set([
  "edit_file",
  "write_file",
  "code_action",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

function normalizeFsPath(p) {
  if (!p || typeof p !== "string") return "";
  try {
    const cleaned = p.replace(/^["']|["']$/g, "").replace(/^file:\/\/\/?/i, "");
    const resolved = resolve(cleaned);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return "";
  }
}

function normalizeSlashPath(p) {
  const norm = normalizeFsPath(p).replace(/\\/g, "/");
  if (!norm) return "";
  if (/^[a-zA-Z]:\/$/.test(norm) || norm === "/") return norm;
  return norm.replace(/\/+$/, "");
}

function isPathInside(targetPath, allowedDir) {
  const target = normalizeFsPath(targetPath);
  const base = normalizeFsPath(allowedDir);
  if (!target || !base) return false;
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return target.startsWith(prefix);
}

function isAutoAllowedWritePath(targetPath) {
  if (!targetPath) return true;
  const home = homedir();
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const writeAllowedDirs = [
    ...workspaces,
    payload.artifactDirectoryPath,
    join(home, ".gemini", "antigravity", "scratch"),
  ].filter(Boolean);
  return writeAllowedDirs.some((dir) => isPathInside(targetPath, dir));
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

function parseCommandMode(preset, autoExec) {
  const p = typeof preset === "string" ? preset.trim().toUpperCase() : "";
  if (p) {
    if (p.includes("TURBO") || p.includes("EAGER")) return "turbo";
    if (
      p.includes("REVIEW") ||
      p.includes("OFF") ||
      p.includes("MANUAL") ||
      p.includes("STRICT") ||
      p.includes("ASK")
    ) {
      return "review";
    }
    if (p.includes("DEFAULT")) return "default";
    if (p.includes("AUTO")) return "auto";
  }
  const a = typeof autoExec === "string" ? autoExec.trim().toUpperCase() : "";
  if (a) {
    if (a.includes("TURBO") || a.includes("EAGER")) return "turbo";
    if (a.includes("OFF")) return "review";
    if (a.includes("AUTO")) return "auto";
  }
  return "auto";
}

function parseAllowGrants(rawGrants) {
  const parsed = [];
  for (const entry of rawGrants) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([a-zA-Z0-9_.-]+)\(([\s\S]*)\)$/);
    if (m) {
      parsed.push({
        kind: m[1].toLowerCase(),
        pattern: m[2].trim(),
      });
    } else {
      parsed.push({
        kind: "raw",
        pattern: trimmed,
      });
    }
  }
  return parsed;
}

function projectMatchesWorkspaces(projectData, workspacePaths) {
  if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) return false;
  const resources = projectData?.projectResources?.resources;
  if (!Array.isArray(resources)) return false;
  for (const res of resources) {
    const uri = res?.folderUri;
    if (typeof uri !== "string" || !uri) continue;
    let folderPath = "";
    try {
      folderPath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
    } catch {
      folderPath = "";
    }
    const normProj = normalizeFsPath(folderPath);
    if (!normProj) continue;
    for (const ws of workspacePaths) {
      const normWs = normalizeFsPath(ws);
      if (!normWs) continue;
      if (normProj === normWs || isPathInside(ws, folderPath) || isPathInside(folderPath, ws)) {
        return true;
      }
    }
  }
  return false;
}

function loadAgyPermissionContext(workspacePaths) {
  const configDir = process.env.SESSION_ALARM_AGY_CONFIG_DIR || join(homedir(), ".gemini", "config");
  const configData = readJsonSafe(join(configDir, "config.json")) || {};
  const userSettings = configData.userSettings && typeof configData.userSettings === "object"
    ? configData.userSettings
    : {};

  const allowGrants = [];
  if (Array.isArray(userSettings.globalPermissionGrants?.allow)) {
    allowGrants.push(...userSettings.globalPermissionGrants.allow);
  }
  if (Array.isArray(userSettings.mcpPermissionGrants?.allow)) {
    allowGrants.push(...userSettings.mcpPermissionGrants.allow);
  }

  const effectiveSettings = {
    permissionPreset: userSettings.permissionPreset,
    autoExecutionPolicy: userSettings.autoExecutionPolicy,
    nonWorkspaceFileAccessPolicy: userSettings.nonWorkspaceFileAccessPolicy,
    artifactReviewMode: userSettings.artifactReviewMode,
  };

  const projectsDir = join(configDir, "projects");
  try {
    if (existsSync(projectsDir)) {
      const files = readdirSync(projectsDir).filter((name) => name.endsWith(".json"));
      for (const fileName of files) {
        const proj = readJsonSafe(join(projectsDir, fileName));
        if (!proj || !projectMatchesWorkspaces(proj, workspacePaths)) continue;
        if (Array.isArray(proj.permissionGrants?.allow)) {
          allowGrants.push(...proj.permissionGrants.allow);
        }
        if (Array.isArray(proj.permissionGrants?.permissionGrants?.allow)) {
          allowGrants.push(...proj.permissionGrants.permissionGrants.allow);
        }
        if (Array.isArray(proj.mcpPermissionGrants?.allow)) {
          allowGrants.push(...proj.mcpPermissionGrants.allow);
        }
        if (proj.settings && typeof proj.settings === "object") {
          for (const key of [
            "permissionPreset",
            "autoExecutionPolicy",
            "nonWorkspaceFileAccessPolicy",
            "artifactReviewMode",
          ]) {
            if (typeof proj.settings[key] === "string" && proj.settings[key].trim()) {
              effectiveSettings[key] = proj.settings[key];
            }
          }
        }
      }
    }
  } catch {
    // Ignore unreadable project overrides
  }

  const commandMode = parseCommandMode(
    effectiveSettings.permissionPreset,
    effectiveSettings.autoExecutionPolicy,
  );
  const nonWsPolicy =
    typeof effectiveSettings.nonWorkspaceFileAccessPolicy === "string"
      ? effectiveSettings.nonWorkspaceFileAccessPolicy.toUpperCase()
      : "";
  const allowNonWorkspaceWrites =
    commandMode === "turbo" || nonWsPolicy.includes("ALLOW") || nonWsPolicy.includes("TURBO");
  const artifactReviewMode =
    typeof effectiveSettings.artifactReviewMode === "string"
      ? effectiveSettings.artifactReviewMode.toUpperCase()
      : "";
  const artifactReviewTurbo = artifactReviewMode.includes("TURBO");

  return {
    commandMode,
    allowNonWorkspaceWrites,
    artifactReviewTurbo,
    grants: parseAllowGrants(allowGrants),
  };
}

function wildcardToRegex(pattern, { pathMode }) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const body = pathMode
    ? escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")
    : escaped.replace(/\*/g, ".*");
  return new RegExp(`^${body}$`, process.platform === "win32" ? "i" : "");
}

function isCommandGranted(commandLine, grants) {
  const cmd = typeof commandLine === "string" ? commandLine.trim() : "";
  if (!cmd) return false;
  const cmdCmp = process.platform === "win32" ? cmd.toLowerCase() : cmd;
  for (const grant of grants) {
    if (grant.kind !== "command" || !grant.pattern) continue;
    const pat = grant.pattern.trim();
    if (pat === "*") return true;
    if (pat.includes("*")) {
      if (wildcardToRegex(pat, { pathMode: false }).test(cmd)) return true;
    } else {
      const patCmp = process.platform === "win32" ? pat.toLowerCase() : pat;
      if (
        cmdCmp === patCmp ||
        cmdCmp.startsWith(`${patCmp} `) ||
        cmdCmp.startsWith(`${patCmp}\t`)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isPathGranted(targetPath, grants, allowedKinds) {
  const normTarget = normalizeSlashPath(targetPath);
  if (!normTarget) return false;
  for (const grant of grants) {
    if (!allowedKinds.has(grant.kind) || !grant.pattern) continue;
    const pat = grant.pattern.trim();
    if (pat === "*") return true;
    if (pat.includes("*")) {
      const normPat = pat
        .replace(/^["']|["']$/g, "")
        .replace(/^file:\/\/\/?/i, "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
      if (normPat && wildcardToRegex(normPat, { pathMode: true }).test(normTarget)) {
        return true;
      }
    } else {
      const normPat = normalizeSlashPath(pat);
      if (normPat && (normTarget === normPat || normTarget.startsWith(`${normPat}/`))) {
        return true;
      }
    }
  }
  return false;
}

function isWriteFileGranted(targetPath, grants) {
  return isPathGranted(targetPath, grants, new Set(["write_file", "edit_file"]));
}

function isReadFileGranted(targetPath, grants) {
  return isPathGranted(targetPath, grants, new Set(["read_file", "view_file"]));
}

const MCP_GRANT_KINDS = new Set([
  "mcp",
  "mcp_tool",
  "mcp_server",
  "call_mcp_tool",
  "tool",
  "raw",
]);

function isMcpToolGranted(toolName, args, grants) {
  const toolLower = String(toolName || "").toLowerCase();
  const isLazy = toolLower === "call_mcp_tool";
  const serverName = isLazy
    ? String(args?.ServerName || args?.serverName || args?.server || "").trim()
    : "";
  const mcpTool = isLazy
    ? String(args?.ToolName || args?.toolName || args?.tool || "").trim()
    : "";
  const serverLower = serverName.toLowerCase();
  const mcpToolLower = mcpTool.toLowerCase();

  const candidates = [];
  if (isLazy) {
    if (serverLower && mcpToolLower) {
      candidates.push(
        `${serverLower}/${mcpToolLower}`,
        `${serverLower}:${mcpToolLower}`,
        `mcp_${serverLower}_${mcpToolLower}`,
        `${serverLower}_${mcpToolLower}`,
      );
    } else if (serverLower) {
      candidates.push(serverLower);
    }
  } else {
    candidates.push(toolLower);
    if (toolLower.startsWith("mcp_")) {
      candidates.push(toolLower.slice(4));
    }
  }

  for (const grant of grants) {
    const kind = grant.kind;
    const isPrefixedMcpKind = kind.startsWith("mcp_");
    if (!MCP_GRANT_KINDS.has(kind) && !isPrefixedMcpKind) continue;

    const pat = typeof grant.pattern === "string" ? grant.pattern.trim() : "";
    if (isPrefixedMcpKind && (!pat || pat === "*")) {
      if (!isLazy && kind === toolLower) return true;
      if (isLazy && serverLower && mcpToolLower && kind === `mcp_${serverLower}_${mcpToolLower}`) {
        return true;
      }
      if (isLazy && serverLower && !mcpToolLower && kind === `mcp_${serverLower}`) {
        return true;
      }
      continue;
    }

    if (!pat) continue;
    const patLower = pat.toLowerCase();
    if (patLower === "*") return true;
    const patUnderscore = patLower.replace(/[/:]/g, "_");

    if (patLower.includes("*")) {
      const reDirect = wildcardToRegex(patLower, { pathMode: false });
      const reUnder = wildcardToRegex(patUnderscore, { pathMode: false });
      if (candidates.some((c) => reDirect.test(c) || reUnder.test(c))) {
        return true;
      }
      continue;
    }

    if (candidates.includes(patLower) || candidates.includes(patUnderscore)) {
      return true;
    }

    if (!patLower.includes("/") && !patLower.includes(":")) {
      if (isLazy && serverLower && serverLower === patLower) return true;
      if (!isLazy && (toolLower.startsWith(`mcp_${patLower}_`) || toolLower.slice(4).startsWith(`${patLower}_`))) {
        return true;
      }
    }
  }
  return false;
}

function isTrustedMcpSkipped(toolName, args) {
  const raw = process.env.SESSION_ALARM_SKIP_MCP_PREFIXES;
  if (!raw) return false;
  const prefixes = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (prefixes.length === 0) return false;

  const candidates = [String(toolName || "").toLowerCase()];
  if (toolName === "call_mcp_tool") {
    const serverName = String(args?.ServerName || args?.serverName || args?.server || "").trim();
    const mcpTool = String(args?.ToolName || args?.toolName || args?.tool || "").trim();
    if (serverName) {
      candidates.push(`mcp_${serverName}_${mcpTool}`.toLowerCase());
      candidates.push(serverName.toLowerCase());
      if (mcpTool) {
        candidates.push(`${serverName}/${mcpTool}`.toLowerCase());
      }
    }
  }
  return prefixes.some((prefix) => candidates.some((cand) => cand.startsWith(prefix)));
}

function inspectTranscriptForStop(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { skip: false, reason: "no_transcript" };
  }
  try {
    const content = readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return { skip: false, reason: "empty_transcript" };
    }
    const steps = [];
    for (const line of lines) {
      try {
        steps.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines
      }
    }
    if (steps.length === 0) {
      return { skip: false, reason: "no_parsed_steps" };
    }

    // 1. Subagent conversations never have USER_INPUT / USER_EXPLICIT steps.
    const hasUserInput = steps.some(
      (s) => s.type === "USER_INPUT" || s.source === "USER_EXPLICIT",
    );
    if (!hasUserInput) {
      return { skip: true, reason: "subagent_session" };
    }

    // 2. Check steps in the current turn (after the last USER_INPUT or SYSTEM_MESSAGE wakeup).
    let lastWakeupIdx = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === "USER_INPUT" || steps[i].type === "SYSTEM_MESSAGE") {
        lastWakeupIdx = i;
        break;
      }
    }
    const turnSteps = lastWakeupIdx >= 0 ? steps.slice(lastWakeupIdx + 1) : steps;

    for (const step of turnSteps) {
      if (step.status === "RUNNING") {
        return { skip: true, reason: "waiting_for_running_background_task" };
      }
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          if (ASYNC_DELEGATION_TOOLS.has(tc?.name)) {
            return { skip: true, reason: `waiting_for_${tc.name}` };
          }
        }
      }
    }

    let lastAssistantMessage = "";
    for (let i = turnSteps.length - 1; i >= 0; i--) {
      if (turnSteps[i].type === "PLANNER_RESPONSE" && typeof turnSteps[i].content === "string") {
        lastAssistantMessage = turnSteps[i].content;
        break;
      }
    }

    return { skip: false, reason: "turn_complete", lastAssistantMessage };
  } catch {
    return { skip: false, reason: "transcript_read_error" };
  }
}

function getSessionAlarmHome() {
  return (
    process.env.SESSION_ALARM_HOME ||
    (process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "session-alarm")
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "session-alarm"))
  );
}

function getPendingDir() {
  return join(getSessionAlarmHome(), "pending");
}

function getPendingId(p) {
  const raw =
    typeof p?.toolCall?.id === "string" && p.toolCall.id.trim()
      ? p.toolCall.id.trim()
      : `${p?.conversationId || "unknown"}_${p?.stepIdx ?? "0"}_${p?.toolCall?.name || "tool"}`;
  if (/^[a-zA-Z0-9_-]{1,100}$/.test(raw)) {
    return raw;
  }
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safe.slice(0, 64) || "call"}_${digest}`;
}

function getDelayMs(kind) {
  const map = {
    read: { envKey: "SESSION_ALARM_DELAY_READ_MS", defaultMs: 5000 },
    write: { envKey: "SESSION_ALARM_DELAY_WRITE_MS", defaultMs: 5000 },
    command: { envKey: "SESSION_ALARM_DELAY_COMMAND_MS", defaultMs: 5000 },
    mcp: { envKey: "SESSION_ALARM_DELAY_MCP_MS", defaultMs: 5000 },
  };
  const config = map[kind] || map.mcp;
  const raw = process.env[config.envKey];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return config.defaultMs;
}

function sweepStalePendingFiles(pendingDir, maxAgeMs = 5 * 60 * 1000) {
  try {
    if (!existsSync(pendingDir)) return;
    const now = Date.now();
    for (const name of readdirSync(pendingDir)) {
      if (!name.endsWith(".json")) continue;
      const fullPath = join(pendingDir, name);
      try {
        const st = statSync(fullPath);
        if (now - st.mtimeMs > maxAgeMs) {
          rmSync(fullPath, { force: true });
        }
      } catch {
        // Ignore individual file errors
      }
    }
  } catch {
    // Ignore sweep errors
  }
}

function armDelayedAlert({ delayMs, toolName }) {
  try {
    const pendingDir = getPendingDir();
    mkdirSync(pendingDir, { recursive: true });
    sweepStalePendingFiles(pendingDir);
    const pendingId = getPendingId(payload);
    const pendingFile = join(pendingDir, `${pendingId}.json`);
    const meta = {
      toolCallId: payload.toolCall?.id || null,
      pendingId,
      conversationId: payload.conversationId || null,
      toolName: toolName || null,
      delayMs,
      createdAtMs: Date.now(),
      token: randomBytes(8).toString("hex"),
    };
    writeFileSync(pendingFile, JSON.stringify(meta), "utf8");
    const workerScript = fileURLToPath(new URL("./delay_alert_worker.mjs", import.meta.url));
    const child = spawn(process.execPath, [workerScript, pendingFile], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    // Delayed alert arming must never block tool execution
  }
}

function cancelDelayedAlert() {
  try {
    const pendingFile = join(getPendingDir(), `${getPendingId(payload)}.json`);
    rmSync(pendingFile, { force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function cancelConversationPendingAlerts(conversationId) {
  if (!conversationId) return;
  try {
    const pendingDir = getPendingDir();
    if (!existsSync(pendingDir)) return;
    for (const name of readdirSync(pendingDir)) {
      if (!name.endsWith(".json")) continue;
      const fullPath = join(pendingDir, name);
      const meta = readJsonSafe(fullPath);
      if (meta?.conversationId === conversationId) {
        rmSync(fullPath, { force: true });
      }
    }
  } catch {
    // Ignore cleanup errors
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
        conversationId: payload.conversationId || null,
        hookEventName: hookEvent || null,
        terminationReason: payload.terminationReason || null,
        ...entry,
      }),
    );
    if (lines.length > 200) {
      lines = lines.slice(-200);
    }
    writeFileSync(historyFile, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Logging must never break hook execution
  }
}

function buildMappedPayload(permCtx) {
  if (hookEvent === "SessionStart") {
    return { mapped: { hook_event_name: "SessionStart" }, reason: "session_start" };
  }
  if (hookEvent === "PreToolUse") {
    const toolName = payload.toolCall?.name || "";
    const args = payload.toolCall?.args || {};
    if (toolName === "ask_question") {
      return {
        mapped: { hook_event_name: "PermissionRequest" },
        reason: "ask_question",
        decision: "allow",
      };
    }
    if (toolName === "run_command") {
      const rawBypass = args.BypassSandbox;
      const bypass = rawBypass === true || rawBypass === "true";
      const cmdLine = args.CommandLine || args.command || "";
      if (permCtx.commandMode === "turbo") {
        return {
          mapped: null,
          reason: "skipped_by_turbo_mode",
          decision: "allow",
          logSkip: true,
        };
      }
      if (permCtx.commandMode === "review" || bypass) {
        if (isCommandGranted(cmdLine, permCtx.grants)) {
          return {
            mapped: null,
            reason: "allowed_by_permission_grant",
            decision: "ask",
            logSkip: true,
          };
        }
        return {
          mapped: null,
          reason: bypass ? "run_command_bypass_sandbox" : "run_command_review_mode",
          decision: "ask",
          delayAlert: {
            delayMs: getDelayMs("command"),
            toolName,
          },
        };
      }
      return {
        mapped: null,
        reason: "run_command_sandboxed",
        decision: "allow",
      };
    }
    if (WRITE_TOOLS.has(toolName)) {
      const reqFeedback =
        args.ArtifactMetadata?.RequestFeedback === true ||
        args.ArtifactMetadata?.RequestFeedback === "true";
      if (reqFeedback && !permCtx.artifactReviewTurbo) {
        return {
          mapped: { hook_event_name: "PermissionRequest" },
          reason: `${toolName}_request_feedback`,
          decision: "allow",
        };
      }
      const targetPath =
        args.Path ||
        args.TargetFile ||
        args.AbsolutePath ||
        args.FilePath ||
        args.path ||
        args.targetFile ||
        "";
      if (isAutoAllowedWritePath(targetPath)) {
        return {
          mapped: null,
          reason: `${toolName}_auto_allowed`,
          decision: "allow",
        };
      }
      if (permCtx.allowNonWorkspaceWrites) {
        return {
          mapped: null,
          reason: "skipped_by_permission_policy",
          decision: "allow",
          logSkip: true,
        };
      }
      if (isWriteFileGranted(targetPath, permCtx.grants)) {
        return {
          mapped: null,
          reason: "allowed_by_permission_grant",
          decision: "ask",
          logSkip: true,
        };
      }
      return {
        mapped: null,
        reason: `${toolName}_outside_workspace`,
        decision: "ask",
        delayAlert: {
          delayMs: getDelayMs("write"),
          toolName,
        },
      };
    }
    const isReadTool = toolName === "read_file" || toolName === "view_file";
    const isMcpTool = toolName.startsWith("mcp_") || toolName === "call_mcp_tool";
    if (isReadTool) {
      if (permCtx.commandMode === "turbo") {
        return {
          mapped: null,
          reason: "skipped_by_turbo_mode",
          decision: "ask",
        };
      }
      const targetPath =
        args.Path ||
        args.AbsolutePath ||
        args.TargetFile ||
        args.FilePath ||
        args.path ||
        args.targetFile ||
        "";
      if (targetPath && isAutoAllowedWritePath(targetPath)) {
        return {
          mapped: null,
          reason: "read_auto_allowed_path",
          decision: "ask",
        };
      }
      if (targetPath && isReadFileGranted(targetPath, permCtx.grants)) {
        return {
          mapped: null,
          reason: "allowed_by_permission_grant",
          decision: "ask",
          logSkip: true,
        };
      }
      return {
        mapped: null,
        reason: "delayed_alert_armed_read",
        decision: "ask",
        delayAlert: {
          delayMs: getDelayMs("read"),
          toolName,
        },
      };
    }
    if (isMcpTool) {
      if (permCtx.commandMode === "turbo") {
        return {
          mapped: null,
          reason: "skipped_by_turbo_mode",
          decision: "ask",
        };
      }
      if (isMcpToolGranted(toolName, args, permCtx.grants)) {
        return {
          mapped: null,
          reason: "allowed_by_permission_grant",
          decision: "ask",
          logSkip: true,
        };
      }
      if (isTrustedMcpSkipped(toolName, args)) {
        return {
          mapped: null,
          reason: "skipped_trusted_mcp_prefix",
          decision: "ask",
        };
      }
      return {
        mapped: null,
        reason: "delayed_alert_armed_mcp",
        decision: "ask",
        delayAlert: {
          delayMs: getDelayMs("mcp"),
          toolName,
        },
      };
    }
    return {
      mapped: null,
      reason: `ignored_tool_${toolName}`,
      decision: "allow",
    };
  }
  if (hookEvent === "Stop") {
    if (payload.continuationActive) {
      return { mapped: null, reason: "continuation_active" };
    }
    if (payload.fullyIdle === false) {
      return { mapped: null, reason: "not_fully_idle" };
    }
    const reason = payload.terminationReason || "";
    if (reason === "USER_CANCELED") {
      return { mapped: null, reason: "user_canceled" };
    }
    if (reason === "ERROR" || Boolean(payload.error)) {
      const check = inspectTranscriptForStop(payload.transcriptPath);
      if (check.reason === "subagent_session") {
        return { mapped: null, reason: "subagent_error_suppressed" };
      }
      return { mapped: { hook_event_name: "StopFailure" }, reason: "stop_error" };
    }
    const check = inspectTranscriptForStop(payload.transcriptPath);
    if (check.skip) {
      return { mapped: null, reason: check.reason };
    }
    const mapped = { hook_event_name: "Stop" };
    if (check.lastAssistantMessage) {
      mapped.last_assistant_message = check.lastAssistantMessage;
    }
    return { mapped, reason: check.reason };
  }
  return { mapped: null, reason: "unhandled_event" };
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

function runSessionAlarm(mappedPayload) {
  const pythonScript = fileURLToPath(new URL("./session_alarm.py", import.meta.url));
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(...findUvPythonCandidates());
    candidates.push(["py", ["-3"]], ["python", []], ["python3", []]);
  } else {
    candidates.push(["python3", []], ["python", []]);
  }

  const stdinJson = JSON.stringify(mappedPayload);
  for (const [cmd, prefixArgs] of candidates) {
    const result = spawnSync(cmd, [...prefixArgs, pythonScript, "hook", "--source", "agy"], {
      input: stdinJson,
      encoding: "utf8",
      timeout: 9000,
      windowsHide: true,
    });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0 && result.stdout.trim().startsWith("{")) {
      try {
        return JSON.parse(result.stdout.trim());
      } catch {
        return {};
      }
    }
    return {};
  }
  return {};
}

function spawnImmediatePermissionAlert() {
  try {
    const workerScript = fileURLToPath(new URL("./delay_alert_worker.mjs", import.meta.url));
    const child = spawn(process.execPath, [workerScript, "--immediate"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    runSessionAlarm({ hook_event_name: "PermissionRequest" });
  }
}

if (hookEvent === "PostToolUse") {
  cancelDelayedAlert();
  process.stdout.write("{}\n");
  process.exit(0);
}

if (hookEvent === "Stop") {
  cancelConversationPendingAlerts(payload.conversationId);
}

const permCtx = hookEvent === "PreToolUse" ? loadAgyPermissionContext(payload.workspacePaths) : null;
const { mapped, reason, decision, logSkip, delayAlert } = buildMappedPayload(permCtx);
let output = hookEvent === "PreToolUse" ? { decision: decision || "allow" } : {};

if (hookEvent === "PreToolUse" && delayAlert) {
  armDelayedAlert(delayAlert);
}

if (hookEvent === "Stop" || (hookEvent === "PreToolUse" && (mapped || logSkip))) {
  appendHistoryLog({
    action: mapped ? "triggered" : "skipped",
    reason,
    mappedEvent: mapped?.hook_event_name || null,
    ...(hookEvent === "PreToolUse" ? { toolName: payload.toolCall?.name || null } : {}),
  });
}

if (mapped) {
  if (hookEvent === "PreToolUse" && mapped.hook_event_name === "PermissionRequest") {
    spawnImmediatePermissionAlert();
  } else {
    const saResult = runSessionAlarm(mapped);
    if (hookEvent === "SessionStart") {
      const ctx = saResult?.hookSpecificOutput?.additionalContext;
      if (ctx) {
        output = {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: ctx,
              },
            },
          ],
        };
      }
    }
  }
}

process.stdout.write(`${JSON.stringify(output)}\n`);
