// Dev host commands (SPEC-0001 section 11).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, type ProjectConfig } from '../protocol/config.ts';
import type { ConsoleTarget } from '../protocol/messages.ts';
import { VERSION } from '../protocol/version.ts';
import { Remote, remoteHost } from '../remote/client.ts';
import { runDeploy, UsageError } from './deploy.ts';
import { findProject, type Project } from './project.ts';

export { UsageError } from './deploy.ts';

function exec(command: string, args: string[], options: { cwd?: string; shell?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

async function withRemote<T>(config: ProjectConfig, run: (remote: Remote) => Promise<T>): Promise<T> {
  const remote = await Remote.connect(config);
  try {
    return await run(remote);
  } finally {
    remote.close();
  }
}

const print = (value: unknown) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

export async function init(): Promise<void> {
  const file = path.resolve(CONFIG_FILE);
  if (fs.existsSync(file)) throw new UsageError(`${CONFIG_FILE} exists`);
  const config = {
    host: 'testbed',
    root: 'C:/redm-testbed',
    fxserver: { build: '37175-0105063b0394b1b9d085c917a8dc9c9abf0a620f' },
    connect: '127.0.0.1:30120',
    build: 'npm run build',
    serverCfg: 'redm-testbed/server.cfg',
    resources: [{ name: 'my-resource', path: 'resources/my-resource', category: '[project]' }],
  };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const cfg = path.resolve('redm-testbed', 'server.cfg');
  if (!fs.existsSync(cfg)) {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(
      cfg,
      [
        '# redm-testbed adds the endpoints and `exec secrets.cfg` above these lines.',
        'sv_lan true',
        'sv_hostname "redm-testbed"',
        'sv_maxclients 8',
        'set onesync on',
        '',
        'ensure my-resource',
        '',
      ].join('\n'),
    );
  }
  console.log(`wrote ${CONFIG_FILE} and redm-testbed/server.cfg`);
}

// Installs this package version on the test host and runs `host setup` there.
export async function hostInstall({ config }: Project, local: boolean): Promise<void> {
  const host = remoteHost(config);
  const windowsRoot = config.root.replaceAll('/', '\\');
  await exec('ssh', ['-T', host, `if not exist ${windowsRoot}\\tmp mkdir ${windowsRoot}\\tmp`]);
  let spec = `redm-testbed@${VERSION}`;
  if (local) {
    const packageDir = fileURLToPath(new URL('../..', import.meta.url));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redm-testbed-'));
    await exec('npm', ['pack', '--silent', '--pack-destination', out], { cwd: packageDir });
    const tgz = fs.readdirSync(out).find((name) => name.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack made no archive');
    await exec('scp', ['-q', path.join(out, tgz), `${host}:${config.root}/tmp/${tgz}`]);
    spec = `${config.root}/tmp/${tgz}`;
  }
  await exec('ssh', ['-T', host, `npm install --global --no-fund --no-audit ${spec}`]);
  await exec('ssh', ['-T', host, `redm-testbed host setup --root ${config.root} --build ${config.fxserver.build}`]);
}

export async function deploy(project: Project, only: string[]): Promise<void> {
  await withRemote(project.config, (remote) => runDeploy(project, remote, only, (line) => console.log(line)));
}

export async function server({ config }: Project, action: string | undefined): Promise<void> {
  const method = { start: 'server.start', stop: 'server.stop', restart: 'server.restart', status: 'server.status' } as const;
  if (!action || !Object.hasOwn(method, action)) throw new UsageError('usage: redm-testbed server <start|stop|restart|status>');
  await withRemote(config, async (remote) => print(await remote.call(method[action as keyof typeof method], {})));
}

export async function client({ config }: Project, action: string | undefined, args: string[] = []): Promise<void> {
  if (action === 'launch') {
    // Waits for the join or the connection error, unless `--no-wait` (SPEC-0003 D4, D6).
    const wait = !args.includes('--no-wait');
    await withRemote(config, async (remote) => {
      const status = await remote.call('client.launch', { wait });
      print(status);
      if (wait && status.state !== 'joined') {
        console.error(`client did not join: ${status.reason ?? status.state}`);
        process.exitCode = 1;
      }
    });
    return;
  }
  const method = { quit: 'client.quit', status: 'client.status' } as const;
  if (!action || !Object.hasOwn(method, action)) throw new UsageError('usage: redm-testbed client <launch [--no-wait]|quit|status>');
  await withRemote(config, async (remote) => print(await remote.call(method[action as keyof typeof method], {})));
}

export async function rconCommand({ config }: Project, words: string[]): Promise<void> {
  if (words.length === 0) throw new UsageError('usage: redm-testbed rcon <command...>');
  await withRemote(config, async (remote) => print((await remote.call('rcon', { command: words.join(' ') })).output));
}

export async function logs({ config }: Project, args: string[]): Promise<void> {
  const target: ConsoleTarget = args.includes('--client') ? 'client' : 'server';
  const limitIndex = args.indexOf('--lines');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 100;
  await withRemote(config, async (remote) => {
    let { lines, cursor } = await remote.call('console.read', { target, limit });
    for (const line of lines) console.log(line.text);
    if (!args.includes('--follow')) return;
    for (;;) {
      const waited = await remote.call('console.wait', { target, pattern: '.', after: cursor, timeoutMs: 30_000 });
      if (!waited.line) continue;
      ({ lines, cursor } = await remote.call('console.read', { target, after: cursor, limit: 5000 }));
      for (const line of lines) console.log(line.text);
    }
  });
}

export async function screenshot({ config }: Project, args: string[]): Promise<void> {
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = path.resolve(option('--out') ?? `redm-testbed-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const maxSide = Number(option('--max') ?? 1920);
  await withRemote(config, async (remote) => {
    const shot = await remote.call('window.screenshot', { maxSide });
    fs.writeFileSync(out, Buffer.from(shot.png, 'base64'));
    console.log(`${out} (${shot.width}x${shot.height})`);
  });
}

export async function key({ config }: Project, name: string | undefined): Promise<void> {
  if (!name) throw new UsageError('usage: redm-testbed key <name>');
  await withRemote(config, (remote) => remote.call('window.key', { key: name }));
}

export async function typeText({ config }: Project, words: string[]): Promise<void> {
  if (words.length === 0) throw new UsageError('usage: redm-testbed type <text...>');
  await withRemote(config, (remote) => remote.call('window.text', { text: words.join(' ') }));
}

export async function doctor(): Promise<void> {
  let project: Project;
  try {
    project = findProject();
  } catch (error) {
    console.log(`FAIL config: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK   config: ${path.join(project.dir, CONFIG_FILE)}`);
  let remote: Remote;
  try {
    remote = await Remote.connect(project.config);
  } catch (error) {
    console.log(`FAIL daemon: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  try {
    console.log(`OK   daemon: ${remoteHost(project.config)}, version ${VERSION}`);
    const { checks } = await remote.call('health', {});
    for (const check of checks) console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.label}: ${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  } finally {
    remote.close();
  }
}
