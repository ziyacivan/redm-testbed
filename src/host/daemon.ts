// The daemon runs in the interactive session of the test host (SPEC-0001 D3, section 9.1).
// It owns FXServer and serves JSON-RPC to relays on a named pipe.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { z } from 'zod';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DevconConnection } from '../cfx/devcon.ts';
import { ClientLogFollower, parseClientLogLine } from './client-log.ts';
import { rcon } from '../cfx/rcon.ts';
import { fileURLToPath } from 'node:url';
import { pipeName } from '../protocol/config.ts';
import { clientStates, isMethodName, type MethodName, methods, type Params, type Result } from '../protocol/messages.ts';
import { APP_ERROR, auth, encode, LineSplitter, PROTOCOL_ERROR, request } from '../protocol/rpc.ts';
import { VERSION } from '../protocol/version.ts';
import { keyCode } from '../protocol/keys.ts';
import { ConsoleBuffer } from './console-buffer.ts';
import { WindowHelper } from './window-helper.ts';
import { extraSecrets, type HostPaths, hostPaths, readSecrets, requireSecret, secretLine } from './paths.ts';
import { killImage, killTree, processesWithPrefix, run } from './windows.ts';

interface State {
  connect: string;
  secrets?: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BRIDGE_SOURCE = fileURLToPath(new URL('../../bridge', import.meta.url));
const BRIDGE_CATEGORY = '[redm-testbed]';
const BRIDGE_NAME = 'testbed-bridge';

type BridgeResult = Result<'bridge'>;

// Hides the payload of bridge requests, because it carries the token (SPEC-0001 S3).
export function redact(text: string): string {
  return text.replace(/(testbed tb-[0-9a-z-]+ \w+ \S+ )\S+/g, '$1<redacted>');
}

function cfgList(values: string[]): string {
  return `"${values.filter((value) => /^[\w:*.-]+$/.test(value)).join(',')}"`;
}

// Parses `TESTBED_RESULT <id> <json>` lines of an RCON reply.
function bridgeResults(output: string): Map<string, BridgeResult> {
  const results = new Map<string, BridgeResult>();
  for (const line of output.split(/\r?\n/)) {
    const match = /TESTBED_RESULT (tb-[0-9a-z-]+) (.*)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    try {
      results.set(match[1], JSON.parse(match[2]) as BridgeResult);
    } catch {
      results.set(match[1], { ok: false, error: `unreadable bridge result: ${match[2].slice(0, 80)}` });
    }
  }
  return results;
}

class Daemon {
  private readonly server = new ConsoleBuffer();
  private readonly client = new ConsoleBuffer();
  private fxserver: ChildProcess | undefined;
  private startedAt: number | undefined;
  private readonly uploads = new Map<string, string>();
  private readonly bridgeInbox = new Map<string, BridgeResult>();
  private readonly window = new WindowHelper();
  private connection: { state: (typeof clientStates)[number]; reason?: string; src?: number; progress?: string } = { state: 'idle' };
  private readonly clientLog = new ClientLogFollower((line) => this.onClientLogLine(line));
  private readonly devcon = new DevconConnection(({ channel, message }) => this.client.push(`[${channel}] ${message}`));

  private readonly paths: HostPaths;

  constructor(paths: HostPaths) {
    this.paths = paths;
  }

  private get state(): State {
    try {
      return JSON.parse(fs.readFileSync(this.paths.state, 'utf8')) as State;
    } catch {
      return { connect: '127.0.0.1:30120' };
    }
  }

  private get rconPort(): number {
    return Number(this.state.connect.split(':')[1]);
  }

  private rcon(command: string, timeoutMs = 5000): Promise<string> {
    return rcon(
      { host: '127.0.0.1', port: this.rconPort, password: requireSecret(this.paths.secrets, 'RCON_PASSWORD'), timeoutMs },
      command,
    );
  }

  private async rconAlive(): Promise<boolean> {
    if (!this.fxserver) return false;
    try {
      await this.rcon('version', 2000);
      return true;
    } catch {
      return false;
    }
  }

