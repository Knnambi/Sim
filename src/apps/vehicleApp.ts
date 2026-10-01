import type { VehicleDataBroker } from '../vss/databroker';

/**
 * A third-party vehicle app, modelled on Eclipse Velocitas: it only knows VSS paths
 * and the broker API, never which ECU or simulator sits underneath.
 */
export interface VehicleApp {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Starts the app; returns a function that stops it. */
  start(broker: VehicleDataBroker): () => void;
}

/** Holds app instances and starts/stops them against one broker. */
export class AppRuntime {
  private readonly running = new Map<string, () => void>();

  constructor(private readonly broker: VehicleDataBroker, readonly apps: readonly VehicleApp[]) {}

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  setRunning(id: string, run: boolean): void {
    if (run === this.isRunning(id)) return;
    if (run) {
      const app = this.apps.find((a) => a.id === id);
      if (!app) throw new Error(`Unknown app ${id}`);
      this.running.set(id, app.start(this.broker));
    } else {
      this.running.get(id)?.();
      this.running.delete(id);
    }
  }
}
