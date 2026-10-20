#!/usr/bin/env node
// Binary entry. Routes test host commands to `host/` and all other commands to `cli/` (SPEC-0001 D1, R2).
function option(args: string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name) || !value) throw new Error(`missing ${name}`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, sub, ...rest] = argv;
  if (command === 'host' && sub && sub !== 'install') {
    if (sub === 'setup') {
      const { runSetup } = await import('./host/setup.ts');
      return runSetup(option(rest, '--root'), option(rest, '--build'));
    }
    if (sub === 'daemon') {
      const { runSupervisor } = await import('./host/supervisor.ts');
      return runSupervisor(option(rest, '--root'));
    }
    if (sub === 'daemon-worker') {
      const { runDaemon } = await import('./host/daemon.ts');
      return runDaemon(option(rest, '--root'));
    }
    if (sub === 'connect') {
      const { runRelay } = await import('./host/relay.ts');
      return runRelay(option(rest, '--root'));
    }
  }
  const { runCli } = await import('./cli/main.ts');
  return runCli(argv);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Error && error.constructor.name === 'UsageError' ? 2 : 1;
});