  private async serverStatus(): Promise<Result<'server.status'>> {
    const running = this.fxserver !== undefined;
    return {
      running,
      rcon: await this.rconAlive(),
      ...(this.fxserver?.pid ? { pid: this.fxserver.pid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    };
  }

  configure({ serverCfg, connect, bridge, secrets }: z.output<typeof methods['server.configure']['params']>): Result<'server.configure'> {
    const port = connect.split(':')[1];
    const header = [
      '# Written by redm-testbed. Edit the server.cfg of the project, not this file.',
      `endpoint_add_tcp "127.0.0.1:${port}"`,
      `endpoint_add_udp "127.0.0.1:${port}"`,
      // The server hosts RedM, not FiveM (SPEC-0002 D4).
      'set gamename rdr3',
      'exec secrets.cfg',
      // The daemon talks to the server over RCON on 127.0.0.1 only. The default limit (0.2/s, burst 5)
      // drops bridge polls and then blocks RCON for 15 s (citizen-server-impl RconOutOfBand.h).
      'set rateLimiter_rcon_rate 50',
      'set rateLimiter_rcon_burst 100',
      // Do not echo RCON commands: a bridge request carries the token (SPEC-0001 S3).
      'con_addChannelFilter rcon noprint',
      '',
    ].join('\n');
    const footer = [
      '',
      '# testbed-bridge (redm-testbed).',
      'set testbed_enabled true',
      `set testbed_event_allowlist ${cfgList(bridge.events)}`,
      `set testbed_export_allowlist ${cfgList(bridge.exports)}`,
      `set testbed_native_allowlist ${cfgList(bridge.natives)}`,
      `ensure ${BRIDGE_NAME}`,
      '',
    ].join('\n');
    fs.mkdirSync(this.paths.serverData, { recursive: true });
    fs.writeFileSync(this.paths.serverCfg, `${header}${serverCfg.replace(/\r\n/g, '\n')}\n${footer}`);
    fs.writeFileSync(this.paths.state, JSON.stringify({ connect, secrets } satisfies State));
    return {};
  }

  private writeSecretsCfg(): void {
    const lines = [
      '# Written by redm-testbed from secrets.env before each start.',
      `set sv_licenseKey "${requireSecret(this.paths.secrets, 'LICENSE_KEY')}"`,
      `set rcon_password "${requireSecret(this.paths.secrets, 'RCON_PASSWORD')}"`,
      `set testbed_token "${requireSecret(this.paths.secrets, 'BRIDGE_TOKEN')}"`,
    ];
    const extra = extraSecrets(this.paths.secrets);
    for (const key of extra.skipped) console.error(`secrets.env: ${key} skipped, not a valid convar name`);
    for (const name of this.state.secrets ?? []) {
      if (!extra.values.get(name)) throw new Error(`the project needs CFG_${name} in ${this.paths.secrets}`);
    }
    for (const [name, value] of extra.values) lines.push(secretLine(name, value));
    fs.writeFileSync(this.paths.secretsCfg, `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  async start(): Promise<Result<'server.start'>> {
    if (this.fxserver) return this.serverStatus();
    if (processesWithPrefix('FXServer').length > 0) {
      throw new Error('another FXServer process runs on the test host; stop it first');
    }
    const exe = path.join(this.paths.server, 'FXServer.exe');
    if (!fs.existsSync(exe)) throw new Error(`${exe} does not exist; run \`redm-testbed host setup\``);
    if (!fs.existsSync(this.paths.serverCfg)) throw new Error('no server.cfg; run `redm-testbed deploy` first');
    this.writeSecretsCfg();
    this.installBridge();
    fs.mkdirSync(this.paths.logs, { recursive: true });
    if (fs.existsSync(this.paths.serverLog)) {
      fs.renameSync(this.paths.serverLog, path.join(this.paths.logs, 'server.prev.log'));
    }
    const log = fs.createWriteStream(this.paths.serverLog);
    const child = spawn(exe, ['+exec', 'server.cfg'], {
      cwd: this.paths.serverData,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.fxserver = child;
    this.startedAt = Date.now();
    this.server.push(`[redm-testbed] FXServer started (pid ${child.pid})`);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const safe = redact(chunk);
        log.write(safe);
        this.server.write(safe);
      });
    }
    child.on('exit', (code) => {
      this.server.flush();
      this.server.push(`[redm-testbed] FXServer exited (code ${code})`);
      log.end();
      if (this.fxserver === child) {
        this.fxserver = undefined;
        this.startedAt = undefined;
      }
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!this.fxserver) {
        const tail = this.server.read({ limit: 15 }).map((line) => line.text).join('\n');
        throw new Error(`FXServer exited during start:\n${tail}`);
      }
      if (await this.rconAlive()) return this.serverStatus();
      await sleep(1000);
    }
    throw new Error('FXServer gave no RCON answer in 120 s; read the server console');
  }

  async stop(): Promise<Result<'server.stop'>> {
    const child = this.fxserver;
    if (!child) return this.serverStatus();
    await this.rcon('quit "redm-testbed stop"', 2000).catch(() => undefined);
    for (let i = 0; i < 20 && this.fxserver === child; i++) await sleep(500);
    if (this.fxserver === child && child.pid) killTree(child.pid);
    for (let i = 0; i < 20 && this.fxserver === child; i++) await sleep(250);
    return this.serverStatus();
  }

  // The bridge always has the version of the running package (SPEC-0001 D8).
  private installBridge(): void {
    const target = path.join(this.paths.resources, BRIDGE_CATEGORY, BRIDGE_NAME);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(BRIDGE_SOURCE, target, { recursive: true });
  }

  async bridge(params: z.output<typeof methods.bridge.params>): Promise<BridgeResult> {
    if (!this.fxserver) throw new Error('the server is not running');
    const id = `tb-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const token = requireSecret(this.paths.secrets, 'BRIDGE_TOKEN');
    const payload = Buffer.from(JSON.stringify({ ...params.args, op: params.op, token })).toString('base64');
    const player = params.target === 'client' ? String(params.src) : '-';
    const output = await this.rcon(`testbed ${id} ${params.target} ${player} ${payload}`);
    const direct = bridgeResults(output).get(id);
    if (direct) return direct;
    if (!output.includes(`TESTBED_ACK ${id}`)) throw new Error(`no bridge answer: ${output.trim().slice(0, 200)}`);
    const deadline = Date.now() + 15_000;
    let delay = 100;
    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 1000);
      const pollId = `tb-poll-${randomBytes(4).toString('hex')}`;
      const poll = Buffer.from(JSON.stringify({ op: 'poll', token })).toString('base64');
      const queued = bridgeResults(await this.rcon(`testbed ${pollId} server - ${poll}`)).get(pollId);
      for (const entry of (queued?.data as { id: string; result: BridgeResult }[] | undefined) ?? []) {
        this.bridgeInbox.set(entry.id, entry.result);
      }
      const result = this.bridgeInbox.get(id);
      if (result) {
        this.bridgeInbox.delete(id);
        return result;
      }
    }
    throw new Error(`client ${player} gave no bridge answer in 15 s`);
  }

  // Connects to devcon while RedM runs, so the client console is available (SPEC-0001 section 9.1).
  watchDevcon(): void {
    setInterval(() => {
      if (this.devcon.connected || !this.clientStatus().running) return;
      this.devcon.connect().then(
        () => this.client.push('[redm-testbed] devcon connected'),
        () => undefined,
      );
    }, 3000).unref();
  }

  async clientCommand({ command, timeoutMs = 5000, quietMs = 400 }: Params<'client.command'>): Promise<Result<'client.command'>> {
    if (!this.devcon.connected) await this.devcon.connect();
    const after = this.client.cursor;
    this.devcon.send(command);
    const deadline = Date.now() + timeoutMs;
    let seen = after;
    while (Date.now() < deadline) {
      const line = await this.client.wait(/./, { after: seen, timeoutMs: quietMs });
      if (!line) break;
      seen = this.client.cursor;
    }
    return { lines: this.client.read({ after, limit: 5000 }).map((line) => line.text) };
  }

  private clientStatus(): Result<'client.status'> {
    const processes = processesWithPrefix('RedM');
    // `starting` has no process for a short time after the launch.
    if (processes.length === 0 && (this.connection.state === 'connecting' || this.connection.state === 'joined')) {
      this.connection = { state: 'stopped' };
      this.clientLog.stop();
    }
    return { running: processes.length > 0, processes, ...this.connection };
  }

  // Client log lines go to the client console and update the connection state (SPEC-0003 D1, D2).
  private onClientLogLine(line: string): void {
    this.client.push(`[client-log] ${line}`);
    const event = parseClientLogLine(line);
    if (event.kind === 'error' && this.connection.state !== 'joined') {
      this.connection = { state: 'failed', reason: event.reason };
    } else if (event.kind === 'progress' && (this.connection.state === 'starting' || this.connection.state === 'connecting')) {
      this.connection = { state: 'connecting', progress: event.text };
    }
  }

  private async playerIds(): Promise<number[]> {
    if (!this.fxserver) return [];
    try {
      const result = await this.bridge({ target: 'server', op: 'players', args: {} });
      return ((result.data as { src: number }[] | undefined) ?? []).map((player) => player.src);
    } catch {
      return [];
    }
  }

  // RedM refuses a start from a service or a task. The shell opens the link (SPEC-0002 D3, F9).
  // With `wait`, returns when the client joined or failed (SPEC-0003 D3, D4).
  async launch({ wait, timeoutMs }: z.output<typeof methods['client.launch']['params']>): Promise<Result<'client.launch'>> {
    if (this.clientStatus().running) return this.clientStatus();
    // A quitting player keeps its old ID for a short time (SPEC-0003 F4). Only a new ID counts as joined.
    const before = new Set(await this.playerIds());
    const since = Date.now() - 2000;
    this.connection = { state: 'starting' };
    this.clientLog.start(since);
    const link = `redm://connect/${this.state.connect}`;
    spawn('explorer.exe', [link], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 32 && processesWithPrefix('RedM').length === 0; i++) await sleep(250);
    if (processesWithPrefix('RedM').length === 0) {
      // The redm protocol can lack a shell command (SPEC-0002 F9). Start RedM.exe with the link.
      const exe = path.join(process.env.LOCALAPPDATA ?? '', 'RedM', 'RedM.exe');
      spawn(exe, [link], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 48 && processesWithPrefix('RedM').length === 0; i++) await sleep(250);
    }
    if (processesWithPrefix('RedM').length === 0) {
      this.clientLog.stop();
      this.connection = { state: 'failed', reason: 'RedM did not start in 20 s' };
      return this.clientStatus();
    }
    if (!wait) return this.clientStatus();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connection.state === 'failed' || this.connection.state === 'stopped') break;
      const joined = (await this.playerIds()).find((id) => !before.has(id));
      if (joined !== undefined) {
        this.connection = { state: 'joined', src: joined };
        break;
      }
      await sleep(2000);
    }
    const status = this.clientStatus();
    if (status.state !== 'joined' && status.state !== 'failed' && status.state !== 'stopped') {
      return { ...status, reason: `no join in ${Math.round(timeoutMs / 1000)} s` };
    }
    return status;
  }

