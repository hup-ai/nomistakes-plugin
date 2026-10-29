#!/usr/bin/env node
/** Read a pinned session or explicitly search local history; never guess which conversation the user meant. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_CHARS = 1200;
const MAX_AI_CHARS = 400;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const SEARCH_LIMITS = { files: 1000, directories: 4000, bytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, results: 30 };

function canonicalTool(tool) {
  if (tool === "claude" || tool === "claude-code") return "claude-code";
  if (tool === "codex") return "codex";
  throw new Error("Use --tool claude-code or --tool codex.");
}

function sessionFiles(dir, recursive = true) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const candidate = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive && entry.name !== "subagents") return sessionFiles(candidate);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [candidate] : [];
  });
}

function realDirectory(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/** Inspect metadata only while locating a Codex session; no unrelated messages are returned. */
function codexMetadata(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.type === "session_meta") return record.payload ?? {};
      } catch {}
    }
    return {};
  } finally { fs.closeSync(fd); }
}

/** Claude's encoded folder names can collide; verify the source cwd before scoped discovery. */
function claudeMetadata(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
      try { const record = JSON.parse(line); if (!record.isSidechain && !record.isMeta && typeof record.cwd === "string") return { cwd: record.cwd }; } catch {}
    }
    return {};
  } finally { fs.closeSync(fd); }
}

export function resolveSessionFile({ tool, file, sessionId, cwd = process.cwd(), env = process.env }) {
  tool = canonicalTool(tool);
  if (file) return fs.realpathSync(path.resolve(file));
  const claudeRoot = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const project = path.join(claudeRoot, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const root = tool === "codex" ? path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions") : project;
  const id = sessionId ?? (tool === "codex" ? env.CODEX_THREAD_ID || env.CODEX_SESSION_ID : env.CLAUDE_SESSION_ID);
  const files = sessionFiles(root, tool === "codex");
  let candidates;
  if (id) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid session id. Pass the current session transcript with --file instead.");
    candidates = files.filter((candidate) => {
      const name = path.basename(candidate, ".jsonl");
      return name === id || (tool === "codex" && name.endsWith(`-${id}`));
    });
    if (tool === "codex") candidates = candidates.filter((candidate) => codexMetadata(candidate).id === id);
  } else if (tool === "codex") {
    candidates = files.filter((candidate) => {
      const metadata = codexMetadata(candidate);
      return typeof metadata.cwd === "string" && realDirectory(metadata.cwd) === realDirectory(cwd);
    });
  } else {
    candidates = files;
  }
  if (tool === "claude-code") candidates = candidates.filter(candidate => {
    const metadata = claudeMetadata(candidate);
    return typeof metadata.cwd === "string" ? realDirectory(metadata.cwd) === realDirectory(cwd) : Boolean(id);
  });
  if (candidates.length !== 1) {
    const reason = candidates.length ? "More than one session matches" : "The current session transcript was not found";
    throw new Error(`${reason}. Pass --session-id with the current session id, or --file with its exact transcript path. No other session was selected.`);
  }
  return fs.realpathSync(candidates[0]);
}

function isNoise(text) {
  const t = text.trimStart();
  return !t || t.startsWith("<") || /^\/[a-z0-9:_-]+(\s|$)/i.test(t) || t.startsWith("[Request interrupted") || t.startsWith("Caveat:");
}

function textBlocks(content, types) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => types.includes(block.type) && typeof block.text === "string").map((block) => block.text).join("\n");
}

