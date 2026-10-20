// testbed-bridge server half (SPEC-0001 D9, section 9.3).
// The daemon runs `testbed <id> <server|client> <src|-> <base64 json>` over RCON on 127.0.0.1.
// Server results print as `TESTBED_RESULT <id> <json>`, so the RCON reply carries them.
// Client results wait in a queue until the `poll` op takes them.
'use strict';

const crypto = require('crypto');

const MAX_RESULT_CHARS = 4000;
const pendingClient = new Map();
const results = [];

function convar(name, fallback) {
  return GetConvar(name, fallback);
}

function list(name) {
  return convar(name, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenMatches(given) {
  const expected = convar('testbed_token', '');
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function printResult(id, result) {
  let json = JSON.stringify(result, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
  if (json.length > MAX_RESULT_CHARS) {
    json = JSON.stringify({ ok: result.ok, truncated: true, preview: json.slice(0, MAX_RESULT_CHARS - 100) });
  }
  console.log(`TESTBED_RESULT ${id} ${json}`);
}

function allowedExport(resource, method) {
  const allow = list('testbed_export_allowlist');
  return allow.includes(`${resource}:${method}`) || allow.includes(`${resource}:*`);
}

const serverOps = {
  ping: () => ({ pong: true }),
  players: () =>
    getPlayers().map((src) => ({ src: Number(src), name: GetPlayerName(src), ping: GetPlayerPing(src) })),
  call_export: (req) => {
    if (!allowedExport(req.resource, req.method)) {
      throw new Error(`export ${req.resource}:${req.method} is not in testbed_export_allowlist`);
    }
    const value = exports[req.resource][req.method](...(Array.isArray(req.args) ? req.args : []));
    return value === undefined ? null : value;
  },
  trigger_event: (req) => {
    if (!list('testbed_event_allowlist').includes(req.event)) {
      throw new Error(`event '${req.event}' is not in testbed_event_allowlist`);
    }
    const args = Array.isArray(req.args) ? req.args : [];
    if (req.player !== undefined) emitNet(req.event, String(req.player), ...args);
    else emit(req.event, ...args);
    return { triggered: req.event };
  },
  poll: (req) => results.splice(0, typeof req.max === 'number' ? req.max : 16),
};

const clientOps = new Set(['ping', 'position', 'teleport', 'freeze', 'call_native', 'nui_callback']);

function dispatchClient(id, src, req) {
  if (!clientOps.has(req.op)) throw new Error(`unknown client op '${req.op}'`);
  if (req.op === 'call_native') {
    const allow = list('testbed_native_allowlist');
    if (!/^[A-Z][A-Za-z0-9]*$/.test(String(req.name))) throw new Error('a native name must be PascalCase');
    if (allow.length > 0 && !allow.includes(req.name)) throw new Error(`native ${req.name} is not in testbed_native_allowlist`);
  }
  if (!GetPlayerName(src)) throw new Error(`player ${src} is not connected`);
  const timeoutMs = Number(convar('testbed_client_timeout_ms', '10000'));
  const timer = setTimeout(() => {
    pendingClient.delete(id);
    results.push({ id, result: { ok: false, error: `client ${src} gave no answer in ${timeoutMs} ms` } });
  }, timeoutMs);
  pendingClient.set(id, { src: String(src), timer });
  emitNet('testbed:request', String(src), Object.assign({}, req, { id }));
  console.log(`TESTBED_ACK ${id}`);
}

onNet('testbed:response', (id, result) => {
  const src = String(source);
  const pending = pendingClient.get(id);
  if (!pending || pending.src !== src) return;
  clearTimeout(pending.timer);
  pendingClient.delete(id);
  results.push({ id, result });
  if (results.length > 128) results.splice(0, results.length - 128);
});

RegisterCommand(
  'testbed',
  (src, args) => {
    if (src !== 0) {
      console.log('TESTBED_DENY the testbed command is for the server console only');
      return;
    }
    const [id, target, player, payload] = args;
    if (!/^tb-[0-9a-z-]+$/.test(String(id)) || args.length !== 4) {
      console.log('TESTBED_ERR invalid request');
      return;
    }
    if (convar('testbed_enabled', 'false') !== 'true') {
      printResult(id, { ok: false, error: 'testbed-bridge is disabled (set testbed_enabled true)' });
      return;
    }
    try {
      const req = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      if (!req || typeof req !== 'object' || !tokenMatches(req.token)) throw new Error('invalid token');
      delete req.token;
      if (target === 'server') {
        const op = Object.prototype.hasOwnProperty.call(serverOps, req.op) ? serverOps[req.op] : undefined;
        if (!op) throw new Error(`unknown server op '${req.op}'`);
        printResult(id, { ok: true, data: op(req) });
      } else if (target === 'client') {
        dispatchClient(id, Number(player), req);
      } else {
        throw new Error(`unknown target '${target}'`);
      }
    } catch (error) {
      printResult(id, { ok: false, error: String((error && error.message) || error) });
    }
  },
  true,
);