  async quit(): Promise<Result<'client.quit'>> {
    killImage('RedM.exe');
    for (let i = 0; i < 20 && processesWithPrefix('RedM').length > 0; i++) await sleep(250);
    this.clientLog.stop();
    this.connection = { state: 'stopped' };
    return this.clientStatus();
  }

  upload({ uploadId, chunk }: Params<'resource.upload'>): Result<'resource.upload'> {
    fs.mkdirSync(this.paths.tmp, { recursive: true });
    const file = this.uploads.get(uploadId) ?? path.join(this.paths.tmp, `${uploadId}.tar`);
    if (!this.uploads.has(uploadId)) {
      fs.rmSync(file, { force: true });
      this.uploads.set(uploadId, file);
    }
    fs.appendFileSync(file, Buffer.from(chunk, 'base64'));
    return { bytes: fs.statSync(file).size };
  }

  // Unpacks into a staging folder, then swaps it in, so no stale file stays.
  commit({ uploadId, category, name }: Params<'resource.commit'>): Result<'resource.commit'> {
    const file = this.uploads.get(uploadId);
    if (!file) throw new Error(`unknown upload ${uploadId}`);
    this.uploads.delete(uploadId);
    const target = path.join(this.paths.resources, category, name);
    const staging = `${target}.staging`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      const result = run('tar', ['-x', '-f', file, '-C', staging]);
      if (result.status !== 0) throw new Error(`tar failed: ${result.output}`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
    return {};
  }

  async reload({ names }: Params<'resource.reload'>): Promise<Result<'resource.reload'>> {
    if (!(await this.rconAlive())) return { output: 'server not running; reload skipped' };
    const outputs = [await this.rcon('refresh')];
    for (const name of names) outputs.push(await this.rcon(`ensure ${name}`));
    return { output: outputs.map((text) => text.trim()).filter(Boolean).join('\n') };
  }

  async health(): Promise<Result<'health'>> {
    const checks: Result<'health'>['checks'] = [];
    const check = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });
    const build = fs.existsSync(this.paths.buildMarker) ? fs.readFileSync(this.paths.buildMarker, 'utf8').trim() : '';
    check(build !== '', 'fxserver', build ? `build ${build}` : 'not installed');
    const secrets = readSecrets(this.paths.secrets);
    check(Boolean(secrets.get('RCON_PASSWORD')), 'rcon password', this.paths.secrets);
    check(Boolean(secrets.get('LICENSE_KEY')), 'license key', `LICENSE_KEY in ${this.paths.secrets}`);
    const extra = extraSecrets(this.paths.secrets).values;
    for (const name of this.state.secrets ?? []) check(Boolean(extra.get(name)), `secret ${name}`, `CFG_${name} in ${this.paths.secrets}`);
    check(fs.existsSync(this.paths.serverCfg), 'server.cfg', this.paths.serverCfg);
    const server = await this.serverStatus();
    check(!server.running || server.rcon, 'server', server.running ? `running, rcon ${server.rcon ? 'ok' : 'no answer'}` : 'stopped');
    const client = this.clientStatus();
    check(true, 'client', client.running ? `running (${client.processes.join(', ')})` : 'not running');
    return { checks };
  }

  private buffer(target: 'server' | 'client'): ConsoleBuffer {
    return target === 'server' ? this.server : this.client;
  }

  async handle(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case 'hello': {
        const { version } = methods.hello.params.parse(params);
        if (version !== VERSION) {
          throw new Error(`version mismatch: dev host ${version}, test host ${VERSION}; run \`redm-testbed host install\``);
        }
        return { version: VERSION, root: this.paths.root };
      }
      case 'health':
        return this.health();
      case 'server.configure':
        return this.configure(methods['server.configure'].params.parse(params));
      case 'server.start':
        return this.start();
      case 'server.stop':
        return this.stop();
      case 'server.restart':
        await this.stop();
        return this.start();
      case 'server.status':
        return this.serverStatus();
      case 'client.launch':
        return this.launch(methods['client.launch'].params.parse(params));
      case 'client.quit':
        return this.quit();
      case 'client.status':
        return this.clientStatus();
      case 'client.command':
        return this.clientCommand(methods['client.command'].params.parse(params));
      case 'bridge':
        return this.bridge(methods.bridge.params.parse(params));
      case 'window.status':
        return this.window.request('status');
      case 'window.screenshot': {
        const p = methods['window.screenshot'].params.parse(params);
        return this.window.request('screenshot', { maxSide: p.maxSide ?? 900, ...(p.crop ?? { x: 0, y: 0, width: 0, height: 0 }) }, 30_000);
      }
      case 'window.key': {
        const p = methods['window.key'].params.parse(params);
        const code = keyCode(p.key);
        await this.window.request('key', { scan: code.scan, extended: code.extended, holdMs: p.holdMs ?? 50 }, 15_000);
        return {};
      }
      case 'window.text': {
        await this.window.request('text', methods['window.text'].params.parse(params));
        return {};
      }
      case 'window.mouse': {
        const p = methods['window.mouse'].params.parse(params);
        await this.window.request(p.action, p);
        return {};
      }
      case 'rcon': {
        const { command } = methods.rcon.params.parse(params);
        return { output: await this.rcon(command) };
      }
      case 'console.read': {
        const p = methods['console.read'].params.parse(params);
        const buffer = this.buffer(p.target);
        const lines = buffer.read({
          ...(p.after !== undefined ? { after: p.after } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
          ...(p.pattern ? { pattern: new RegExp(p.pattern, 'i') } : {}),
        });
        return { lines, cursor: buffer.cursor };
      }
      case 'console.wait': {
        const p = methods['console.wait'].params.parse(params);
        const buffer = this.buffer(p.target);
        const line = await buffer.wait(new RegExp(p.pattern, 'i'), {
          timeoutMs: p.timeoutMs,
          ...(p.after !== undefined ? { after: p.after } : {}),
        });
        return { line, cursor: buffer.cursor };
      }
      case 'resource.upload':
        return this.upload(methods['resource.upload'].params.parse(params));
      case 'resource.commit':
        return this.commit(methods['resource.commit'].params.parse(params));
      case 'resource.reload':
        return this.reload(methods['resource.reload'].params.parse(params));
    }
  }

  shutdown(): void {
    this.window.stop();
    if (this.fxserver?.pid) killTree(this.fxserver.pid);
  }
}

