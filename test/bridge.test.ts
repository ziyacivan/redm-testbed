// SPEC-0001 R3: the client script uses ES2017 and FiveM functions only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const clientSource = fs.readFileSync(new URL('../bridge/client.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../bridge/server.js', import.meta.url), 'utf8');

// Globals that the FiveM client runtime does not have (SPEC-0001 F5) or that are newer than ES2017.
const FORBIDDEN = ['fetch', 'AbortController', 'XMLHttpRequest', 'window', 'document', 'require', 'process', 'Buffer', 'globalThis', 'atob', 'btoa', 'structuredClone', 'queueMicrotask'];

function code(source: string): string {
  return source.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

type Handler = (...args: unknown[]) => void;

function clientSandbox() {
  const handlers = new Map<string, Handler>();
  const sent: unknown[][] = [];
  const nuiMessages: Record<string, unknown>[] = [];
  const context = vm.createContext({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    onNet: (name: string, fn: Handler) => handlers.set(name, fn),
    emitNet: (...args: unknown[]) => sent.push(args),
    RegisterNuiCallbackType: () => undefined,
    SendNUIMessage: (message: Record<string, unknown>) => nuiMessages.push(message),
    setTimeout,
    clearTimeout,
    GetGameTimer: () => 1234,
    PlayerPedId: () => 7,
    GetEntityCoords: () => [1, 2, 3],
    GetEntityHeading: () => 90,
    SetEntityCoords: () => undefined,
    SetEntityHeading: () => undefined,
    FreezeEntityPosition: () => undefined,
  });
  vm.runInContext(clientSource, context);
  const request = async (req: Record<string, unknown>) => {
    handlers.get('testbed:request')?.(req);
    for (let i = 0; i < 50 && !sent.some((args) => args[1] === req.id); i++) await new Promise((r) => setTimeout(r, 5));
    return sent.find((args) => args[1] === req.id)?.[2] as { ok: boolean; data?: unknown; error?: string };
  };
  return { handlers, nuiMessages, request };
}

describe('bridge client', () => {
  it('uses no forbidden global', () => {
    const body = code(clientSource);
    for (const name of FORBIDDEN) expect(body, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('answers ping and position', async () => {
    const { request } = clientSandbox();
    expect(await request({ id: 'tb-1', op: 'ping' })).toEqual({ ok: true, data: { pong: true, gameTimer: 1234 } });
    expect((await request({ id: 'tb-2', op: 'position' }))?.data).toEqual({ coords: { x: 1, y: 2, z: 3 }, heading: 90 });
  });

  it('refuses an unknown op and a prototype key', async () => {
    const { request } = clientSandbox();
    expect((await request({ id: 'tb-3', op: 'constructor' }))?.ok).toBe(false);
  });

  it('runs nui_callback through the NUI page of the bridge', async () => {
    const { handlers, nuiMessages, request } = clientSandbox();
    const answer = request({ id: 'tb-4', op: 'nui_callback', resource: 'neo', endpoint: 'chat:submit', payload: { text: 'hi' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(nuiMessages[0]).toMatchObject({ type: 'testbed:nui_callback', id: 'tb-4', resource: 'neo', endpoint: 'chat:submit' });
    handlers.get('__cfx_nui:result')?.({ id: 'tb-4', result: { ok: true, data: { status: 200, body: 'ok' } } }, () => undefined);
    expect(await answer).toEqual({ ok: true, data: { status: 200, body: 'ok' } });
  });
});

function serverSandbox(convars: Record<string, string>) {
  const output: string[] = [];
  const handlers = new Map<string, Handler>();
  const toClient: unknown[][] = [];
  let command: Handler = () => undefined;
  const context = vm.createContext({
    require: (name: string) => (name === 'crypto' ? crypto : undefined),
    Buffer,
    console: { log: (line: string) => output.push(line) },
    setTimeout,
    clearTimeout,
    GetConvar: (name: string, fallback: string) => convars[name] ?? fallback,
    getPlayers: () => ['1'],
    GetPlayerName: (src: string) => (String(src) === '1' ? 'tester' : ''),
    GetPlayerPing: () => 10,
    onNet: (name: string, fn: Handler) => handlers.set(name, fn),
    emitNet: (...args: unknown[]) => toClient.push(args),
    emit: () => undefined,
    exports: {},
    RegisterCommand: (_name: string, fn: Handler) => {
      command = fn;
    },
  });
  vm.runInContext(serverSource, context);
  const run = (src: number, id: string, target: string, player: string, req: Record<string, unknown>) => {
    output.length = 0;
    command(src, [id, target, player, Buffer.from(JSON.stringify(req)).toString('base64')]);
    return output.join('\n');
  };
  const respond = (src: number, id: string, result: unknown) => {
    (context as { source?: number }).source = src;
    handlers.get('testbed:response')?.(id, result);
  };
  return { run, respond, toClient };
}

describe('bridge server', () => {
  const convars = { testbed_enabled: 'true', testbed_token: 'secret-token' };

  it('accepts the console only', () => {
    expect(serverSandbox(convars).run(1, 'tb-a', 'server', '-', { op: 'ping', token: 'secret-token' })).toContain('TESTBED_DENY');
  });

  it('refuses a wrong token and a disabled bridge', () => {
    expect(serverSandbox(convars).run(0, 'tb-b', 'server', '-', { op: 'ping', token: 'wrong' })).toContain('invalid token');
    expect(serverSandbox({}).run(0, 'tb-c', 'server', '-', { op: 'ping', token: 'x' })).toContain('disabled');
  });

  it('lists players', () => {
    const line = serverSandbox(convars).run(0, 'tb-d', 'server', '-', { op: 'players', token: 'secret-token' });
    expect(JSON.parse(line.replace(/^TESTBED_RESULT tb-d /, ''))).toEqual({ ok: true, data: [{ src: 1, name: 'tester', ping: 10 }] });
  });

  it('relays a client op and queues the answer of the same player only', () => {
    const bridge = serverSandbox(convars);
    expect(bridge.run(0, 'tb-e', 'client', '1', { op: 'ping', token: 'secret-token' })).toBe('TESTBED_ACK tb-e');
    expect(bridge.toClient[0]?.slice(0, 2)).toEqual(['testbed:request', '1']);
    bridge.respond(2, 'tb-e', { ok: true, data: 'from another player' });
    bridge.respond(1, 'tb-e', { ok: true, data: { pong: true } });
    const poll = bridge.run(0, 'tb-f', 'server', '-', { op: 'poll', token: 'secret-token' });
    expect(JSON.parse(poll.replace(/^TESTBED_RESULT tb-f /, ''))).toEqual({ ok: true, data: [{ id: 'tb-e', result: { ok: true, data: { pong: true } } }] });
  });

  it('enforces the export allowlist', () => {
    const line = serverSandbox(convars).run(0, 'tb-g', 'server', '-', { op: 'call_export', token: 'secret-token', resource: 'neo', method: 'x' });
    expect(line).toContain('not in testbed_export_allowlist');
  });
});
