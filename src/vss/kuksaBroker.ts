import { SIGNALS, SIGNAL_BY_PATH, coerce, type SignalValue } from './signals';
import type { ChangeEvent, Datapoint, Unsubscribe, VehicleDataBroker } from './databroker';

/** Remote updates for a path we wrote within this window are treated as our own echoes. */
const ECHO_WINDOW_MS = 400;
const REMOTE_SOURCE = 'Kuksa';

export type BrokerStatus =
  | { state: 'connecting'; url: string }
  | { state: 'connected'; url: string; server: string; kuksa: string }
  | { state: 'disconnected'; url: string; reason: string };

type BridgeMessage =
  | { type: 'ready'; server: { name: string; version: string }; kuksa: string }
  | { type: 'update'; updates: { path: string; value: SignalValue | null }[] }
  | { type: 'actuateResult'; id: number; error?: string }
  | { type: 'actuationRequest'; path: string; value: SignalValue }
  | { type: 'error'; op: string; path?: string; message: string };

/**
 * VehicleDataBroker backed by a real Eclipse Kuksa Databroker, reached through the WebSocket
 * bridge in /bridge. The browser vehicle registers as the provider for every actuator, so apps
 * anywhere (this page, Python, another machine) actuate the 3D car through Kuksa.
 *
 * `get()` stays synchronous: the broker mirrors all simulator signals in a local cache, fed by a
 * Kuksa subscription. Local writes update the cache immediately and are then sent to Kuksa.
 */
export class KuksaDataBroker implements VehicleDataBroker {
  private readonly values = new Map<string, Datapoint>();
  private readonly subscribers = new Map<string, Set<(e: ChangeEvent) => void>>();
  private readonly global = new Set<(e: ChangeEvent) => void>();
  private readonly statusListeners = new Set<(s: BrokerStatus) => void>();
  private readonly providers = new Map<string, (value: SignalValue, source: string) => void>();
  private readonly lastLocalWrite = new Map<string, number>();
  /** Actuations this page requested, so the provider side can credit the right source. */
  private readonly pendingActuations: { path: string; value: SignalValue; source: string }[] = [];
  private ws!: WebSocket;
  private nextActuateId = 1;
  private initialised = false;
  status: BrokerStatus;

  private constructor(private readonly url: string) {
    const now = performance.now();
    for (const s of SIGNALS) this.values.set(s.path, { value: s.default, timestamp: now });
    this.status = { state: 'connecting', url };
  }