function serveConnection(socket: net.Socket, daemon: Daemon, token: Buffer): void {
  const splitter = new LineSplitter();
  let authed = false;
  socket.setEncoding('utf8');
  const send = (message: unknown) => {
    if (!socket.destroyed) socket.write(encode(message));
  };
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    for (const line of splitter.push(chunk)) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: PROTOCOL_ERROR.parse, message: 'invalid JSON' } });
        continue;
      }
      if (!authed) {
        const given = auth.safeParse(message);
        const ok =
          given.success &&
          Buffer.byteLength(given.data.auth) === token.length &&
          timingSafeEqual(Buffer.from(given.data.auth), token);
        if (!ok) {
          socket.destroy();
          return;
        }
        authed = true;
        continue;
      }
      const parsed = request.safeParse(message);
      if (!parsed.success) {
        send({ jsonrpc: '2.0', id: null, error: { code: PROTOCOL_ERROR.invalidRequest, message: 'invalid request' } });
        continue;
      }
      const { id, method, params } = parsed.data;
      if (!isMethodName(method)) {
        send({ jsonrpc: '2.0', id, error: { code: PROTOCOL_ERROR.methodNotFound, message: `unknown method ${method}` } });
        continue;
      }
      daemon
        .handle(method, params ?? {})
        .then((result) => send({ jsonrpc: '2.0', id, result }))
        .catch((error: unknown) =>
          send({ jsonrpc: '2.0', id, error: { code: APP_ERROR, message: error instanceof Error ? error.message : String(error) } }),
        );
    }
  });
}

