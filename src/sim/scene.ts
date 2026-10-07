import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { VehicleDataBroker } from '../vss/databroker';
import type { Pose } from './vehicleModel';

const BODY_COLOR = 0x1f5fd1;
const BLINK_HZ = 1.5;
const RAIN_DROPS = 3000;
const RAIN_HEIGHT = 14;
const RAIN_RADIUS = 18;
const WINDOW_TRAVEL = 0.46;
const WIPER_SWEEP = 1.75; // radians
const DOOR_POSITIONS = ['Row1.DriverSide', 'Row1.PassengerSide', 'Row2.DriverSide', 'Row2.PassengerSide'];

export type CameraMode = 'orbit' | 'chase' | 'top';

// --- sky --------------------------------------------------------------------------------------

const SKY = {
  day: { top: new THREE.Color(0x3d7fd6), horizon: new THREE.Color(0xcfe3f5) },
  night: { top: new THREE.Color(0x020409), horizon: new THREE.Color(0x0c1220) },
  rain: { top: new THREE.Color(0x59616c), horizon: new THREE.Color(0x9aa2ab) },
};

function buildSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: SKY.day.top.clone() }, horizon: { value: SKY.day.horizon.clone() } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vDir; void main() { float h = clamp(vDir.y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(h, 0.7)), 1.0); }',
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
  sky.frustumCulled = false;
  return sky;
}

/** Rain streaks: one line segment per drop, in a cylinder around the car. */
function buildRain(): THREE.LineSegments {
  const pos = new Float32Array(RAIN_DROPS * 6);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * RAIN_RADIUS;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = Math.random() * RAIN_HEIGHT;
    pos.set([x, y, z, x, y + 0.35, z], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const drops = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xaec3d8, transparent: true, opacity: 0.55 }));
  drops.frustumCulled = false;
  drops.visible = false;
  return drops;
}

// --- ego car ----------------------------------------------------------------------------------

interface Lamp { material: THREE.MeshStandardMaterial; onColor: number; offColor: number }

function setLamp(l: Lamp, on: boolean, intensity = 2): void {
  l.material.emissive.setHex(on ? l.onColor : 0x000000);
  l.material.emissiveIntensity = on ? intensity : 0;
  l.material.color.setHex(on ? l.onColor : l.offColor);
}

/** A closed outline in the car's side plane (u = position along the car, y = height). */
function sideShape(points: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  points.forEach(([u, y], i) => (i ? s.lineTo(u, y) : s.moveTo(u, y)));
  s.closePath();
  return s;
}

/** Extrudes a side outline across the car (x), centred, with rounded edges. */
function extrudeSide(shape: THREE.Shape, width: number, bevel: number): THREE.BufferGeometry {
  const depth = width - 2 * bevel;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 3, curveSegments: 14 });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2); // (u, y, across) -> (x = -across, y, z = u)
  geo.computeVertexNormals();
  return geo;
}

/** A flat polygon in the side plane, placed at x = 0. */
function sidePlane(points: [number, number][]): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(sideShape(points));
  geo.rotateY(-Math.PI / 2);
  return geo;
}

/**
 * The ego car, built from extruded side profiles so doors, windows, trunk, mirrors, wipers and
 * lamps can all move independently. Forward is -Z, units are metres, left-hand drive.
 */
class CarMesh {
  readonly root = new THREE.Group();
  readonly frontWheels: THREE.Group[] = [];
  readonly wheels: THREE.Object3D[] = [];
  readonly doors = new Map<string, THREE.Group>();
  readonly windows = new Map<string, THREE.Mesh>();
  readonly mirrors = new Map<'DriverSide' | 'PassengerSide', THREE.Group>();
  readonly wipers: THREE.Group[] = [];
  readonly trunk = new THREE.Group();
  readonly headLow: Lamp[] = [];
  readonly headHigh: Lamp[] = [];
  readonly tail: Lamp[] = [];
  readonly indicators = { Left: [] as Lamp[], Right: [] as Lamp[] };
  readonly lowBeams: THREE.SpotLight[] = [];
  readonly highBeams: THREE.SpotLight[] = [];
  readonly taxiSign: THREE.Group;

