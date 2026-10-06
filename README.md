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
 │ VehicleModel: powertrain (bicycle model) +     │  ← or a classic body ECU on CAN
 │ body controller rules (the "virtual ECUs")     │    (vecu/, see below)
 └────────────────────────────────────────────────┘
```

**Live demo:** https://knnambi.github.io/Sim/ (in-browser mode; the Kuksa, CAN and SOME/IP modes
need the local Docker stack below).

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

### With a classic body ECU on CAN

The lights, doors and trunk can be handed to a **virtual Body Control Module** (BCM): a classic,
signal-based ECU that only speaks CAN frames defined in a DBC file. A CAN provider connects that
bus to Kuksa, so the chain becomes:

```
 app ── Actuate ──► Kuksa ──► can_provider ── BCM_Request (0x210) ──► BCM vECU
                                                                        │ body rules
 3D car ◄── bridge ◄── Kuksa ◄── PublishValue ◄── can_provider ◄── BCM_LampStatus / BCM_DoorStatus (0x2A0/0x2A1)
 browser ── Speed, Brake pedal ──► Kuksa ──► can_provider ── ESP_Status (0x120) ──► BCM vECU
```

```bash
docker compose --profile can up      # Kuksa + bridge + BCM vECU + CAN provider
npm run dev                          # open http://localhost:5173/?broker=kuksa&body=can
```

With `&body=can` the browser stops running its own body rules and no longer claims those
actuators in Kuksa; the BCM does the work. Everything else is unchanged: the panel, keyboard,
in-page apps and the Python Speed Guard all reach the BCM through Kuksa and CAN.

| Piece | File | Notes |
|---|---|---|
| DBC | `vecu/dbc/sim_body.dbc` | `ESP_Status` (50 ms), `BCM_Request` (commands + rolling counter, 100 ms), `BCM_LampStatus`, `BCM_DoorStatus` (100 ms + on change). |
| BCM vECU | `vecu/bcm.py` | Knows only CAN. Brake lamps from the pedal, high beam needs low beam, exclusive turn signals, doors/trunk locked above 5 km/h. Acts on a new `BCM_RequestCounter`, ignores cyclic repeats. |
| CAN provider | `vecu/can_provider.py` | Kuksa v2 provider for the 10 body actuators: `Actuate` → command frame; status frames → `PublishValue`; speed/brake → `ESP_Status`. |
| Mapping | `vecu/mapping/vss_dbc.json` | VSS ↔ DBC with `vss2dbc` / `dbc2vss` blocks and value `mapping` transforms, the same per-signal format as Kuksa's CAN provider (keyed by flat VSS paths). |
| CAN monitor | `vecu/canmon.py` | Prints decoded frames, by default only when their content changes. |

**Which CAN bus?** By default the nodes use python-can's `udp_multicast` interface (CAN frames
over UDP multicast), which works on any OS and between Docker containers. On Linux you can use
real SocketCAN instead:

```bash
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0
docker compose -f docker-compose.yml -f docker-compose.socketcan.yml --profile can up
candump vcan0                        # can-utils: watch the raw frames
```

Running the CAN side without Docker:

```bash
pip install -r vecu/requirements.txt
python vecu/bcm.py                         # add --interface socketcan --channel vcan0 for vcan
python vecu/can_provider.py --kuksa 127.0.0.1:55555
python vecu/canmon.py                      # watch the bus
```

> Why not the official [kuksa-can-provider](https://github.com/eclipse-kuksa/kuksa-can-provider)?
> It uses Kuksa's older `kuksa.val.v1` API for actuator targets. Databroker 0.6 only routes
> `Actuate` calls to `kuksa.val.v2` providers, so it would never receive them. It also only
> supports SocketCAN. `vecu/can_provider.py` uses the same DBC and mapping approach on the v2 API.

### With a service-oriented comfort ECU on SOME/IP

Windows and wipers can be handed to a **comfort vECU** built the Adaptive AUTOSAR way: it offers
SOME/IP *services* (methods + events, found via SOME/IP Service Discovery) instead of sending
signals in fixed frames.

```
 app ── Actuate(Window.Position) ──► Kuksa ──► someip_provider ── WindowControl.SetPosition() ──► comfort_ecu
 3D car ◄── bridge ◄── Kuksa ◄── PublishValue ◄── someip_provider ◄── WindowStatus event (100 ms while moving)
 panel ── Raindetection.Intensity ──► Kuksa ──► someip_provider ── offers Environment.RainStatus ──► comfort_ecu
                                                                       (wipers in RAIN_SENSOR mode)
