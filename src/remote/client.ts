// JSON-RPC client that reaches the daemon through `ssh <host> redm-testbed host connect` (SPEC-0001 D2, D3).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { ProjectConfig } from '../protocol/config.ts';
import { type MethodName, methods, type Params, type Result } from '../protocol/messages.ts';
import { encode, LineSplitter, response } from '../protocol/rpc.ts';
import { VERSION } from '../protocol/version.ts';

type Pending = { method: MethodName; resolve: (value: unknown) => void; reject: (error: Error) => void };

export function remoteHost(config: ProjectConfig): string {
  return process.env.REDM_TESTBED_HOST ?? config.host;
}

export class Remote {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = '';

  private readonly ssh: ChildProcessWithoutNullStreams;

  private constructor(ssh: ChildProcessWithoutNullStreams) {
    this.ssh = ssh;
    const splitter = new LineSplitter();
    ssh.stdout.setEncoding('utf8');
    ssh.stdout.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.receive(line);
    });
    ssh.stderr.setEncoding('utf8');
    ssh.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    ssh.on('close', (code) => {
      const detail = this.stderr.trim() || `ssh exited with code ${code}`;
      for (const pending of this.pending.values()) pending.reject(new Error(detail));
      this.pending.clear();
    });
  }

  static async connect(config: ProjectConfig): Promise<Remote> {
    const ssh = spawn('ssh', ['-T', '-o', 'ConnectTimeout=10', remoteHost(config), 'redm-testbed', 'host', 'connect', '--root', config.root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const remote = new Remote(ssh);
    await remote.call('hello', { version: VERSION });
    return remote;
  }

  private receive(line: string): void {
    let parsed;
    try {
      parsed = response.parse(JSON.parse(line));
    } catch {
      return;
    }
    if (parsed.id === null) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if ('error' in parsed) {
      pending.reject(new Error(parsed.error.message));
      return;
    }
    const result = methods[pending.method].result.safeParse(parsed.result);
    if (result.success) pending.resolve(result.data);
    else pending.reject(new Error(`invalid result of ${pending.method}: ${result.error.message}`));
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.ssh.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.ssh.stdin.end();
  }
}