  constructor() {
    const paint = new THREE.MeshPhysicalMaterial({ color: BODY_COLOR, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x1b2a38, metalness: 0.2, roughness: 0.03, transparent: true, opacity: 0.62, side: THREE.DoubleSide, envMapIntensity: 1.6 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.55 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
    const interior = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.85 });
    const plate = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.5 });

    // Lower body: side silhouette with wheel arches, extruded across the car.
    const arch = (cu: number): [number, number][] => {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 14; k++) {
        const a = -0.09 + ((Math.PI + 0.18) * k) / 14;
        pts.push([cu + 0.47 * Math.cos(a), 0.34 + 0.47 * Math.sin(a)]);
      }
      return pts;
    };
    const body = sideShape([
      [-2.2, 0.3], [-2.27, 0.42], [-2.27, 0.6], [-2.2, 0.72], [-1.9, 0.8], [-1.5, 0.86], [-1.05, 0.92],
      [1.5, 0.95], [2.0, 0.93], [2.2, 0.88], [2.27, 0.72], [2.27, 0.42], [2.2, 0.3],
      ...arch(1.35), ...arch(-1.35),
    ]);
    const lower = new THREE.Mesh(extrudeSide(body, 1.82, 0.07), paint);
    lower.castShadow = true;
    lower.receiveShadow = true;
    // Sills and bumpers in dark trim.
    const sill = new THREE.Mesh(new RoundedBoxGeometry(1.84, 0.1, 1.6, 2, 0.04), trim);
    sill.position.set(0, 0.34, 0);
    // The bevelled body's front and rear faces are at about z = ∓2.33; parts below sit on them.
    const bumperF = new THREE.Mesh(new RoundedBoxGeometry(1.86, 0.2, 0.16, 2, 0.06), trim);
    bumperF.position.set(0, 0.36, -2.3);
    const bumperR = bumperF.clone();
    bumperR.position.z = 2.3;
    const diffuser = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.06, 0.1, 2, 0.02), chrome);
    diffuser.position.set(0, 0.3, 2.37);
    this.root.add(lower, sill, bumperF, bumperR, diffuser);

    // Cabin: roof, glass and pillars.
    const roof = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.07, 1.3, 3, 0.03), paint);
    roof.position.set(0, 1.37, 0.33);
    roof.castShadow = true;
    this.root.add(roof);
    const leaning = (base: [number, number], top: [number, number]) => {
      const g = new THREE.Group();
      const len = Math.hypot(top[0] - base[0], top[1] - base[1]);
      g.position.set(0, base[1], base[0]);
      g.rotation.x = Math.atan2(top[0] - base[0], top[1] - base[1]);
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, len), glass);
      pane.position.y = len / 2;
      g.add(pane);
      for (const x of [-0.77, 0.77]) {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, len, 0.07), paint);
        pillar.position.set(x, len / 2, 0);
        g.add(pillar);
      }
      this.root.add(g);
      return { g, len };
    };
    const shield = leaning([-1.06, 0.93], [-0.32, 1.36]);
    leaning([1.52, 0.96], [0.98, 1.36]);
    for (const x of [-0.79, 0.79]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.44, 0.09), paint);
      b.position.set(x, 1.15, 0.355);
      this.root.add(b);
    }
    // Wipers along the bottom of the windshield, sweeping up across it.
    for (const x of [-0.62, 0.05]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.05, -0.03);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.022, 0.022), trim);
      blade.position.x = 0.31;
      pivot.add(blade);
      shield.g.add(pivot);
      this.wipers.push(pivot);
    }

    // Interior, visible through the glass.
    for (const x of [-0.4, 0.4]) {
      const seat = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.5, 0.5, 2, 0.06), interior);
      seat.position.set(x, 0.9, 0);
      const back = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.55, 0.12, 2, 0.05), interior);
      back.position.set(x, 1.12, 0.24);
      this.root.add(seat, back);
    }
    const bench = new THREE.Mesh(new RoundedBoxGeometry(1.35, 0.5, 0.5, 2, 0.06), interior);
    bench.position.set(0, 0.9, 0.9);
    const dash = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.18, 0.4, 2, 0.06), interior);
    dash.position.set(0, 1.0, -0.82);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 8, 24), trim);
    wheel.position.set(-0.4, 1.08, -0.6);
    wheel.rotation.x = -0.35;
    this.root.add(bench, dash, wheel);

    // Wheels: tyre + rim; front wheels sit in a steering pivot.
    const tyreGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 28).rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.25, 20).rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.26, 0.36, 0.06);
    for (const [x, z, front] of [[-0.8, -1.35, true], [0.8, -1.35, true], [-0.8, 1.35, false], [0.8, 1.35, false]] as const) {
      const w = new THREE.Group();
      const t = new THREE.Mesh(tyreGeo, tyre);
      t.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, chrome);
      const spoke = new THREE.Mesh(spokeGeo, chrome);
      const spoke2 = spoke.clone();
      spoke2.rotation.x = Math.PI / 2;
      w.add(t, rim, spoke, spoke2);
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.34, z);
      pivot.add(w);
      this.root.add(pivot);
      this.wheels.push(w);
      if (front) this.frontWheels.push(pivot);
    }

    // Doors (with their windows) hinge at the front edge and swing outwards.
    const doorShapes: Record<string, { hinge: number; panel: [number, number][]; window: [number, number][] }> = {
      front: { hinge: -1.0, panel: [[-0.89, 0.33], [0.34, 0.33], [0.34, 0.93], [-1.05, 0.92], [-1.05, 0.72], [-0.95, 0.55]], window: [[-1.04, 0.93], [-0.32, 1.33], [0.33, 1.33], [0.33, 0.93]] },
      rear: { hinge: 0.37, panel: [[0.37, 0.33], [0.89, 0.33], [0.95, 0.55], [1.05, 0.72], [1.3, 0.82], [1.45, 0.95], [0.37, 0.94]], window: [[0.39, 0.93], [0.39, 1.33], [0.97, 1.33], [1.5, 0.97]] },
    };
    for (const pos of DOOR_POSITIONS) {
      const side = pos.endsWith('DriverSide') ? -1 : 1;
      const spec = pos.startsWith('Row1') ? doorShapes.front : doorShapes.rear;
      const rel = (pts: [number, number][]) => pts.map(([u, y]) => [u - spec.hinge, y] as [number, number]);
      const hinge = new THREE.Group();
      hinge.position.set(side * 0.925, 0, spec.hinge);
      const panel = new THREE.Mesh(extrudeSide(sideShape(rel(spec.panel)), 0.05, 0.015), paint);
      panel.castShadow = true;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, 0.16), chrome);
      handle.position.set(side * 0.03, 0.82, spec === doorShapes.front ? 1.1 : 0.85); // near the rear edge
      const pane = new THREE.Mesh(sidePlane(rel(spec.window)), glass);
      pane.position.set(-side * 0.13, 0, 0);
      pane.userData.closedY = 0;
      hinge.add(panel, handle, pane);
      hinge.userData.side = side;
      this.root.add(hinge);
      this.doors.set(pos, hinge);
      this.windows.set(pos, pane);
    }

    // Side mirrors on the front doors' upper corner; they fold back against the window.
    for (const [name, side] of [['DriverSide', -1], ['PassengerSide', 1]] as const) {
      const g = new THREE.Group();
      g.position.set(side * 0.93, 1.0, -0.92);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.06), trim);
      arm.position.x = side * 0.05;
      const housing = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.14, 0.1, 2, 0.03), paint);
      housing.position.set(side * 0.16, 0.03, 0);
      const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.11), chrome);
      mirror.position.set(side * 0.16, 0.03, 0.052);
      g.add(arm, housing, mirror);
      g.userData.side = side;
      this.root.add(g);
      this.mirrors.set(name, g);
    }

    // Trunk lid hinges at the base of the rear window.
    this.trunk.position.set(0, 0.96, 1.52);
    const lid = new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.06, 0.72, 2, 0.025), paint);
    lid.position.set(0, -0.01, 0.36);
    lid.castShadow = true;
    this.trunk.add(lid);
    this.root.add(this.trunk);

    // Front: grille, plates, lamps.
    const grille = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.2, 0.06, 2, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.4, metalness: 0.3 }));
    grille.position.set(0, 0.56, -2.33);
    const grilleTrim = new THREE.Mesh(new RoundedBoxGeometry(0.94, 0.025, 0.05, 1, 0.01), chrome);
    grilleTrim.position.set(0, 0.665, -2.34);
    const plateF = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.02), plate);
    plateF.position.set(0, 0.38, -2.39);
    const plateR = plateF.clone();
    plateR.position.set(0, 0.52, 2.35);
    this.root.add(grille, grilleTrim, plateF, plateR);
    const lamp = (w: number, h: number, onColor: number, offColor: number, x: number, y: number, z: number, bezel = false): Lamp => {
      const material = new THREE.MeshStandardMaterial({ color: offColor, emissive: 0x000000, roughness: 0.15, metalness: 0.2 });
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, 0.06, 2, 0.025), material);
      m.position.set(x, y, z);
      this.root.add(m);
      if (bezel) {
        const b = new THREE.Mesh(new RoundedBoxGeometry(w + 0.05, h + 0.05, 0.04, 2, 0.02), trim);
        b.position.set(x, y, z + Math.sign(z) * -0.02);
        this.root.add(b);
      }
      return { material, onColor, offColor };
    };
    // Rear light bar between the tail lamps (lit with them).
    const bar = lamp(0.5, 0.035, 0xff1a1a, 0x5a0c0c, 0, 0.8, 2.32);
    this.tail.push(bar);
    for (const side of [-1, 1] as const) {
      this.headLow.push(lamp(0.34, 0.11, 0xfff6d5, 0xdde3ea, side * 0.62, 0.64, -2.34, true));
      this.headHigh.push(lamp(0.1, 0.08, 0xe8f0ff, 0xb9c2cc, side * 0.39, 0.64, -2.35));
      this.tail.push(lamp(0.38, 0.12, 0xff1a1a, 0x7a1212, side * 0.6, 0.78, 2.32, true));
      const key = side < 0 ? 'Left' : 'Right';
      this.indicators[key].push(lamp(0.12, 0.05, 0xffa000, 0x8a6020, side * 0.62, 0.55, -2.35));
      this.indicators[key].push(lamp(0.1, 0.12, 0xffa000, 0x8a6020, side * 0.86, 0.78, 2.3));
      for (const [arr, angle, distance, aimY, aimZ] of [
        [this.lowBeams, 0.45, 40, 0, -14],
        [this.highBeams, 0.3, 100, 0.6, -40],
      ] as const) {
        const spot = new THREE.SpotLight(0xfff3d6, 0, distance, angle, 0.5, 1.2);
        spot.position.set(side * 0.6, 0.66, -2.4);
        spot.target.position.set(side * 0.6, aimY, aimZ);
        this.root.add(spot, spot.target);
        arr.push(spot);
      }
    }

    // Robotaxi roof sign (hidden unless a taxi service uses the car).
    this.taxiSign = new THREE.Group();
    const sign = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.18, 0.26, 2, 0.04), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb300, emissiveIntensity: 0.6 }));
    sign.position.set(0, 1.5, 0.3);
    this.taxiSign.add(sign);
    this.taxiSign.visible = false;
    this.root.add(this.taxiSign);
  }
}

