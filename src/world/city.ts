/**
 * City layout and lane graph (right-hand traffic), shared by the renderer, traffic,
 * pedestrians and the autonomy stack.
 *
 * Coordinates: metres on the X/Z ground plane. A heading h faces f = (-sin h, -cos h);
 * h = 0 faces -Z. The right-hand side of a direction f is r = (-f.z, f.x).
 */

export interface Vec2 { x: number; z: number }
export type Axis = 'NS' | 'EW'; // NS: road along Z, EW: road along X
export type LightState = 'G' | 'Y' | 'R';

export const GRID = 5; // intersections per side
export const BLOCK = 72; // distance between intersections
export const ROAD_HALF = 5; // asphalt half width (two lanes)
export const LANE_OFFSET = 2; // lane centre to road centre
export const SIDEWALK = 3.2; // sidewalk width beyond the asphalt
export const CROSSWALK_AT = 7; // crosswalk centre, distance from intersection centre
export const STOP_AT = 9.5; // stop line, distance from intersection centre
export const WALK_OFFSET = ROAD_HALF + 1.4; // pedestrians walk this far from the road centre

export const LIGHT_CYCLE = 26; // s: NS green 10, yellow 2, all-red 1, EW green 10, yellow 2, all-red 1

export interface Node { id: number; i: number; j: number; x: number; z: number; degree: number; hasLight: boolean; offset: number }

/** One directed lane between two intersections, from the stop line area of `from` to the stop line of `to`. */
export interface Lane {
  id: number;
  from: number;
  to: number;
  axis: Axis;
  dir: Vec2; // unit travel direction
  points: Vec2[]; // centreline from exit of `from` to the stop line of `to`
  length: number;
  next: Connector[];
}

/** Path through an intersection from the end of one lane to the start of another. */
export interface Connector { from: number; to: number; node: number; points: Vec2[]; length: number; turn: 'straight' | 'left' | 'right' }

export interface Bay { id: number; center: Vec2; heading: number; side: 'east' | 'west' }

export interface ParkingLot {
  min: Vec2; max: Vec2;
  aisleX: number; // aisle runs along Z at this X
  entrance: Vec2; // where the driveway meets the aisle
  entryLane: number; // lane from which the lot is entered (right turn into the driveway)
  bays: Bay[];
}

export const coord = (k: number) => (k - (GRID - 1) / 2) * BLOCK;

const add = (a: Vec2, b: Vec2, s = 1): Vec2 => ({ x: a.x + b.x * s, z: a.z + b.z * s });
const right = (f: Vec2): Vec2 => ({ x: -f.z, z: f.x });
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
export const headingOf = (f: Vec2) => Math.atan2(-f.x, -f.z);
export const forwardOf = (h: number): Vec2 => ({ x: -Math.sin(h), z: -Math.cos(h) });

function polylineLength(p: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  return l;
}

function bezier(a: Vec2, c: Vec2, b: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, z: u * u * a.z + 2 * u * t * c.z + t * t * b.z });
  }
  return out;
}

function lineIntersection(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d.x * e.z - d.z * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den;
  return add(p, d, t);
}

export class City {
  readonly nodes: Node[] = [];
  readonly lanes: Lane[] = [];
  readonly lot: ParkingLot;
  /** Blocks (by min-corner grid index) that hold buildings; the lot block is excluded. */
  readonly blocks: { i: number; j: number; min: Vec2; max: Vec2; kind: 'commercial' | 'suburban' | 'park' | 'lot' }[] = [];

