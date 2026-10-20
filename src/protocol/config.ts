// Project configuration file `redm-testbed.config.json` (SPEC-0001 section 10).
import { z } from 'zod';

export const CONFIG_FILE = 'redm-testbed.config.json';

export const resourceEntry = z.object({
  name: z.string().regex(/^[\w-]+$/),
  path: z.string().min(1),
  category: z.string().regex(/^\[[\w-]+\]$/).default('[project]'),
  reload: z.boolean().optional(),
});

// A convar name for an extra secret (SPEC-0002 D2).
export const CONVAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const projectConfig = z.object({
  $schema: z.string().optional(),
  host: z.string().min(1),
  root: z.string().default('C:/redm-testbed'),
  fxserver: z.object({ build: z.string().regex(/^\d+-[0-9a-f]{40}$/) }),
  connect: z.string().regex(/^[\w.-]+:\d+$/).default('127.0.0.1:30120'),
  build: z.string().optional(),
  serverCfg: z.string().default('redm-testbed/server.cfg'),
  resources: z.array(resourceEntry).default([]),
  bridge: z
    .object({
      events: z.array(z.string()).default([]),
      exports: z.array(z.string()).default([]),
      natives: z.array(z.string()).default([]),
    })
    .default({ events: [], exports: [], natives: [] }),
  secrets: z.array(z.string().regex(CONVAR_NAME)).default([]),
});

export type ProjectConfig = z.infer<typeof projectConfig>;
export type ResourceEntry = z.infer<typeof resourceEntry>;

export function fxserverUrl(build: string): string {
  return `https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/${build}/server.7z`;
}

export function pipeName(user: string): string {
  return `\\\\.\\pipe\\redm-testbed-${user.toLowerCase().replace(/[^\w-]/g, '_')}`;
}
