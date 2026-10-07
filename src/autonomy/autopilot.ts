import type { VehicleDataBroker } from '../vss/databroker';
import { DRAG, MAX_ACCEL, MAX_DECEL, MAX_ROAD_WHEEL_ANGLE_RAD, ROLLING, WHEELBASE_M, type Pose } from '../sim/vehicleModel';
import { City, LANE_OFFSET, Path, ROAD_HALF, coord, dist, forwardOf, pathFromLanes, type Bay, type Vec2 } from '../world/city';
import { gapAhead, idm, type DriveRules, type Obstacle } from '../world/agents';

/**
 * AI driver for the ego car. It plans on the city's lane graph and drives like a human would:
 * by publishing the VSS driver inputs (accelerator, brake, steering, gear). The vehicle model,
 * ECUs and apps see an ordinary driver. Any keyboard input disengages it.
 *
 *   steering  pure pursuit on the rear-axle bicycle model (forward and reverse)
 *   speed     IDM towards the speed limit, curve speed, lights, cars, pedestrians, path end
 */

const SRC = 'Autopilot';
const EGO_RULES: DriveRules = { vMax: 11, aMax: 2, bComfort: 2.5, gap0: 3, headway: 1.2 };
const LOT_SPEED = 3;
const PARK_SPEED = 1.1;
const PARK_POS_TOL = 0.5; // m, PASS threshold for the parking judgement
const PARK_HEADING_TOL = 5; // degrees

export type AutopilotMode = 'off' | 'drive' | 'park-approach' | 'park-reverse' | 'arrived';

export interface ParkResult { bay: number; positionError: number; headingErrorDeg: number; passed: boolean; seconds: number }

interface Segment { path: Path; reverse: boolean; speed: number; city: boolean }

export class Autopilot {
  mode: AutopilotMode = 'off';
  private segments: Segment[] = [];
  private seg = 0;
  private s = 0;
  private parkBay: Bay | null = null;
  private parkStart = 0;
  private elapsed = 0;
  private stillFor = 0;
  private waited = 0; // seconds stopped in city traffic, for the deadlock breaker
  private readonly listeners = new Set<(event: string, detail?: unknown) => void>();
  /** Full planned route (for the minimap). */
  route: Path | null = null;

  constructor(private readonly city: City, private readonly broker: VehicleDataBroker, private readonly pose: Pose,
    private readonly obstacles: () => Obstacle[]) {
    // A driver taking over disengages the autopilot.
    broker.subscribe(['Vehicle.Chassis.Accelerator.PedalPosition', 'Vehicle.Chassis.Brake.PedalPosition', 'Vehicle.Chassis.SteeringWheel.Angle'], (e) => {
      if (this.mode !== 'off' && this.mode !== 'arrived' && e.source === 'Driver (keyboard)') this.disengage('driver took over');
    });
  }

