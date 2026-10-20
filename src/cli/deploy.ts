// Build, upload and restart the resources of a project (SPEC-0001 section 11, D7).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Remote } from '../remote/client.ts';
import type { Project } from './project.ts';

const CHUNK_BYTES = 512 * 1024;

export class UsageError extends Error {}

// Runs the build command. Keeps its output, because stdout of `redm-testbed mcp` is the MCP channel.
function build(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-20_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`build failed (exit code ${code}):\n${output.slice(-4000)}`)),
    );
  });
}

function tarFolder(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(dir)) {
      reject(new Error(`${dir} does not exist`));
      return;
    }
    const tar = spawn('tar', ['-c', '--no-xattrs', '-f', '-', '-C', dir, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const chunks: Buffer[] = [];
    tar.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar exited with code ${code}`))));
  });
}

export async function runDeploy(project: Project, remote: Remote, only: string[], log: (line: string) => void): Promise<void> {
  const { dir, config } = project;
  const unknown = only.filter((name) => !config.resources.some((r) => r.name === name));
  if (unknown.length > 0) throw new UsageError(`unknown resource: ${unknown.join(', ')}`);
  if (config.build) {
    log(`build: ${config.build}`);
    await build(config.build, dir);
  }
  const resources = only.length > 0 ? config.resources.filter((r) => only.includes(r.name)) : config.resources;
  for (const resource of resources) {
    const archive = await tarFolder(path.resolve(dir, resource.path));
    const uploadId = randomUUID();
    for (let offset = 0; offset < archive.length; offset += CHUNK_BYTES) {
      await remote.call('resource.upload', { uploadId, chunk: archive.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
    }
    await remote.call('resource.commit', { uploadId, category: resource.category, name: resource.name });
    log(`deployed ${resource.category}/${resource.name} (${archive.length} bytes)`);
  }
  const serverCfg = fs.readFileSync(path.resolve(dir, config.serverCfg), 'utf8');
  await remote.call('server.configure', { serverCfg, connect: config.connect, bridge: config.bridge, secrets: config.secrets });
  const names = resources.filter((r) => r.reload ?? r.category === '[project]').map((r) => r.name);
  log((await remote.call('resource.reload', { names })).output);
}
