import { City, Path, WALK_OFFSET, CROSSWALK_AT, STOP_AT, dist, headingOf, type Axis, type Vec2 } from './city';

/**
 * Other road users: NPC vehicles driving the lane graph and pedestrians walking the sidewalks.
 * Vehicles keep their distance (Intelligent Driver Model), stop for red/yellow lights and for
 * pedestrians on crosswalks; pedestrians cross only when the crossed traffic has red.
 */

export interface Obstacle { p: Vec2; radius: number; id: string; heading?: number }

// --- shared helpers used by NPCs and the autonomy stack ------------------------------------

export interface DriveRules { vMax: number; aMax: number; bComfort: number; gap0: number; headway: number }
export const NPC_RULES: DriveRules = { vMax: 11, aMax: 1.6, bComfort: 2.5, gap0: 3, headway: 1.3 };

/** IDM acceleration for speed v towards vDes with a gap to the next obstacle (Infinity = free road). */
export function idm(v: number, vDes: number, gap: number, dv: number, r: DriveRules): number {
  const free = 1 - Math.pow(Math.max(v, 0) / Math.max(vDes, 0.1), 4);
  if (!Number.isFinite(gap)) return r.aMax * free;
  const sStar = r.gap0 + Math.max(0, v * r.headway + (v * dv) / (2 * Math.sqrt(r.aMax * r.bComfort)));
  return r.aMax * (free - Math.pow(sStar / Math.max(gap, 0.1), 2));
}

/**
 * Distance along `path` (from s) to the first thing that blocks it within `horizon` metres:
 * an obstacle near the path, or a stop line whose light says stop. `ignore` skips self.
 */
const BOX = 2 * STOP_AT + 6; // path length from a stop line through the intersection and one car beyond

const aligned = (o: Obstacle, tan: Vec2) => o.heading !== undefined && -Math.sin(o.heading) * tan.x - Math.cos(o.heading) * tan.z > 0.7;

export function gapAhead(city: City, path: Path, s: number, v: number, t: number, obstacles: Obstacle[], ignore: string, horizon = 45, halfWidth = 1.6, alignedOnly = false): number {
  let gap = Infinity;
  for (const stop of path.stops) {
    const d = stop.s - s;
    if (d < -0.5 || d > horizon) continue;
    const state = city.light(stop.node, stop.axis, t);
    // Yellow: stop if it can be done comfortably, otherwise go through.
    if (state === 'R' || (state === 'Y' && d > (v * v) / (2 * 3.5) + 1)) gap = Math.min(gap, Math.max(d, 0));
    // Don't block the box: wait at the line while traffic going our way queues inside it.
    else if (d > 0.5 && d < 25 && boxBlocked(path, stop.s, obstacles, ignore)) gap = Math.min(gap, d);
  }
  const step = 2;
  for (let ds = 2; ds <= horizon && ds < gap; ds += step) {
    if (s + ds > path.length) break;
    const { p: q, t: tan } = path.at(s + ds);
    for (const o of obstacles) {
      if (o.id === ignore) continue;
      if (Math.abs(o.p.x - q.x) > 4 || Math.abs(o.p.z - q.z) > 4) continue;
      // Deadlock breaker: after waiting long enough, yield only to traffic going our way.
      // Only one side of a deadlock may do this (ego first, then by id), so they don't both creep.
      if (alignedOnly && o.heading !== undefined && outranks(ignore, o.id) && -Math.sin(o.heading) * tan.x - Math.cos(o.heading) * tan.z < 0.3) continue;
      if (dist(o.p, q) < halfWidth + o.radius) {
        gap = Math.min(gap, ds - o.radius - 2.2);
        break;
      }
    }
  }
  return gap;
}

const outranks = (a: string, b: string) => a === 'ego' || (b !== 'ego' && a < b);