function parseTranscript(buffer, tool) {
  const out = [];
  const usageById = new Map();
  const observedModels = new Set();
  let model = null, totals = null, first = null, last = null, turns = 0, recognized = false, project = null;
  const lines = buffer.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try { record = JSON.parse(lines[index]); } catch { continue; }
    if (tool === "claude-code" && (record.isSidechain || record.isMeta)) continue;
    if (!project && typeof record.cwd === "string") project = record.cwd;
    if (tool === "codex") {
      if (record.type === "session_meta") { recognized = true; model ??= record.payload?.model ?? null; }
      if (record.type === "turn_context") model = record.payload?.model ?? model;
      if (typeof model === "string" && model) observedModels.add(model);
      if (record.type === "event_msg" && record.payload?.type === "token_count") totals = record.payload.info?.total_token_usage ?? totals;
    } else if ((record.type === "user" || record.type === "assistant") && record.message) {
      recognized = true;
      if (record.type === "assistant" && record.message.usage && record.message.id) usageById.set(record.message.id, record.message.usage);
      if (record.type === "assistant" && typeof record.message.model === "string" && record.message.model) observedModels.add(record.message.model);
    }
    if (record.timestamp && (tool === "codex" || record.type === "user" || record.type === "assistant")) {
      const timestamp = Date.parse(record.timestamp);
      if (Number.isFinite(timestamp)) { first = first === null ? timestamp : Math.min(first, timestamp); last = last === null ? timestamp : Math.max(last, timestamp); }
    }
    let role, text, assistantId;
    if (tool === "codex") {
      const message = record.payload;
      if (record.type !== "response_item" || message?.type !== "message") continue;
      if (message.recipient && message.recipient !== "all") continue;
      if (message.role === "assistant" && message.channel && message.channel !== "final") continue;
      if (message.role === "assistant" && message.phase && message.phase !== "final_answer") continue;
      role = message.role === "user" ? "human" : message.role === "assistant" ? "ai" : null;
      text = textBlocks(message.content, ["input_text", "output_text"]);
    } else {
      if (record.type !== "user" && record.type !== "assistant") continue;
      if (Array.isArray(record.message?.content) && record.message.content.some((block) => block.type === "tool_result")) continue;
      role = record.type === "user" ? "human" : "ai";
      text = textBlocks(record.message?.content, ["text"]);
      assistantId = record.message?.id;
    }
    if (!role || !text?.trim() || (role === "human" && isNoise(text))) continue;
    if (role === "human") turns += 1;
    // Claude may persist text blocks for one answer across multiple records.
    const messageModel = tool === "codex" ? model : role === "ai" ? record.message?.model ?? null : null;
    if (role === "ai" && assistantId && out.at(-1)?.assistantId === assistantId) {
      out.at(-1).text += `\n${text}`;
      if (out.at(-1).model !== messageModel) out.at(-1).model = null;
    } else out.push({ role, text, index, assistantId, model: messageModel });
  }
  if (!recognized) throw new Error(`This file is not a recognized ${tool} transcript. Nothing was extracted.`);
  let tokens;
  if (tool === "codex") {
    const cached = totals?.cached_input_tokens ?? 0;
    tokens = { inputTokens: Math.max((totals?.input_tokens ?? 0) - cached, 0), outputTokens: totals?.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: totals?.cache_write_input_tokens ?? 0 };
  } else {
    tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const usage of usageById.values()) {
      tokens.inputTokens += usage.input_tokens ?? 0;
      tokens.outputTokens += usage.output_tokens ?? 0;
      tokens.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      tokens.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    }
  }
  const sessionModel = observedModels.size === 1 ? [...observedModels][0] : null;
  const stats = { tool, model: sessionModel, durationSec: first === null || last === null ? null : Math.round((last - first) / 1000), turns, ...tokens };
  return { out, model: sessionModel, stats, date: first === null ? null : new Date(first).toISOString(), project };
}

function readSession(file, snapshot) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || path.extname(file) !== ".jsonl") throw new Error("The transcript must be a regular .jsonl file.");
  const size = snapshot?.bytes ?? stat.size;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES || size > stat.size) throw new Error("The transcript snapshot is missing, too large, or has changed. Run --list and --pick again.");
  const fd = fs.openSync(file, "r");
  let buffer;
  try {
    buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = fs.readSync(fd, buffer, read, size - read, read);
      if (!count) throw new Error("The transcript changed while reading it. Try again.");
      read += count;
    }
  } finally { fs.closeSync(fd); }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (snapshot && snapshot.sha256 !== sha256) throw new Error("The transcript changed since this moment was selected. Run --list and --pick again.");
  return { buffer, snapshot: { bytes: size, sha256 } };
}

