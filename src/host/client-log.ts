// Follows the RedM client log, so connection errors are visible before devcon exists (SPEC-0003 D1, F1 to F3).
import fs from 'node:fs';
import path from 'node:path';

export type ClientLogEvent = { kind: 'progress'; text: string } | { kind: 'error'; reason: string } | { kind: 'other' };

/** Reads one line of `CitizenFX_log_*.log` (SPEC-0003 F2). */
export function parseClientLogLine(line: string): ClientLogEvent {
  const error = /OnConnectionError: (.*)$/.exec(line);
  if (error) {
    return { kind: 'error', reason: (error[1] ?? '').trim() };
  }
  const progress = /OnConnectionProgress: (.*)$/.exec(line);
  if (progress) {
    return { kind: 'progress', text: (progress[1] ?? '').trim() };
  }
  return { kind: 'other' };
}

export function clientLogDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  return path.join(localAppData, 'RedM', 'RedM.app', 'logs');
}

/** The newest client log file that changed at or after `since`, or `undefined`. */
export function newestClientLog(directory: string, since: number): string | undefined {
  let newest: { file: string; mtime: number } | undefined;
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!/^CitizenFX_log_.*\.log$/.test(name)) {
      continue;
    }
    const file = path.join(directory, name);
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime >= since && (newest === undefined || mtime > newest.mtime)) {
      newest = { file, mtime };
    }
  }
  return newest?.file;
}

/** Polls the newest client log file and reports each new complete line. */
export class ClientLogFollower {
  private timer: NodeJS.Timeout | undefined;
  private file: string | undefined;
  private offset = 0;
  private partial = '';
  private readonly directory: string;
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void, directory = clientLogDirectory()) {
    this.onLine = onLine;
    this.directory = directory;
  }

  /** Follows the newest file that changes from `since` on (a RedM start makes a new file). */
  start(since: number): void {
    this.stop();
    this.file = undefined;
    this.offset = 0;
    this.partial = '';
    this.timer = setInterval(() => this.poll(since), 500);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(since: number): void {
    const newest = newestClientLog(this.directory, since);
    if (newest === undefined) {
      return;
    }
    if (newest !== this.file) {
      this.file = newest;
      this.offset = 0;
      this.partial = '';
    }
    let size: number;
    try {
      size = fs.statSync(newest).size;
    } catch {
      return;
    }
    if (size <= this.offset) {
      return;
    }
    const handle = fs.openSync(newest, 'r');
    try {
      const chunk = Buffer.alloc(size - this.offset);
      fs.readSync(handle, chunk, 0, chunk.length, this.offset);
      this.offset = size;
      const parts = (this.partial + chunk.toString('utf8')).split(/\r?\n/);
      this.partial = parts.pop() ?? '';
      for (const part of parts) {
        if (part.length > 0) this.onLine(part);
      }
    } finally {
      fs.closeSync(handle);
    }
  }
}
