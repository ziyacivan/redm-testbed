// Layer rules from SPEC-0001 section 13.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'r1-protocol-is-standalone',
      comment: 'R1: protocol imports nothing from the other folders.',
      severity: 'error',
      from: { path: '^src/protocol/' },
      to: { path: '^src/', pathNot: '^src/protocol/' },
    },
    {
      name: 'r2-dev-side-not-host-side',
      comment: 'R2: cli, mcp and remote do not import host or cfx.',
      severity: 'error',
      from: { path: '^src/(cli|mcp|remote)/' },
      to: { path: '^src/(host|cfx)/' },
    },
    {
      name: 'r2-host-side-not-dev-side',
      comment: 'R2: host does not import cli, mcp or remote.',
      severity: 'error',
      from: { path: '^src/host/' },
      to: { path: '^src/(cli|mcp|remote)/' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'not-to-unresolvable', severity: 'error', from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