function statsSummary(stats) {
  const minutes = Math.round((stats.durationSec ?? 0) / 60);
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const tokens = stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
  return `${duration} in, ${stats.turns} turns, ${tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1e3)}k`} tokens`;
}

/** A search scans local human text only. Results are candidates, never permission to upload one. */
export function searchMoments({ tool, query, project, allProjects = false, limit = 10, cwd = process.cwd(), env = process.env }) {
  tool = canonicalTool(tool);
  const normalize = text => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (typeof query !== "string" || query.trim().length < 2 || query.length > 160) throw new Error("--search needs a phrase of 2–160 characters. Search terms are literal text, not a regular expression.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.results) throw new Error("Search --limit must be an integer from 1 to 30.");
  if (project && allProjects) throw new Error("Use --project or --all-projects, not both.");
  const projectDirectory = realDirectory(project ? path.resolve(cwd, project) : cwd);
  const claudeRoot = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
  const root = tool === "codex" ? path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions") : allProjects ? claudeRoot : path.join(claudeRoot, projectDirectory.replace(/[^A-Za-z0-9]/g, "-"));
  const files = [];
  let visitedDirectories = 0, truncated = false, scannedBytes = 0, scannedFiles = 0, skippedFiles = 0;
  const collect = directory => {
    if (++visitedDirectories > SEARCH_LIMITS.directories) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= SEARCH_LIMITS.files || visitedDirectories > SEARCH_LIMITS.directories) { truncated = true; return; }
      const candidate = path.join(directory, entry.name);
      // Never follow symlinks or enter subagent stores, including cross-project searches.
      if (entry.isDirectory() && entry.name !== "subagents") collect(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith("agent-")) {
        try { const stat = fs.statSync(candidate); files.push({ file: candidate, size: stat.size, modified: stat.mtimeMs }); } catch { skippedFiles++; }
      }
    }
  };
  collect(root);
  // Recent candidates first is a display order, never an automatic selection.
  files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
  const matches = [];
  const needle = normalize(query);
  for (const candidate of files) {
    if (matches.length >= limit) { truncated = true; break; }
    if (scannedBytes >= SEARCH_LIMITS.bytes) { truncated = true; break; }
    let buffer, metadata = {};
    try {
      if (tool === "codex") {
        const bytes = Math.min(candidate.size, 64 * 1024, SEARCH_LIMITS.bytes - scannedBytes);
        const fd = fs.openSync(candidate.file, "r");
        try { const prefix = Buffer.alloc(bytes); const read = fs.readSync(fd, prefix, 0, bytes, 0); scannedBytes += read;
          for (const line of prefix.subarray(0, read).toString("utf8").split("\n")) { try { const record = JSON.parse(line); if (record.type === "session_meta") { metadata = record.payload ?? {}; break; } } catch {} }
        } finally { fs.closeSync(fd); }
        if (!metadata.id || metadata.source === "subagent" || (typeof metadata.source === "object" && metadata.source !== null && "subagent" in metadata.source)) { skippedFiles++; continue; }
        if (!allProjects && (typeof metadata.cwd !== "string" || realDirectory(metadata.cwd) !== projectDirectory)) continue;
      }
      if (candidate.size < 1 || candidate.size > SEARCH_LIMITS.fileBytes || candidate.size > SEARCH_LIMITS.bytes - scannedBytes) { skippedFiles++; truncated = true; continue; }
      const fd = fs.openSync(candidate.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const size = fs.fstatSync(fd).size;
        if (size > SEARCH_LIMITS.fileBytes || size > SEARCH_LIMITS.bytes - scannedBytes) { skippedFiles++; truncated = true; continue; }
        buffer = Buffer.alloc(size);
        let bytes = 0;
        while (bytes < size) { const read = fs.readSync(fd, buffer, bytes, size - bytes, bytes); if (!read) break; bytes += read; }
        buffer = buffer.subarray(0, bytes);
      } finally { fs.closeSync(fd); }
      scannedBytes += buffer.length;
      scannedFiles++;
      const parsed = parseTranscript(buffer, tool);
      if (tool === "claude-code" && !allProjects && (!parsed.project || realDirectory(parsed.project) !== projectDirectory)) { skippedFiles++; if (!parsed.project) truncated = true; continue; }
      const snapshot = { bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
      const { out } = parsed;
      for (const message of out) {
        if (message.role !== "human" || !normalize(message.text).includes(needle)) continue;
        if (matches.length >= limit) { truncated = true; break; }
        const collapsed = message.text.replace(/\s+/g, " ").trim();
        const lower = normalize(collapsed);
        const at = Math.max(0, lower.indexOf(needle));
        const start = Math.max(0, at - 45);
        const preview = `${start ? "…" : ""}${collapsed.slice(start, start + 180)}${collapsed.length > start + 180 ? "…" : ""}`;
        matches.push({ n: matches.length + 1, index: message.index, sessionFile: fs.realpathSync(candidate.file), snapshot, date: parsed.date ?? new Date(candidate.modified).toISOString(), dateSource: parsed.date ? "session" : "file-modified", project: tool === "codex" ? metadata.cwd ?? null : parsed.project ?? null, preview, eligible: message.text.length <= MAX_CHARS, characters: message.text.length });
      }
    } catch { skippedFiles++; }
  }
  const menu = matches.map(match => `${String(match.n).padStart(2)}. ${match.date.slice(0, 10)} · ${match.preview}${match.eligible ? "" : ` [too long: ${match.characters} characters]`}`).join("\n");
  return { tool, query, scope: allProjects ? "all-projects" : projectDirectory, matches, menu, count: matches.length, scannedFiles, scannedBytes, skippedFiles, truncated, limits: { ...SEARCH_LIMITS } };
}

export function listMoments({ tool, file, limit = 12, ...options }) {
  tool = canonicalTool(tool);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer from 1 to 100.");
  file = resolveSessionFile({ tool, file, ...options });
  const { buffer } = readSession(file);
  const { out, model } = parseTranscript(buffer, tool);
  const picks = out.filter((message) => message.role === "human").slice(-limit).map((message, n) => {
    const oneLine = message.text.replace(/\s+/g, " ").trim();
    return { n: n + 1, index: message.index, preview: oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine, eligible: message.text.length <= MAX_CHARS, characters: message.text.length };
  });
  const menu = picks.map((pick) => `${String(pick.n).padStart(2)}. ${pick.preview}${pick.eligible ? "" : ` [too long: ${pick.characters} characters]`}`).join("\n");
  return { tool, model, sessionFile: file, count: picks.length, picks, menu };
}

/** The submit helper re-reads this exact snapshot instead of trusting hand-written message JSON. */
export function extractMoment({ tool, file, index, snapshot, ...options }) {
  tool = canonicalTool(tool);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("--pick must be a non-negative message index from --list.");
  file = resolveSessionFile({ tool, file, ...options });
  const read = readSession(file, snapshot);
  const { out, stats } = parseTranscript(read.buffer, tool);
  const at = out.findIndex((message) => message.index === index && message.role === "human");
  if (at < 0) throw new Error("That human message was not found in this session. Run --list again.");
  const chosen = out[at];
  const model = out[at + 1]?.role === "ai" ? out[at + 1].model : chosen.model;
  if (chosen.text.length > MAX_CHARS) throw new Error(`This line is ${chosen.text.length} characters; the limit is ${MAX_CHARS}. Choose another line. Human words are never silently shortened.`);
  const messages = [];
  const aiContext = (message) => ({ role: "ai", text: message.text.length > MAX_AI_CHARS ? `${message.text.slice(0, MAX_AI_CHARS - 1)}…` : message.text });
  if (out[at - 1]?.role === "ai") messages.push(aiContext(out[at - 1]));
  messages.push({ role: "human", text: chosen.text });
  if (out[at + 1]?.role === "ai") messages.push(aiContext(out[at + 1]));
  return { tool, model, sessionFile: file, snapshot: read.snapshot, picked: { index, text: chosen.text }, messages, stats, statsSummary: statsSummary(stats) };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--list" || flag === "--all-projects") { const key = flag === "--list" ? "list" : "all-projects"; if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: ${flag}`); options[key] = true; continue; }
    if (!["--tool", "--file", "--session-id", "--limit", "--pick", "--output", "--search", "--project", "--snapshot-bytes", "--snapshot-sha256"].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Invalid argument: ${flag}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: ${flag}`);
    options[key] = argv[++i];
  }
  if ([!!options.list, options.pick !== undefined, options.search !== undefined].filter(Boolean).length !== 1) throw new Error("Use --list, --pick <index>, or --search <phrase>.");
  if (options.output && options.pick === undefined) throw new Error("--output is only available with --pick.");
  if ((options.project || options["all-projects"]) && options.search === undefined) throw new Error("--project and --all-projects are only available with --search.");
  if (options.search !== undefined && (options.file || options["session-id"])) throw new Error("Search uses a project scope, not --file or --session-id.");
  if (options["snapshot-bytes"] || options["snapshot-sha256"]) {
    if (options.pick === undefined || !options["snapshot-bytes"] || !/^[a-f0-9]{64}$/.test(options["snapshot-sha256"] ?? "")) throw new Error("Use both --snapshot-bytes and --snapshot-sha256 only with --pick.");
  }
  return options;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const options = { tool: args.tool, file: args.file, sessionId: args["session-id"], ...(args["snapshot-bytes"] ? { snapshot: { bytes: Number(args["snapshot-bytes"]), sha256: args["snapshot-sha256"] } } : {}) };
    const result = args.search !== undefined ? searchMoments({ tool: args.tool, query: args.search, project: args.project, allProjects: args["all-projects"] ?? false, limit: Number(args.limit ?? 10) }) : args.list ? listMoments({ ...options, limit: Number(args.limit ?? 12) }) : extractMoment({ ...options, index: Number(args.pick) });
    if (args.output) fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, messages: [] }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
