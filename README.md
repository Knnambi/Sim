# SDV Sim

A browser-based **software-defined vehicle** simulator. A 3D car is driven entirely by
[COVESA VSS](https://covesa.github.io/vehicle_signal_specification/) signals that flow through a
data broker shaped like [Eclipse Kuksa Databroker](https://github.com/eclipse-kuksa/kuksa-databroker).
Third-party "vehicle apps" run against that same API, without knowing whether a real car or a
simulator sits underneath.

```
 ┌───────────────┐   ┌────────────────────┐   ┌──────────────────────┐
 │ Vehicle apps  │   │ Signal panel / keys│   │ 3D scene + dashboard │
 │ (Velocitas-   │   │ (driver input)     │   │ (subscribes to VSS)  │
 │  style)       │   └─────────┬──────────┘   └──────────▲───────────┘
 └──────┬────────┘             │                         │
        │ actuate / subscribe  │ publish / actuate       │ subscribe
 ┌──────▼──────────────────────▼─────────────────────────┴───────────┐
 │              VehicleDataBroker  (VSS paths, kuksa.val.v2-like)     │
 └──────▲─────────────────────────────────────────────────────────────┘
        │ provide actuation / publish sensors
 ┌──────┴─────────────────────────────────────────┐
 │ VehicleModel: powertrain (bicycle model) +     │  ← later: real vECUs via
 │ body controller rules (the "virtual ECUs")     │    vcan/CAN or SOME/IP providers
 └────────────────────────────────────────────────┘
```

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  (in-browser broker, no backend needed)
npm run build      # typecheck + production build into dist/
```

### With a real Kuksa Databroker

```bash
docker compose up                    # Kuksa Databroker 0.6.0 on :55555 + bridge on :8091
npm run dev                          # open http://localhost:5173/?broker=kuksa
docker compose --profile apps up     # optional: also run the Python Speed Guard app
```

The badge under the title shows which broker is in use (`Kuksa · databroker 0.6.0` when connected).
To run the pieces separately instead of with Compose: `npm run kuksa` (databroker) and
`npm --prefix bridge install && npm run bridge` (bridge).
Use `?bridge=ws://host:8091` if the bridge runs elsewhere.

How it fits together:

```
 Browser (3D car, panel, in-page apps)          Python / any gRPC client
        │ JSON over WebSocket                          │ kuksa.val.v2 gRPC
        ▼                                              │
 bridge/server.mjs ──── kuksa.val.v2 gRPC ────► Kuksa Databroker (VSS 5.1)
```

- The browser car registers with Kuksa as the **provider for every actuator** (`OpenProviderStream`).
  So when *any* client calls `Actuate` (for example `Vehicle.Body.Lights.Hazard.IsSignaling`), Kuksa
  routes it to the car, the simulated body ECU applies its rules, and the new value is published back.
- Sensors (speed, pedals, steering, odometer, …) are published to Kuksa with `PublishValue`.
- Values written to Kuksa by other clients show up in the car, the panel and the in-page apps.
  They appear as `Kuksa` / `External app via Kuksa` in the Trace tab.

Try it from Python while the simulator is open:

```bash
pip install -r apps/python/requirements.txt
python apps/python/speed_guard.py --limit 100   # drive above 100 km/h: hazards come on
```

`apps/python/speed_guard.py` is a complete external vehicle app: it subscribes to `Vehicle.Speed`
and actuates the hazard lights through Kuksa, with no knowledge of the simulator.

**Keys:** `W/S` throttle/brake · `A/D` steer · `R` toggle reverse · `Q/E` indicators ·
`H` hazard · `L/K` low/high beam · drag to orbit the camera.

## What's in Phase 1

| Piece | File | Notes |
|---|---|---|
| VSS signal catalog | `src/vss/signals.ts` | Real VSS 5.1 paths (speed, pedals, steering, gear, lights, doors, trunk, ambient light). |
| Data broker | `src/vss/databroker.ts` | `get`, `subscribe`, `publishValue` (sensors), `actuate` (actuators), `provideActuation` (providers own an actuator). |
| Kuksa broker | `src/vss/kuksaBroker.ts`, `bridge/` | Same interface backed by Kuksa Databroker via the WebSocket ↔ gRPC bridge. |
| Virtual ECUs | `src/sim/vehicleModel.ts` | Kinematic bicycle model, brake lights follow the pedal, high beam implies low beam, indicators are exclusive, doors refuse to open above 5 km/h. |
| 3D vehicle | `src/sim/scene.ts` | Three.js car with animated doors/trunk, steering wheels, working headlights, tail/brake lamps, blinking indicators, day/night. |
| Vehicle apps | `src/apps/sampleApps.ts` | Auto Headlights, Auto High Beam, Indicator Auto-Cancel, Emergency Brake Hazard, each toggleable in the **Apps** tab. |
| Signal trace | `src/ui/panel.ts` | Every change with its source (driver, app, ECU), so you can see the cause → effect chain. |

You can also script it from the browser console:

```js
sdv.broker.publishValue('Vehicle.Exterior.LightIntensity', 10, 'console'); // night
sdv.broker.actuate('Vehicle.Cabin.Door.Row1.DriverSide.IsOpen', true, 'console');
sdv.apps.setRunning('auto-high-beam', true);
```

### Writing a vehicle app

```ts
export const myApp: VehicleApp = {
  id: 'my-app',
  name: 'My App',
  description: 'Hazards on when the trunk opens while moving.',
  start(b) {
    return b.subscribe(['Vehicle.Body.Trunk.Rear.IsOpen'], (e) => {
      if (e.value && (b.get('Vehicle.Speed').value as number) > 0) {
        b.actuate('Vehicle.Body.Lights.Hazard.IsSignaling', true, this.name);
      }
    });
  },
};
```

Add it to `SAMPLE_APPS` and it shows up in the Apps tab.

## Roadmap

1. ~~**Phase 1:** in-browser broker, 3D car, signal panel, sample apps, trace.~~
2. ~~**Real Kuksa Databroker:** bridge + `KuksaDataBroker`, Python app driving the 3D car.~~
3. **Classic vECU on CAN:** a Linux-hosted ECU on `vcan0`, mapped to VSS with Kuksa's CAN provider (DBC → VSS).
4. **Adaptive / SOME/IP:** a service-oriented vECU (e.g. S-CORE-based) bridged through vsomeip.
5. **AI layer:** natural-language feature request → generated vehicle app; scenario generation; trace explanations.
