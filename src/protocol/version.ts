import { readFileSync } from 'node:fs';

// Both hosts must run the same package version (SPEC-0001 D1).
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
