// Finds session logs under each source's home and tails them incrementally.
// Read-only: files are opened with 'r' and never written. Polling (no fs.watch) keeps it
// portable; each poll is one stat() per tracked file plus a read of only the new bytes.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ClaudeState, claudeLine, newClaudeState } from './claude.ts';
import { type CodexState, codexLine, newCodexState } from './codex.ts';
import type { SourceConfig } from './config.ts';
import { type Clock, type Session, newSession } from './session.ts';

interface Entry { session: Session; state: ClaudeState | CodexState; files: string[] }
interface FileState { key: string; sub: boolean; offset: number; partial: Buffer | null; mtime: number; clock: Clock }

const CHUNK = 4 << 20;

export class SourceWatcher {
  readonly cfg: SourceConfig;
  readonly sessions = new Map<string, Entry>();
  private files = new Map<string, FileState>();
  warning: string | null = null;
  private maxAgeMs: number;
  // Codex homes can share one sessions dir (e.g. a symlink); the logged-in account id
  // tells which sessions belong to this source. Only this one field of auth.json is read.
  private accountId: string | null = null;

  constructor(cfg: SourceConfig, days: number) {
    this.cfg = cfg;
    this.maxAgeMs = days * 86_400_000;
    if (cfg.provider === 'codex') {
      try { this.accountId = JSON.parse(readFileSync(join(cfg.home, 'auth.json'), 'utf8')).tokens?.account_id ?? null; } catch {}
    }
  }

  // Discover new log files. Cheap enough to run every few seconds.
  scan(now = Date.now()): void {
    const { home, provider } = this.cfg;
    if (!existsSync(home)) { this.warning = `${this.cfg.name}: ${home} not found`; return; }
    this.warning = null;
    if (provider === 'codex') this.loadThreadNames();
    const found: [string, string, boolean][] = []; // [path, sessionKey, isSubagent]
    if (provider === 'claude') {
      const root = join(home, 'projects');
      for (const slug of ls(root)) {
        const dir = join(root, slug);
        for (const f of ls(dir)) {
          if (f.endsWith('.jsonl')) found.push([join(dir, f), `${slug}/${f.slice(0, -6)}`, false]);
          else for (const a of ls(join(dir, f, 'subagents')))
            if (a.endsWith('.jsonl')) found.push([join(dir, f, 'subagents', a), `${slug}/${f}`, true]);
        }
      }
    } else {
      const walk = (dir: string): void => {
        for (const f of ls(dir)) {
          const p = join(dir, f);
          if (f.endsWith('.jsonl')) found.push([p, f, false]);
          else if (!f.includes('.')) walk(p);
        }
      };
      walk(join(home, 'sessions'));
    }
    for (const [path, key, sub] of found) {
      if (this.files.has(path)) continue;
      let mtime: number;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      if (now - mtime > this.maxAgeMs) continue;
      this.files.set(path, { key, sub, offset: 0, partial: null, mtime, clock: { lastInput: 0 } });
      let e = this.sessions.get(key);
      if (!e) {
        const id = provider === 'claude' ? basename(key) : codexId(key);
        e = {
          session: newSession(id, this.cfg.name, provider),
          state: provider === 'claude' ? newClaudeState() : newCodexState(),
          files: [],
        };
        this.sessions.set(key, e);
      }
      e.files.push(path);
    }
  }

  // Read new bytes from every tracked file.
  poll(): void {
    for (const [path, f] of this.files) {
      let st;
      try { st = statSync(path); } catch { continue; }
      const e = this.sessions.get(f.key)!;
      if (st.size < f.offset) { this.reset(e); }
      if (st.size === f.offset) continue;
      f.mtime = st.mtimeMs;
      e.session.lastActive = Math.max(e.session.lastActive, st.mtimeMs);
      this.read(path, f, e, st.size);
    }
  }

  // A log shrank (rewritten): rebuild that session from scratch.
  private reset(e: Entry): void {
    const s = e.session;
    e.session = newSession(s.id, s.source, s.provider);
    e.state = s.provider === 'claude' ? newClaudeState() : newCodexState();
    for (const p of e.files) { const f = this.files.get(p)!; f.offset = 0; f.partial = null; f.clock = { lastInput: 0 }; }
  }

  private read(path: string, f: FileState, e: Entry, size: number): void {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { return; }
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - f.offset));
      while (f.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - f.offset), f.offset);
        if (n <= 0) break;
        f.offset += n;
        let data = buf.subarray(0, n);
        if (f.partial) { data = Buffer.concat([f.partial, data]); f.partial = null; }
        let start = 0;
        for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
          this.line(data.toString('utf8', start, nl), f, e);
          start = nl + 1;
        }
        // Keep an incomplete trailing line until the writer finishes it.
        if (start < data.length) f.partial = Buffer.from(data.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  }

  private line(text: string, f: FileState, e: Entry): void {
    // Skip JSON.parse for lines that cannot matter (most of a log is message content).
    if (e.session.provider === 'claude') {
      if (!/"usage"|"type":"user"|"(custom|ai)-title"/.test(text) && (e.session.project || !text.includes('"cwd"'))) return;
    } else if (!/"(token_count|turn_context|session_meta|function_call_output|custom_tool_call_output|local_shell_call_output)"|"role":"user"/.test(text)) {
      return;
    }
    let d: any;
    try { d = JSON.parse(text); } catch { return; }
    if (e.session.provider === 'claude') claudeLine(e.session, e.state as ClaudeState, d, f.sub, f.clock);
    else codexLine(e.session, e.state as CodexState, d, f.clock);
  }

  // Codex keeps thread names in <home>/session_index.jsonl (one line per rename; last wins).
  private names = new Map<string, string>();
  private namesMtime = 0;
  private loadThreadNames(): void {
    const path = join(this.cfg.home, 'session_index.jsonl');
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { return; }
    if (mtime === this.namesMtime) return;
    this.namesMtime = mtime;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      try { const d = JSON.parse(line); if (d.id && d.thread_name) this.names.set(d.id, d.thread_name); } catch {}
    }
  }

  list(): Session[] {
    if (this.names.size) for (const e of this.sessions.values()) {
      const n = this.names.get(e.session.id);
      if (n) e.session.title = n;
    }
    return [...this.sessions.values()].map((e) => e.session)
      .filter((s) => !this.accountId || !s.account || s.account === this.accountId);
  }
}

function ls(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

// rollout-2026-10-07T17-24-01-<uuid>.jsonl -> <uuid>
function codexId(file: string): string {
  return file.replace(/^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, '').replace(/\.jsonl$/, '');
}

