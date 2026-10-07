import './style.css';
import { InMemoryDataBroker, type VehicleDataBroker } from './vss/databroker';
import { KuksaDataBroker, type BrokerStatus } from './vss/kuksaBroker';
import { VehicleModel, isBodySignal, isComfortSignal } from './sim/vehicleModel';
import { VehicleScene } from './sim/scene';
import { AppRuntime } from './apps/vehicleApp';
import { SAMPLE_APPS } from './apps/sampleApps';
import { KeyboardDriver } from './ui/keyboard';
import { buildAppsTab, buildSignalsTab, buildTraceTab } from './ui/panel';
import { buildAiTab } from './ui/aiTab';
import { buildApiTab } from './ui/apiTab';
import { OsdviRuntime } from './vapi/osdvi';
import { windowSyncApp } from './apps/osdviApps';
import acmeProfile from './vapi/profiles/acme-example.json';
import type { AttributeProfile } from './vapi/attributeApi';
import { City } from './world/city';
import { Crowd, Traffic, type Obstacle } from './world/agents';
import { loadAssets } from './world/assets';
import { CityView } from './world/cityView';
import { Autopilot } from './autonomy/autopilot';
import { RobotaxiService } from './apps/robotaxi';
import { buildDriveTab } from './ui/driveTab';

// ?broker=kuksa connects to a real Kuksa Databroker through the bridge (see /bridge);
// ?bridge=ws://host:port overrides the bridge address.
// ?body=can (with Kuksa) hands lights/doors/trunk to the CAN body ECU in /vecu.
// ?comfort=someip (with Kuksa) hands windows/wipers to the SOME/IP comfort ECU in /soa.
const params = new URLSearchParams(location.search);
let bodyOnCan = false;
let comfortOnSomeip = false;
const statusEl = document.getElementById('broker-status')!;
function showStatus(text: string, state: 'local' | 'warning' | BrokerStatus['state'], title = '') {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
  statusEl.title = title;
}

async function createBroker(): Promise<VehicleDataBroker> {
  if (params.get('broker') !== 'kuksa') {
    showStatus('In-browser broker', 'local', 'Add ?broker=kuksa to the URL to use a Kuksa Databroker');
    return new InMemoryDataBroker();
  }
  const url = params.get('bridge') ?? `ws://${location.hostname || 'localhost'}:8091`;
  showStatus('Connecting to Kuksa…', 'connecting', url);
  try {
    const wantCan = params.get('body') === 'can';
    const wantSomeip = params.get('comfort') === 'someip';
    const kuksa = await KuksaDataBroker.connect(url, {
      provides: (path) => !(wantCan && isBodySignal(path)) && !(wantSomeip && isComfortSignal(path)),
    });
    bodyOnCan = wantCan;
    comfortOnSomeip = wantSomeip;
    const suffix = [bodyOnCan && 'body on CAN', comfortOnSomeip && 'comfort on SOME/IP'].filter(Boolean).map((t) => ` · ${t}`).join('');
    kuksa.onStatus((s) => {
      if (s.state === 'connected' && s.warning) {
        showStatus(`Kuksa · ${s.server} · actuators owned elsewhere`, 'warning', `${s.warning}\nAre the external ECUs running? Add &body=can and/or &comfort=someip to the URL.`);
      } else if (s.state === 'connected') showStatus(`Kuksa · ${s.server}${suffix}`, s.state, `${s.url} → ${s.kuksa}`);
      else if (s.state === 'connecting') showStatus('Reconnecting to Kuksa…', s.state, s.url);
      else showStatus('Kuksa offline', s.state, `${s.url}: ${s.reason}`);
    });
    return kuksa;
  } catch (err) {
    console.error(err);
    showStatus('Kuksa unreachable · using in-browser broker', 'disconnected', String(err));
    return new InMemoryDataBroker();
  }
}

const broker = await createBroker();
const vehicle = new VehicleModel(broker, { bodyController: !bodyOnCan, comfortController: !comfortOnSomeip });
const scene = new VehicleScene(document.getElementById('viewport')!, broker);
const keyboard = new KeyboardDriver(broker);
const osdvi = new OsdviRuntime(broker);
const apps = new AppRuntime(broker, [...SAMPLE_APPS, windowSyncApp(osdvi)]);
apps.setRunning('auto-headlights', true);
apps.setRunning('indicator-auto-cancel', true);

// The city: lane graph, traffic lights, NPC traffic and pedestrians.
const city = new City();
const traffic = new Traffic(city);
const crowd = new Crowd(city);
vehicle.pose.x = 2; // northbound lane of the central avenue
vehicle.pose.z = 40;
const egoObstacle = (): Obstacle => ({ p: { x: vehicle.pose.x, z: vehicle.pose.z }, radius: 1.3, id: 'ego', heading: vehicle.pose.heading });
const autopilot = new Autopilot(city, broker, vehicle.pose, () => [
  ...traffic.npcs.map((n) => ({ p: n.p, radius: 1.2, id: n.id, heading: n.heading })),
  ...crowd.obstacles(),
]);
let cityView: CityView | null = null;
traffic.setCount(18, vehicle.pose);
crowd.setCount(40);
loadAssets().then((clone) => {
  const view = new CityView(city, clone, traffic, crowd);
  scene.attachWorld(view.group, (p) => city.heightAt(p));
  scene.onDaylight((t) => view.setDaylight(t));
  cityView = view;
}).catch((err) => console.error('Could not load the city models', err));
const freeBays = () => city.lot.bays
  .filter((b) => !cityView?.occupiedBays.has(b.id) && Math.hypot(b.center.x - vehicle.pose.x, b.center.z - vehicle.pose.z) > 2.5)
  .map((b) => b.id);