  /** Connects and resolves once the initial values have been loaded from Kuksa. */
  static connect(url: string, timeoutMs = 5000): Promise<KuksaDataBroker> {
    const broker = new KuksaDataBroker(url);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from bridge at ${url}`)), timeoutMs);
      broker.open(() => {
        clearTimeout(timer);
        resolve(broker);
      }, (reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
      });
    });
  }

  private open(onInitialised: () => void, onFail: (reason: string) => void): void {
    this.setStatus({ state: 'connecting', url: this.url });
    const ws = (this.ws = new WebSocket(this.url));
    let ready = false;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as BridgeMessage;
      switch (msg.type) {
        case 'ready':
          ready = true;
          this.setStatus({ state: 'connected', url: this.url, server: `${msg.server.name} ${msg.server.version}`, kuksa: msg.kuksa });
          this.send({ type: 'subscribe', paths: SIGNALS.map((s) => s.path) });
          this.sendProvide();
          break;
        case 'update':
          this.applyRemote(msg.updates);
          if (!this.initialised) {
            this.initialised = true;
            onInitialised();
          }
          break;
        case 'actuationRequest':
          this.fulfilActuation(msg.path, msg.value);
          break;
        case 'actuateResult':
          if (msg.error) console.warn(`[Kuksa] actuate #${msg.id} failed: ${msg.error}`);
          break;
        case 'error':
          console.warn(`[Kuksa] ${msg.op}${msg.path ? ` ${msg.path}` : ''}: ${msg.message}`);
          break;
      }
    };
    ws.onclose = (ev) => {
      const reason = ev.reason || (ready ? 'connection lost' : 'bridge not reachable');
      this.setStatus({ state: 'disconnected', url: this.url, reason });
      if (!this.initialised) return onFail(`${reason} (${this.url})`);
      // Keep the simulator running locally and try to reattach.
      setTimeout(() => this.open(() => undefined, () => undefined), 2000);
    };
  }

  private send(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** The browser vehicle provides every actuator in the catalog; unclaimed ones just take the value. */
  private sendProvide(): void {
    const actuators = SIGNALS.filter((s) => s.kind === 'actuator').map((s) => s.path);
    this.send({ type: 'provide', paths: actuators });
  }

  private applyRemote(updates: { path: string; value: SignalValue | null }[]): void {
    const now = performance.now();
    for (const { path, value } of updates) {
      const def = SIGNAL_BY_PATH.get(path);
      if (!def) continue;
      if (value === null) {
        // Kuksa has no value yet (fresh broker): seed it with the simulator's current value.
        this.send({ type: 'publish', path, value: this.get(path).value });
        continue;
      }
      if (now - (this.lastLocalWrite.get(path) ?? -Infinity) < ECHO_WINDOW_MS) continue;
      let coerced: SignalValue;
      try {
        coerced = coerce(def, value);
      } catch {
        continue;
      }
      this.emit(path, coerced, REMOTE_SOURCE);
    }
  }

  private fulfilActuation(path: string, value: SignalValue): void {
    const i = this.pendingActuations.findIndex((a) => a.path === path && a.value === value);
    const source = i >= 0 ? this.pendingActuations.splice(i, 1)[0].source : 'External app via Kuksa';
    const def = SIGNAL_BY_PATH.get(path);
    if (!def) return;
    const handler = this.providers.get(path);
    if (handler) handler(coerce(def, value), source);
    else this.publishValue(path, value, source);
  }

  private emit(path: string, value: SignalValue, source: string): void {
    const prev = this.get(path);
    if (prev.value === value) return;
    const timestamp = performance.now();
    this.values.set(path, { value, timestamp });
    const event: ChangeEvent = { path, value, previous: prev.value, source, timestamp };
    this.subscribers.get(path)?.forEach((cb) => cb(event));
    this.global.forEach((cb) => cb(event));
  }

  private setStatus(s: BrokerStatus): void {
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  onStatus(cb: (s: BrokerStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  get(path: string): Datapoint {
    const dp = this.values.get(path);
    if (!dp) throw new Error(`Unknown VSS path: ${path}`);
    return dp;
  }

  subscribe(paths: readonly string[], cb: (e: ChangeEvent) => void): Unsubscribe {
    for (const path of paths) {
      const dp = this.get(path);
      let set = this.subscribers.get(path);
      if (!set) this.subscribers.set(path, (set = new Set()));
      set.add(cb);
      cb({ path, value: dp.value, previous: dp.value, source: 'initial', timestamp: dp.timestamp });
    }
    return () => paths.forEach((p) => this.subscribers.get(p)?.delete(cb));
  }

  publishValue(path: string, value: SignalValue, source: string): void {
    const def = SIGNAL_BY_PATH.get(path);
    if (!def) throw new Error(`Unknown VSS path: ${path}`);
    const next = coerce(def, value);
    if (this.get(path).value === next) return;
    this.lastLocalWrite.set(path, performance.now());
    this.emit(path, next, source);
    this.send({ type: 'publish', path, value: next });
  }

  actuate(path: string, value: SignalValue, source: string): void {
    const def = SIGNAL_BY_PATH.get(path);
    if (!def) throw new Error(`Unknown VSS path: ${path}`);
    if (def.kind !== 'actuator') throw new Error(`${path} is a ${def.kind}, not an actuator`);
    const coerced = coerce(def, value);
    if (this.ws.readyState !== WebSocket.OPEN) {
      // Offline: behave like the vehicle would locally so the UI stays usable.
      this.fulfilActuation(path, coerced);
      return;
    }
    this.pendingActuations.push({ path, value: coerced, source });
    if (this.pendingActuations.length > 50) this.pendingActuations.shift();
    this.send({ type: 'actuate', id: this.nextActuateId++, path, value: coerced });
  }

  provideActuation(path: string, handler: (value: SignalValue, source: string) => void): Unsubscribe {
    if (this.providers.has(path)) throw new Error(`${path} already has a provider`);
    this.providers.set(path, handler);
    return () => this.providers.delete(path);
  }

  onAnyChange(cb: (e: ChangeEvent) => void): Unsubscribe {
    this.global.add(cb);
    return () => this.global.delete(cb);
  }
}
