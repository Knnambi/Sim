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
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
```

**Keys:** `W/S` throttle/brake · `A/D` steer · `R` toggle reverse · `Q/E` indicators ·
`H` hazard · `L/K` low/high beam · drag to orbit the camera.

## What's in Phase 1

| Piece | File | Notes |
|---|---|---|
| VSS signal catalog | `src/vss/signals.ts` | Real VSS 4.x paths (speed, pedals, steering, gear, lights, doors, trunk, ambient light). |
| Data broker | `src/vss/databroker.ts` | `get`, `subscribe`, `publishValue` (sensors), `actuate` (actuators), `provideActuation` (providers own an actuator). |
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

1. **Phase 1 (this):** in-browser broker, 3D car, signal panel, sample apps, trace.
2. **Real Kuksa Databroker:** implement `VehicleDataBroker` over gRPC-web (or a small WebSocket bridge) to
   `kuksa-databroker`, so Python/C++ Velocitas apps can drive the 3D car.
3. **Classic vECU on CAN:** a Linux-hosted ECU on `vcan0`, mapped to VSS with Kuksa's CAN provider (DBC → VSS).
4. **Adaptive / SOME/IP:** a service-oriented vECU (e.g. S-CORE-based) bridged through vsomeip.
5. **AI layer:** natural-language feature request → generated vehicle app; scenario generation; trace explanations.
