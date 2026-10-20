// Folder layout on the test host and the secrets file (SPEC-0001 section 9.2, D12).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface HostPaths {
  root: string;
  server: string;
  buildMarker: string;
  serverData: string;
  serverCfg: string;
  secretsCfg: string;
  resources: string;
  logs: string;
  serverLog: string;
  tmp: string;
  secrets: string;
  token: string;
  state: string;
}

export function hostPaths(root: string): HostPaths {
  const base = path.resolve(root);
  const serverData = path.join(base, 'server-data');
  return {
    root: base,
    server: path.join(base, 'server'),
    buildMarker: path.join(base, 'server', '.redm-testbed-build'),
    serverData,
    serverCfg: path.join(serverData, 'server.cfg'),
    secretsCfg: path.join(serverData, 'secrets.cfg'),
    resources: path.join(serverData, 'resources'),
    logs: path.join(base, 'logs'),
    serverLog: path.join(base, 'logs', 'server.log'),
    tmp: path.join(base, 'tmp'),
    secrets: path.join(base, 'secrets.env'),
    token: path.join(base, 'daemon.token'),
    state: path.join(base, 'state.json'),
  };
}

export const SECRET_KEYS = ['LICENSE_KEY', 'RCON_PASSWORD', 'BRIDGE_TOKEN'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export function readSecrets(file: string): Map<string, string> {
  const secrets = new Map<string, string>();
  if (!fs.existsSync(file)) return secrets;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) secrets.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return secrets;
}

// Makes the generated secrets. Adds an empty LICENSE_KEY line for the owner. Returns true on a change.
export function initSecrets(file: string): boolean {
  const secrets = readSecrets(file);
  let changed = false;
  for (const key of SECRET_KEYS) {
    if (secrets.has(key) && (key === 'LICENSE_KEY' || secrets.get(key))) continue;
    secrets.set(key, key === 'LICENSE_KEY' ? '' : randomBytes(24).toString('hex'));
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, `${[...secrets].map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  }
  return changed;
}

// `CFG_<convar>=<value>` lines become `set <convar> "<value>"` (SPEC-0002 D1 to D3).
export interface ExtraSecrets {
  values: Map<string, string>;
  skipped: string[];
}

export function extraSecrets(file: string): ExtraSecrets {
  const values = new Map<string, string>();
  const skipped: string[] = [];
  for (const [key, value] of readSecrets(file)) {
    if (!key.startsWith('CFG_')) continue;
    const name = key.slice(4);
    if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) values.set(name, value);
    else skipped.push(key);
  }
  return { values, skipped };
}

export function secretLine(name: string, value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error(`the value of CFG_${name} in secrets.env contains a quote, a line break or a NUL`);
  return `set ${name} "${value}"`;
}

export function requireSecret(file: string, key: SecretKey): string {
  const value = readSecrets(file).get(key);
  if (!value) {
    const fix = key === 'LICENSE_KEY' ? 'add a key from https://portal.cfx.re' : 'run `redm-testbed host setup`';
    throw new Error(`${key} is empty in ${file}: ${fix}`);
  }
  return value;
}