const robotaxi = new RobotaxiService(city, broker, vehicle.pose, autopilot, crowd, osdvi,
  () => freeBays()[0] ?? null, (on) => scene.setTaxiSign(on));

// Sidebar tabs.
const tabs = { signals: buildSignalsTab(broker), apps: buildAppsTab(apps), trace: buildTraceTab(broker), apis: buildApiTab(broker, osdvi, [acmeProfile as AttributeProfile]), ai: buildAiTab(broker, apps),
  drive: buildDriveTab({ city, pose: vehicle.pose, traffic, crowd, autopilot, robotaxi, freeBays,
    showBay: (id) => cityView?.showBay(id), setCameraMode: (m) => scene.setCameraMode(m), cameraMode: () => scene.cameraMode }) };
const panelBody = document.getElementById('panel-body')!;
const tabButtons = document.querySelectorAll<HTMLButtonElement>('[data-tab]');
function showTab(name: keyof typeof tabs) {
  panelBody.replaceChildren(tabs[name]);
  tabs[name].dispatchEvent(new Event('tab-shown'));
  tabButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  try { localStorage.setItem('sdv-sim.tab', name); } catch { /* storage unavailable */ }
}
tabButtons.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab as keyof typeof tabs)));
let initialTab: keyof typeof tabs = 'drive';
try {
  const saved = localStorage.getItem('sdv-sim.tab');
  if (saved && saved in tabs) initialTab = saved as keyof typeof tabs;
} catch { /* storage unavailable */ }
showTab(initialTab);

// Dashboard overlay.
const hud = {
  speed: document.getElementById('hud-speed')!,
  gear: document.getElementById('hud-gear')!,
  left: document.getElementById('hud-left')!,
  right: document.getElementById('hud-right')!,
  low: document.getElementById('hud-low')!,
  high: document.getElementById('hud-high')!,
  odo: document.getElementById('hud-odo')!,
};
broker.subscribe(['Vehicle.Speed'], (e) => (hud.speed.textContent = String(Math.round(e.value as number))));
broker.subscribe(['Vehicle.TraveledDistance'], (e) => (hud.odo.textContent = `${(e.value as number).toFixed(2)} km`));
broker.subscribe(['Vehicle.Powertrain.Transmission.SelectedGear'], (e) => (hud.gear.textContent = ({ '-1': 'R', '0': 'N', '1': 'D' } as Record<string, string>)[String(e.value)]));
broker.subscribe(['Vehicle.Body.Lights.Beam.Low.IsOn'], (e) => hud.low.classList.toggle('on', e.value as boolean));
broker.subscribe(['Vehicle.Body.Lights.Beam.High.IsOn'], (e) => hud.high.classList.toggle('on', e.value as boolean));
const hudAuto = document.getElementById('hud-auto')!;
const toast = document.getElementById('toast')!;
let toastTimer = 0;
function showToast(text: string) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 3500);
}
const CAMERAS = ['chase', 'orbit', 'top'] as const;
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'c' || e.repeat || (e.target as HTMLElement).closest('input, textarea, select')) return;
  scene.setCameraMode(CAMERAS[(CAMERAS.indexOf(scene.cameraMode as typeof CAMERAS[number]) + 1) % CAMERAS.length]);
});
vehicle.onReject((what, from) => showToast(`Refused ${what} from ${from}: vehicle is moving`));
autopilot.on((ev, detail) => {
  if (ev === 'disengaged' && detail === 'driver took over') showToast('Autopilot disengaged: driver took over');
});

let last = performance.now();
let elapsed = 0;
function frame(now: number) {
  // Cap at 0.25 s so a background tab doesn't teleport the car; step physics in small slices.
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  elapsed += dt;

  autopilot.step(dt, elapsed);
  const slices = Math.ceil(dt / 0.02);
  for (let i = 0; i < slices; i++) {
    keyboard.step(dt / slices);
    vehicle.step(dt / slices);
  }
  traffic.step(dt, elapsed, [egoObstacle()]);
  crowd.step(dt, elapsed);
  cityView?.update(elapsed, dt);
  scene.render(vehicle.pose, dt);
  hudAuto.textContent = robotaxi.running ? 'ROBOTAXI' : autopilot.active ? 'AUTO' : '';
  hudAuto.hidden = !autopilot.active && !robotaxi.running;

  const hazard = broker.get('Vehicle.Body.Lights.Hazard.IsSignaling').value as boolean;
  const blink = (elapsed * 1.5) % 1 < 0.5;
  hud.left.classList.toggle('on', blink && (hazard || (broker.get('Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling').value as boolean)));
  hud.right.classList.toggle('on', blink && (hazard || (broker.get('Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling').value as boolean)));

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for experimenting from the browser console, e.g.
//   sdv.broker.actuate('Vehicle.Cabin.Door.Row1.DriverSide.IsOpen', true, 'console')
Object.assign(window, { sdv: { broker, apps, osdvi, city, traffic, crowd, autopilot, robotaxi, scene, vehicle } });
