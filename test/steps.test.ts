import { describe, expect, it } from 'vitest';
import { checkSteps, runSteps, stepSchema, type Step, type StepExecutor } from '../src/mcp/steps.ts';

function fakeExecutor(failOn?: string): { io: StepExecutor; calls: string[]; sleeps: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const io = {
    async call(method: string, params: unknown) {
      calls.push(`${method} ${JSON.stringify(params)}`);
      if (failOn === method) throw new Error(`${method} failed`);
      if (method === 'window.screenshot') return { png: 'AAAA', width: 640, height: 360 };
      if (method === 'rcon') return { output: 'ok\n' };
      if (method === 'client.command') return { lines: ['a', 'b'] };
      if (method === 'console.read') return { lines: [{ seq: 1, time: 0, text: 'line one' }], cursor: 1 };
      return {};
    },
    async sleep(ms: number) {
      sleeps.push(ms);
    },
  } as unknown as StepExecutor;
  return { io, calls, sleeps };
}

describe('checkSteps (SPEC-0004 D1, D3)', () => {
  const key: Step = { do: 'key', key: 'enter' };
  const shot: Step = { do: 'screenshot' };

  it('allows a normal list', () => {
    expect(checkSteps([key, shot])).toBeUndefined();
  });

  it('refuses an empty list and more than 30 steps', () => {
    expect(checkSteps([])).toMatch(/empty/);
    expect(checkSteps(Array.from({ length: 31 }, () => key))).toMatch(/at most 30/);
    expect(checkSteps(Array.from({ length: 30 }, () => key))).toBeUndefined();
  });

  it('refuses more than 3 screenshots', () => {
    expect(checkSteps([shot, shot, shot, shot])).toMatch(/at most 3 screenshot/);
    expect(checkSteps([shot, shot, shot])).toBeUndefined();
  });
});

describe('stepSchema', () => {
  it('parses each step kind and refuses an unknown one', () => {
    expect(stepSchema.safeParse({ do: 'keys', keys: ['t', 'enter'] }).success).toBe(true);
    expect(stepSchema.safeParse({ do: 'console', target: 'client', pattern: 'error' }).success).toBe(true);
    expect(stepSchema.safeParse({ do: 'fly' }).success).toBe(false);
    expect(stepSchema.safeParse({ do: 'wait', ms: 20_000 }).success).toBe(false);
  });
});

describe('runSteps (SPEC-0004 D1, D2)', () => {
  it('runs the steps in order and collects the images', async () => {
    const { io, calls, sleeps } = fakeExecutor();
    const outcome = await runSteps(
      [
        { do: 'keys', keys: ['t', 'a'], gapMs: 50 },
        { do: 'text', text: '/hud' },
        { do: 'key', key: 'enter' },
        { do: 'wait', ms: 300 },
        { do: 'screenshot', crop: { x: 0, y: 0, width: 100, height: 50 } },
      ],
      io,
    );
    expect(outcome.ok).toBe(true);
    expect(calls.map((call) => call.split(' ')[0])).toEqual(['window.key', 'window.key', 'window.text', 'window.key', 'window.screenshot']);
    expect(sleeps).toEqual([50, 300]);
    expect(outcome.images).toEqual([{ png: 'AAAA', width: 640, height: 360 }]);
    expect(outcome.lines).toHaveLength(5);
  });

  it('uses the default screenshot side of 640', async () => {
    const { io, calls } = fakeExecutor();
    await runSteps([{ do: 'screenshot' }], io);
    expect(calls[0]).toContain('"maxSide":640');
  });

  it('keeps an own maxSide', async () => {
    const { io, calls } = fakeExecutor();
    await runSteps([{ do: 'screenshot', maxSide: 1200 }], io);
    expect(calls[0]).toContain('"maxSide":1200');
  });

  it('stops at the first failure and keeps the earlier output', async () => {
    const { io, calls } = fakeExecutor('window.text');
    const outcome = await runSteps([{ do: 'key', key: 't' }, { do: 'text', text: 'x' }, { do: 'screenshot' }], io);
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(outcome.images).toEqual([]);
    expect(outcome.lines[0]).toMatch(/1\/3 ok/);
    expect(outcome.lines[1]).toMatch(/2\/3 FAILED \(text\): window.text failed/);
    expect(outcome.lines[2]).toMatch(/1 step\(s\) not run/);
  });

  it('reads commands and the console', async () => {
    const { io } = fakeExecutor();
    const outcome = await runSteps(
      [
        { do: 'command', target: 'client', command: 'neo_nametag demo' },
        { do: 'command', target: 'server', command: 'status' },
        { do: 'console', target: 'client', pattern: 'error' },
      ],
      io,
    );
    expect(outcome.lines[0]).toContain('a | b');
    expect(outcome.lines[1]).toContain('ok');
    expect(outcome.lines[2]).toContain('line one');
  });
});
