// One-time setup of the test host (SPEC-0001 section 9.2). It is idempotent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fxserverUrl } from '../protocol/config.ts';
import { hostPaths, initSecrets } from './paths.ts';
import { powershell, processesWithPrefix, run } from './windows.ts';

export const DAEMON_TASK = 'redm-testbed-daemon';

async function installFxserver(paths: ReturnType<typeof hostPaths>, build: string): Promise<void> {
  const current = fs.existsSync(paths.buildMarker) ? fs.readFileSync(paths.buildMarker, 'utf8').trim() : '';
  if (current === build) {
    console.log(`fxserver: build ${build} already installed`);
    return;
  }
  if (processesWithPrefix('FXServer').length > 0) throw new Error('fxserver: stop the server first');
  const archive = path.join(paths.tmp, `fxserver-${build}.7z`);
  if (!fs.existsSync(archive)) {
    console.log(`fxserver: downloading build ${build}`);
    const response = await fetch(fxserverUrl(build));
    if (!response.ok) throw new Error(`fxserver: download failed with HTTP ${response.status}`);
    fs.writeFileSync(`${archive}.part`, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(`${archive}.part`, archive);
  }
  const staging = `${paths.server}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const result = run('tar', ['-x', '-f', archive, '-C', staging]);
  if (result.status !== 0) throw new Error(`fxserver: extraction failed: ${result.output}`);
  fs.writeFileSync(path.join(staging, path.basename(paths.buildMarker)), build);
  fs.rmSync(paths.server, { recursive: true, force: true });
  fs.renameSync(staging, paths.server);
  console.log(`fxserver: build ${build} installed`);
}

// The daemon starts at logon in the interactive session (SPEC-0001 D3).
function registerDaemonTask(root: string): void {
  const entry = fileURLToPath(new URL('../main.js', import.meta.url));
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const conhost = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'conhost.exe');
  const script = `
$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
# A headless console: no window that a person can close by mistake.
$action = New-ScheduledTaskAction -Execute ${quote(conhost)} -Argument ${quote(`--headless "${process.execPath}" "${entry}" host daemon --root "${root}"`)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName ${quote(DAEMON_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName ${quote(DAEMON_TASK)} -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*redm-testbed*host daemon*' } | Sort-Object { $_.CommandLine -like '*daemon-worker*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName ${quote(DAEMON_TASK)}
`;
  const result = powershell(script);
  if (result.status !== 0) throw new Error(`task: registration failed: ${result.output}`);
  console.log(`task: ${DAEMON_TASK} registered and started`);
}

export async function runSetup(root: string, build: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('host setup runs on the Windows test host only');
  const paths = hostPaths(root);
  for (const dir of [paths.root, paths.resources, paths.logs, paths.tmp]) fs.mkdirSync(dir, { recursive: true });
  await installFxserver(paths, build);
  if (initSecrets(paths.secrets)) {
    run('icacls', [paths.secrets, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`, 'SYSTEM:F', '*S-1-5-32-544:F']);
    console.log(`secrets: written to ${paths.secrets}`);
  } else {
    console.log('secrets: unchanged');
  }
  if (processesWithPrefix('FXServer').length > 0) {
    console.log('task: FXServer runs; the daemon was not restarted');
  } else {
    registerDaemonTask(paths.root);
  }
  console.log('setup: done');
}
