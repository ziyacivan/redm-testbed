// testbed-bridge client half (SPEC-0001 section 9.3).
// ES2017 and CFX functions only: the RedM client runtime has no fetch, no AbortController
// and no other browser API (SPEC-0001 F5, R3). The NUI page of this resource does the fetch.
'use strict';

// The global object without `globalThis` (ES2020).
const root = Function('return this')();
const NUI_TIMEOUT_MS = 5000;
const pendingNui = {};

function vector(value) {
  return { x: value[0], y: value[1], z: value[2] };
}

function nuiCallback(req) {
  if (typeof req.resource !== 'string' || typeof req.endpoint !== 'string') {
    return Promise.reject(new Error("nui_callback needs string 'resource' and 'endpoint'"));
  }
  const timeoutMs = typeof req.timeoutMs === 'number' ? req.timeoutMs : NUI_TIMEOUT_MS;
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      delete pendingNui[req.id];
      reject(new Error('NUI callback ' + req.resource + '/' + req.endpoint + ' gave no answer in ' + timeoutMs + ' ms'));
    }, timeoutMs + 1000);
    pendingNui[req.id] = function (result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete pendingNui[req.id];
      if (result && result.ok) resolve(result.data);
      else reject(new Error((result && result.error) || 'NUI callback failed'));
    };
    SendNUIMessage({
      type: 'testbed:nui_callback',
      id: req.id,
      resource: req.resource,
      endpoint: req.endpoint,
      payload: req.payload,
      timeoutMs: timeoutMs,
    });
  });
}

RegisterNuiCallbackType('result');
on('__cfx_nui:result', function (data, cb) {
  cb({});
  const settle = data && pendingNui[data.id];
  if (settle) settle(data.result);
});

const ops = {
  ping: function () {
    return { pong: true, gameTimer: GetGameTimer() };
  },
  position: function () {
    const ped = PlayerPedId();
    return { coords: vector(GetEntityCoords(ped, true, true)), heading: GetEntityHeading(ped) };
  },
  teleport: function (req) {
    const ped = PlayerPedId();
    SetEntityCoords(ped, Number(req.x), Number(req.y), Number(req.z), false, false, false, false);
    if (typeof req.heading === 'number') SetEntityHeading(ped, req.heading);
    return { coords: vector(GetEntityCoords(ped, true, true)) };
  },
  freeze: function (req) {
    FreezeEntityPosition(PlayerPedId(), req.on !== false);
    return { frozen: req.on !== false };
  },
  call_native: function (req) {
    const fn = root[req.name];
    if (typeof fn !== 'function') throw new Error('native ' + req.name + ' does not exist');
    const result = fn.apply(null, Array.isArray(req.args) ? req.args : []);
    return result === undefined ? null : result;
  },
  nui_callback: nuiCallback,
};

onNet('testbed:request', function (req) {
  Promise.resolve()
    .then(function () {
      const op = Object.prototype.hasOwnProperty.call(ops, req.op) ? ops[req.op] : undefined;
      if (!op) throw new Error("unknown client op '" + req.op + "'");
      return op(req);
    })
    .then(
      function (data) {
        emitNet('testbed:response', req.id, { ok: true, data: data });
      },
      function (error) {
        emitNet('testbed:response', req.id, { ok: false, error: String((error && error.message) || error) });
      },
    );
});
