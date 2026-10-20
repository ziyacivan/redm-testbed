// Dev host CLI dispatch (SPEC-0001 section 11).
import { VERSION } from '../protocol/version.ts';
import * as commands from './commands.ts';
import { findProject } from './project.ts';

export const USAGE = `redm-testbed ${VERSION}

usage: redm-testbed <command>

  init                                  write redm-testbed.config.json and a server.cfg
  host install [--local]                install this version on the test host and run host setup
  deploy [resource...]                  build, upload and restart resources
  server <start|stop|restart|status>
  client <launch [--no-wait]|quit|status>
  logs [--client] [--follow] [--lines <n>]
  rcon <command...>
  screenshot [--out <file>] [--max <px>] save a screenshot of the game window
  key <name>                            press a key in the game window
  type <text...>                        type text into the game window
  doctor                                check the test environment
  mcp                                   start the MCP server (stdio)

on the test host:
  host setup --root <dir> --build <build>
  host daemon --root <dir>
  host connect --root <dir>`;

export async function runCli([command, ...args]: string[]): Promise<void> {
  switch (command) {
    case 'init':
      return commands.init();
    case 'doctor':
      return commands.doctor();
    case 'mcp': {
      const { runMcp } = await import('../mcp/server.ts');
      return runMcp();
    }
    case 'deploy':
      return commands.deploy(findProject(), args);
    case 'server':
      return commands.server(findProject(), args[0]);
    case 'client':
      return commands.client(findProject(), args[0], args.slice(1));
    case 'rcon':
      return commands.rconCommand(findProject(), args);
    case 'screenshot':
      return commands.screenshot(findProject(), args);
    case 'key':
      return commands.key(findProject(), args[0]);
    case 'type':
      return commands.typeText(findProject(), args);
    case 'logs':
      return commands.logs(findProject(), args);
    case 'host':
      if (args[0] === 'install') return commands.hostInstall(findProject(), args.includes('--local'));
      throw new commands.UsageError(USAGE);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;
    case '--version':
      console.log(VERSION);
      return;
    default:
      throw new commands.UsageError(USAGE);
  }
}