function boxBlocked(path: Path, stopS: number, obstacles: Obstacle[], ignore: string): boolean {
  for (let ds = 3; ds <= BOX && stopS + ds <= path.length; ds += 2) {
    const { p: q, t: tan } = path.at(stopS + ds);
    for (const o of obstacles) {
      if (o.id === ignore || o.radius < 1) continue; // cars only, not pedestrians
      if (Math.abs(o.p.x - q.x) < 2.5 && Math.abs(o.p.z - q.z) < 2.5 && dist(o.p, q) < 2.2 && aligned(o, tan)) return true;
    }
  }
  return false;
}

// --- NPC vehicles --------------------------------------------------------------------------

export interface Npc {
  id: string;
  model: number; // index into the vehicle model list, chosen by the renderer
  path: Path;
  lanes: number[];
  s: number;
  v: number;
  p: Vec2;
  heading: number;
  wheelSpin: number;
  waited: number; // seconds standing still without a red light
}

let rand = 1234567;
const random = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);

export class Traffic {
  readonly npcs: Npc[] = [];

  constructor(private readonly city: City) {}

  private extend(n: Npc): void {
    // Keep at least ~120 m of path ahead: append random onward lanes (no U-turns).
    while (n.path.length - n.s < 120) {
      const last = this.city.lanes[n.lanes[n.lanes.length - 1]];
      const options = last.next;
      const c = options[Math.floor(random() * options.length)];
      n.path.stops.push({ s: n.path.length, node: last.to, axis: last.axis });
      for (const p of c.points) n.path.push(p);
      const lane = this.city.lanes[c.to];
      for (const p of lane.points) n.path.push(p);
      n.lanes.push(c.to);
    }
  }

  /** Moves a car to a random free spot on a lane, at least 60 m from `avoid[0]` (the ego car). */
  private respawn(n: Npc, avoid: Vec2[]): boolean {
    for (let k = 0; k < 30; k++) {
      const lane = this.city.lanes[Math.floor(random() * this.city.lanes.length)];
      const s = 6 + random() * (lane.length - 12);
      const p = { x: lane.points[0].x + lane.dir.x * s, z: lane.points[0].z + lane.dir.z * s };
      if ((avoid[0] && dist(p, avoid[0]) < 60) || avoid.some((a) => dist(a, p) < 14)) continue;
      n.path = new Path(lane.points);
      n.lanes = [lane.id];
      n.s = s;
      n.v = 4;
      n.p = p;
      n.heading = headingOf(lane.dir);
      n.waited = 0;
      this.extend(n);
      return true;
    }
    return false;
  }

  setCount(count: number, avoid: Vec2): void {
    while (this.npcs.length > count) this.npcs.pop();
    let guard = 0;
    while (this.npcs.length < count && guard++ < 500) {
      const lane = this.city.lanes[Math.floor(random() * this.city.lanes.length)];
      const s = 6 + random() * (lane.length - 12);
      const p = { x: lane.points[0].x + lane.dir.x * s, z: lane.points[0].z + lane.dir.z * s };
      if (dist(p, avoid) < 25 || this.npcs.some((n) => dist(n.p, p) < 14)) continue;
      const path = new Path(lane.points);
      const n: Npc = { id: `npc${this.npcs.length}-${Math.floor(random() * 1e6)}`, model: Math.floor(random() * 1000), path, lanes: [lane.id], s, v: 6 + random() * 4, p, heading: headingOf(lane.dir), wheelSpin: 0, waited: 0 };
      this.extend(n);
      this.npcs.push(n);
    }
  }

