import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BLOCK, CROSSWALK_AT, City, GRID, LANE_OFFSET, ROAD_HALF, SIDEWALK, STOP_AT, coord, type Axis, type Vec2 } from './city';
import type { Crowd, Pedestrian, Traffic } from './agents';
import { CAR_MODELS, COMMERCIAL, HOUSES, SCALE, SKYSCRAPERS } from './assets';

type Clone = (kit: string, name: string, scale: number) => THREE.Group;

const COLORS = {
  grass: 0x5d8a46, asphalt: 0x3a3d42, lotAsphalt: 0x45484d, sidewalk: 0xb9b6ad, plaza: 0xcfc9bb, curb: 0x9a978f,
  white: 0xf2f2ee, yellow: 0xf0c419,
};

let seed = 4242;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** Instanced flat rectangles (road markings): add(center, length along dir, width, dir). */
class Markings {
  private readonly items: { x: number; z: number; len: number; w: number; rot: number }[] = [];
  add(c: Vec2, len: number, w: number, alongX: boolean): void {
    this.items.push({ x: c.x, z: c.z, len, w, rot: alongX ? Math.PI / 2 : 0 });
  }
  build(color: number, y: number): THREE.InstancedMesh {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }), this.items.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    this.items.forEach((it, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rot);
      m.compose(new THREE.Vector3(it.x, y, it.z), q, new THREE.Vector3(it.w, 1, it.len));
      mesh.setMatrixAt(i, m);
    });
    mesh.receiveShadow = true;
    return mesh;
  }
}

function slab(min: Vec2, max: Vec2, y: number, h: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(max.x - min.x, h, max.z - min.z), new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
  mesh.position.set((min.x + max.x) / 2, y + h / 2, (min.z + max.z) / 2);
  mesh.receiveShadow = true;
  return mesh;
}

interface TrafficLamp { node: number; axis: Axis; state: 'R' | 'Y' | 'G'; on: THREE.Color; off: THREE.Color }

