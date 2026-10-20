// Connects the stdio of an SSH session to the daemon (SPEC-0001 D3, D4).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { pipeName } from '../protocol/config.ts';
import { encode } from '../protocol/rpc.ts';
import { hostPaths } from './paths.ts';

export function runRelay(root: string): void {
  const paths = hostPaths(root);
  let token: string;
  try {
    token = fs.readFileSync(paths.token, 'utf8').trim();
  } catch {
    console.error(`redm-testbed: the daemon is not running (no ${paths.token}); log on to the test host or run \`redm-testbed host setup\``);
    process.exit(3);
  }
  const socket = net.connect(pipeName(os.userInfo().username));
  socket.on('error', (error) => {
    console.error(`redm-testbed: cannot reach the daemon: ${error.message}`);
    process.exit(3);
  });
  socket.on('connect', () => {
    socket.write(encode({ auth: token }));
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on('close', () => process.exit(0));
  process.stdin.on('end', () => socket.end());
}
