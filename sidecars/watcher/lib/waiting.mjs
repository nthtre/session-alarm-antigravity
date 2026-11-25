// Pure helpers for tracking Antigravity waitingSteps across GetAllCascadeTrajectories polls.

export function parseLsEndpoint(rawAddress, rawCsrf) {
  const addr = typeof rawAddress === "string" ? rawAddress.trim() : "";
  const csrf = typeof rawCsrf === "string" ? rawCsrf.trim() : "";
  if (!addr || !csrf || addr === "test.invalid") {
    return null;
  }
  try {
    const url = new URL(addr.includes("://") ? addr : `http://${addr}`);
    const protocol = url.protocol === "https:" ? "https:" : "http:";
    const port = Number(url.port) || (protocol === "https:" ? 443 : 80);
    if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null;
    }
    return { protocol, host: url.hostname, port, csrf };
  } catch {
    return null;
  }
}

export function waitingStepKey(ws, idx) {
  if (ws && typeof ws === "object") {
    const id = ws.stepIndex ?? ws.stepIdx ?? ws.index ?? ws.toolCallId ?? ws.id;
    if (id !== undefined && id !== null && String(id) !== "") {
      return String(id);
    }
    try {
      const json = JSON.stringify(ws);
      if (json && json !== "{}") {
        return json;
      }
    } catch {
      // Fall back to index key
    }
    return `idx_${idx}`;
  }
  if (ws !== undefined && ws !== null && String(ws) !== "") {
    return String(ws);
  }
  return `idx_${idx}`;
}

export function isConversationActive(rawStatus) {
  return /RUNNING|BUSY|CANCELING|WAITING/i.test(String(rawStatus || ""));
}

export function isConversationIdle(rawStatus) {
  return /IDLE|COMPLETED|DONE/i.test(String(rawStatus || ""));
}

export function extractTrajectories(response) {
  if (
    !response ||
    typeof response !== "object" ||
    !response.trajectorySummaries ||
    typeof response.trajectorySummaries !== "object" ||
    Array.isArray(response.trajectorySummaries)
  ) {
    throw new Error("invalid_trajectory_response");
  }

  let anyRunning = false;
  const waitingByConv = new Map();

  for (const [id, value] of Object.entries(response.trajectorySummaries)) {
    const rawStatus = String(value?.status || "");
    const waitingArr = Array.isArray(value?.waitingSteps) ? value.waitingSteps : [];
    const idle = isConversationIdle(rawStatus);

    if ((isConversationActive(rawStatus) || waitingArr.length > 0) && !(idle && waitingArr.length === 0)) {
      anyRunning = true;
    }

    if (!idle && waitingArr.length > 0) {
      const keys = [];
      const seen = new Set();
      for (let i = 0; i < waitingArr.length; i++) {
        const key = waitingStepKey(waitingArr[i], i);
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
      if (keys.length > 0) {
        waitingByConv.set(id, keys);
      }
    }
  }

  return { anyRunning, waitingByConv };
}

export class WaitingTracker {
  constructor({ graceMs = 0 } = {}) {
    this.graceMs = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 0;
    this.initialized = false;
    this.firstSeen = new Map();
    this.triggered = new Set();
  }

  update(waitingByConv, nowMs = Date.now()) {
    const currentPairs = new Set();
    for (const [convId, keys] of waitingByConv) {
      for (const stepKey of keys) {
        currentPairs.add(`${convId}\0${stepKey}`);
      }
    }

    for (const pair of this.firstSeen.keys()) {
      if (!currentPairs.has(pair)) {
        this.firstSeen.delete(pair);
      }
    }
    for (const pair of this.triggered) {
      if (!currentPairs.has(pair)) {
        this.triggered.delete(pair);
      }
    }

    if (!this.initialized) {
      this.initialized = true;
      for (const pair of currentPairs) {
        this.firstSeen.set(pair, nowMs);
        this.triggered.add(pair);
      }
      return [];
    }

    const alerts = [];
    for (const [convId, keys] of waitingByConv) {
      const readyKeys = [];
      for (const stepKey of keys) {
        const pair = `${convId}\0${stepKey}`;
        if (this.triggered.has(pair)) continue;
        if (!this.firstSeen.has(pair)) {
          this.firstSeen.set(pair, nowMs);
        }
        if (nowMs - this.firstSeen.get(pair) >= this.graceMs) {
          this.triggered.add(pair);
          readyKeys.push(stepKey);
        }
      }
      if (readyKeys.length > 0) {
        alerts.push({
          conversationId: convId,
          waitingCount: keys.length,
          waitingKeys: readyKeys,
        });
      }
    }

    return alerts;
  }
}
