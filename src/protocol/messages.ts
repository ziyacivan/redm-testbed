// JSON-RPC methods between the dev host and the daemon (SPEC-0001 section 8).
import { z } from 'zod';

export const consoleTarget = z.enum(['server', 'client']);
export type ConsoleTarget = z.infer<typeof consoleTarget>;

export const consoleLine = z.object({ seq: z.number().int(), time: z.number(), text: z.string() });
export type ConsoleLine = z.infer<typeof consoleLine>;

const empty = z.object({}).strict();
const output = z.object({ output: z.string() });

const serverStatus = z.object({
  running: z.boolean(),
  pid: z.number().int().optional(),
  rcon: z.boolean(),
  startedAt: z.number().optional(),
});

// SPEC-0003 D2.
export const clientStates = ['idle', 'starting', 'connecting', 'joined', 'failed', 'stopped'] as const;

const clientStatus = z.object({
  running: z.boolean(),
  processes: z.array(z.string()),
  state: z.enum(clientStates),
  reason: z.string().optional(),
  src: z.number().int().optional(),
  progress: z.string().optional(),
});

export const bridgeSettings = z.object({
  events: z.array(z.string()).default([]),
  exports: z.array(z.string()).default([]),
  natives: z.array(z.string()).default([]),
});

export const bridgeServerOps = ['ping', 'players', 'call_export', 'trigger_event'] as const;
export const bridgeClientOps = ['ping', 'position', 'teleport', 'freeze', 'call_native', 'nui_callback'] as const;

const healthCheck = z.object({ ok: z.boolean(), label: z.string(), detail: z.string() });

export const methods = {
  hello: {
    params: z.object({ version: z.string() }),
    result: z.object({ version: z.string(), root: z.string() }),
  },
  health: { params: empty, result: z.object({ checks: z.array(healthCheck) }) },
  'server.configure': {
    params: z.object({
      serverCfg: z.string(),
      connect: z.string(),
      bridge: bridgeSettings,
      secrets: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).default([]),
    }),
    result: empty,
  },
  'server.start': { params: empty, result: serverStatus },
  'server.stop': { params: empty, result: serverStatus },
  'server.restart': { params: empty, result: serverStatus },
  'server.status': { params: empty, result: serverStatus },
  'client.launch': {
    params: z.object({ wait: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(600_000).default(180_000) }),
    result: clientStatus,
  },
  'client.quit': { params: empty, result: clientStatus },
  'client.status': { params: empty, result: clientStatus },
  'client.command': {
    params: z.object({
      command: z.string().min(1).max(512),
      timeoutMs: z.number().int().min(100).max(60_000).optional(),
      quietMs: z.number().int().min(50).max(10_000).optional(),
    }),
    result: z.object({ lines: z.array(z.string()) }),
  },
  bridge: {
    params: z.discriminatedUnion('target', [
      z.object({ target: z.literal('server'), op: z.enum(bridgeServerOps), args: z.record(z.string(), z.unknown()).default({}) }),
      z.object({
        target: z.literal('client'),
        src: z.number().int().min(1),
        op: z.enum(bridgeClientOps),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
    ]),
    result: z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }),
  },
  'window.status': {
    params: empty,
    result: z.object({
      found: z.boolean(),
      focused: z.boolean(),
      title: z.string().optional(),
      rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    }),
  },
  'window.screenshot': {
    params: z.object({
      maxSide: z.number().int().min(64).max(4096).optional(),
      crop: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).optional(),
    }),
    result: z.object({ png: z.string(), width: z.number().int(), height: z.number().int() }),
  },
  'window.key': {
    params: z.object({ key: z.string(), holdMs: z.number().int().min(0).max(10_000).optional() }),
    result: empty,
  },
  'window.text': { params: z.object({ text: z.string().min(1).max(500) }), result: empty },
  'window.mouse': {
    params: z.discriminatedUnion('action', [
      z.object({ action: z.literal('move'), dx: z.number().int(), dy: z.number().int() }),
      z.object({ action: z.literal('position'), x: z.number().int().min(0), y: z.number().int().min(0) }),
      z.object({ action: z.literal('click'), button: z.enum(['left', 'right']).default('left') }),
      z.object({ action: z.literal('scroll'), amount: z.number().int().min(-50).max(50) }),
    ]),
    result: empty,
  },
  rcon: { params: z.object({ command: z.string().min(1).max(512) }), result: output },
  'console.read': {
    params: z.object({
      target: consoleTarget,
      after: z.number().int().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      pattern: z.string().optional(),
    }),
    result: z.object({ lines: z.array(consoleLine), cursor: z.number().int() }),
  },
  'console.wait': {
    params: z.object({
      target: consoleTarget,
      pattern: z.string(),
      after: z.number().int().optional(),
      timeoutMs: z.number().int().min(1).max(600_000),
    }),
    result: z.object({ line: consoleLine.nullable(), cursor: z.number().int() }),
  },
  'resource.upload': {
    params: z.object({ uploadId: z.string().regex(/^[\w-]{8,64}$/), chunk: z.string() }),
    result: z.object({ bytes: z.number().int() }),
  },
  'resource.commit': {
    params: z.object({
      uploadId: z.string().regex(/^[\w-]{8,64}$/),
      category: z.string().regex(/^\[[\w-]+\]$/),
      name: z.string().regex(/^[\w-]+$/),
    }),
    result: empty,
  },
  'resource.reload': { params: z.object({ names: z.array(z.string().regex(/^[\w-]+$/)) }), result: output },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = z.input<Methods[M]['params']>;
export type Result<M extends MethodName> = z.infer<Methods[M]['result']>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
