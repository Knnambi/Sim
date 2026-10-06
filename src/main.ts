import './style.css';
import { InMemoryDataBroker, type VehicleDataBroker } from './vss/databroker';
import { KuksaDataBroker, type BrokerStatus } from './vss/kuksaBroker';
import { VehicleModel } from './sim/vehicleModel';
import { VehicleScene } from './sim/scene';
import { AppRuntime } from './apps/vehicleApp';
import { SAMPLE_APPS } from './apps/sampleApps';
import { KeyboardDriver } from './ui/keyboard';
import { buildAppsTab, buildSignalsTab, buildTraceTab } from './ui/panel';

// ?broker=kuksa connects to a real Kuksa Databroker through the bridge (see /bridge);
// ?bridge=ws://host:port overrides the bridge address.
const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('broker-status')!;
function showStatus(text: string, state: 'local' | BrokerStatus['state'], title = '') {
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
    const kuksa = await KuksaDataBroker.connect(url);
    kuksa.onStatus((s) => {
      if (s.state === 'connected') showStatus(`Kuksa · ${s.server}`, s.state, `${s.url} → ${s.kuksa}`);
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
const vehicle = new VehicleModel(broker);
const scene = new VehicleScene(document.getElementById('viewport')!, broker);
const keyboard = new KeyboardDriver(broker);
const apps = new AppRuntime(broker, SAMPLE_APPS);
apps.setRunning('auto-headlights', true);
apps.setRunning('indicator-auto-cancel', true);

// Sidebar tabs.
const tabs = { signals: buildSignalsTab(broker), apps: buildAppsTab(apps), trace: buildTraceTab(broker) };
const panelBody = document.getElementById('panel-body')!;
const tabButtons = document.querySelectorAll<HTMLButtonElement>('[data-tab]');
function showTab(name: keyof typeof tabs) {
  panelBody.replaceChildren(tabs[name]);
  tabs[name].dispatchEvent(new Event('tab-shown'));
  tabButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  try { localStorage.setItem('sdv-sim.tab', name); } catch { /* storage unavailable */ }
}
tabButtons.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab as keyof typeof tabs)));
let initialTab: keyof typeof tabs = 'signals';
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

let last = performance.now();
let elapsed = 0;
function frame(now: number) {
  // Cap at 0.25 s so a background tab doesn't teleport the car; step physics in small slices.
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  elapsed += dt;

  const slices = Math.ceil(dt / 0.02);
  for (let i = 0; i < slices; i++) {
    keyboard.step(dt / slices);
    vehicle.step(dt / slices);
  }
  scene.render(vehicle.pose, dt);

  const hazard = broker.get('Vehicle.Body.Lights.Hazard.IsSignaling').value as boolean;
  const blink = (elapsed * 1.5) % 1 < 0.5;
  hud.left.classList.toggle('on', blink && (hazard || (broker.get('Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling').value as boolean)));
  hud.right.classList.toggle('on', blink && (hazard || (broker.get('Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling').value as boolean)));

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for experimenting from the browser console, e.g.
//   sdv.broker.actuate('Vehicle.Cabin.Door.Row1.DriverSide.IsOpen', true, 'console')
Object.assign(window, { sdv: { broker, apps } });