export async function runDaemon(root: string): Promise<void> {
  const paths = hostPaths(root);
  fs.mkdirSync(paths.logs, { recursive: true });
  // The task has no visible output, so the daemon writes its own log.
  const daemonLog = path.join(paths.logs, 'daemon.log');
  const write = (level: string, args: unknown[]) =>
    fs.appendFileSync(daemonLog, `${new Date().toISOString()} ${level} ${args.map(String).join(' ')}\n`);
  console.log = (...args: unknown[]) => write('info', args);
  console.error = (...args: unknown[]) => write('error', args);
  process.on('uncaughtException', (error) => {
    write('fatal', [error.stack ?? error]);
    process.exit(1);
  });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(paths.token, token, { mode: 0o600 });
  run('icacls', [paths.token, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`, 'SYSTEM:F']);

  const daemon = new Daemon(paths);
  daemon.watchDevcon();
  const pipe = pipeName(os.userInfo().username);
  const server = net.createServer((socket) => serveConnection(socket, daemon, Buffer.from(token)));
  // A previous daemon can hold the pipe for a short time after it stops.
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipe, () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 30) throw error;
      await sleep(500);
    }
  }
  process.title = 'redm-testbed daemon';
  console.log(`redm-testbed ${VERSION} daemon: listening on ${pipe}, root ${paths.root}`);
  const exit = (signal: string) => {
    console.log(`daemon: stopped by ${signal}`);
    daemon.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => exit('SIGINT'));
  process.on('SIGTERM', () => exit('SIGTERM'));
}
