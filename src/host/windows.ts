// Small wrappers around Windows tools on the test host.
import { spawnSync } from 'node:child_process';

export function run(command: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

export function powershell(script: string): { status: number; output: string } {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
}

// Image names of running processes that start with the prefix (case-insensitive).
export function processesWithPrefix(prefix: string): string[] {
  const result = run('tasklist', ['/fo', 'csv', '/nh']);
  const names = new Set<string>();
  for (const line of result.output.split(/\r?\n/)) {
    const name = line.split('","')[0]?.replace(/^"/, '');
    if (name?.toLowerCase().startsWith(prefix.toLowerCase())) names.add(name);
  }
  return [...names];
}

export function killTree(pid: number): void {
  run('taskkill', ['/f', '/t', '/pid', String(pid)]);
}

export function killImage(image: string): void {
  run('taskkill', ['/f', '/t', '/im', image]);
}