```

```bash
docker compose --profile someip up                 # Kuksa + bridge + comfort vECU + SOME/IP provider
npm run dev                                        # open http://localhost:5173/?broker=kuksa&comfort=someip
docker compose --profile can --profile someip up   # both external ECUs: ...?broker=kuksa&body=can&comfort=someip
```

| Piece | File | Notes |
|---|---|---|
| Service interfaces | `soa/interfaces.py` | Service/method/event IDs and payload structs (someipy serialization). `WindowControl` 0x6001, `WiperControl` 0x6002, `Environment` 0x6003. |
| Comfort vECU | `soa/comfort_ecu.py` | Knows only SOME/IP. Window motors at 20 %/s, `WindowStatus` every 100 ms while moving. Wiper modes incl. `RAIN_SENSOR`, which consumes the `Environment` service. |
| SOME/IP provider | `soa/someip_provider.py` | Kuksa v2 provider for the 4 window positions and the wiper mode. `Actuate` → method call; events → `PublishValue`. Offers rain intensity from VSS as a SOME/IP service. |
| Launcher | `soa/run_with_daemon.sh` | One someipy daemon per ECU (container), bound to the container IP; SD on 224.224.224.245:30490. |

Without Docker (one daemon serves both nodes on one host):

```bash
pip install -r soa/requirements.txt
python soa/someipyd_patched.py &           # the someipy daemon
python soa/comfort_ecu.py
python soa/someip_provider.py --kuksa 127.0.0.1:55555
```

Notes on [someipy](https://github.com/chrizog/someipy) 2.1.2, the pure-Python SOME/IP stack used here:
- `soa/someipyd_patched.py` starts its daemon with a one-line fix. `Method` is unhashable, which
  crashes the daemon when a remote node subscribes to a service that also has methods.
- The daemon client matches FindService replies by arrival order. So the provider sends one
  method call at a time; concurrent calls could otherwise reach the wrong service.
- For production-grade interop testing, the same service interfaces can be implemented with
  [vsomeip](https://github.com/COVESA/vsomeip) (C++). The wire format is standard SOME/IP.

### AI layer (Claude)

The **AI ✦** tab adds three Claude-powered tools. They call the Claude API (`claude-opus-5-5`)
straight from the browser with **your own API key**, which is stored only in that browser's local
storage. Use a key you can revoke, and never deploy a build with a key baked in.

| Tool | What it does |
|---|---|
| **App Studio** | Describe a feature in plain English (*"close the windows when I drive faster than 30 km/h"*). Claude writes a vehicle app against the VSS signal catalog. You see the code and the result of static checks: known signals only, `actuate` only on actuators, no network/DOM/storage access. Then you run it; it appears in the Apps tab marked ✦. |
| **Scenario Lab** | Describe a test (*"open the windows, then heavy rain: windows close and wipers start"*). Claude writes a timed scenario of stimuli and expectations. It runs against the live vehicle (in-browser, Kuksa, CAN and SOME/IP modes alike) and reports pass/fail per step. |
| **Explain the trace** | Ask *"why did the hazards come on?"*. Claude reads the recorded signal trace (who changed what, when) and explains the cause→effect chain, citing timestamps. |

Implementation: `src/ai/claude.ts` (Anthropic TypeScript SDK; structured outputs via Zod schemas;
server-side refusal fallback `fallbacks: "default"`; cached system prompt containing the signal
catalog), `src/ai/appCompiler.ts` (checks and a narrowed broker for generated apps),
`src/ai/scenarioRunner.ts`.

> The checks on generated apps catch mistakes; they are not a security sandbox. Generated code
> runs in your page, so read it before pressing **Run app**.

## What's in Phase 1

| Piece | File | Notes |
|---|---|---|
| VSS signal catalog | `src/vss/signals.ts` | Real VSS 5.1 paths (speed, pedals, steering, gear, lights, doors, trunk, windows, wipers, rain, ambient light). |
| Data broker | `src/vss/databroker.ts` | `get`, `subscribe`, `publishValue` (sensors), `actuate` (actuators), `provideActuation` (providers own an actuator). |
| Kuksa broker | `src/vss/kuksaBroker.ts`, `bridge/` | Same interface backed by Kuksa Databroker via the WebSocket ↔ gRPC bridge. |
| Virtual ECUs | `src/sim/vehicleModel.ts` | Kinematic bicycle model, brake lights follow the pedal, high beam implies low beam, indicators are exclusive, doors refuse to open above 5 km/h; window motors and wiper modes (comfort controller). |
| 3D vehicle | `src/sim/scene.ts` | Three.js car with animated doors/trunk, steering wheels, working headlights, tail/brake lamps, blinking indicators, sliding side windows, wipers, rain, day/night. |
| Vehicle apps | `src/apps/sampleApps.ts` | Auto Headlights, Auto High Beam, Indicator Auto-Cancel, Emergency Brake Hazard, Rain Guard (closes windows when rain starts), each toggleable in the **Apps** tab. |
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
3. ~~**Classic vECU on CAN:** BCM vECU + DBC + v2 CAN provider, on vcan0 or UDP multicast.~~
   Next steps here: Classic AUTOSAR-generated vECU (e.g. ETAS ISOLAR-VRTA) on the same DBC; E2E protection (CRC) on `BCM_Request`.
4. ~~**Adaptive / SOME/IP:** comfort vECU with window/wiper services + SOME/IP provider.~~
   Next steps here: the same services on vsomeip or an S-CORE-based stack; SOME/IP-TP / TCP for large payloads.
5. ~~**AI layer:** natural-language feature request → generated vehicle app; scenario generation; trace explanations.~~
