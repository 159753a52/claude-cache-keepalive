#!/usr/bin/env node
// Prompt-cache keepalive for Claude Code sessions on a claude.ai subscription
// (1-hour cache TTL). Inspired by
// https://github.com/yujiachen-y/claude-code-cache-keepalive, reworked so that:
//   - Runs as an `asyncRewake` Stop hook: the session stays usable while the
//     hook waits, and exit code 2 wakes Claude with the ping message.
//   - Only for interactive sessions signed in with the claude.ai account;
//     API-key, relay and headless (-p / SDK) sessions are skipped.
//   - Reads the session's real cache TTL and prompt size from the transcript,
//     and skips 5-minute-TTL or small sessions where a ping can't pay off.
//   - Per-session state; a newer Stop/prompt supersedes older sleepers.
//   - Skips the ping if the conversation moved on while waiting, or if
//     background tasks / scheduled wakeups will wake the session anyway.
//
// Usage from hooks: node cache-keepalive.js stop|prompt|end
// Pause without editing settings: create ~/.claude/cache-keepalive/DISABLED

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const INTERVAL = Number(process.env.CCKA_INTERVAL || 3000);         // seconds between pings
const MAX_LOOPS = Number(process.env.CCKA_MAX_LOOPS || 3);          // pings per idle stretch
const MIN_CONTEXT = Number(process.env.CCKA_MIN_CONTEXT || 50000);  // tokens; smaller sessions are cheap to rewrite
const SETTLE = Number(process.env.CCKA_SETTLE || 20);               // wait for the transcript to catch up
const CHECK_EVERY = Number(process.env.CCKA_CHECK || 30);           // seconds between supersede checks
const STATE_DIR = process.env.CCKA_STATE_DIR || path.join(os.homedir(), '.claude', 'cache-keepalive');
const LOG_FILE = path.join(STATE_DIR, 'keepalive.log');
const MESSAGE = process.env.CCKA_MESSAGE ||
  '[cache keepalive] Automatic heartbeat to keep the prompt cache warm; the user has not sent anything. ' +
  'Do not call tools or resume any work. Reply with just "ok".';
const INTERACTIVE_ENTRYPOINTS = ['claude-desktop', 'cli', 'claude-vscode'];

const sleep = s => new Promise(r => setTimeout(r, s * 1000));

function log(sid, msg) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const st = fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE);
    if (st && st.size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    const ts = new Date().toLocaleString('sv-SE');
    fs.appendFileSync(LOG_FILE, `[${ts}] [${String(sid).slice(0, 8)}] ${msg}\n`);
  } catch { /* logging must never break the hook */ }
}

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// True for interactive sessions billed to the claude.ai subscription.
function onSubscription() {
  const e = process.env, ep = e.CLAUDE_CODE_ENTRYPOINT;
  if (!INTERACTIVE_ENTRYPOINTS.includes(ep)) return false;
  if (e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX || e.CLAUDE_CODE_USE_FOUNDRY) return false;
  if (e.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(e.ANTHROPIC_BASE_URL)) return false;
  // Desktop always signs in with the claude.ai account; an inherited token is unused there.
  return ep === 'claude-desktop' || !(e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN);
}

const stateFile = sid => path.join(STATE_DIR, `${sid}.json`);

