// MCP server on the dev host (SPEC-0001 D7, section 12). It runs local actions and calls the daemon over SSH.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runDeploy } from '../cli/deploy.ts';
import { findProject, type Project } from '../cli/project.ts';
import { bridgeClientOps, bridgeServerOps, type MethodName, type Params, type Result } from '../protocol/messages.ts';
import { KEY_NAMES } from '../protocol/keys.ts';
import { VERSION } from '../protocol/version.ts';
import { Remote } from '../remote/client.ts';
import { checkSteps, DEFAULT_SCREENSHOT_SIDE, runSteps, stepSchema } from './steps.ts';

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

class Session {
  private remote: Remote | undefined;
  readonly project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  private async connection(): Promise<Remote> {
    this.remote ??= await Remote.connect(this.project.config);
    return this.remote;
  }

  // Drops a broken connection, so the next call connects again.
  async call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const remote = await this.connection();
    try {
      return await remote.call(method, params);
    } catch (error) {
      if ((error as Error).message.includes('ssh exited')) this.remote = undefined;
      throw error;
    }
  }

  async withRemote<T>(run: (remote: Remote) => Promise<T>): Promise<T> {
    return run(await this.connection());
  }

  close(): void {
    this.remote?.close();
  }
}

function tool<A>(run: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return text(await run(args));
    } catch (error) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  };
}

const target = z.enum(['server', 'client']).describe('Which console: the FXServer console or the RedM client console (devcon).');

