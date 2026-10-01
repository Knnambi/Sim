import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { VehicleDataBroker } from '../vss/databroker';
import type { Pose } from './vehicleModel';

const BODY_COLOR = 0x2f6fde;
const DAY_SKY = new THREE.Color(0x9cc8ef);
const NIGHT_SKY = new THREE.Color(0x05070d);
const BLINK_HZ = 1.5;

interface Lamp {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  onColor: number;
  offColor: number;
}

function lamp(w: number, h: number, d: number, onColor: number, offColor: number): Lamp {
  const material = new THREE.MeshStandardMaterial({ color: offColor, emissive: 0x000000, roughness: 0.3 });
  return { mesh: new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material), material, onColor, offColor };
}

function setLamp(l: Lamp, on: boolean, intensity = 2): void {
  l.material.emissive.setHex(on ? l.onColor : 0x000000);
  l.material.emissiveIntensity = on ? intensity : 0;
  l.material.color.setHex(on ? l.onColor : l.offColor);
}

/** A low-poly car built from primitives. Forward is -Z; units are metres. */
class CarMesh {
  readonly root = new THREE.Group();
  readonly frontWheels: THREE.Group[] = [];
  readonly wheels: THREE.Mesh[] = [];
  readonly doors = new Map<string, THREE.Group>();
  readonly trunk = new THREE.Group();
  readonly headLow: Lamp[] = [];
  readonly headHigh: Lamp[] = [];
  readonly tail: Lamp[] = [];
  readonly indicators = { Left: [] as Lamp[], Right: [] as Lamp[] };
  readonly lowBeams: THREE.SpotLight[] = [];
  readonly highBeams: THREE.SpotLight[] = [];

  constructor() {
    const paint = new THREE.MeshStandardMaterial({ color: BODY_COLOR, metalness: 0.4, roughness: 0.35 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.75 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });

    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.4), paint);
    lower.position.y = 0.6;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), glass);
    cabin.position.set(0, 1.12, 0.15);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.06, 2.0), paint);
    roof.position.set(0, 1.4, 0.2);
    this.root.add(lower, cabin, roof);
    for (const m of [lower, cabin, roof]) m.castShadow = true;

    // Wheels: front wheels sit inside a steering pivot.
    const tyreGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 20).rotateZ(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.8, roughness: 0.3 });
    for (const [x, z, front] of [[-0.85, -1.4, true], [0.85, -1.4, true], [-0.85, 1.4, false], [0.85, 1.4, false]] as const) {
      const wheel = new THREE.Mesh(tyreGeo, dark);
      const hub = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.4, 0.08), hubMat);
      wheel.add(hub);
      wheel.castShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.34, z);
      pivot.add(wheel);
      this.root.add(pivot);
      this.wheels.push(wheel);
      if (front) this.frontWheels.push(pivot);
    }

    // Doors hinge at their front edge and swing outwards.
    const doorSpecs = [
      ['Row1.DriverSide', -1, -0.55],
      ['Row1.PassengerSide', 1, -0.55],
      ['Row2.DriverSide', -1, 0.6],
      ['Row2.PassengerSide', 1, 0.6],
    ] as const;
    for (const [pos, side, zFront] of doorSpecs) {
      const hinge = new THREE.Group();
      hinge.position.set(side * 0.91, 0.62, zFront);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 1.05), paint);
      panel.position.z = 0.525;
      panel.castShadow = true;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.18), hubMat);
      handle.position.set(side * 0.03, 0.12, 0.8);
      hinge.add(panel, handle);
      hinge.userData.side = side;
      this.root.add(hinge);
      this.doors.set(pos, hinge);
    }

    // Trunk lid hinges at the rear of the cabin.
    this.trunk.position.set(0, 0.9, 1.25);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.95), paint);
    lid.position.z = 0.475;
    lid.castShadow = true;
    this.trunk.add(lid);
    this.root.add(this.trunk);

    // Lamps.
    for (const side of [-1, 1] as const) {
      const low = lamp(0.4, 0.12, 0.05, 0xfff6d5, 0xbfc5cc);
      low.mesh.position.set(side * 0.6, 0.72, -2.21);
      const high = lamp(0.18, 0.1, 0.05, 0xe8f0ff, 0x9aa3ad);
      high.mesh.position.set(side * 0.25, 0.72, -2.21);
      const tail = lamp(0.4, 0.14, 0.05, 0xff1a1a, 0x5a0d0d);
      tail.mesh.position.set(side * 0.6, 0.75, 2.21);
      const indFront = lamp(0.14, 0.1, 0.06, 0xffa000, 0x6b4a10);
      indFront.mesh.position.set(side * 0.86, 0.72, -2.2);
      const indRear = lamp(0.14, 0.1, 0.06, 0xffa000, 0x6b4a10);
      indRear.mesh.position.set(side * 0.86, 0.75, 2.2);
      this.root.add(low.mesh, high.mesh, tail.mesh, indFront.mesh, indRear.mesh);
      this.headLow.push(low);
      this.headHigh.push(high);
      this.tail.push(tail);
      this.indicators[side < 0 ? 'Left' : 'Right'].push(indFront, indRear);

      // Actual light cast onto the road.
      // [beams, cone angle, range, aim point on the road ahead]
      for (const [arr, angle, distance, aimY, aimZ] of [
        [this.lowBeams, 0.45, 40, 0, -14],
        [this.highBeams, 0.3, 100, 0.6, -40],
      ] as const) {
        const spot = new THREE.SpotLight(0xfff3d6, 0, distance, angle, 0.5, 1.2);
        spot.position.set(side * 0.6, 0.72, -2.25);
        spot.target.position.set(side * 0.6, aimY, aimZ);
        this.root.add(spot, spot.target);
        arr.push(spot);
      }
    }
  }
}

