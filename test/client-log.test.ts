import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientLogFollower, newestClientLog, parseClientLogLine } from '../src/host/client-log.ts';

describe('parseClientLogLine', () => {
  it('reads progress and error lines', () => {
    expect(parseClientLogLine('[ 29656] [b3258_GTAProce]  UV loop: httpClient/ OnConnectionProgress: neo: Deferring connection...')).toEqual({
      kind: 'progress',
      text: 'neo: Deferring connection...',
    });
    expect(
      parseClientLogLine('[ 29688] [b3258_GTAProce]  UV loop: httpClient/ OnConnectionError: Connection rejected by server: neo needs a Discord account.'),
    ).toEqual({ kind: 'error', reason: 'Connection rejected by server: neo needs a Discord account.' });
  });

  it('ignores other lines', () => {
    expect(parseClientLogLine('[ 2781] [FiveM] MainThrd/ hello from FiveM.exe')).toEqual({ kind: 'other' });
  });
});

describe('ClientLogFollower', () => {
  it('follows the newest file and reports complete lines only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-log-'));
    const old = path.join(dir, 'CitizenFX_log_2026-10-10T100000.log');
    fs.writeFileSync(old, 'old line\n');
    fs.utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const since = Date.now() - 1000;
    expect(newestClientLog(dir, since)).toBeUndefined();

    const lines: string[] = [];
    const follower = new ClientLogFollower((line) => lines.push(line), dir);
    follower.start(since);
    const current = path.join(dir, 'CitizenFX_log_2026-10-11T100000.log');
    fs.writeFileSync(current, 'first\nsecond par');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(lines).toEqual(['first']);
    fs.appendFileSync(current, 'tial\r\n');
    await new Promise((resolve) => setTimeout(resolve, 700));
    follower.stop();
    expect(lines).toEqual(['first', 'second partial']);
  });
});