// --- scene ------------------------------------------------------------------------------------

/** Renders the ego vehicle in the world and reflects VSS signal state onto the 3D model. */
export class VehicleScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly car = new CarMesh();
  private readonly hemi = new THREE.HemisphereLight(0xdbe9ff, 0x5a6b4a, 0.9);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.6);
  private readonly sky = buildSky();
  private readonly doorTargets = new Map<string, number>();
  private readonly windowTargets = new Map<string, number>();
  private readonly mirrorFolded = new Map<string, number>();
  private trunkTarget = 0;
  private time = 0;
  private wiperCpm = 0;
  private wiperPhase = 0;
  private daylight = 1;
  private rain = 0;
  private readonly rainDrops = buildRain();
  private heightAt: (p: { x: number; z: number }) => number = () => 0;
  private readonly daylightListeners = new Set<(t: number) => void>();
  cameraMode: CameraMode = 'chase';

  constructor(container: HTMLElement, private readonly broker: VehicleDataBroker) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    this.camera.position.set(6, 3.5, 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.8, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 80;
    this.controls.enabled = false;

    this.sun.position.set(40, 70, 25);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 200 });
    this.scene.add(this.sky, this.hemi, this.sun, this.sun.target, this.car.root, this.rainDrops);
    this.scene.fog = new THREE.Fog(SKY.day.horizon, 140, 620);

    for (const pos of this.car.doors.keys()) this.doorTargets.set(pos, 0);
    this.bindSignals();

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(container);
    resize();
  }

  /** Adds the city (or any static world) and the ground height function used to place the car. */
  attachWorld(group: THREE.Object3D, heightAt: (p: { x: number; z: number }) => number): void {
    this.scene.add(group);
    this.heightAt = heightAt;
  }

  onDaylight(cb: (t: number) => void): void {
    this.daylightListeners.add(cb);
    cb(this.daylight);
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'orbit';
    if (mode === 'orbit') {
      const p = this.car.root.position;
      this.controls.target.set(p.x, 0.8, p.z);
      this.camera.position.set(p.x + 7, 4, p.z + 9);
    }
  }

  setTaxiSign(on: boolean): void {
    this.car.taxiSign.visible = on;
  }

  private bindSignals(): void {
    const b = this.broker;
    for (const pos of this.car.doors.keys()) {
      b.subscribe([`Vehicle.Cabin.Door.${pos}.IsOpen`], (e) => this.doorTargets.set(pos, e.value ? 1 : 0));
      b.subscribe([`Vehicle.Cabin.Door.${pos}.Window.Position`], (e) => this.windowTargets.set(pos, e.value as number));
    }
    for (const side of this.car.mirrors.keys()) {
      b.subscribe([`Vehicle.Body.Mirrors.${side}.IsFolded`], (e) => this.mirrorFolded.set(side, e.value ? 1 : 0));
    }
    b.subscribe(['Vehicle.Body.Trunk.Rear.IsOpen'], (e) => (this.trunkTarget = e.value ? 1 : 0));
    b.subscribe(['Vehicle.Exterior.LightIntensity'], (e) => {
      this.daylight = (e.value as number) / 100;
      this.applyDaylight();
    });
    b.subscribe(['Vehicle.Body.Raindetection.Intensity'], (e) => {
      this.rain = (e.value as number) / 100;
      this.rainDrops.geometry.setDrawRange(0, Math.round(this.rain * RAIN_DROPS) * 2);
      this.rainDrops.visible = this.rain > 0;
      this.applyDaylight();
    });
    b.subscribe(['Vehicle.Body.Windshield.Front.Wiping.System.Frequency', 'Vehicle.Body.Windshield.Front.Wiping.System.IsWiping'], () => {
      const wiping = b.get('Vehicle.Body.Windshield.Front.Wiping.System.IsWiping').value as boolean;
      this.wiperCpm = wiping ? (b.get('Vehicle.Body.Windshield.Front.Wiping.System.Frequency').value as number) : 0;
    });
  }

  private applyDaylight(): void {
    // Rain clouds dim the daylight.
    const t = this.daylight * (1 - 0.45 * this.rain);
    const u = this.sky.material as THREE.ShaderMaterial;
    const dayTop = SKY.day.top.clone().lerp(SKY.rain.top, this.rain * 0.85);
    const dayHorizon = SKY.day.horizon.clone().lerp(SKY.rain.horizon, this.rain * 0.85);
    (u.uniforms.top.value as THREE.Color).copy(SKY.night.top).lerp(dayTop, t);
    (u.uniforms.horizon.value as THREE.Color).copy(SKY.night.horizon).lerp(dayHorizon, t);
    (this.scene.fog as THREE.Fog).color.copy(u.uniforms.horizon.value as THREE.Color);
    this.hemi.intensity = 0.06 + 0.9 * t;
    this.sun.intensity = 2.6 * t;
    this.scene.environmentIntensity = 0.15 + 0.85 * t;
    this.daylightListeners.forEach((cb) => cb(t));
  }

  private updateRain(dt: number): void {
    if (!this.rainDrops.visible) return;
    const attr = this.rainDrops.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const count = Math.round(this.rain * RAIN_DROPS);
    const fall = 11 * dt;
    for (let i = 0; i < count; i++) {
      let y = pos[i * 6 + 1] - fall;
      if (y < 0) y += RAIN_HEIGHT;
      pos[i * 6 + 1] = y;
      pos[i * 6 + 4] = y + 0.35;
    }
    attr.needsUpdate = true;
    this.rainDrops.position.set(this.car.root.position.x, 0, this.car.root.position.z);
  }

  private applyLights(): void {
    const b = this.broker;
    const low = b.get('Vehicle.Body.Lights.Beam.Low.IsOn').value as boolean;
    const high = b.get('Vehicle.Body.Lights.Beam.High.IsOn').value as boolean;
    const braking = b.get('Vehicle.Body.Lights.Brake.IsActive').value !== 'INACTIVE';
    const hazard = b.get('Vehicle.Body.Lights.Hazard.IsSignaling').value as boolean;
    const left = hazard || (b.get('Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling').value as boolean);
    const right = hazard || (b.get('Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling').value as boolean);
    const blinkOn = (this.time * BLINK_HZ) % 1 < 0.5;
    this.car.headLow.forEach((l) => setLamp(l, low));
    this.car.headHigh.forEach((l) => setLamp(l, high, 3));
    this.car.lowBeams.forEach((s) => (s.intensity = low ? 60 : 0));
    this.car.highBeams.forEach((s) => (s.intensity = high ? 140 : 0));
    // Tail lamps glow dimly with the low beam and brightly when braking.
    this.car.tail.forEach((l) => setLamp(l, braking || low, braking ? 3 : 0.8));
    this.car.indicators.Left.forEach((l) => setLamp(l, left && blinkOn, 3));
    this.car.indicators.Right.forEach((l) => setLamp(l, right && blinkOn, 3));
  }

  private updateCamera(dt: number, delta: THREE.Vector3): void {
    const p = this.car.root.position;
    const h = this.car.root.rotation.y;
    const f = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    if (this.cameraMode === 'orbit') {
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.controls.update();
      return;
    }
    const k = 1 - Math.exp(-dt * 4);
    if (this.cameraMode === 'chase') {
      const want = p.clone().addScaledVector(f, -9).add(new THREE.Vector3(0, 3.6, 0));
      this.camera.position.lerp(want, k);
      this.camera.lookAt(p.clone().addScaledVector(f, 4).add(new THREE.Vector3(0, 1, 0)));
    } else {
      const want = new THREE.Vector3(p.x, 70, p.z + 0.01);
      this.camera.position.lerp(want, k);
      this.camera.lookAt(p.x, 0, p.z);
    }
  }

  render(pose: Pose, dt: number): void {
    this.time += dt;
    const car = this.car;

    const prev = car.root.position.clone();
    car.root.position.set(pose.x, this.heightAt(pose), pose.z);
    car.root.rotation.y = pose.heading;
    const delta = car.root.position.clone().sub(prev);
    this.sun.position.add(delta);
    this.sun.target.position.copy(car.root.position);
    this.updateCamera(dt, delta);

    car.frontWheels.forEach((w) => (w.rotation.y = pose.wheelAngle));
    car.wheels.forEach((w) => (w.rotation.x = -pose.wheelSpin));

    const k = Math.min(1, dt * 6);
    for (const [pos, hinge] of car.doors) {
      const target = (this.doorTargets.get(pos) ?? 0) * 1.1 * hinge.userData.side;
      hinge.rotation.y += (target - hinge.rotation.y) * k;
    }
    car.trunk.rotation.x += (this.trunkTarget * -1.2 - car.trunk.rotation.x) * k;
    for (const [side, g] of car.mirrors) {
      const target = (this.mirrorFolded.get(side) ?? 0) * -1.25 * g.userData.side;
      g.rotation.y += (target - g.rotation.y) * Math.min(1, dt * 3);
    }
    // Windows slide to the reported position (the motor speed itself lives in the ECU).
    for (const [pos, pane] of car.windows) {
      const target = pane.userData.closedY - ((this.windowTargets.get(pos) ?? 0) / 100) * WINDOW_TRAVEL;
      pane.position.y += (target - pane.position.y) * Math.min(1, dt * 12);
    }
    // Wipers: one cycle = up and back. When switched off, finish the sweep and park.
    const cycle = Math.PI * 2;
    if (this.wiperCpm > 0) {
      this.wiperPhase = (this.wiperPhase + dt * (this.wiperCpm / 60) * cycle) % cycle;
    } else if (this.wiperPhase > 0) {
      this.wiperPhase += dt * (40 / 60) * cycle;
      if (this.wiperPhase >= cycle) this.wiperPhase = 0;
    }
    const sweep = ((1 - Math.cos(this.wiperPhase)) / 2) * WIPER_SWEEP;
    car.wipers.forEach((w) => (w.rotation.z = sweep));
    this.updateRain(dt);

    this.applyLights();
    this.renderer.render(this.scene, this.camera);
  }
}