  step(dt: number, t: number, others: Obstacle[]): void {
    const obstacles: Obstacle[] = [...others, ...this.npcs.map((n) => ({ p: n.p, radius: 1.2, id: n.id, heading: n.heading }))];
    for (const n of this.npcs) {
      // Gridlock breakers: after 4 s yield only to cars going our way; after 15 s (e.g. queued
      // behind the parked ego car) the car leaves the scene and re-enters somewhere else.
      if (n.waited > 15 && this.respawn(n, [...others.map((o) => o.p), ...this.npcs.filter((m) => m !== n).map((m) => m.p)])) continue;
      const gap = gapAhead(this.city, n.path, n.s, n.v, t, obstacles, n.id, 45, 1.6, n.waited > 4);
      const redAhead = n.path.stops.some((x) => x.s - n.s > -0.5 && x.s - n.s < 12 && this.city.light(x.node, x.axis, t) !== 'G');
      n.waited = n.v < 0.3 && !redAhead ? n.waited + dt : 0;
      const vDes = n.path.curvature(n.s + 6) > 0.05 ? 5 : NPC_RULES.vMax;
      const a = idm(n.v, vDes, gap, n.v, NPC_RULES);
      n.v = Math.max(0, n.v + Math.max(-8, a) * dt);
      n.s += n.v * dt;
      n.wheelSpin += (n.v / 0.34) * dt;
      const { p, t: tan } = n.path.at(n.s);
      n.p = p;
      n.heading = headingOf(tan);
      // Trim consumed path so it doesn't grow forever.
      if (n.s > 300) {
        const keepFrom = n.s - 20;
        const pts = n.path.pts.filter((_, i) => n.path.s[i] >= keepFrom);
        const shift = n.path.s[n.path.pts.length - pts.length];
        const stops = n.path.stops.filter((x) => x.s >= keepFrom).map((x) => ({ ...x, s: x.s - shift }));
        n.path = new Path(pts);
        n.path.stops.push(...stops);
        n.s -= shift;
      }
      this.extend(n);
    }
  }
}

// --- pedestrians -----------------------------------------------------------------------

export interface Pedestrian {
  id: string;
  p: Vec2;
  heading: number;
  speed: number;
  /** Block (min-corner grid index) the pedestrian walks around. */
  bi: number;
  bj: number;
  corner: number; // next corner index 0..3 around the block
  crossing: null | { from: Vec2; to: Vec2; node: number; axis: Axis; waiting: boolean };
  phase: number; // walk animation phase
  color: number;
  hidden: boolean; // e.g. while riding in the robotaxi
  scripted: boolean; // controlled by a scenario, not the crowd logic
  target: Vec2 | null; // scripted walk target
}

export class Crowd {
  readonly people: Pedestrian[] = [];

  constructor(private readonly city: City) {}

  /** Sidewalk corner k (0..3, counter-clockwise from the min corner) of block (bi, bj). */
  corner(bi: number, bj: number, k: number): Vec2 {
    const n = this.city.node(bi + (k === 1 || k === 2 ? 1 : 0), bj + (k >= 2 ? 1 : 0));
    const sx = k === 1 || k === 2 ? -1 : 1;
    const sz = k >= 2 ? -1 : 1;
    return { x: n.x + sx * WALK_OFFSET, z: n.z + sz * WALK_OFFSET };
  }

  setCount(count: number): void {
    while (this.people.filter((p) => !p.scripted).length > count) {
      const i = this.people.findIndex((p) => !p.scripted);
      this.people.splice(i, 1);
    }
    const walkable = this.city.blocks.filter((b) => b.kind !== 'lot');
    while (this.people.filter((p) => !p.scripted).length < count) {
      const b = walkable[Math.floor(random() * walkable.length)];
      const k = Math.floor(random() * 4);
      const a = this.corner(b.i, b.j, k);
      const c = this.corner(b.i, b.j, (k + 1) % 4);
      const u = random();
      this.people.push({
        id: `ped${Math.floor(random() * 1e9)}`, p: { x: a.x + (c.x - a.x) * u, z: a.z + (c.z - a.z) * u }, heading: 0,
        speed: 1.1 + random() * 0.5, bi: b.i, bj: b.j, corner: (k + 1) % 4, crossing: null, phase: random() * 6,
        color: Math.floor(random() * 6), hidden: false, scripted: false, target: null,
      });
    }
  }

