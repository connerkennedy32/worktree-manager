"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const pty = require("node-pty");
const os = require("os");
const crypto = require("crypto");
const protocol = require("./chunks/protocol-G_dq-gNN.js");
const child_process = require("child_process");
const http = require("http");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const net__namespace = /* @__PURE__ */ _interopNamespaceDefault(net);
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
const http__namespace = /* @__PURE__ */ _interopNamespaceDefault(http);
const MAX_BUFFER = 2e5;
class PtyManager {
  sessions = /* @__PURE__ */ new Map();
  start(worktreePath, onData, extraEnv = {}) {
    if (this.sessions.has(worktreePath)) return;
    const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "bash");
    const args = os.platform() === "win32" ? [] : ["-l"];
    const id = crypto.randomUUID();
    const proc = pty__namespace.spawn(shell, args, {
      name: "xterm-color",
      cols: 100,
      rows: 30,
      cwd: worktreePath,
      env: { ...process.env, ...extraEnv, WTM_TERMINAL_ID: id }
    });
    const session = { proc, buffer: "", id };
    proc.onData((d) => {
      session.buffer += d;
      if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER);
      onData(d);
    });
    proc.onExit(() => this.sessions.delete(worktreePath));
    this.sessions.set(worktreePath, session);
  }
  has(worktreePath) {
    return this.sessions.has(worktreePath);
  }
  getBuffer(worktreePath) {
    return this.sessions.get(worktreePath)?.buffer ?? "";
  }
  list() {
    return [...this.sessions.keys()];
  }
  id(worktreePath) {
    return this.sessions.get(worktreePath)?.id;
  }
  pid(worktreePath) {
    return this.sessions.get(worktreePath)?.proc.pid;
  }
  pathForId(id) {
    for (const [path2, s] of this.sessions) if (s.id === id) return path2;
    return void 0;
  }
  // Resolve a hook's reported cwd to the worktree that owns it. The agent may
  // run in a subdirectory of the worktree, so match by longest path prefix
  // rather than exact equality. Identifying by cwd (from the hook payload)
  // instead of an inherited env var is what makes status survive tmux, which
  // does not propagate per-pane env into the agent's process.
  pathForCwd(cwd) {
    let best;
    for (const path2 of this.sessions.keys()) {
      if (cwd === path2 || cwd.startsWith(`${path2}/`)) {
        if (!best || path2.length > best.length) best = path2;
      }
    }
    return best;
  }
  write(worktreePath, data) {
    this.sessions.get(worktreePath)?.proc.write(data);
  }
  resize(worktreePath, cols, rows) {
    try {
      this.sessions.get(worktreePath)?.proc.resize(cols, rows);
    } catch {
    }
  }
  kill(worktreePath) {
    this.sessions.get(worktreePath)?.proc.kill();
    this.sessions.delete(worktreePath);
  }
  killAll() {
    for (const [, s] of this.sessions) s.proc.kill();
    this.sessions.clear();
  }
}
const EVENTS = {
  UserPromptSubmit: "working",
  // A turn can run many tools; each one re-asserts working so a long turn
  // never decays to done.
  PostToolUse: "working",
  // A failed tool call does not end the turn — the agent is still going.
  PostToolUseFailure: "working",
  PermissionRequest: "permission",
  Stop: "done",
  StopFailure: "failed",
  SessionEnd: "none"
};
function mapHookEvent(event) {
  return EVENTS[event] ?? null;
}
const LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
function parseProcessTable(psOutput) {
  const entries = [];
  for (const line of psOutput.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const comm = m[3].trim();
    if (!comm) continue;
    entries.push({ pid: Number(m[1]), ppid: Number(m[2]), comm });
  }
  return entries;
}
function isAgentComm(comm) {
  const first = comm.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1) === "claude";
}
function buildChildIndex(entries) {
  const children = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const siblings = children.get(e.ppid);
    if (siblings) siblings.push(e);
    else children.set(e.ppid, [e]);
  }
  return children;
}
function hasDescendantMatching(entries, rootPid, match) {
  const children = buildChildIndex(entries);
  const visited = /* @__PURE__ */ new Set([rootPid]);
  const queue = [...children.get(rootPid) ?? []];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (visited.has(entry.pid)) continue;
    visited.add(entry.pid);
    if (match(entry)) return true;
    queue.push(...children.get(entry.pid) ?? []);
  }
  return false;
}
function hasAgentDescendant(entries, rootPid) {
  return hasDescendantMatching(entries, rootPid, (e) => isAgentComm(e.comm));
}
function isTmuxComm(comm) {
  const first = comm.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1) === "tmux";
}
function detachedTmuxServerPids(entries) {
  return entries.filter((e) => e.ppid === 1 && isTmuxComm(e.comm)).map((e) => e.pid);
}
function hasAgentDescendantThroughTmux(entries, rootPid) {
  if (hasAgentDescendant(entries, rootPid)) return true;
  if (!hasDescendantMatching(entries, rootPid, (e) => isTmuxComm(e.comm))) return false;
  return detachedTmuxServerPids(entries).some((serverPid) => hasAgentDescendant(entries, serverPid));
}
function readProcessTable() {
  return new Promise((resolve, reject) => {
    child_process.exec("ps -axo pid,ppid,comm", { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
const SWEEP_MS = 2e3;
class AgentTracker {
  constructor(sessions2, emit, readTable = readProcessTable, now = Date.now) {
    this.sessions = sessions2;
    this.emit = emit;
    this.readTable = readTable;
    this.now = now;
  }
  reports = /* @__PURE__ */ new Map();
  timer;
  /** Called for each hook POST. `cwd` is the agent's working directory. */
  handleHook(cwd, event) {
    const path2 = this.sessions.pathForCwd(cwd);
    if (!path2) return;
    const status = mapHookEvent(event);
    if (!status) return;
    const at = this.now();
    if (status === "none") {
      this.reports.delete(path2);
    } else {
      this.reports.set(path2, { status, at });
    }
    this.emit(path2, { status, at });
  }
  /**
   * Clears statuses whose agent is gone. Skips the `ps` entirely when nothing is
   * active, so an idle machine does no work.
   */
  async sweep() {
    if (this.reports.size === 0) return;
    let entries;
    try {
      entries = parseProcessTable(await this.readTable());
    } catch {
      return;
    }
    const live = new Set(this.sessions.list());
    for (const path2 of [...this.reports.keys()]) {
      const pid = this.sessions.pid(path2);
      const gone = !live.has(path2) || pid === void 0 || !hasAgentDescendantThroughTmux(entries, pid);
      if (!gone) continue;
      this.reports.delete(path2);
      this.emit(path2, { status: "none", at: this.now() });
    }
  }
  snapshot() {
    return Object.fromEntries(this.reports);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
  }
}
const MAX_BODY = 64 * 1024;
function startHookServer(socketPath2, onHook) {
  try {
    fs.unlinkSync(socketPath2);
  } catch {
  }
  const server2 = http__namespace.createServer((req, res) => {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      if (tooBig) return;
      try {
        const { cwd, event } = JSON.parse(body);
        if (typeof cwd === "string" && typeof event === "string") onHook(cwd, event);
      } catch {
      }
    });
  });
  server2.on("error", (e) => process.stderr.write(`[pty-daemon] hook server: ${e}
`));
  server2.listen(socketPath2);
  server2.setTimeout(1e4);
  return server2;
}
const REQUIRED_NAMES = ["WTM_TERMINAL_ID", "WTM_HOOK_SOCKET"];
function parseUpdateEnvironment(raw) {
  const names = [];
  for (const line of raw.split("\n")) {
    const m = /^update-environment\[\d+\]\s+(\S+)\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}
function mergeUpdateEnvironment(current, additions) {
  const merged = [...current];
  for (const name of additions) if (!merged.includes(name)) merged.push(name);
  return merged;
}
function run(cmd) {
  return new Promise((resolve, reject) => {
    child_process.exec(cmd, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
async function ensureTmuxUpdateEnvironment(names = REQUIRED_NAMES) {
  try {
    const raw = await run("tmux show-options -g update-environment");
    const current = parseUpdateEnvironment(raw);
    const merged = mergeUpdateEnvironment(current, names);
    if (merged.length === current.length) return;
    await run(`tmux set-option -g update-environment "${merged.join(" ")}"`);
  } catch {
  }
}
function configDir() {
  const dir = process.env.WTM_DAEMON_CONFIG_DIR || process.env.WTM_CONFIG_DIR;
  if (!dir) throw new Error("WTM_DAEMON_CONFIG_DIR (or WTM_CONFIG_DIR) must be set");
  return dir;
}
const socketPath = path__namespace.join(configDir(), "pty-daemon.sock");
const manifestPath = path__namespace.join(configDir(), "pty-daemon.json");
const hookSocketPath = path__namespace.join(configDir(), "agent-hook.sock");
const sessions = new PtyManager();
const clients = /* @__PURE__ */ new Set();
function broadcast(message) {
  const frame = protocol.encodeFrame(message);
  for (const sock of clients) sock.write(frame);
}
const agents = new AgentTracker(sessions, (p, report) => broadcast({ type: "agentStatus", path: p, report }));
agents.start();
startHookServer(hookSocketPath, (cwd, event) => agents.handleHook(cwd, event));
function startSession(worktreePath) {
  sessions.start(worktreePath, (chunk) => broadcast({ type: "data", path: worktreePath, chunk }), {
    WTM_HOOK_SOCKET: hookSocketPath
  });
  void ensureTmuxUpdateEnvironment();
}
function handleMessage(sock, message) {
  switch (message.type) {
    case "hello":
      sock.write(protocol.encodeFrame({ type: "welcome", version: protocol.PROTOCOL_VERSION }));
      for (const [p, report] of Object.entries(agents.snapshot())) {
        sock.write(protocol.encodeFrame({ type: "agentStatus", path: p, report }));
      }
      return;
    case "start":
      if (!sessions.has(message.path)) startSession(message.path);
      return;
    case "input":
      sessions.write(message.path, message.data);
      return;
    case "resize":
      sessions.resize(message.path, message.cols, message.rows);
      return;
    case "reset":
      sessions.kill(message.path);
      startSession(message.path);
      return;
    case "kill":
      sessions.kill(message.path);
      return;
    case "killAll":
      sessions.killAll();
      return;
    case "list":
      sock.write(protocol.encodeFrame({ type: "list", reqId: message.reqId, paths: sessions.list() }));
      return;
    case "replayRequest":
      sock.write(protocol.encodeFrame({
        type: "replayResponse",
        reqId: message.reqId,
        path: message.path,
        buffer: sessions.getBuffer(message.path)
      }));
      return;
  }
}
fs__namespace.mkdirSync(configDir(), { recursive: true });
try {
  fs__namespace.unlinkSync(socketPath);
} catch {
}
const server = net__namespace.createServer((sock) => {
  clients.add(sock);
  const decoder = new protocol.FrameDecoder();
  sock.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) handleMessage(sock, message);
  });
  sock.on("close", () => clients.delete(sock));
  sock.on("error", () => clients.delete(sock));
});
server.listen(socketPath, () => {
  fs__namespace.writeFileSync(manifestPath, JSON.stringify({
    pid: process.pid,
    socketPath,
    version: protocol.PROTOCOL_VERSION
  }));
  process.stderr.write(`[pty-daemon] listening on ${socketPath} (pid=${process.pid})
`);
});
