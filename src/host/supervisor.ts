// Restarts the daemon after a crash or a kill (SPEC-0001 D3). The scheduled task runs this small process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hostPaths } from './paths.ts';

const RESTART_DELAY_MS = 2000;
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 60_000;

export function runSupervisor(root: string): void {
  const logFile = path.join(hostPaths(root).logs, 'daemon.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = (message: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} supervisor ${message}\n`);
  const starts: number[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;

  const start = () => {
    const now = Date.now();
    starts.push(now);
    while (starts.length > 0 && (starts[0] ?? now) < now - BURST_WINDOW_MS) starts.shift();
    // Many crashes in a short time: wait longer, so a broken install does not spin.
    const delay = starts.length > BURST_LIMIT ? BURST_WINDOW_MS : 0;
    setTimeout(() => {
      child = spawn(process.execPath, [process.argv[1] ?? '', 'host', 'daemon-worker', '--root', root], { stdio: 'ignore', windowsHide: true });
      child.on('exit', (code, signal) => {
        if (stopping) {
          process.exit(0);
        }
        log(`daemon exited (code ${code}, signal ${signal}); restart in ${RESTART_DELAY_MS} ms`);
        setTimeout(start, RESTART_DELAY_MS);
      });
    }, delay);
  };

  const stop = () => {
    stopping = true;
    if (child?.pid) child.kill();
    else process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log('started');
  start();
}
