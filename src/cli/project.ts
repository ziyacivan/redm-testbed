// Finds and reads the project configuration (SPEC-0001 D11).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, type ProjectConfig, projectConfig } from '../protocol/config.ts';

export interface Project {
  dir: string;
  config: ProjectConfig;
}

export function findProject(start = process.cwd()): Project {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(file)) {
      const parsed = projectConfig.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) throw new Error(`${file} is not valid:\n${parsed.error.message}`);
      return { dir, config: parsed.data };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no ${CONFIG_FILE} found; run \`redm-testbed init\``);
    dir = parent;
  }
}