  constructor() {
    const id = (i: number, j: number) => j * GRID + i;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const degree = (i > 0 ? 1 : 0) + (i < GRID - 1 ? 1 : 0) + (j > 0 ? 1 : 0) + (j < GRID - 1 ? 1 : 0);
        this.nodes.push({ id: id(i, j), i, j, x: coord(i), z: coord(j), degree, hasLight: degree >= 3, offset: ((i * 7 + j * 11) % 5) * 2.6 });
      }
    }
    // Directed lanes for every road segment.
    for (const n of this.nodes) {
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const i = n.i + di;
        const j = n.j + dj;
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue;
        const m = this.nodes[id(i, j)];
        const dir = { x: di, z: dj };
        const r = right(dir);
        const start = add(add(n, dir, STOP_AT), r, LANE_OFFSET);
        const end = add(add(m, dir, -STOP_AT), r, LANE_OFFSET);
        const points: Vec2[] = [];
        const len = dist(start, end);
        const steps = Math.ceil(len / 4);
        for (let k = 0; k <= steps; k++) points.push(add(start, dir, (len * k) / steps));
        this.lanes.push({ id: this.lanes.length, from: n.id, to: m.id, axis: dj === 0 ? 'EW' : 'NS', dir, points, length: len, next: [] });
      }
    }
    // Connectors through intersections (no U-turns).
    for (const a of this.lanes) {
      for (const b of this.lanes) {
        if (b.from !== a.to || b.to === a.from) continue;
        const p = a.points[a.points.length - 1];
        const q = b.points[0];
        const cross = a.dir.x * b.dir.z - a.dir.z * b.dir.x;
        const turn = Math.abs(cross) < 1e-6 ? 'straight' : cross > 0 ? 'right' : 'left';
        const c = turn === 'straight' ? null : lineIntersection(p, a.dir, q, b.dir);
        const points = c ? bezier(p, c, q, 12) : [p, q];
        a.next.push({ from: a.id, to: b.id, node: a.to, points, length: polylineLength(points), turn });
      }
    }
    // Blocks and the parking lot (block with min corner at grid (2, 0)).
    for (let j = 0; j < GRID - 1; j++) {
      for (let i = 0; i < GRID - 1; i++) {
        const min = { x: coord(i), z: coord(j) };
        const max = { x: coord(i + 1), z: coord(j + 1) };
        const lot = i === 2 && j === 0;
        const central = i >= 1 && i <= 2 && j >= 1 && j <= 2;
        const kind = lot ? 'lot' : i === 0 && j === 3 ? 'park' : central ? 'commercial' : 'suburban';
        this.blocks.push({ i, j, min, max, kind });
      }
    }
    this.lot = this.buildLot();
  }

  private buildLot(): ParkingLot {
    const x0 = coord(2);
    const x1 = coord(3);
    const z0 = coord(0);
    const z1 = coord(1);
    const inset = ROAD_HALF + SIDEWALK + 0.5;
    const min = { x: x0 + inset, z: z0 + inset };
    const max = { x: x1 - inset, z: z1 - inset };
    const aisleX = (x0 + x1) / 2;
    // Entered from the westbound lane of the road at z1 (the lot is on its right).
    const entryLane = this.lanes.find((l) => l.from === (1 * GRID + 3) && l.to === (1 * GRID + 2))!;
    const bays: Bay[] = [];
    const bayW = 2.8;
    const depth = 5.5;
    const aisleHalf = 3.6;
    let idn = 0;
    for (let z = max.z - 4; z >= min.z + 10; z -= bayW) {
      bays.push({ id: idn++, center: { x: aisleX + aisleHalf + depth / 2, z }, heading: Math.PI / 2, side: 'east' });
      bays.push({ id: idn++, center: { x: aisleX - aisleHalf - depth / 2, z }, heading: -Math.PI / 2, side: 'west' });
    }
    return { min, max, aisleX, entrance: { x: aisleX, z: max.z }, entryLane: entryLane.id, bays };
  }

  /** Ground height: road 0, sidewalks/blocks 0.15, parking lot and driveway 0.17. */
  heightAt(p: Vec2): number {
    const lot = this.lot;
    if (p.x > lot.min.x && p.x < lot.max.x && p.z > lot.min.z && p.z < lot.max.z) return 0.17;
    if (Math.abs(p.x - lot.aisleX) < 3.6 && p.z >= lot.max.z && p.z < coord(1) - ROAD_HALF) return 0.17;
    for (const b of this.blocks) {
      if (p.x > b.min.x + ROAD_HALF && p.x < b.max.x - ROAD_HALF && p.z > b.min.z + ROAD_HALF && p.z < b.max.z - ROAD_HALF) return 0.15;
    }
    return 0;
  }

  node(i: number, j: number): Node {
    return this.nodes[j * GRID + i];
  }

  /** Traffic light state for the given approach axis at a node (G everywhere for unsignalled nodes). */
  light(nodeId: number, axis: Axis, t: number): LightState {
    const n = this.nodes[nodeId];
    if (!n.hasLight) return 'G';
    const c = (((t + n.offset) % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
    const phase = axis === 'NS' ? c : (c + LIGHT_CYCLE / 2) % LIGHT_CYCLE;
    return phase < 10 ? 'G' : phase < 12 ? 'Y' : 'R';
  }

  /** Pedestrians may cross a road arm when the traffic on that arm's axis has red. */
  canCross(nodeId: number, roadAxis: Axis, t: number): boolean {
    const n = this.nodes[nodeId];
    if (!n.hasLight) return true;
    return this.light(nodeId, roadAxis, t) === 'R' && this.light(nodeId, roadAxis, t - 1.5) === 'R';
  }

  /** Nearest lane whose direction roughly matches the heading; returns lane and arc length along it. */
  nearestLane(p: Vec2, heading?: number): { lane: Lane; s: number; d: number } {
    let best = { lane: this.lanes[0], s: 0, d: Infinity };
    const f = heading === undefined ? null : forwardOf(heading);
    for (const lane of this.lanes) {
      if (f && lane.dir.x * f.x + lane.dir.z * f.z < 0.5) continue;
      const a = lane.points[0];
      const s = Math.max(0, Math.min(lane.length, (p.x - a.x) * lane.dir.x + (p.z - a.z) * lane.dir.z));
      const q = add(a, lane.dir, s);
      const d = dist(p, q);
      if (d < best.d) best = { lane, s, d };
    }
    return best;
  }

  /** Shortest lane sequence from lane `from` to lane `to` (A* over lane lengths). */
  route(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const goal = this.lanes[to].points[0];
    const h = (l: number) => dist(this.lanes[l].points[this.lanes[l].points.length - 1], goal);
    const g = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const open = new Set([from]);
    while (open.size) {
      let cur = -1;
      let bestF = Infinity;
      for (const l of open) {
        const f = g.get(l)! + h(l);
        if (f < bestF) { bestF = f; cur = l; }
      }
      if (cur === to) {
        const path = [cur];
        while (prev.has(path[0])) path.unshift(prev.get(path[0])!);
        return path;
      }
      open.delete(cur);
      for (const c of this.lanes[cur].next) {
        const cost = g.get(cur)! + c.length + this.lanes[c.to].length;
        if (cost < (g.get(c.to) ?? Infinity)) {
          g.set(c.to, cost);
          prev.set(c.to, cur);
          open.add(c.to);
        }
      }
    }
    return null;
  }

  connector(from: number, to: number): Connector | undefined {
    return this.lanes[from].next.find((c) => c.to === to);
  }
}

// --- Paths -----------------------------------------------------------------------------------

/** A stop line on a path: vehicles must stop before `s` unless the light lets them through. */
export interface StopMark { s: number; node: number; axis: Axis }

/** Densely sampled polyline with arc length, used by traffic and the autonomy stack. */
export class Path {
  readonly pts: Vec2[] = [];
  readonly s: number[] = [];
  readonly stops: StopMark[] = [];

  constructor(points: Vec2[] = []) {
    for (const p of points) this.push(p);
  }

  push(p: Vec2): void {
    const last = this.pts[this.pts.length - 1];
    if (last && dist(last, p) < 0.05) return;
    this.s.push(last ? this.s[this.s.length - 1] + dist(last, p) : 0);
    this.pts.push(p);
  }

  get length(): number {
    return this.s.length ? this.s[this.s.length - 1] : 0;
  }

  /** Point and unit tangent at arc length s (clamped). */
  at(s: number): { p: Vec2; t: Vec2 } {
    const n = this.pts.length;
    if (n < 2) return { p: this.pts[0] ?? { x: 0, z: 0 }, t: { x: 0, z: -1 } };
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo];
    const b = this.pts[hi];
    const seg = this.s[hi] - this.s[lo] || 1;
    const u = (s - this.s[lo]) / seg;
    const t = { x: (b.x - a.x) / seg, z: (b.z - a.z) / seg };
    return { p: { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }, t };
  }

  /** Arc length of the point closest to p, searched near a hint to keep progress monotonic. */
  project(p: Vec2, hint = 0, window = 30): number {
    let best = hint;
    let bestD = Infinity;
    for (let i = 0; i < this.pts.length - 1; i++) {
      if (this.s[i + 1] < hint - 5 || this.s[i] > hint + window) continue;
      const a = this.pts[i];
      const b = this.pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
      const d = Math.hypot(p.x - (a.x + dx * u), p.z - (a.z + dz * u));
      if (d < bestD) { bestD = d; best = this.s[i] + u * Math.sqrt(l2); }
    }
    return best;
  }

  /** Curvature magnitude around s (1/m). */
  curvature(s: number): number {
    const a = this.at(s - 2).t;
    const b = this.at(s + 2).t;
    return Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z)) / 4;
  }
}

/** Builds a drivable path from a lane sequence (lanes joined by their connectors). */
export function pathFromLanes(city: City, lanes: number[], startS = 0, endS?: number): Path {
  const path = new Path();
  lanes.forEach((id, k) => {
    const lane = city.lanes[id];
    const from = k === 0 ? startS : 0;
    const to = k === lanes.length - 1 && endS !== undefined ? endS : lane.length;
    const a = lane.points[0];
    for (let s = from; s < to; s += 2) path.push(add(a, lane.dir, s));
    path.push(add(a, lane.dir, to));
    if (k < lanes.length - 1) {
      const c = city.connector(id, lanes[k + 1])!;
      path.stops.push({ s: path.length, node: lane.to, axis: lane.axis });
      for (const p of c.points) path.push(p);
    }
  });
  return path;
}