  /** Spawns a scenario-controlled pedestrian (e.g. a robotaxi passenger). */
  spawnScripted(p: Vec2): Pedestrian {
    const ped: Pedestrian = { id: `pax${Math.floor(random() * 1e9)}`, p: { ...p }, heading: 0, speed: 1.3, bi: 0, bj: 0, corner: 0, crossing: null, phase: 0, color: 6, hidden: false, scripted: true, target: null };
    this.people.push(ped);
    return ped;
  }

  remove(ped: Pedestrian): void {
    const i = this.people.indexOf(ped);
    if (i >= 0) this.people.splice(i, 1);
  }

  private walk(ped: Pedestrian, to: Vec2, dt: number): boolean {
    const d = dist(ped.p, to);
    const step = ped.speed * dt;
    if (d <= step) {
      ped.p = { ...to };
      return true;
    }
    ped.heading = headingOf({ x: (to.x - ped.p.x) / d, z: (to.z - ped.p.z) / d });
    ped.p = { x: ped.p.x + ((to.x - ped.p.x) / d) * step, z: ped.p.z + ((to.z - ped.p.z) / d) * step };
    ped.phase += step * 3;
    return false;
  }

  step(dt: number, t: number): void {
    for (const ped of this.people) {
      if (ped.hidden) continue;
      if (ped.scripted) {
        if (ped.target && this.walk(ped, ped.target, dt)) ped.target = null;
        continue;
      }
      if (ped.crossing) {
        const c = ped.crossing;
        if (c.waiting) {
          if (this.city.canCross(c.node, c.axis, t)) c.waiting = false;
          continue;
        }
        if (this.walk(ped, c.to, dt)) ped.crossing = null;
        continue;
      }
      const target = this.corner(ped.bi, ped.bj, ped.corner);
      if (!this.walk(ped, target, dt)) continue;
      // At a corner: sometimes cross to the neighbouring block, otherwise keep circling.
      const k = ped.corner;
      if (random() < 0.45) {
        const n = this.city.node(ped.bi + (k === 1 || k === 2 ? 1 : 0), ped.bj + (k >= 2 ? 1 : 0));
        // Two arms meet at this corner; cross the one along X (EW road) or along Z (NS road).
        const alongX = random() < 0.5;
        const ni = ped.bi + (alongX ? 0 : k === 1 || k === 2 ? 1 : -1);
        const nj = ped.bj + (alongX ? (k >= 2 ? 1 : -1) : 0);
        if (ni >= 0 && nj >= 0 && ni < 4 && nj < 4 && !(ni === 2 && nj === 0)) {
          const sx = k === 1 || k === 2 ? -1 : 1;
          const sz = k >= 2 ? -1 : 1;
          // Walk onto the crosswalk line, then across.
          const from = alongX ? { x: n.x + sx * CROSSWALK_AT, z: n.z + sz * WALK_OFFSET } : { x: n.x + sx * WALK_OFFSET, z: n.z + sz * CROSSWALK_AT };
          const to = alongX ? { x: from.x, z: n.z - sz * WALK_OFFSET } : { x: n.x - sx * WALK_OFFSET, z: from.z };
          ped.p = from;
          ped.crossing = { from, to, node: n.id, axis: alongX ? 'EW' : 'NS', waiting: true };
          ped.bi = ni;
          ped.bj = nj;
          // Corner index of the arrival point on the new block, then continue counter-clockwise.
          const arrive = [0, 1, 2, 3].reduce((best, c) => (dist(this.corner(ni, nj, c), to) < dist(this.corner(ni, nj, best), to) ? c : best), 0);
          ped.corner = (arrive + 1) % 4;
          continue;
        }
      }
      ped.corner = (k + 1) % 4;
    }
  }

  /** Pedestrians as obstacles for vehicles: only those on the road (crossing) or scripted ones. */
  obstacles(): Obstacle[] {
    return this.people.filter((p) => !p.hidden && (p.crossing && !p.crossing.waiting || p.scripted)).map((p) => ({ p: p.p, radius: 0.6, id: p.id }));
  }
}