function loadState(sid) {
  try { return JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')); } catch { return null; }
}

function saveState(sid, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${stateFile(sid)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile(sid));
}

function pruneStale() {
  try {
    const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json') && !f.endsWith('.tmp')) continue;
      const p = path.join(STATE_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
}

function transcriptSize(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

function readRange(p, offset, len) {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
  return buf.toString('utf8');
}

// True if user/assistant messages were appended after `offset`. Metadata-only
// writes (titles, snapshots) don't count as the conversation moving on.
function conversationMoved(p, offset) {
  const size = transcriptSize(p);
  if (offset === null || size === null || size <= offset) return false;
  return readRange(p, offset, Math.min(size - offset, 8 * 1024 * 1024)).split('\n').some(line => {
    try { const o = JSON.parse(line); return o.type === 'user' || o.type === 'assistant'; } catch { return false; }
  });
}

// From the newest main-thread API usage in the transcript: the cache TTL the
// session writes with ('1h' / '5m' / null) and the prompt size in tokens.
function lastUsage(p) {
  try {
    const size = transcriptSize(p);
    if (!size) return {};
    const len = Math.min(size, 4 * 1024 * 1024);
    const lines = readRange(p, size - len, len).split('\n');
    let context = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const u = o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage;
      if (!u) continue;
      if (context === null) context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const cc = u.cache_creation || {};
      if (cc.ephemeral_1h_input_tokens > 0) return { ttl: '1h', context };
      if (cc.ephemeral_5m_input_tokens > 0) return { ttl: '5m', context };
    }
    return { ttl: null, context };
  } catch { return {}; }
}

// Pings since the last real user prompt, counted from the transcript. It
// doesn't depend on hook state, so the loop cap holds even if state is reset.
function recentPings(p) {
  try {
    const size = transcriptSize(p);
    if (!size) return 0;
    const len = Math.min(size, 4 * 1024 * 1024);
    const lines = readRange(p, size - len, len).split('\n');
    let n = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== 'user' || o.isSidechain || o.isMeta || !o.message) continue;
      const c = o.message.content;
      if (Array.isArray(c) && c.some(x => x && x.type === 'tool_result')) continue;
      if ((typeof c === 'string' ? c : JSON.stringify(c)).includes(MESSAGE)) n++;
      else return n;
    }
    return n;
  } catch { return 0; }
}

function claudeAlive() {
  const pid = Number(process.env.CLAUDE_PID);
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function onStop(input) {
  const sid = input.session_id;
  if (!sid) return 0;
  if ((input.background_tasks || []).length || (input.session_crons || []).length) {
    log(sid, 'background work pending, skip keepalive');
    return 0;
  }
  pruneStale();
  const prev = loadState(sid) || { count: 0 };
  // A Stop right after our own ping keeps counting; any other turn starts fresh.
  // The transcript count backs up the state, which a prompt hook may reset.
  const count = Math.max(prev.pinged ? prev.count : 0, recentPings(input.transcript_path));
  if (count >= MAX_LOOPS) {
    log(sid, `reached max loops (${count}/${MAX_LOOPS}), keepalive stops`);
    saveState(sid, { count, gen: prev.gen, pinged: false });
    return 0;
  }
  const gen = crypto.randomUUID();
  saveState(sid, { count, gen, pinged: false });
  const superseded = () => { const s = loadState(sid); return !s || s.gen !== gen; };

  let waited = Math.min(SETTLE, INTERVAL);
  await sleep(waited);
  if (superseded()) return 0;
  const { ttl, context } = lastUsage(input.transcript_path);
  if (ttl === '5m' && INTERVAL >= 300) {
    log(sid, `cache TTL is 5m, a ${INTERVAL}s ping would miss it, skip`);
    return 0;
  }
  if (context != null && context < MIN_CONTEXT) {
    log(sid, `context ${context} tokens < ${MIN_CONTEXT}, not worth keeping warm, skip`);
    return 0;
  }
  log(sid, `waiting ${INTERVAL}s before ping ${count + 1}/${MAX_LOOPS} (ttl=${ttl || '?'}, context=${context ?? '?'})`);
  const baseline = transcriptSize(input.transcript_path);
  while (waited < INTERVAL) {
    const step = Math.min(CHECK_EVERY, INTERVAL - waited);
    await sleep(step);
    waited += step;
    if (superseded()) { log(sid, 'superseded by newer activity, exit'); return 0; }
    if (!claudeAlive()) { log(sid, 'Claude process gone, exit'); return 0; }
  }
  if (conversationMoved(input.transcript_path, baseline)) {
    log(sid, 'conversation moved on while waiting, skip ping');
    return 0;
  }
  saveState(sid, { count: count + 1, gen, pinged: true, pingedAt: Date.now() });
  log(sid, `ping ${count + 1}/${MAX_LOOPS}`);
  process.stderr.write(MESSAGE);
  return 2;
}

function onPrompt(input) {
  const sid = input.session_id;
  const state = sid && loadState(sid);
  if (!state) return 0;
  // Our own ping comes back through UserPromptSubmit as a task notification.
  // Resetting on it would restart the count after every ping.
  const text = typeof input.prompt === 'string' && input.prompt ? input.prompt : null;
  const ownPing = state.pinged &&
    (text !== null ? text.includes(MESSAGE) : Date.now() - (state.pingedAt || 0) < 120 * 1000);
  if (ownPing) return 0;
  saveState(sid, { count: 0, gen: crypto.randomUUID(), pinged: false });
  return 0;
}

function onEnd(input) {
  if (input.session_id) fs.rmSync(stateFile(input.session_id), { force: true });
  return 0;
}

async function main() {
  const mode = process.argv[2];
  const input = readInput();
  if (!onSubscription()) {
    if (mode === 'stop') log(input.session_id || '-', `skip: not a subscription session (entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT || 'unset'})`);
    return 0;
  }
  if (fs.existsSync(path.join(STATE_DIR, 'DISABLED'))) return 0;
  if (mode === 'stop') return onStop(input);
  if (mode === 'prompt') return onPrompt(input);
  if (mode === 'end') return onEnd(input);
  return 0;
}

main().then(
  code => { process.exitCode = code; },
  err => { log('-', `error: ${err && err.stack || err}`); process.exitCode = 0; }
);
