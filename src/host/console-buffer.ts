// Keeps the last console lines of a process, with a sequence number for paging (SPEC-0001 D5).
import type { ConsoleLine } from '../protocol/messages.ts';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

type Waiter = { pattern: RegExp; resolve: (line: ConsoleLine) => void };

export class ConsoleBuffer {
  private lines: ConsoleLine[] = [];
  private nextSeq = 1;
  private partial = '';
  private waiters = new Set<Waiter>();

  private readonly capacity: number;

  constructor(capacity = 10_000) {
    this.capacity = capacity;
  }

  get cursor(): number {
    return this.nextSeq - 1;
  }

  // Accepts raw output. Splits it into lines and removes ANSI colors.
  write(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const part of parts) this.push(stripAnsi(part));
  }

  flush(): void {
    if (this.partial) this.push(stripAnsi(this.partial));
    this.partial = '';
  }

  push(text: string): ConsoleLine {
    const line = { seq: this.nextSeq++, time: Date.now(), text };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    for (const waiter of this.waiters) {
      if (waiter.pattern.test(text)) {
        this.waiters.delete(waiter);
        waiter.resolve(line);
      }
    }
    return line;
  }

  read(options: { after?: number; limit?: number; pattern?: RegExp } = {}): ConsoleLine[] {
    const { after, limit = 200, pattern } = options;
    let lines = after === undefined ? this.lines : this.lines.filter((line) => line.seq > after);
    if (pattern) lines = lines.filter((line) => pattern.test(line.text));
    return after === undefined ? lines.slice(-limit) : lines.slice(0, limit);
  }

  // Resolves with the first line after `after` that matches, or null after the timeout.
  wait(pattern: RegExp, options: { after?: number; timeoutMs: number }): Promise<ConsoleLine | null> {
    const existing = this.read({ after: options.after ?? this.cursor, pattern, limit: 1 })[0];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        pattern,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, options.timeoutMs);
      this.waiters.add(waiter);
    });
  }
}