export async function runMcp(): Promise<void> {
  const session = new Session(findProject());
  const server = new McpServer({ name: 'redm-testbed', version: VERSION });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'doctor',
    { description: 'Check the configuration, the daemon on the test host, FXServer and RedM. Call first.', annotations: readOnly },
    tool(async () => {
      const { checks } = await session.call('health', {});
      return checks.map((check) => `${check.ok ? 'OK  ' : 'FAIL'} ${check.label}: ${check.detail}`).join('\n');
    }),
  );

  server.registerTool(
    'deploy',
    {
      description:
        'Run the build command of the project, upload the resources to the test host and restart them (refresh + ensure). ' +
        'Without `resources`, deploys all resources of redm-testbed.config.json.',
      inputSchema: { resources: z.array(z.string()).optional().describe('Resource names to deploy.') },
    },
    tool(async ({ resources }: { resources?: string[] | undefined }) => {
      const lines: string[] = [];
      await session.withRemote((remote) => runDeploy(session.project, remote, resources ?? [], (line) => lines.push(line)));
      return lines.join('\n');
    }),
  );

  server.registerTool(
    'server_control',
    { description: 'Start, stop, restart or read the state of FXServer on the test host.', inputSchema: { action: z.enum(['start', 'stop', 'restart', 'status']) } },
    tool(async ({ action }: { action: 'start' | 'stop' | 'restart' | 'status' }) => session.call(`server.${action}`, {})),
  );

  server.registerTool(
    'client_control',
    {
      description:
        'Launch RedM on the test host and wait until it joins the test server (state joined, with src) or fails ' +
        '(state failed, with the reason from the client log). Also quit, or read the state. A join takes about 1 to 2 minutes.',
      inputSchema: { action: z.enum(['launch', 'quit', 'status']), timeoutMs: z.number().int().min(1000).max(600_000).optional() },
    },
    tool(async ({ action, timeoutMs }: { action: 'launch' | 'quit' | 'status'; timeoutMs?: number | undefined }) =>
      action === 'launch'
        ? session.call('client.launch', { wait: true, ...(timeoutMs ? { timeoutMs } : {}) })
        : session.call(`client.${action}`, {}),
    ),
  );

  server.registerTool(
    'server_command',
    { description: 'Run one FXServer console command over RCON and return its output.', inputSchema: { command: z.string().min(1) } },
    tool(async ({ command }: { command: string }) => (await session.call('rcon', { command })).output),
  );

  server.registerTool(
    'client_command',
    {
      description:
        'Run one F8 console command in the RedM client (devcon) and return the console lines it printed. ' +
        'This is the client console, not chat: RegisterCommand chat commands do not run here.',
      inputSchema: { command: z.string().min(1), timeoutMs: z.number().int().optional() },
    },
    tool(async ({ command, timeoutMs }: { command: string; timeoutMs?: number | undefined }) =>
      (await session.call('client.command', { command, ...(timeoutMs ? { timeoutMs } : {}) })).lines.join('\n'),
    ),
  );

  server.registerTool(
    'read_console',
    {
      description: 'Read console lines. Without `after`, returns the newest lines. Use the returned cursor as `after` to page.',
      inputSchema: {
        target,
        after: z.number().int().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        pattern: z.string().optional().describe('Case-insensitive regular expression filter.'),
      },
      annotations: readOnly,
    },
    tool(async (args: Params<'console.read'>) => {
      const { lines, cursor } = await session.call('console.read', args);
      return `${lines.map((line) => line.text).join('\n')}\n(cursor ${cursor})`;
    }),
  );

  server.registerTool(
    'wait_for_console',
    {
      description: 'Wait for the first console line that matches a pattern. Your assertion primitive. Returns null on timeout.',
      inputSchema: {
        target,
        pattern: z.string().describe('Case-insensitive regular expression.'),
        after: z.number().int().optional().describe('Only lines after this cursor. Default: lines from now on.'),
        timeoutMs: z.number().int().min(1).max(600_000).default(30_000),
      },
      annotations: readOnly,
    },
    tool(async (args: Params<'console.wait'>) => session.call('console.wait', args)),
  );

  server.registerTool(
    'bridge',
    {
      description:
        `Run a testbed-bridge operation inside the game. Server ops: ${bridgeServerOps.join(', ')}. ` +
        `Client ops (need src, the server ID of the player): ${bridgeClientOps.join(', ')}. ` +
        'Args: call_export {resource, method, args}, trigger_event {event, args, player?}, teleport {x, y, z, heading?}, ' +
        'freeze {on}, call_native {name, args}, nui_callback {resource, endpoint, payload, timeoutMs?}.',
      inputSchema: {
        target: z.enum(['server', 'client']),
        op: z.enum([...new Set([...bridgeServerOps, ...bridgeClientOps])] as [string, ...string[]]),
        src: z.number().int().min(1).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      },
    },
    tool(async ({ target: side, op, src, args }: { target: 'server' | 'client'; op: string; src?: number | undefined; args?: Record<string, unknown> | undefined }) => {
      if (side === 'client' && src === undefined) throw new Error('a client op needs src (bridge server op `players` lists them)');
      const params = side === 'server' ? { target: side, op, args: args ?? {} } : { target: side, op, src, args: args ?? {} };
      return session.call('bridge', params as Params<'bridge'>);
    }),
  );

  server.registerTool(
    'screenshot',
    {
      description:
        `PNG of the game window on the test host, scaled down so the longest side is maxSide (default ${DEFAULT_SCREENSHOT_SIDE}). ` +
        'Each image costs many tokens for the rest of the session: prefer console and bridge checks, and use a small maxSide or a crop. ' +
        'To see the result of an input, put one screenshot step at the end of a `steps` call instead of a separate call.',
      inputSchema: {
        maxSide: z.number().int().min(64).max(4096).optional(),
        crop: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }).optional(),
      },
      annotations: readOnly,
    },
    async (args: Params<'window.screenshot'>): Promise<ToolResult> => {
      try {
        const shot = await session.call('window.screenshot', { ...args, maxSide: args.maxSide ?? DEFAULT_SCREENSHOT_SIDE });
        return {
          content: [
            { type: 'image', data: shot.png, mimeType: 'image/png' },
            { type: 'text', text: `${shot.width}x${shot.height}` },
          ],
        };
      } catch (error) {
        return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
      }
    },
  );

  server.registerTool(
    'window_status',
    { description: 'State of the game window: found, focused, title and client rectangle.', annotations: readOnly },
    tool(async () => session.call('window.status', {})),
  );

  server.registerTool(
    'press_key',
    {
      description: `Press one key in the game window (scan code input). Keys: ${KEY_NAMES.join(', ')}. Each call is one model turn: for a sequence of inputs use \`steps\`.`,
      inputSchema: { key: z.string(), holdMs: z.number().int().min(0).max(10_000).optional() },
    },
    tool(async (args: Params<'window.key'>) => session.call('window.key', args)),
  );

  server.registerTool(
    'type_text',
    {
      description: 'Type text into the game window as Unicode key events, for example into the chat input or the F8 console. For text between key presses use `steps`.',
      inputSchema: { text: z.string().min(1).max(500) },
    },
    tool(async (args: Params<'window.text'>) => session.call('window.text', args)),
  );

  server.registerTool(
    'mouse',
    {
      description:
        'Mouse input in the game window. move {dx, dy}: relative move (camera). position {x, y}: cursor position in window pixels (NUI). ' +
        'click {button}: left or right click. scroll {amount}: wheel steps.',
      inputSchema: {
        action: z.enum(['move', 'position', 'click', 'scroll']),
        dx: z.number().int().optional(),
        dy: z.number().int().optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        button: z.enum(['left', 'right']).optional(),
        amount: z.number().int().optional(),
      },
    },
    tool(async (args: Record<string, unknown>) => session.call('window.mouse', args as Params<'window.mouse'>)),
  );

  server.registerTool(
    'steps',
    {
      description:
        'Run up to 30 test actions in order in ONE call (each tool call costs a whole model turn, so prefer this for any flow of inputs). ' +
        'Steps: {do:"key",key,holdMs?}, {do:"keys",keys:[...],gapMs?} (a sequence), {do:"text",text}, {do:"mouse",action,...} (arguments of the mouse tool), ' +
        '{do:"wait",ms}, {do:"command",target:"client"|"server",command}, {do:"console",target,pattern?,limit?} (newest matching lines), ' +
        `{do:"screenshot",maxSide?,crop?} (at most 3 per call, default maxSide ${DEFAULT_SCREENSHOT_SIDE}). ` +
        'It stops at the first failed step and reports each step. Example: open chat, type a command, send it, look: ' +
        '[{do:"key",key:"t"},{do:"text",text:"/hud"},{do:"key",key:"enter"},{do:"wait",ms:300},{do:"screenshot",crop:{x:0,y:0,width:960,height:540}}].',
      inputSchema: { steps: z.array(stepSchema).min(1).max(30) },
    },
    async ({ steps }): Promise<ToolResult> => {
      const refusal = checkSteps(steps);
      if (refusal !== undefined) return { ...text(refusal), isError: true };
      try {
        const outcome = await runSteps(steps, {
          call: (method, params) => session.call(method, params),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        return {
          content: [
            { type: 'text', text: outcome.lines.join('\n') },
            ...outcome.images.map((image) => ({ type: 'image' as const, data: image.png, mimeType: 'image/png' })),
          ],
          ...(outcome.ok ? {} : { isError: true }),
        };
      } catch (error) {
        return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
      }
    },
  );

  server.registerPrompt(
    'test_resource',
    {
      description: 'Deploy a resource, scan both consoles for errors, run an in-game scenario and report PASS or FAIL with evidence.',
      argsSchema: { resource: z.string(), expectations: z.string().optional() },
    },
    ({ resource, expectations }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Test the RedM resource "${resource}" with the redm-testbed tools.`,
              '1. Call doctor. Stop and report if a check fails.',
              `2. Call deploy with resources ["${resource}"]. If the server is stopped, call server_control start.`,
              `3. wait_for_console (server) for "Started resource ${resource}" or an error line.`,
              '4. read_console (server) and look for errors and warnings of the resource.',
              '5. client_control status. If the state is not joined, call client_control launch. On state failed, stop and report the reason.',
              '6. read_console (client) and look for script errors of the resource.',
              `7. Run the scenario with bridge ops and console tools.${expectations ? ` Expectations: ${expectations}` : ''}`,
              '8. Report PASS or FAIL for each expectation, with the console lines or bridge results as evidence. Say so when you cannot verify a step.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => {
    session.close();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
