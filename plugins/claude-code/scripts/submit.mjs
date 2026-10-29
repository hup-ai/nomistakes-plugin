#!/usr/bin/env node
/** Draft upload from a pinned local session. Credentials are local, per origin and tool. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const sha256 = value => createHash("sha256").update(value).digest("hex");
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}
function siteUrl() {
  let value = process.env.NOMISTAKES_URL;
  if (!value) {
    try { value = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json"), "utf8")).url; }
    catch (err) { if (err.code !== "ENOENT") throw new Error("Invalid plugin config.json. Reinstall the plugin."); }
  }
  const url = new URL(value || "https://makenomistakes.sh");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS website origin (HTTP is allowed only on loopback for development).");
  }
  return url.origin;
}
function stateFile(base, tool, createDirectory = true) {
  const directory = process.env.NOMISTAKES_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "nomistakes");
  if (createDirectory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${sha256(`${base}:${tool}`)}.json`);
}
const pendingFile = file => file.replace(/\.json$/, ".pending.json");
const receiptFile = file => file.replace(/\.json$/, ".receipt.json");
function save(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { if (err.code === "ENOENT") return null; throw new Error("Cannot read the installation credential. Restore it or remove that credential file to reconnect."); }
}
function mutationLock(file) {
  const directory = `${file}.locks`;
  const ownName = `${process.pid}-${randomUUID()}.json`;
  const ownFile = path.join(directory, ownName);
  const busy = () => new Error("Another plugin command is using this website and tool. Let it finish, then retry. Your selection and credentials were preserved.");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = () => {
    fs.rmSync(ownFile, { force: true });
    try { fs.rmdirSync(directory); } catch (err) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) throw err; }
  };
  try {
    // A filesystem bakery lock: each process owns a unique claim, then orders tickets.
    // Dead owners can be removed safely because their UUID filenames are never reused.
    fs.writeFileSync(ownFile, JSON.stringify({ pid: process.pid, choosing: true, ticket: 0 }), { flag: "wx", mode: 0o600 });
    const others = () => fs.readdirSync(directory).filter(name => name !== ownName && name.endsWith(".json")).flatMap(name => {
      const claimFile = path.join(directory, name);
      let claim;
      try { claim = JSON.parse(fs.readFileSync(claimFile, "utf8")); }
      catch (err) { if (err.code === "ENOENT") return []; throw busy(); }
      if (!Number.isSafeInteger(claim.pid) || claim.pid < 1 || !Number.isSafeInteger(claim.ticket) || claim.ticket < 0 || typeof claim.choosing !== "boolean" || !name.startsWith(`${claim.pid}-`)) throw busy();
      try { process.kill(claim.pid, 0); }
      catch (err) {
        if (err.code === "ESRCH") { fs.rmSync(claimFile, { force: true }); return []; }
        if (err.code !== "EPERM") throw busy();
      }
      return [{ ...claim, name }];
    });
    const ticket = Math.max(0, ...others().map(claim => claim.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw busy();
    save(ownFile, { pid: process.pid, choosing: false, ticket });
    if (others().some(claim => claim.choosing || claim.ticket < ticket || (claim.ticket === ticket && claim.name < ownName))) throw busy();
    return release;
  } catch (err) {
    release();
    if (err.code === "ENOENT") throw busy(); // A just-finished owner removed an empty lock directory.
    throw err;
  }
}
async function request(base, route, { method = "GET", body = "", state, nonce = randomUUID() } = {}) {
  const headers = { "user-agent": "nomistakes-plugin/0.5" };
  if (body) headers["content-type"] = "application/json";
  if (state) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = ["nomistakes-v1", state.id, method, route, timestamp, nonce, sha256(body)].join("\n");
    Object.assign(headers, {
      "x-nomistakes-installation": state.id,
      "x-nomistakes-timestamp": timestamp,
      "x-nomistakes-nonce": nonce,
      "x-nomistakes-signature": sign(null, Buffer.from(canonical), state.privateKey).toString("base64url"),
    });
  }
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.issues) ? ` ${data.issues.join("; ")}` : "";
    throw new Error(`Request failed (${response.status}): ${data.error || "The service is unavailable."}${detail}`);
  }
  return data;
}
function showApproval(state, tool) {
  console.log("Connect this installation once before uploading any conversation.");
  console.log(`Open: ${state.verificationUrl}`);
  console.log(`Enter this code yourself: ${state.code}`);
  console.log(`Key fingerprint: ${state.fingerprint}`);
  console.log(`After approving in your browser, run ${tool === "claude-code" ? "/nomistakes:nomistakes" : "/nomistakes"} resume. Do not let the agent approve its own connection.`);
}

/** Sanitized diagnostics are read-only: no registration, quote selection or upload. */
async function doctor(tool) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const runtime = Number(process.versions.node.split(".")[0]) >= 20;
  add("runtime", runtime ? "pass" : "fail", runtime ? `Node.js ${process.versions.node} is supported.` : "Install Node.js 20 or newer, then restart your assistant.");
  let base = null, extractor = null, state = null, installation = "unconnected", pending = false;
  try { base = siteUrl(); add("origin", "pass", "Configured website origin is valid."); }
  catch { add("origin", "fail", "Reinstall from the intended HTTPS website, or use an HTTP loopback origin for local development."); }
  try {
    extractor = await import("./extract.mjs");
    if (typeof extractor.resolveSessionFile !== "function" || typeof extractor.extractMoment !== "function") throw new Error("Incompatible extractor");
    add("extractor", "pass", "The installed transcript helper is available.");
  } catch { extractor = null; add("extractor", "fail", "The transcript helper is missing or incompatible. Reinstall the complete plugin."); }
  if (extractor) {
    try { extractor.resolveSessionFile({ tool }); add("currentSession", "pass", "The current conversation is unambiguous. No conversation text is included in this report."); }
    catch { add("currentSession", "warn", "Run this inside the intended assistant conversation, or explicitly search an older conversation. No other conversation was selected."); }
  }
  if (base) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok || (await response.json()).ok !== true) throw new Error("Unavailable");
      add("website", "pass", "The website and its database responded.");
    } catch { add("website", "fail", "The configured website is unavailable. Start the local app or check the intended public deployment; local history search still works."); }
    const file = stateFile(base, tool, false);
    try {
      state = load(file);
      if (!state?.id) add("installation", "warn", "This tool is not connected. Choose a moment, then run --connect with this tool.");
      else {
        const status = await request(base, `/api/agent/installations/${state.id}`, { state });
        installation = status.status;
        const message = { active: "The installation signature is valid and uploads are enabled.", pending: "Browser approval is pending. Run --connect to show the private link and code again.", expired: "The approval link expired. Run --connect to request a fresh connection.", revoked: "The installation was disconnected. Run --connect only when you want to reconnect." }[installation];
        if (!message) throw new Error("Unknown status");
        add("installation", installation === "active" ? "pass" : "warn", message);
      }
    } catch { add("installation", "fail", "The installation credential could not be verified. Check website availability and your clock; existing credentials were preserved."); }
    try {
      const saved = readSelection(base, tool, file);
      pending = Boolean(saved && saved.origin === base && saved.tool === tool);
      add("savedSelection", pending ? "pass" : "info", pending ? "A private selection is saved. --resume will re-verify its original transcript before uploading." : "There is no saved selection for this website and tool.");
    } catch { add("savedSelection", "warn", "A saved selection could not be read. Use --discard-pending only if you want to replace it."); }
  }
  const failed = checks.some(check => check.status === "fail");
  const readyToUpload = !failed && installation === "active";
  const nextAction = failed ? "Resolve the failed checks, then run --doctor again. No data was uploaded or reset." : pending ? installation === "active" ? `Run --resume --tool ${tool} to re-verify and upload your saved selection.` : `Run --connect --tool ${tool}, approve the browser connection yourself, then --resume --tool ${tool}.` : installation === "active" ? "Choose a line from this conversation or explicitly search your local history." : `Choose a moment, then run --connect --tool ${tool} and approve the browser connection yourself.`;
  console.log(JSON.stringify({ version: "0.5", tool, origin: base, checks, readyToUpload, localSearchAvailable: runtime && Boolean(extractor), nextAction }, null, 2));
  if (failed) process.exitCode = 1;
}

