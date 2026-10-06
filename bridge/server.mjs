// WebSocket <-> Kuksa Databroker bridge.
//
// Browsers can't speak gRPC (HTTP/2 trailers), so this small service translates a JSON
// WebSocket protocol into kuksa.val.v2 calls. One WebSocket = one Kuksa client session:
// its subscriptions and provider stream live exactly as long as the socket.
//
// Client -> bridge
//   { type: 'subscribe', paths: string[] }
//   { type: 'publish',   path, value }               -> PublishValue
//   { type: 'actuate',   id, path, value }           -> Actuate, answered with 'actuateResult'
//   { type: 'provide',   paths: string[] }           -> OpenProviderStream + ProvideActuationRequest
// Bridge -> client
//   { type: 'ready', server: { name, version } }
//   { type: 'update', updates: [{ path, value }] }   (value is null when Kuksa has none yet)
//   { type: 'actuateResult', id, error? }
//   { type: 'actuationRequest', path, value }        (we are the provider for `path`)
//   { type: 'error', op, path?, message }

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { WebSocketServer } from 'ws';

const KUKSA_ADDR = process.env.KUKSA_ADDR ?? '127.0.0.1:55555';
const PORT = Number(process.env.BRIDGE_PORT ?? 8091);
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';

const protoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proto');
const definition = protoLoader.loadSync('kuksa/val/v2/val.proto', {
  includeDirs: [protoDir],
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: false,
  oneofs: true,
});
const { VAL } = grpc.loadPackageDefinition(definition).kuksa.val.v2;
const kuksa = new VAL(KUKSA_ADDR, grpc.credentials.createInsecure());

const unary = (method, request) =>
  new Promise((resolve, reject) => kuksa[method](request, (err, res) => (err ? reject(err) : resolve(res))));

/** VSS metadata, fetched once: path -> { id, dataType, entryType } and id -> path. */
let metadataPromise;
function metadata() {
  metadataPromise ??= unary('ListMetadata', { root: 'Vehicle' })
    .then(({ metadata: list }) => {
      const byPath = new Map();
      const byId = new Map();
      for (const m of list) {
        byPath.set(m.path, { id: m.id, dataType: m.data_type, entryType: m.entry_type });
        byId.set(m.id, m.path);
      }
      return { byPath, byId };
    })
    .catch((err) => {
      metadataPromise = undefined; // retry on the next client
      throw err;
    });
  return metadataPromise;
}

/** Wraps a JS value in the kuksa.val.v2.Value oneof matching the signal's VSS datatype. */
function toKuksaValue(dataType, value) {
  switch (dataType) {
    case 'DATA_TYPE_BOOLEAN': return { bool: Boolean(value) };
    case 'DATA_TYPE_STRING': return { string: String(value) };
    case 'DATA_TYPE_INT8':
    case 'DATA_TYPE_INT16':
    case 'DATA_TYPE_INT32': return { int32: Math.round(Number(value)) };
    case 'DATA_TYPE_INT64': return { int64: Math.round(Number(value)) };
    case 'DATA_TYPE_UINT8':
    case 'DATA_TYPE_UINT16':
    case 'DATA_TYPE_UINT32': return { uint32: Math.max(0, Math.round(Number(value))) };
    case 'DATA_TYPE_UINT64': return { uint64: Math.max(0, Math.round(Number(value))) };
    case 'DATA_TYPE_FLOAT': return { float: Number(value) };
    case 'DATA_TYPE_DOUBLE': return { double: Number(value) };
    default: throw new Error(`Unsupported datatype ${dataType}`);
  }
}

function fromKuksaValue(value) {
  if (!value || !value.typed_value) return null;
  const v = value[value.typed_value];
  // Floats arrive as float32; trim the binary noise (42.099998 -> 42.1).
  return value.typed_value === 'float' ? Math.round(v * 1e4) / 1e4 : v;
}

const describe = (err) => (err?.details ? `${grpc.status[err.code] ?? err.code}: ${err.details}` : String(err?.message ?? err));

function handleClient(ws) {
  const calls = new Set(); // live gRPC streams owned by this socket
  const publishChains = new Map(); // path -> promise, keeps publishes to one signal in order
  let provider;
  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const fail = (op, err, p) => send({ type: 'error', op, path: p, message: describe(err) });

  async function signal(p) {
    const meta = (await metadata()).byPath.get(p);
    if (!meta) throw new Error(`Unknown VSS path ${p}`);
    return meta;
  }

  const handlers = {
    subscribe({ paths }) {
      const call = kuksa.Subscribe({ signal_paths: paths });
      calls.add(call);
      call.on('data', ({ entries }) => {
        const updates = Object.entries(entries).map(([p, dp]) => ({ path: p, value: fromKuksaValue(dp.value) }));
        send({ type: 'update', updates });
      });
      call.on('error', (err) => err.code !== grpc.status.CANCELLED && fail('subscribe', err));
    },

    publish({ path: p, value }) {
      const run = async () => {
        const { dataType } = await signal(p);
        await unary('PublishValue', { signal_id: { path: p }, data_point: { value: toKuksaValue(dataType, value) } });
      };
      const next = (publishChains.get(p) ?? Promise.resolve()).then(run).catch((err) => fail('publish', err, p));
      publishChains.set(p, next);
      return next;
    },

    async actuate({ id, path: p, value }) {
      try {
        const { dataType } = await signal(p);
        await unary('Actuate', { signal_id: { path: p }, value: toKuksaValue(dataType, value) });
        send({ type: 'actuateResult', id });
      } catch (err) {
        send({ type: 'actuateResult', id, error: describe(err) });
      }
    },

    async provide({ paths }) {
      const { byId } = await metadata();
      if (!provider) {
        provider = kuksa.OpenProviderStream();
        calls.add(provider);
        provider.on('data', (msg) => {
          if (msg.action !== 'batch_actuate_stream_request') return;
          for (const req of msg.batch_actuate_stream_request.actuate_requests) {
            const p = req.signal_id.path ?? byId.get(req.signal_id.id);
            send({ type: 'actuationRequest', path: p, value: fromKuksaValue(req.value) });
          }
        });
        provider.on('error', (err) => err.code !== grpc.status.CANCELLED && fail('provide', err));
      }
      provider.write({ provide_actuation_request: { actuator_identifiers: paths.map((p) => ({ path: p })) } });
    },
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail('parse', new Error('Invalid JSON'));
    }
    const handler = handlers[msg.type];
    if (!handler) return fail(msg.type, new Error(`Unknown message type ${msg.type}`));
    try {
      await handler(msg);
    } catch (err) {
      fail(msg.type, err, msg.path);
    }
  });

  ws.on('close', () => {
    for (const call of calls) call.cancel?.() ?? call.end?.();
    calls.clear();
  });

  unary('GetServerInfo', {})
    .then((info) => send({ type: 'ready', server: { name: info.name, version: info.version }, kuksa: KUKSA_ADDR }))
    .catch((err) => {
      fail('connect', err);
      ws.close(1011, 'Kuksa Databroker unreachable');
    });
}

const wss = new WebSocketServer({ host: HOST, port: PORT });
wss.on('connection', handleClient);
wss.on('listening', () => console.log(`[bridge] ws://${HOST}:${PORT} -> kuksa ${KUKSA_ADDR}`));
