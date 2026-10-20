// The `steps` tool: several test actions in one MCP call (SPEC-0004).
import { z } from 'zod';
import type { MethodName, Params, Result } from '../protocol/messages.ts';

const target = z.enum(['server', 'client']);
const crop = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() });

export const stepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('key'), key: z.string(), holdMs: z.number().int().min(0).max(10_000).optional() }),
  z.object({
    do: z.literal('keys'),
    keys: z.array(z.string()).min(1).max(30),
    gapMs: z.number().int().min(0).max(2000).optional(),
    holdMs: z.number().int().min(0).max(10_000).optional(),
  }),
  z.object({ do: z.literal('text'), text: z.string().min(1).max(500) }),
  z.object({
    do: z.literal('mouse'),
    action: z.enum(['move', 'position', 'click', 'scroll']),
    dx: z.number().int().optional(),
    dy: z.number().int().optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    button: z.enum(['left', 'right']).optional(),
    amount: z.number().int().optional(),
  }),
  z.object({ do: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }),
  z.object({ do: z.literal('command'), target, command: z.string().min(1) }),
  z.object({
    do: z.literal('console'),
    target,
    pattern: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({ do: z.literal('screenshot'), maxSide: z.number().int().min(64).max(4096).optional(), crop: crop.optional() }),
]);

export type Step = z.infer<typeof stepSchema>;

export const MAX_STEPS = 30;
export const MAX_SCREENSHOTS = 3;
export const DEFAULT_KEY_GAP_MS = 80;
/** The default longest side of a screenshot (SPEC-0004 D4). */
export const DEFAULT_SCREENSHOT_SIDE = 640;
const DEFAULT_CONSOLE_LINES = 20;

export interface StepExecutor {
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  sleep(ms: number): Promise<void>;
}

export interface StepsOutcome {
  /** One line for each step that ran, in order. */
  lines: string[];
  /** The screenshots, in the order of their steps. */
  images: { png: string; width: number; height: number }[];
  /** False when a step failed. */
  ok: boolean;
}

/** The refusal text of a list that breaks D1 or D3, or `undefined` when the list is allowed. */
export function checkSteps(steps: readonly Step[]): string | undefined {
  if (steps.length === 0) return 'steps is empty';
  if (steps.length > MAX_STEPS) return `at most ${MAX_STEPS} steps in one call, got ${steps.length}`;
  const shots = steps.filter((step) => step.do === 'screenshot').length;
  if (shots > MAX_SCREENSHOTS) return `at most ${MAX_SCREENSHOTS} screenshot steps in one call, got ${shots}`;
  return undefined;
}

async function runStep(step: Step, io: StepExecutor, outcome: StepsOutcome): Promise<string> {
  switch (step.do) {
    case 'key':
      await io.call('window.key', { key: step.key, ...(step.holdMs === undefined ? {} : { holdMs: step.holdMs }) });
      return `key ${step.key}`;
    case 'keys': {
      const gap = step.gapMs ?? DEFAULT_KEY_GAP_MS;
      for (const [index, key] of step.keys.entries()) {
        if (index > 0 && gap > 0) await io.sleep(gap);
        await io.call('window.key', { key, ...(step.holdMs === undefined ? {} : { holdMs: step.holdMs }) });
      }
      return `keys ${step.keys.join(' ')}`;
    }
    case 'text':
      await io.call('window.text', { text: step.text });
      return `text (${step.text.length} characters)`;
    case 'mouse': {
      const { do: _do, ...args } = step;
      await io.call('window.mouse', args as Params<'window.mouse'>);
      return `mouse ${step.action}`;
    }
    case 'wait':
      await io.sleep(step.ms);
      return `wait ${step.ms} ms`;
    case 'command': {
      if (step.target === 'server') {
        const { output } = await io.call('rcon', { command: step.command });
        return `server command: ${output.trim() || '(no output)'}`;
      }
      const { lines } = await io.call('client.command', { command: step.command });
      return `client command: ${lines.join(' | ') || '(no output)'}`;
    }
    case 'console': {
      const limit = step.limit ?? DEFAULT_CONSOLE_LINES;
      const { lines } = await io.call('console.read', {
        target: step.target,
        limit,
        ...(step.pattern === undefined ? {} : { pattern: step.pattern }),
      });
      return `console ${step.target}:\n${lines.map((line) => line.text).join('\n') || '(no lines)'}`;
    }
    case 'screenshot': {
      const shot = await io.call('window.screenshot', {
        maxSide: step.maxSide ?? DEFAULT_SCREENSHOT_SIDE,
        ...(step.crop === undefined ? {} : { crop: step.crop }),
      });
      outcome.images.push({ png: shot.png, width: shot.width, height: shot.height });
      return `screenshot ${shot.width}x${shot.height} (image ${outcome.images.length})`;
    }
  }
}

/** Runs the steps in order and stops at the first failure (SPEC-0004 D2). The caller checks the list with `checkSteps`. */
export async function runSteps(steps: readonly Step[], io: StepExecutor): Promise<StepsOutcome> {
  const outcome: StepsOutcome = { lines: [], images: [], ok: true };
  for (const [index, step] of steps.entries()) {
    const label = `${index + 1}/${steps.length}`;
    try {
      outcome.lines.push(`${label} ok: ${await runStep(step, io, outcome)}`);
    } catch (error) {
      outcome.ok = false;
      outcome.lines.push(`${label} FAILED (${step.do}): ${error instanceof Error ? error.message : String(error)}`);
      outcome.lines.push(`stopped: ${steps.length - index - 1} step(s) not run`);
      break;
    }
  }
  return outcome;
}