function buildWorld(scene: THREE.Scene): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4d6b3c, roughness: 1 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // A long straight road plus a crossing road, with dashed centre lines.
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.9 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
  for (const rot of [0, Math.PI / 2]) {
    const road = new THREE.Group();
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(9, 800).rotateX(-Math.PI / 2), asphalt);
    surface.position.y = 0.01;
    surface.receiveShadow = true;
    road.add(surface);
    for (let z = -400; z < 400; z += 8) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 3).rotateX(-Math.PI / 2), lineMat);
      dash.position.set(0, 0.02 + rot * 0.001, z);
      road.add(dash);
    }
    road.rotation.y = rot;
    scene.add(road);
  }

  // Trees for a sense of speed (deterministic placement).
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b3a1e });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e6b30, roughness: 0.9 });
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const x = (rand() - 0.5) * 400;
    const z = (rand() - 0.5) * 400;
    if (Math.abs(x) < 8 || Math.abs(z) < 8) continue;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.4), trunkMat);
    trunk.position.y = 0.7;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(1 + rand(), 3 + rand() * 2, 8), leafMat);
    crown.position.y = 2.8;
    crown.castShadow = trunk.castShadow = true;
    tree.add(trunk, crown);
    tree.position.set(x, 0, z);
    scene.add(tree);
  }

  // Street lamps along the main road, lit only at night.
  scene.userData.streetLamps = [] as THREE.MeshStandardMaterial[];
  for (let z = -200; z <= 200; z += 25) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5), new THREE.MeshStandardMaterial({ color: 0x777777 }));
    pole.position.set(5.5, 2.5, z);
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0xffd28a, emissiveIntensity: 0 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), bulbMat);
    bulb.position.set(5.5, 5.05, z);
    scene.add(pole, bulb);
    scene.userData.streetLamps.push(bulbMat);
  }
}

/** Renders the vehicle and reflects VSS signal state onto the 3D model. */
export class VehicleScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly car = new CarMesh();
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 1.2);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly doorTargets = new Map<string, number>();
  private trunkTarget = 0;
  private time = 0;

  constructor(container: HTMLElement, private readonly broker: VehicleDataBroker) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.camera.position.set(6, 3.5, 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.8, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 40;

    this.sun.position.set(30, 50, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
    this.scene.add(this.hemi, this.sun, this.sun.target, this.car.root);
    buildWorld(this.scene);
    this.scene.fog = new THREE.Fog(DAY_SKY, 80, 300);

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

  private bindSignals(): void {
    const b = this.broker;
    for (const pos of this.car.doors.keys()) {
      b.subscribe([`Vehicle.Cabin.Door.${pos}.IsOpen`], (e) => this.doorTargets.set(pos, e.value ? 1 : 0));
    }
    b.subscribe(['Vehicle.Body.Trunk.Rear.IsOpen'], (e) => (this.trunkTarget = e.value ? 1 : 0));
    b.subscribe(['Vehicle.Exterior.LightIntensity'], (e) => this.applyDaylight((e.value as number) / 100));
  }

  private applyDaylight(t: number): void {
    const sky = NIGHT_SKY.clone().lerp(DAY_SKY, t);
    this.scene.background = sky;
    (this.scene.fog as THREE.Fog).color.copy(sky);
    this.hemi.intensity = 0.08 + 1.1 * t;
    this.sun.intensity = 2.2 * t;
    for (const m of this.scene.userData.streetLamps as THREE.MeshStandardMaterial[]) {
      m.emissiveIntensity = t < 0.35 ? 2 : 0;
    }
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

  render(pose: Pose, dt: number): void {
    this.time += dt;
    const car = this.car;

    // Move the car and let the camera follow it while keeping the user's orbit offset.
    const prev = car.root.position.clone();
    car.root.position.set(pose.x, 0, pose.z);
    car.root.rotation.y = pose.heading;
    const delta = car.root.position.clone().sub(prev);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    this.sun.position.add(delta);
    this.sun.target.position.copy(car.root.position);

    car.frontWheels.forEach((w) => (w.rotation.y = pose.wheelAngle));
    car.wheels.forEach((w) => (w.rotation.x = -pose.wheelSpin));

    // Animate doors and trunk towards their target state.
    const k = Math.min(1, dt * 6);
    for (const [pos, hinge] of car.doors) {
      const target = (this.doorTargets.get(pos) ?? 0) * 1.1 * hinge.userData.side;
      hinge.rotation.y += (target - hinge.rotation.y) * k;
    }
    car.trunk.rotation.x += (this.trunkTarget * -1.2 - car.trunk.rotation.x) * k;

    this.applyLights();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
