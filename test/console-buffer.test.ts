import { describe, expect, it } from 'vitest';
import { ConsoleBuffer, stripAnsi } from '../src/host/console-buffer.ts';

describe('ConsoleBuffer', () => {
  it('splits chunks into lines and keeps a partial line', () => {
    const buffer = new ConsoleBuffer();
    buffer.write('one\r\ntw');
    buffer.write('o\nthree');
    expect(buffer.read().map((line) => line.text)).toEqual(['one', 'two']);
    buffer.flush();
    expect(buffer.read().map((line) => line.text)).toEqual(['one', 'two', 'three']);
  });

  it('removes ANSI colors', () => {
    expect(stripAnsi('\x1b[38;5;83m[resources]\x1b[0m Started')).toBe('[resources] Started');
  });

  it('keeps only the newest lines', () => {
    const buffer = new ConsoleBuffer(2);
    for (const text of ['a', 'b', 'c']) buffer.push(text);
    expect(buffer.read().map((line) => line.text)).toEqual(['b', 'c']);
    expect(buffer.cursor).toBe(3);
  });

  it('reads after a cursor with a pattern', () => {
    const buffer = new ConsoleBuffer();
    for (const text of ['x1', 'y', 'x2']) buffer.push(text);
    expect(buffer.read({ after: 1, pattern: /^x/ }).map((line) => line.text)).toEqual(['x2']);
  });

  it('resolves a wait on a later line', async () => {
    const buffer = new ConsoleBuffer();
    const waiting = buffer.wait(/Started resource neo/, { timeoutMs: 1000 });
    buffer.push('Started resource mapmanager');
    buffer.push('Started resource neo');
    expect((await waiting)?.seq).toBe(2);
  });

  it('resolves a wait on an existing line after the cursor', async () => {
    const buffer = new ConsoleBuffer();
    buffer.push('ready');
    expect((await buffer.wait(/ready/, { after: 0, timeoutMs: 10 }))?.text).toBe('ready');
  });

  it('resolves null after the timeout', async () => {
    expect(await new ConsoleBuffer().wait(/never/, { timeoutMs: 10 })).toBeNull();
  });
});