  on(cb: (event: string, detail?: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: string, detail?: unknown): void {
    this.listeners.forEach((cb) => cb(event, detail));
  }

  get active(): boolean {
    return this.mode !== 'off' && this.mode !== 'arrived';
  }

  /** Drives to the lane position nearest to `target`. */
  driveTo(target: Vec2): boolean {
    const dest = this.city.nearestLane(target);
    const exit = this.lotExit();
    const path = this.cityPath(dest.lane.id, dest.s, exit?.join);
    if (!path) return false;
    this.start([...(exit ? [exit.segment] : []), { path, reverse: false, speed: EGO_RULES.vMax, city: true }], 'drive');
    return true;
  }

  /**
   * When the car stands in the parking lot, the way out: pull forward out of the bay (it was
   * reversed in, so it faces the aisle), drive up the aisle and the driveway and turn right onto
   * the westbound lane. Returns null when the car is not in the lot.
   */
  private lotExit(): { segment: Segment; join: { lane: number; s: number } } | null {
    const lot = this.city.lot;
    const P = { x: this.pose.x, z: this.pose.z };
    if (P.x < lot.min.x || P.x > lot.max.x || P.z < lot.min.z || P.z > lot.max.z + 4) return null;
    const f = forwardOf(this.pose.heading);
    const side = Math.sign(P.x - lot.aisleX);
    const inBay = Math.abs(P.x - lot.aisleX) > 3;
    const xe = lot.aisleX - side * 1.5; // drive up the far half of the aisle: the widest turn
    const path = new Path([P]);
    if (inBay) {
      if (f.x * -side < 0.5) return null; // parked nose-in: leave it to the driver
      const end = { x: xe, z: P.z + 5.5 };
      const c = { x: xe, z: P.z };
      for (let k = 1; k <= 14; k++) {
        const t = k / 14;
        const u = 1 - t;
        path.push({ x: u * u * P.x + 2 * u * t * c.x + t * t * end.x, z: u * u * P.z + 2 * u * t * c.z + t * t * end.z });
      }
    } else if (f.z < 0.5) {
      return null; // in the aisle facing the wrong way
    }
    const entry = this.city.lanes[lot.entryLane];
    const laneZ = entry.points[0].z;
    const x0 = inBay ? xe : P.x;
    const turnStart = { x: x0, z: coord(1) - ROAD_HALF - 4 };
    for (let z = path.pts[path.pts.length - 1].z + 2; z < turnStart.z; z += 2) path.push({ x: x0, z });
    path.push(turnStart);
    // Right turn onto the westbound lane (heading +z, right is -x).
    const end = { x: x0 - (laneZ - turnStart.z) - LANE_OFFSET, z: laneZ };
    for (let k = 1; k <= 10; k++) {
      const t = k / 10;
      const u = 1 - t;
      const c = { x: x0, z: laneZ };
      path.push({ x: u * u * turnStart.x + 2 * u * t * c.x + t * t * end.x, z: u * u * turnStart.z + 2 * u * t * c.z + t * t * end.z });
    }
    const join = { lane: entry.id, s: (entry.points[0].x - end.x) / -entry.dir.x + 3 };
    return { segment: { path, reverse: false, speed: LOT_SPEED, city: false }, join };
  }

  /** Drives to the lot and reverses into the bay; reports position and heading error. */
  park(bayId: number): boolean {
    const lot = this.city.lot;
    const bay = lot.bays.find((b) => b.id === bayId);
    if (!bay) return false;
    const entry = this.city.lanes[lot.entryLane];
    // Stop the city leg 6 m before the driveway (lane runs west, aisle at lot.aisleX).
    const sEnd = (entry.points[0].x - (lot.aisleX + 6)) / -entry.dir.x;
    const exit = this.lotExit();
    const cityLeg = this.cityPath(entry.id, sEnd, exit?.join);
    if (!cityLeg) return false;

    const east = bay.side === 'east';
    const sgn = east ? 1 : -1;
    const R = 4;
    const xa = lot.aisleX - sgn * 2.2; // approach line, offset away from the bay side
    const laneEnd = cityLeg.pts[cityLeg.pts.length - 1];
    const lotLeg = new Path([laneEnd]);
    // Right turn from the lane into the driveway, then down the aisle past the bay.
    const turnEnd = { x: xa, z: lot.max.z - 2 };
    for (let k = 1; k <= 12; k++) {
      const t = k / 12;
      const u = 1 - t;
      const c = { x: xa, z: laneEnd.z };
      lotLeg.push({ x: u * u * laneEnd.x + 2 * u * t * c.x + t * t * turnEnd.x, z: u * u * laneEnd.z + 2 * u * t * c.z + t * t * turnEnd.z });
    }
    const a = { x: xa, z: bay.center.z - R };
    for (let z = turnEnd.z - 2; z > a.z; z -= 2) lotLeg.push({ x: xa, z });
    lotLeg.push(a);
    // Reverse leg: quarter circle from A into line with the bay, then straight in.
    const rev = new Path([a]);
    const c = { x: xa + sgn * R, z: bay.center.z - R };
    for (let k = 1; k <= 16; k++) {
      const phi = (Math.PI / 2) * (k / 16);
      rev.push({ x: c.x - sgn * R * Math.cos(phi), z: c.z + R * Math.sin(phi) });
    }
    // Straight into the bay; the last metres are what sets the heading.
    const cEnd = rev.pts[rev.pts.length - 1];
    for (let k = 1; k <= 4; k++) rev.push({ x: cEnd.x + ((bay.center.x - cEnd.x) * k) / 4, z: bay.center.z });
    this.parkBay = bay;
    this.parkStart = this.elapsed;
    this.start([
      ...(exit ? [exit.segment] : []),
      { path: cityLeg, reverse: false, speed: EGO_RULES.vMax, city: true },
      { path: lotLeg, reverse: false, speed: LOT_SPEED, city: false },
      { path: rev, reverse: true, speed: PARK_SPEED, city: false },
    ], 'park-approach');
    return true;
  }

  stop(): void {
    if (this.mode === 'off') return;
    this.disengage('stopped');
  }

  private disengage(reason: string): void {
    this.mode = 'off';
    this.segments = [];
    this.route = null;
    this.parkBay = null;
    this.broker.publishValue('Vehicle.Chassis.Accelerator.PedalPosition', 0, SRC);
    this.broker.publishValue('Vehicle.Chassis.SteeringWheel.Angle', 0, SRC);
    this.emit('disengaged', reason);
  }

  /** Lane-graph path to (destLane, destS), from the car or from `from` (a lane position). */
  private cityPath(destLane: number, destS: number, from?: { lane: number; s: number }): Path | null {
    const startLane = from
      ? { lane: this.city.lanes[from.lane], s: from.s }
      : this.city.nearestLane({ x: this.pose.x, z: this.pose.z }, this.pose.heading);
    const lane0 = startLane.lane;
    const here = from
      ? { x: lane0.points[0].x + lane0.dir.x * from.s, z: lane0.points[0].z + lane0.dir.z * from.s }
      : { x: this.pose.x, z: this.pose.z };
    let lanes = this.city.route(startLane.lane.id, destLane);
    if (!lanes) return null;
    let startS = Math.min(startLane.s + (from ? 2 : 6), startLane.lane.length);
    // Destination behind us on the same lane: go around the block.
    if (lanes.length === 1 && destS < startS) {
      const onward = this.city.lanes[startLane.lane.id].next.find((c) => c.turn === 'right') ?? this.city.lanes[startLane.lane.id].next[0];
      const back = this.city.route(onward.to, destLane);
      if (!back) return null;
      lanes = [startLane.lane.id, ...back];
    }
    if (startS >= startLane.lane.length - 1 && lanes.length > 1) startS = startLane.lane.length - 1;
    const lanePath = pathFromLanes(this.city, lanes, startS, destS);
    const path = new Path([here]);
    const shift = dist(here, lanePath.pts[0]);
    for (const p of lanePath.pts) path.push(p);
    path.stops.push(...lanePath.stops.map((x) => ({ ...x, s: x.s + shift })));
    return path;
  }

  private start(segments: Segment[], mode: AutopilotMode): void {
    this.segments = segments;
    this.seg = 0;
    this.s = 0;
    this.mode = mode;
    this.stillFor = 0;
    const all = new Path();
    for (const sg of segments) for (const p of sg.path.pts) all.push(p);
    this.route = all;
    this.gear(segments[0].reverse ? -1 : 1);
    this.emit('engaged', mode);
  }

  private gear(g: number): void {
    if (this.broker.get('Vehicle.Powertrain.Transmission.SelectedGear').value !== g) {
      this.broker.actuate('Vehicle.Powertrain.Transmission.SelectedGear', g, SRC);
    }
  }

  /** Steering wheel angle (VSS, degrees, + left) from pure pursuit towards `target`. */
  private steer(target: Vec2, reverse: boolean): number {
    const f = forwardOf(this.pose.heading);
    const dir = reverse ? { x: -f.x, z: -f.z } : f;
    const left = { x: dir.z, z: -dir.x };
    const d = { x: target.x - this.pose.x, z: target.z - this.pose.z };
    const ld = Math.max(Math.hypot(d.x, d.z), 0.5);
    const alpha = Math.atan2(d.x * left.x + d.z * left.z, d.x * dir.x + d.z * dir.z);
    let delta = Math.atan((2 * WHEELBASE_M * Math.sin(alpha)) / ld);
    if (reverse) delta = -delta;
    return Math.max(-90, Math.min(90, (delta / MAX_ROAD_WHEEL_ANGLE_RAD) * 90));
  }

  step(dt: number, t: number): void {
    this.elapsed += dt;
    if (!this.active) return;
    const sg = this.segments[this.seg];
    const speed = Math.abs(this.pose.velocity);
    this.s = sg.path.project({ x: this.pose.x, z: this.pose.z }, this.s, 20);
    const remaining = sg.path.length - this.s;

    // Steering: look ahead along the path (shorter in the lot and in reverse).
    const look = sg.reverse ? 2.2 : sg.city ? Math.max(4, 3 + speed * 0.7) : 3;
    const ahead = this.s + look;
    let target = sg.path.at(ahead).p;
    if (ahead > sg.path.length) {
      // Past the end: keep aiming along the final direction so the car finishes straight.
      const end = sg.path.at(sg.path.length);
      target = { x: end.p.x + end.t.x * (ahead - sg.path.length), z: end.p.z + end.t.z * (ahead - sg.path.length) };
    }
    this.broker.publishValue('Vehicle.Chassis.SteeringWheel.Angle', Math.round(this.steer(target, sg.reverse)), SRC);

    // Speed: IDM against everything that can make us stop, including the end of this segment.
    // IDM settles at its minimum gap gap0, so shift the segment end by it to stop right at the end.
    const gap0 = sg.city ? 2 : 0.2;
    let gap = remaining + gap0 - (sg.reverse ? 0.03 : 0.3);
    if (sg.city) {
      // Same deadlock breaker as the NPCs: after waiting a while, yield only to traffic going our way.
      const red = sg.path.stops.some((x) => x.s - this.s > -0.5 && x.s - this.s < 12 && this.city.light(x.node, x.axis, t) !== 'G');
      this.waited = speed < 0.3 && !red && remaining > 1 ? this.waited + dt : 0;
      gap = Math.min(gap, gapAhead(this.city, sg.path, this.s, speed, t, this.obstacles(), 'ego', 45, 1.6, this.waited > 5));
    }
    const curveLimit = Math.sqrt(2.2 / Math.max(sg.path.curvature(this.s + Math.min(8, look)), 1e-3));
    const vDes = Math.min(sg.speed, curveLimit);
    const a = idm(speed, vDes, Math.max(gap, 0), speed, { ...EGO_RULES, vMax: sg.speed, gap0, headway: sg.city ? 1.2 : 0.5 });
    this.pedals(a, speed);

    // Segment done when (nearly) at its end and stopped.
    if (remaining < (sg.reverse ? 0.12 : 0.6) && speed < 0.15) {
      this.stillFor += dt;
      if (this.stillFor > 0.3) this.nextSegment();
    } else {
      this.stillFor = 0;
    }
  }

  /** Maps a desired acceleration onto accelerator/brake pedal positions. */
  private pedals(a: number, speed: number): void {
    const resist = (speed > 0.05 ? ROLLING : 0) + DRAG * speed;
    let throttle = 0;
    let brake = 0;
    if (a + resist > 0.05) throttle = ((a + resist) / MAX_ACCEL) * 100;
    else if (a < -0.05) brake = (-a / MAX_DECEL) * 100;
    if (speed < 0.3 && a < 0) brake = Math.max(brake, 25); // hold the car when stopping
    this.broker.publishValue('Vehicle.Chassis.Accelerator.PedalPosition', Math.min(100, Math.round(throttle)), SRC);
    this.broker.publishValue('Vehicle.Chassis.Brake.PedalPosition', Math.min(100, Math.round(brake)), SRC);
  }

  private nextSegment(): void {
    this.seg++;
    this.s = 0;
    this.stillFor = 0;
    if (this.seg < this.segments.length) {
      const next = this.segments[this.seg];
      this.gear(next.reverse ? -1 : 1);
      this.mode = next.reverse ? 'park-reverse' : this.mode;
      this.emit('segment', this.seg);
      return;
    }
    // Arrived: hold with the brake, back in drive, wheel straight.
    this.broker.publishValue('Vehicle.Chassis.Accelerator.PedalPosition', 0, SRC);
    this.broker.publishValue('Vehicle.Chassis.Brake.PedalPosition', 30, SRC);
    this.broker.publishValue('Vehicle.Chassis.SteeringWheel.Angle', 0, SRC);
    this.gear(1);
    this.mode = 'arrived';
    if (this.parkBay) {
      const bay = this.parkBay;
      const positionError = dist({ x: this.pose.x, z: this.pose.z }, bay.center);
      let dh = (this.pose.heading - bay.heading) % (2 * Math.PI);
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      const headingErrorDeg = Math.abs((dh * 180) / Math.PI);
      const result: ParkResult = {
        bay: bay.id, positionError: Math.round(positionError * 100) / 100, headingErrorDeg: Math.round(headingErrorDeg * 10) / 10,
        passed: positionError <= PARK_POS_TOL && headingErrorDeg <= PARK_HEADING_TOL, seconds: Math.round(this.elapsed - this.parkStart),
      };
      this.parkBay = null;
      this.emit('parked', result);
    } else {
      this.emit('arrived');
    }
  }

  /** Releases the brake hold after arrival so the driver (or the next leg) can take over. */
  release(): void {
    if (this.mode === 'arrived') {
      this.mode = 'off';
      this.broker.publishValue('Vehicle.Chassis.Brake.PedalPosition', 0, SRC);
    }
  }
}
