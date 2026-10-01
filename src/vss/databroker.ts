import { SIGNALS, SIGNAL_BY_PATH, coerce, type SignalValue } from './signals';

export interface Datapoint {
  value: SignalValue;
  timestamp: number;
}

export interface ChangeEvent {
  path: string;
  value: SignalValue;
  previous: SignalValue;
  /** Who caused the change: a UI control, a vehicle app, the vehicle model, ... */
  source: string;
  timestamp: number;
}

export type Unsubscribe = () => void;

/**
 * The API that vehicle apps and the simulated vehicle talk to.
 * Shaped after Kuksa Databroker's kuksa.val.v2 API (Get / Subscribe / PublishValue / Actuate),
 * so an implementation backed by a real broker over gRPC-web can be dropped in later.
 */
export interface VehicleDataBroker {
  get(path: string): Datapoint;
  /** Calls `cb` immediately with the current values, then on every change. */
  subscribe(paths: readonly string[], cb: (e: ChangeEvent) => void): Unsubscribe;
  /** Sensor providers report a measured value. */
  publishValue(path: string, value: SignalValue, source: string): void;
  /** Apps request an actuator target. Routed to the registered provider, if any. */
  actuate(path: string, value: SignalValue, source: string): void;
  /** A provider (vECU, vehicle model) claims an actuator and decides how to fulfil requests. */
  provideActuation(path: string, handler: (value: SignalValue, source: string) => void): Unsubscribe;
  /** Every change on every path, for tracing. */
  onAnyChange(cb: (e: ChangeEvent) => void): Unsubscribe;
}

export class InMemoryDataBroker implements VehicleDataBroker {
  private readonly values = new Map<string, Datapoint>();
  private readonly subscribers = new Map<string, Set<(e: ChangeEvent) => void>>();
  private readonly actuationProviders = new Map<string, (value: SignalValue, source: string) => void>();
  private readonly global = new Set<(e: ChangeEvent) => void>();

  constructor() {
    const now = performance.now();
    for (const s of SIGNALS) this.values.set(s.path, { value: s.default, timestamp: now });
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
    const prev = this.get(path);
    if (prev.value === next) return;

    const timestamp = performance.now();
    this.values.set(path, { value: next, timestamp });
    const event: ChangeEvent = { path, value: next, previous: prev.value, source, timestamp };
    this.subscribers.get(path)?.forEach((cb) => cb(event));
    this.global.forEach((cb) => cb(event));
  }

  actuate(path: string, value: SignalValue, source: string): void {
    const def = SIGNAL_BY_PATH.get(path);
    if (!def) throw new Error(`Unknown VSS path: ${path}`);
    if (def.kind !== 'actuator') throw new Error(`${path} is a ${def.kind}, not an actuator`);
    const provider = this.actuationProviders.get(path);
    if (provider) provider(coerce(def, value), source);
    else this.publishValue(path, value, source);
  }

  provideActuation(path: string, handler: (value: SignalValue, source: string) => void): Unsubscribe {
    if (this.actuationProviders.has(path)) throw new Error(`${path} already has a provider`);
    this.actuationProviders.set(path, handler);
    return () => this.actuationProviders.delete(path);
  }

  onAnyChange(cb: (e: ChangeEvent) => void): Unsubscribe {
    this.global.add(cb);
    return () => this.global.delete(cb);
  }
}