function readMoment(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 40_000) throw new Error("The selected moment must be a JSON file no larger than 40,000 bytes.");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("The selected moment file cannot be read. Extract the moment again."); }
}
async function prepareSelection(base, tool, file, moment, title, handle) {
  if (!moment || !moment.sessionFile || !moment.snapshot || !Number.isInteger(moment.picked?.index)) throw new Error("Select a moment with extract.mjs --pick ... --output ... first.");
  if (moment.tool !== tool) throw new Error("The selected moment and installation use different tools.");
  title = title?.trim();
  if (!title || title.length < 3 || title.length > 90) throw new Error("Give the entry a title between 3 and 90 characters.");
  if (handle && (handle.length > 32 || !/^[A-Za-z0-9_.\- ]*$/.test(handle))) throw new Error("Use a credit of at most 32 letters, numbers, spaces, _ . or -.");
  const { extractMoment } = await import("./extract.mjs");
  const selected = extractMoment({ tool, file: moment.sessionFile, index: moment.picked.index, snapshot: moment.snapshot });
  // Keep a pointer and hash, never the quotation or whole session, outside temporary folders.
  const pending = { version: 1, origin: base, tool, title, handle: handle || null, sessionFile: selected.sessionFile, index: selected.picked.index, snapshot: selected.snapshot };
  const existing = load(pendingFile(file));
  if (existing && JSON.stringify(existing) !== JSON.stringify(pending)) throw new Error("A different selection is already saved. Resume it, or use --discard-pending before replacing it.");
  save(pendingFile(file), pending);
  return pending;
}
function readSelection(base, tool, file) {
  const pending = load(pendingFile(file));
  if (!pending) return null;
  if (pending.version !== 1 || pending.origin !== base || pending.tool !== tool || typeof pending.sessionFile !== "string" || !path.isAbsolute(pending.sessionFile) ||
      !Number.isSafeInteger(pending.snapshot?.bytes) || pending.snapshot.bytes < 1 || !/^[a-f0-9]{64}$/.test(pending.snapshot?.sha256 ?? "") ||
      !Number.isInteger(pending.index) || pending.index < 0 || typeof pending.title !== "string" || pending.title.trim().length < 3 || pending.title.length > 90 ||
      (pending.handle !== null && (typeof pending.handle !== "string" || pending.handle.length > 32 || !/^[A-Za-z0-9_.\- ]*$/.test(pending.handle)))) throw new Error("The saved selection is incompatible. Use --discard-pending and choose the moment again.");
  return pending;
}
function showReceipt(receipt, base, recent = false) {
  const edit = new URL(receipt.editUrl);
  if (edit.origin !== base || !/^\/s\/[^/]+\/edit$/.test(edit.pathname)) throw new Error("The service returned an unexpected draft URL.");
  console.log(recent ? "Your most recent private draft is already saved here:" : "Drafted. Nothing is public yet. Check your words, credit and private notification email here:");
  console.log(edit.toString());
  console.log("Unpublished drafts expire after 30 days. Keep your private link to edit or delete it.");
}
async function connect(base, tool, file, allowEnrollment = true) {
  let state = load(file);
  if (state?.id) {
    const status = await request(base, `/api/agent/installations/${state.id}`, { state });
    if (status.status === "active") return state;
    if (status.status === "pending") { showApproval(state, tool); return null; }
    if (!["expired", "revoked"].includes(status.status)) throw new Error("Unknown installation status. Reconnect after checking the website.");
  }
  if (!allowEnrollment) throw new Error(`This tool needs a new connection. Your selection and existing credential are preserved. Run --connect --tool ${tool}, approve it yourself, then resume.`);
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const enrollment = await request(base, "/api/agent/installations", { method: "POST", body: JSON.stringify({ source: tool, publicKey: keys.publicKey }) });
  const verification = new URL(enrollment.verificationUrl);
  if (verification.origin !== base || !/^\/plugin\/connect\//.test(verification.pathname)) throw new Error("The service returned an unexpected connection URL.");
  state = { ...enrollment, privateKey: keys.privateKey, source: tool, origin: base };
  save(file, state);
  showApproval(state, tool);
  return null;
}
async function main() {
  const modes = ["--doctor", "--connect", "--disconnect", "--prepare", "--resume", "--discard-pending"];
  const allowed = new Set([...modes, "--tool", "--moment", "--title", "--handle"]);
  const seen = new Set();
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (!allowed.has(flag)) throw new Error("Use --moment <extractor-output.json> --title <title>, --resume, --doctor or --connect with --tool codex|claude-code. Raw JSON uploads are no longer supported.");
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (!modes.includes(flag)) { option(flag); index++; }
  }
  const selectedModes = modes.filter(mode => seen.has(mode));
  if (selectedModes.length > 1) throw new Error("Choose one action: doctor, connect, disconnect, prepare, resume or discard-pending.");
  const mode = selectedModes[0];
  if (mode && !["--prepare"].includes(mode) && ["--moment", "--title", "--handle"].some(flag => seen.has(flag))) throw new Error("This action does not take a moment, title or credit.");
  let moment;
  const momentFile = option("--moment");
  if (momentFile) moment = readMoment(momentFile);
  const tool = option("--tool") || moment?.tool;
  if (!["codex", "claude-code"].includes(tool)) throw new Error("Choose --tool codex or --tool claude-code.");
  if (mode === "--doctor") return doctor(tool);
  const base = siteUrl();
  if (!mode && !moment) throw new Error("Choose a moment first, or use --resume with this tool to recover a saved selection.");
  if (mode === "--prepare" && !moment) throw new Error("Choose a moment with --moment and --title before saving it.");
  const file = stateFile(base, tool);
  const release = mutationLock(file);
  try {
    if (mode === "--discard-pending") {
      fs.rmSync(pendingFile(file), { force: true });
      console.log("Saved selection removed. No draft was uploaded or deleted on the website.");
      return;
    }
    if (mode === "--disconnect") {
      const state = load(file);
      if (state?.id) await request(base, `/api/agent/installations/${state.id}`, { method: "DELETE", state });
      for (const local of [file, pendingFile(file), receiptFile(file)]) fs.rmSync(local, { force: true });
      console.log("Disconnected. This installation can no longer upload drafts. Its local saved selection and draft receipt were removed.");
      return;
    }
    let pending;
    if (moment) pending = await prepareSelection(base, tool, file, moment, option("--title"), option("--handle"));
    if (mode === "--prepare") {
      console.log("Selection saved privately. No conversation was uploaded. You can close this chat or remove its temporary selection file.");
      console.log(`Next: --connect --tool ${tool}, then --resume --tool ${tool}. The original local transcript must remain available.`);
      return;
    }
    if (mode === "--resume") {
      pending = readSelection(base, tool, file);
      if (!pending) {
        const receipt = load(receiptFile(file));
        if (receipt) return showReceipt(receipt, base, true);
        throw new Error("There is no saved selection or draft for this website and tool. Choose a moment first.");
      }
    }
    // A connection request never reads or sends conversation content.
    const state = await connect(base, tool, file, mode !== "--resume");
    if (!state) {
      if (pending || load(pendingFile(file))) console.log(`Your chosen moment is saved privately. After approval, run --resume --tool ${tool}; you do not need to select it again.`);
      process.exitCode = 2; return;
    }
    if (mode === "--connect") {
      console.log("Connected. The plugin can upload private drafts.");
      if (load(pendingFile(file))) console.log(`Your saved selection is ready. Run --resume --tool ${tool}.`);
      return;
    }
    const { extractMoment } = await import("./extract.mjs");
    const selected = extractMoment({ tool, file: pending.sessionFile, index: pending.index, snapshot: pending.snapshot });
    // Re-read the pinned transcript. Never trust agent-authored messages or stats in a JSON payload.
    const payload = { title: pending.title, handle: pending.handle, source: tool, model: selected.model, messages: selected.messages, project: null, stats: selected.stats };
    const body = JSON.stringify(payload);
    const data = await request(base, "/api/submissions", { method: "POST", body, state, nonce: sha256(body) });
    // Persist the private receipt before removing the recoverable selection, including on process restart.
    const edit = new URL(data.editUrl);
    if (edit.origin !== base || !/^\/s\/[^/]+\/edit$/.test(edit.pathname)) throw new Error("The service returned an unexpected draft URL.");
    save(receiptFile(file), { editUrl: edit.toString(), createdAt: new Date().toISOString() });
    fs.rmSync(pendingFile(file), { force: true });
    if (selected.statsSummary) console.log(`Printed under it: ${selected.statsSummary}`);
    showReceipt(data, base);
  } finally { release(); }
}
main().catch(err => {
  console.error(err.name === "TimeoutError" ? "The service timed out. Your selection is preserved. Use --resume with this tool; it will reuse the draft if the first request succeeded." : err.message);
  process.exitCode = 1;
});
