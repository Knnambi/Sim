import type { VehicleApp } from './vehicleApp';
import type { OsdviRuntime } from '../vapi/osdvi';

/**
 * A third-party app written only against the Open SDV API (OSDVI), not VSS.
 * The front passenger window follows the driver's window. The app locks the passenger window
 * (priority 60), so other OSDVI clients with lower priority get E_OBJECT_LOCKED while it runs.
 * Window positions are polled with getStatus, as the specification recommends for
 * continuously changing positions.
 */
export function windowSyncApp(rt: OsdviRuntime): VehicleApp {
  return {
    id: 'osdvi-window-sync',
    name: 'Window Sync (OSDVI)',
    description: 'Front passenger window follows the driver window. Uses only the Open SDV API and locks the passenger window.',
    start() {
      const api = rt.app('window-sync');
      const config = api.Window.getConfigAll().config ?? [];
      const find = (row: number, zone: string) => config.find((c) => c.placement.row === row && c.placement.zone === zone)?.instanceId;
      const driver = find(1, 'Left');
      const passenger = find(1, 'Right');
      if (!driver || !passenger) return () => undefined;

      api.Window.lock(passenger, 60);
      const timer = setInterval(() => {
        const d = api.Window.getStatus(driver).status;
        const p = api.Window.getStatus(passenger).status;
        if (!d || !p || d.mainStatus !== 'Stopped') return; // wait until the driver window settles
        if (Math.abs(d.position - p.targetPosition) > 2) api.Window.startMove(passenger, d.position, 'Standard', 60);
      }, 250);
      return () => {
        clearInterval(timer);
        api.Window.unlock(passenger);
      };
    },
  };
}
