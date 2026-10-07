import type { Autopilot, ParkResult } from '../autonomy/autopilot';
import type { RobotaxiService } from '../apps/robotaxi';
import type { CameraMode } from '../sim/scene';
import type { Pose } from '../sim/vehicleModel';
import type { Crowd, Traffic } from '../world/agents';
import { BLOCK, GRID, ROAD_HALF, coord, forwardOf, type City, type Vec2 } from '../world/city';
import { el } from './dom';

export interface DriveDeps {
  city: City;
  pose: Pose;
  traffic: Traffic;
  crowd: Crowd;
  autopilot: Autopilot;
  robotaxi: RobotaxiService;
  freeBays: () => number[];
  showBay: (id: number | null) => void;
  setCameraMode: (mode: CameraMode) => void;
  cameraMode: () => CameraMode;
}

const EXTENT = coord(GRID - 1) + BLOCK / 2; // half size of the drawn map in metres

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: label, className: cls });
  b.addEventListener('click', onClick);
  return b;
}

/** Scenario controls: camera, traffic, minimap with click-to-drive, auto-parking and robotaxi. */
export function buildDriveTab(d: DriveDeps): HTMLElement {
  const { city, pose, autopilot, robotaxi } = d;

  // Camera.
  const camButtons = (['chase', 'orbit', 'top'] as CameraMode[]).map((m) => {
    const b = button(m[0].toUpperCase() + m.slice(1), () => {
      d.setCameraMode(m);
      camButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    b.setAttribute('aria-pressed', String(m === 'chase'));
    return b;
  });

  // Traffic density.
  const range = (label: string, max: number, value: number, onInput: (n: number) => void) => {
    const input = el('input', { type: 'range', min: '0', max: String(max), value: String(value) });
    const out = el('span', { className: 'hint', textContent: String(value) });
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => {
      out.textContent = input.value;
      onInput(Number(input.value));
    });
    return el('label', { className: 'drive-range' }, `${label} `, input, out);
  };

  // Minimap.
  const canvas = el('canvas', { className: 'minimap', width: 600, height: 600 });
  canvas.setAttribute('aria-label', 'City map: click to drive there with the autopilot');
  const ctx = canvas.getContext('2d')!;
  const toPx = (p: Vec2) => ({ x: ((p.x + EXTENT) / (2 * EXTENT)) * canvas.width, y: ((p.z + EXTENT) / (2 * EXTENT)) * canvas.height });
  const toWorld = (x: number, y: number): Vec2 => ({ x: (x / canvas.width) * 2 * EXTENT - EXTENT, z: (y / canvas.height) * 2 * EXTENT - EXTENT });
  let target: Vec2 | null = null;

  const status = el('div', { className: 'ai-status' });
  const say = (text: string, kind: '' | 'ok' | 'error' = '') => {
    status.textContent = text;
    status.className = `ai-status ${kind}`;
  };

  const go = (p: Vec2) => {
    if (robotaxi.running) return say('The robotaxi service is driving. Cancel it first.', 'error');
    autopilot.release();
    target = p;
    if (autopilot.driveTo(p)) say(`Autopilot driving to (${p.x.toFixed(0)}, ${p.z.toFixed(0)})…`);
    else say('No route found.', 'error');
  };
  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    go(toWorld(((ev.clientX - r.left) / r.width) * canvas.width, ((ev.clientY - r.top) / r.height) * canvas.height));
  });

  const drawMap = () => {
    const s = canvas.width / (2 * EXTENT);
    ctx.fillStyle = '#2f4a2a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const b of city.blocks) {
      const a = toPx(b.min);
      const c = toPx(b.max);
      ctx.fillStyle = b.kind === 'park' ? '#3f7a3a' : b.kind === 'lot' ? '#55585e' : b.kind === 'commercial' ? '#6b6f78' : '#8a8172';
      ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
    }
    ctx.fillStyle = '#26282c';
    for (let k = 0; k < GRID; k++) {
      const a = toPx({ x: coord(k) - ROAD_HALF, z: coord(0) });
      const b = toPx({ x: coord(k) + ROAD_HALF, z: coord(GRID - 1) });
      ctx.fillRect(a.x, a.y - ROAD_HALF * s, b.x - a.x, b.y - a.y + 2 * ROAD_HALF * s);
      const c = toPx({ x: coord(0), z: coord(k) - ROAD_HALF });
      const e = toPx({ x: coord(GRID - 1), z: coord(k) + ROAD_HALF });
      ctx.fillRect(c.x - ROAD_HALF * s, c.y, e.x - c.x + 2 * ROAD_HALF * s, e.y - c.y);
    }
    // Free bays.
    const free = new Set(d.freeBays());
    for (const bay of city.lot.bays) {
      const p = toPx(bay.center);
      ctx.fillStyle = free.has(bay.id) ? '#4ec98a' : '#8b2f2f';
      ctx.fillRect(p.x - 4, p.y - 2.5, 8, 5);
    }
    // Traffic and pedestrians.
    ctx.fillStyle = '#e8e8e8';
    for (const n of d.traffic.npcs) {
      const p = toPx(n.p);
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    ctx.fillStyle = '#f2c14e';
    for (const ped of d.crowd.people) {
      if (ped.hidden) continue;
      const p = toPx(ped.p);
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    // Planned route.
    if (autopilot.route && autopilot.active) {
      ctx.strokeStyle = '#4ea1ff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      autopilot.route.pts.forEach((q, i) => {
        const p = toPx(q);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    const marker = (p: Vec2 | null, color: string) => {
      if (!p) return;
      const q = toPx(p);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 7, 0, Math.PI * 2);
      ctx.fill();
    };
    if (autopilot.active && !robotaxi.running) marker(target, '#4ea1ff');
    if (robotaxi.running) {
      marker(robotaxi.pickup, '#f2c14e');
      marker(robotaxi.dropoff, '#e05555');
    }
    // Ego car as an arrow.
    const p = toPx(pose);
    const f = forwardOf(pose.heading);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(f.z, f.x));
    ctx.fillStyle = '#ff5a36';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-8, 7);
    ctx.lineTo(-8, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // Autonomous driving.
  const mode = el('span', { className: 'drive-mode' });
  const randomDest = () => {
    const lane = city.lanes[Math.floor(Math.random() * city.lanes.length)];
    const s = 10 + Math.random() * (lane.length - 20);
    go({ x: lane.points[0].x + lane.dir.x * s, z: lane.points[0].z + lane.dir.z * s });
  };

  // Auto-parking.
  const baySel = el('select');
  baySel.setAttribute('aria-label', 'Parking bay');
  const fillBays = () => {
    const keep = baySel.value;
    const free = d.freeBays();
    baySel.replaceChildren(...free.map((id) => {
      const b = city.lot.bays.find((x) => x.id === id)!;
      return el('option', { value: String(id), textContent: `Bay ${id} (${b.side} row)` });
    }));
    if (keep !== '' && free.includes(Number(keep))) baySel.value = keep;
  };
  baySel.addEventListener('change', () => d.showBay(Number(baySel.value)));
  const parkResult = el('div', { className: 'park-result' });
  const showResult = (r: ParkResult) => {
    parkResult.replaceChildren(
      el('strong', { className: r.passed ? 'pass' : 'fail', textContent: r.passed ? 'PASS' : 'FAIL' }),
      el('span', { textContent: ` bay ${r.bay} · position error ${r.positionError} m (≤ 0.5) · heading error ${r.headingErrorDeg}° (≤ 5) · ${r.seconds} s` }),
    );
  };
  const park = () => {
    if (robotaxi.running) return say('The robotaxi service is driving. Cancel it first.', 'error');
    const id = Number(baySel.value);
    if (!baySel.value) return say('No free bay.', 'error');
    autopilot.release();
    d.showBay(id);
    parkResult.replaceChildren();
    if (autopilot.park(id)) say(`Auto-parking into bay ${id}…`);
    else say('No route to the parking lot.', 'error');
  };

  autopilot.on((ev, detail) => {
    if (ev === 'engaged' && robotaxi.running) say('The robotaxi app is driving.');
    if (ev === 'arrived') say('Arrived.', 'ok');
    if (ev === 'parked') {
      const r = detail as ParkResult;
      showResult(r);
      say(`Parked in bay ${r.bay}.`, r.passed ? 'ok' : 'error');
      d.showBay(null);
      fillBays();
    }
    if (ev === 'disengaged') {
      say(`Autopilot off: ${String(detail)}.`, detail === 'stopped' ? '' : 'error');
      d.showBay(null);
    }
  });

  // Robotaxi.
  const steps = el('ol', { className: 'taxi-steps' });
  const taxiLog = el('ol', { className: 'api-log' });
  const taxiBtn = button('Hail a robotaxi', () => {
    if (robotaxi.running) robotaxi.cancel();
    else {
      autopilot.stop();
      autopilot.release();
      void robotaxi.run();
    }
  }, 'primary');
  const renderTaxi = () => {
    taxiBtn.textContent = robotaxi.running ? 'Cancel ride' : 'Hail a robotaxi';
    steps.replaceChildren(...robotaxi.steps.map((s) => el('li', { className: `taxi-${s.status}` },
      el('span', { className: 'taxi-icon', textContent: { pending: '○', active: '◉', done: '✓', failed: '✕' }[s.status] }),
      ` ${s.label}`, s.detail ? el('small', { textContent: ` · ${s.detail}` }) : '')));
    taxiLog.replaceChildren(...robotaxi.log.slice(0, 12).map((l) => el('li', { textContent: l })));
  };
  robotaxi.onChange(renderTaxi);
  renderTaxi();

  const root = el('div', { className: 'tab-body drive-tab' },
    el('section', { className: 'ai-section' },
      el('h3', { textContent: 'View' }),
      el('div', { className: 'ai-row' }, ...camButtons),
      range('Cars', 40, 18, (n) => d.traffic.setCount(n, pose)),
      range('Pedestrians', 120, 40, (n) => d.crowd.setCount(n)),
    ),
    el('section', { className: 'ai-section' },
      el('h3', { textContent: 'Autonomous driving' }),
      el('p', { className: 'hint', textContent: 'The AI driver plans on the lane graph and drives through the VSS driver inputs: it stops at red lights, follows cars and yields to pedestrians. Click the map to set a destination. Any key (W/A/S/D…) takes over.' }),
      canvas,
      el('div', { className: 'ai-row' }, button('Random destination', randomDest, 'primary'), button('Stop', () => autopilot.stop()), mode),
      status,
    ),
    el('section', { className: 'ai-section' },
      el('h3', { textContent: 'Autonomous parking' }),
      el('p', { className: 'hint', textContent: 'Drives to the parking lot, pulls past the bay and reverses in. Judged by position error (≤ 0.5 m) and heading error (≤ 5°).' }),
      el('div', { className: 'ai-row' }, baySel, button('Park', park, 'primary')),
      parkResult,
    ),
    el('section', { className: 'ai-section' },
      el('h3', { textContent: 'Robotaxi (third-party app)' }),
      el('p', { className: 'hint', textContent: 'A ride-hailing app built on the Vehicle APIs: drives to the passenger, turns on the hazards (VSS), opens the rear door (OSDVI Door), drives to the destination, lets the passenger out and parks in the lot.' }),
      el('div', { className: 'ai-row' }, taxiBtn),
      steps,
      el('h4', { textContent: 'App log' }),
      taxiLog,
    ),
  );

  fillBays();
  setInterval(() => {
    if (!root.isConnected) return;
    drawMap();
    mode.textContent = `mode: ${autopilot.mode}`;
    camButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((['chase', 'orbit', 'top'] as CameraMode[])[i] === d.cameraMode())));
    if (!autopilot.active && baySel.options.length !== d.freeBays().length) fillBays();
  }, 100);
  root.addEventListener('tab-shown', () => {
    fillBays();
    drawMap();
  });
  return root;
}