/** Static city geometry plus per-frame updates for lights, traffic and pedestrians. */
export class CityView {
  readonly group = new THREE.Group();
  /** Everything that never moves; merged into a few meshes per block once built. */
  private readonly statics = new THREE.Group();
  private readonly lamps: TrafficLamp[] = [];
  private lampMesh: THREE.InstancedMesh | null = null;
  private readonly bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffd28a, emissiveIntensity: 0 });
  private readonly npcMeshes = new Map<string, { obj: THREE.Group; wheels: THREE.Object3D[] }>();
  private readonly pedMeshes = new Map<string, { obj: THREE.Group; legs: THREE.Object3D[]; arms: THREE.Object3D[] }>();
  private readonly bayMarker: THREE.Mesh;
  readonly occupiedBays = new Set<number>();
  private readonly pedMaterials = [0xd94f4f, 0x3b7dd8, 0x4caf50, 0xf2a93b, 0x8e5cc4, 0x2b2b2b, 0xffd23f].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));
  private readonly skin = new THREE.MeshStandardMaterial({ color: 0xe0b08a, roughness: 0.8 });
  private readonly trousers = new THREE.MeshStandardMaterial({ color: 0x33384a, roughness: 0.9 });

  constructor(private readonly city: City, private readonly clone: Clone, private readonly traffic: Traffic, private readonly crowd: Crowd) {
    this.buildGround();
    this.buildRoads();
    this.buildBlocks();
    this.buildLot();
    this.buildStreetFurniture();
    this.mergeStatics();
    this.bayMarker = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.5, 4, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 4),
      new THREE.MeshBasicMaterial({ color: 0x3ccf7a, transparent: true, opacity: 0.85 }));
    this.bayMarker.scale.set(1.6, 1, 2.6);
    this.bayMarker.visible = false;
    this.group.add(this.bayMarker);
  }

  private get extent(): number {
    return coord(GRID - 1) + ROAD_HALF;
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: COLORS.grass, roughness: 1 }));
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    const e = this.extent;
    const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(2 * e, 2 * e).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: COLORS.asphalt, roughness: 0.92 }));
    asphalt.position.y = 0;
    asphalt.receiveShadow = true;
    this.statics.add(ground, asphalt);
  }

  private buildRoads(): void {
    const white = new Markings();
    const yellow = new Markings();
    const c = this.city;
    for (const lane of c.lanes) {
      // Draw each road segment once (from the lower node id), lane-specific marks per lane.
      const a = c.nodes[lane.from];
      const b = c.nodes[lane.to];
      const alongX = lane.axis === 'EW';
      const len = BLOCK - 2 * (CROSSWALK_AT + 1.8);
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const r = { x: -lane.dir.z, z: lane.dir.x };
      if (lane.from < lane.to) {
        for (const o of [-0.13, 0.13]) yellow.add({ x: mid.x + r.x * o, z: mid.z + r.z * o }, len, 0.1, alongX);
        for (const o of [-(ROAD_HALF - 0.3), ROAD_HALF - 0.3]) white.add({ x: mid.x + r.x * o, z: mid.z + r.z * o }, len, 0.12, alongX);
      }
      // Stop line across this lane at the end node, if it is signalled.
      if (b.hasLight || b.degree >= 3) {
        const p = { x: b.x - lane.dir.x * STOP_AT + r.x * LANE_OFFSET, z: b.z - lane.dir.z * STOP_AT + r.z * LANE_OFFSET };
        white.add(p, 0.45, ROAD_HALF - 0.4, alongX); // thin along the road, spans the lane
        // Zebra crosswalk on this arm (each arm has exactly one incoming lane).
        for (let o = -ROAD_HALF + 0.6; o <= ROAD_HALF - 0.5; o += 1.0) {
          white.add({ x: b.x - lane.dir.x * CROSSWALK_AT + r.x * o, z: b.z - lane.dir.z * CROSSWALK_AT + r.z * o }, 2.6, 0.5, alongX);
        }
      }
    }
    this.statics.add(white.build(COLORS.white, 0.012), yellow.build(COLORS.yellow, 0.013));
  }

  private buildBlocks(): void {
    for (const b of this.city.blocks) {
      const min = { x: b.min.x + ROAD_HALF, z: b.min.z + ROAD_HALF };
      const max = { x: b.max.x - ROAD_HALF, z: b.max.z - ROAD_HALF };
      this.statics.add(slab(min, max, 0, 0.15, COLORS.sidewalk));
      const inner = { min: { x: min.x + SIDEWALK, z: min.z + SIDEWALK }, max: { x: max.x - SIDEWALK, z: max.z - SIDEWALK } };
      if (b.kind === 'lot') continue;
      const color = b.kind === 'commercial' ? COLORS.plaza : COLORS.grass;
      this.statics.add(slab(inner.min, inner.max, 0.15, 0.04, color));
      if (b.kind === 'commercial') this.buildCommercial(inner.min, inner.max);
      else if (b.kind === 'suburban') this.buildSuburban(inner.min, inner.max);
      else this.buildPark(inner.min, inner.max);
    }
  }

  /** Places models along the four edges of an area, facing outwards to the street. */
  private perimeter(min: Vec2, max: Vec2, spacing: number, inset: number, make: () => THREE.Object3D): void {
    const edges: [Vec2, Vec2, number][] = [
      [{ x: min.x, z: max.z - inset }, { x: max.x, z: max.z - inset }, 0], // +z edge, face +z
      [{ x: max.x - inset, z: max.z }, { x: max.x - inset, z: min.z }, Math.PI / 2], // +x edge
      [{ x: max.x, z: min.z + inset }, { x: min.x, z: min.z + inset }, Math.PI], // -z edge
      [{ x: min.x + inset, z: min.z }, { x: min.x + inset, z: max.z }, -Math.PI / 2], // -x edge
    ];
    for (const [a, b, rot] of edges) {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.floor((len - 2 * inset) / spacing));
      for (let k = 0; k < n; k++) {
        const u = (inset + (k + 0.5) * ((len - 2 * inset) / n)) / len;
        const obj = make();
        obj.position.set(a.x + (b.x - a.x) * u, 0.19, a.z + (b.z - a.z) * u);
        obj.rotation.y = rot;
        this.statics.add(obj);
      }
    }
  }

  private buildCommercial(min: Vec2, max: Vec2): void {
    this.perimeter(min, max, 15, 8, () => {
      const tall = rnd() < 0.3;
      const name = tall ? SKYSCRAPERS[Math.floor(rnd() * SKYSCRAPERS.length)] : COMMERCIAL[Math.floor(rnd() * COMMERCIAL.length)];
      return this.clone('commercial', name, tall ? SCALE.commercial * 0.75 : SCALE.commercial);
    });
    // Courtyard trees.
    for (let k = 0; k < 4; k++) {
      const t = this.clone('suburban', 'tree-large', SCALE.tree);
      t.position.set(min.x + 20 + rnd() * (max.x - min.x - 40), 0.19, min.z + 20 + rnd() * (max.z - min.z - 40));
      this.statics.add(t);
    }
  }

  private buildSuburban(min: Vec2, max: Vec2): void {
    this.perimeter(min, max, 13, 7, () => this.clone('suburban', HOUSES[Math.floor(rnd() * HOUSES.length)], SCALE.suburban));
    for (let k = 0; k < 10; k++) {
      const t = this.clone('suburban', rnd() < 0.5 ? 'tree-large' : 'tree-small', SCALE.tree * (0.8 + rnd() * 0.5));
      t.position.set(min.x + 16 + rnd() * (max.x - min.x - 32), 0.19, min.z + 16 + rnd() * (max.z - min.z - 32));
      this.statics.add(t);
    }
  }

  private buildPark(min: Vec2, max: Vec2): void {
    for (let k = 0; k < 40; k++) {
      const t = this.clone('suburban', rnd() < 0.6 ? 'tree-large' : 'tree-small', SCALE.tree * (0.8 + rnd() * 0.7));
      t.position.set(min.x + 3 + rnd() * (max.x - min.x - 6), 0.19, min.z + 3 + rnd() * (max.z - min.z - 6));
      this.statics.add(t);
    }
    const path = slab({ x: min.x, z: (min.z + max.z) / 2 - 1.2 }, { x: max.x, z: (min.z + max.z) / 2 + 1.2 }, 0.19, 0.02, COLORS.plaza);
    this.statics.add(path);
  }

  private buildLot(): void {
    const lot = this.city.lot;
    this.statics.add(slab(lot.min, lot.max, 0.15, 0.02, COLORS.lotAsphalt));
    // Driveway from the road through the sidewalk.
    const dw = { min: { x: lot.aisleX - 3.6, z: lot.max.z }, max: { x: lot.aisleX + 3.6, z: coord(1) - ROAD_HALF } };
    this.statics.add(slab(dw.min, dw.max, 0.15, 0.025, COLORS.lotAsphalt));
    const lines = new Markings();
    const zs = [...new Set(lot.bays.map((b) => b.center.z))].sort((a, b) => a - b);
    for (const side of [1, -1]) {
      const x = lot.aisleX + side * (3.6 + 2.75);
      for (const z of [...zs.map((z) => z - 1.4), zs[zs.length - 1] + 1.4]) lines.add({ x, z }, 5.5, 0.12, true);
    }
    this.statics.add(lines.build(COLORS.white, 0.18));
    // Parked cars in about half the bays (never in every third one, so there's always room).
    for (const bay of lot.bays) {
      if (bay.id % 3 === 0 || rnd() < 0.45) continue;
      this.occupiedBays.add(bay.id);
      const car = this.clone('cars', CAR_MODELS[Math.floor(rnd() * 6)], SCALE.car);
      car.position.set(bay.center.x, 0.17, bay.center.z);
      car.rotation.y = bay.heading + Math.PI + (rnd() < 0.5 ? 0 : Math.PI);
      this.statics.add(car);
    }
  }

  private buildStreetFurniture(): void {
    const c = this.city;
    // Street lights along the roads, on the right-hand sidewalk, every ~24 m.
    for (const lane of c.lanes) {
      if (lane.from > lane.to) continue;
      const r = { x: -lane.dir.z, z: lane.dir.x };
      for (let s = 14; s < lane.length - 6; s += 24) {
        const p = { x: lane.points[0].x + lane.dir.x * s + r.x * (ROAD_HALF - LANE_OFFSET + 1.2), z: lane.points[0].z + lane.dir.z * s + r.z * (ROAD_HALF - LANE_OFFSET + 1.2) };
        const pole = this.clone('roads', 'light-curved', SCALE.road);
        pole.position.set(p.x, 0.15, p.z);
        // The model's arm points to its -z; turn it over the road (towards -r).
        pole.rotation.y = Math.atan2(r.x, r.z);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), this.bulbMat);
        bulb.position.set(p.x - r.x * 1.9, 6.4, p.z - r.z * 1.9);
        this.statics.add(pole, bulb);
        // Sidewalk trees between the lamps.
        if (s + 12 < lane.length - 8) {
          const t = this.clone('suburban', 'tree-small', SCALE.tree * 0.9);
          t.position.set(p.x + lane.dir.x * 12, 0.15, p.z + lane.dir.z * 12);
          this.statics.add(t);
        }
      }
    }
    // Traffic lights: one head per approach lane, on the right corner before the intersection.
    // Group space: the arm runs along local -z (turned to point across the lane, -r); local -x
    // then points back along -dir, towards the approaching traffic, so the lamps sit on that face.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.4, roughness: 0.6 });
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.7 });
    const lampPositions: THREE.Vector3[] = [];
    for (const lane of c.lanes) {
      const n = c.nodes[lane.to];
      if (!n.hasLight) continue;
      const r = { x: -lane.dir.z, z: lane.dir.x };
      const base = { x: n.x - lane.dir.x * (STOP_AT - 1) + r.x * (ROAD_HALF + 0.7), z: n.z - lane.dir.z * (STOP_AT - 1) + r.z * (ROAD_HALF + 0.7) };
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 5.2, 8), poleMat);
      pole.position.y = 2.6;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 3.4), poleMat);
      arm.position.set(0, 5.1, -1.6);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.3, 0.45), housingMat);
      housing.position.set(0, 4.45, -3.0);
      pole.castShadow = arm.castShadow = housing.castShadow = true;
      g.add(pole, arm, housing);
      g.position.set(base.x, 0.15, base.z);
      g.rotation.y = Math.atan2(r.x, r.z);
      this.statics.add(g);
      // Lamp positions (group local x -0.19 at z -3.0) in world space; drawn as one instanced mesh.
      g.updateMatrixWorld(true);
      const lamp = (state: TrafficLamp['state'], color: number, y: number) => {
        const p = new THREE.Vector3(-0.19, y, -3.0).applyMatrix4(g.matrixWorld);
        this.lamps.push({ node: n.id, axis: lane.axis, state, on: new THREE.Color(color).multiplyScalar(2.2), off: new THREE.Color(color).multiplyScalar(0.12) });
        lampPositions.push(p);
      };
      lamp('R', 0xff2a1a, 4.85);
      lamp('Y', 0xffb000, 4.45);
      lamp('G', 0x22e06a, 4.05);
    }
    const lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), lampPositions.length);
    lampPositions.forEach((p, i) => {
      lampMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      lampMesh.setColorAt(i, this.lamps[i].off);
    });
    this.lampMesh = lampMesh;
    this.group.add(lampMesh);
  }

  /**
   * Merges the static meshes per material and per city block, so the whole city renders in a
   * few hundred draw calls instead of thousands, while still being frustum culled per block.
   */
  private mergeStatics(): void {
    this.statics.updateMatrixWorld(true);
    const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean }>();
    const keep: THREE.Object3D[] = [];
    const v = new THREE.Vector3();
    this.statics.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh || Array.isArray(mesh.material)) {
        keep.push(mesh);
        return;
      }
      let geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      if (geo.index) geo = geo.toNonIndexed();
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
      if (!geo.attributes.normal) geo.computeVertexNormals();
      geo.morphAttributes = {};
      mesh.getWorldPosition(v);
      // Big ground planes go in their own cell; everything else by block.
      const cell = geo.boundingSphere === null && (geo.computeBoundingSphere(), geo.boundingSphere!.radius > BLOCK) ? 'big' : `${Math.floor(v.x / BLOCK)},${Math.floor(v.z / BLOCK)}`;
      const key = `${mesh.material.uuid}|${cell}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material: mesh.material, geos: [], cast: false }));
      b.geos.push(geo);
      b.cast ||= mesh.castShadow;
    });
    for (const o of keep) this.group.attach(o);
    for (const b of buckets.values()) {
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.statics.clear();
  }

  // --- per-frame updates ----------------------------------------------------------------

  setDaylight(t: number): void {
    this.bulbMat.emissiveIntensity = t < 0.35 ? 2.2 : 0;
  }

  showBay(bayId: number | null): void {
    const bay = bayId === null ? null : this.city.lot.bays.find((b) => b.id === bayId);
    this.bayMarker.visible = !!bay;
    if (bay) this.bayMarker.position.set(bay.center.x, 0.2, bay.center.z), (this.bayMarker.rotation.y = bay.heading);
  }

  update(t: number, dt: number): void {
    if (this.lampMesh) {
      this.lamps.forEach((l, i) => this.lampMesh!.setColorAt(i, this.city.light(l.node, l.axis, t) === l.state ? l.on : l.off));
      this.lampMesh.instanceColor!.needsUpdate = true;
    }
    this.updateTraffic();
    this.updatePeople(dt);
  }

  private updateTraffic(): void {
    const alive = new Set<string>();
    for (const n of this.traffic.npcs) {
      alive.add(n.id);
      let m = this.npcMeshes.get(n.id);
      if (!m) {
        const obj = this.clone('cars', CAR_MODELS[n.model % CAR_MODELS.length], SCALE.car);
        const wheels: THREE.Object3D[] = [];
        obj.traverse((o) => o.name.startsWith('wheel') && wheels.push(o));
        m = { obj, wheels };
        this.npcMeshes.set(n.id, m);
        this.group.add(obj);
      }
      m.obj.position.set(n.p.x, this.city.heightAt(n.p), n.p.z);
      m.obj.rotation.y = n.heading + Math.PI; // Kenney cars face +z
      for (const w of m.wheels) w.rotation.x = n.wheelSpin;
    }
    for (const [id, m] of this.npcMeshes) {
      if (alive.has(id)) continue;
      this.group.remove(m.obj);
      this.npcMeshes.delete(id);
    }
  }

  private person(ped: Pedestrian): { obj: THREE.Group; legs: THREE.Object3D[]; arms: THREE.Object3D[] } {
    const g = new THREE.Group();
    const shirt = this.pedMaterials[ped.color % this.pedMaterials.length];
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.45, 4, 8), shirt);
    torso.position.y = 1.15;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), this.skin);
    head.position.y = 1.62;
    const legs: THREE.Object3D[] = [];
    const arms: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.1, 0.85, 0);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.6, 3, 6), this.trousers);
      leg.position.y = -0.42;
      hip.add(leg);
      legs.push(hip);
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.27, 1.38, 0);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.45, 3, 6), shirt);
      arm.position.y = -0.27;
      shoulder.add(arm);
      arms.push(shoulder);
      g.add(hip, shoulder);
    }
    g.add(torso, head);
    g.traverse((o) => ((o as THREE.Mesh).isMesh && (o.castShadow = true)));
    return { obj: g, legs, arms };
  }

  private updatePeople(_dt: number): void {
    const alive = new Set<string>();
    for (const ped of this.crowd.people) {
      alive.add(ped.id);
      let m = this.pedMeshes.get(ped.id);
      if (!m) {
        m = this.person(ped);
        this.pedMeshes.set(ped.id, m);
        this.group.add(m.obj);
      }
      m.obj.visible = !ped.hidden;
      m.obj.position.set(ped.p.x, this.city.heightAt(ped.p), ped.p.z);
      m.obj.rotation.y = ped.heading;
      const moving = !(ped.crossing?.waiting) && (!ped.scripted || ped.target !== null);
      const swing = moving ? Math.sin(ped.phase) * 0.6 : 0;
      m.legs[0].rotation.x = swing;
      m.legs[1].rotation.x = -swing;
      m.arms[0].rotation.x = -swing * 0.8;
      m.arms[1].rotation.x = swing * 0.8;
    }
    for (const [id, m] of this.pedMeshes) {
      if (alive.has(id)) continue;
      this.group.remove(m.obj);
      this.pedMeshes.delete(id);
    }
  }
}
