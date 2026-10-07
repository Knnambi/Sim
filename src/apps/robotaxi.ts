import type { VehicleDataBroker } from '../vss/databroker';
import type { Pose } from '../sim/vehicleModel';
import type { Autopilot, ParkResult } from '../autonomy/autopilot';
import type { Crowd, Pedestrian } from '../world/agents';
import { City, GRID, LANE_OFFSET, ROAD_HALF, coord, dist, forwardOf, type Vec2 } from '../world/city';
import type { OsdviRuntime } from '../vapi/osdvi';

/**
 * Robotaxi service: a third-party app built on Vehicle APIs, run end to end in the simulator.
 * hail -> pickup (stop, hazards, open the curbside rear door, board) -> ride -> drop-off
 * (open door, alight) -> park in the lot. Doors go through the Open SDV API (OSDVI), hazards
 * through VSS, driving through the autopilot.
 */

export interface TaxiStep { id: string; label: string; status: 'pending' | 'active' | 'done' | 'failed'; detail?: string }

const SRC = 'Robotaxi app';
const PAX_DOOR = 4; // OSDVI Door instance: row 2, right (curbside in right-hand traffic)

export class RobotaxiService {
  readonly steps: TaxiStep[] = [
    { id: 'hail', label: 'Passenger hails a robotaxi', status: 'pending' },
    { id: 'pickup', label: 'Drive to the pickup point', status: 'pending' },
    { id: 'board', label: 'Stop, hazards on, open rear door, passenger boards', status: 'pending' },
    { id: 'ride', label: 'Drive to the destination', status: 'pending' },
    { id: 'alight', label: 'Open door, passenger alights', status: 'pending' },
    { id: 'park', label: 'Drive to the lot and park', status: 'pending' },
  ];
  running = false;
  private cancelled = false;
  private passenger: Pedestrian | null = null;
  private readonly listeners = new Set<() => void>();
  readonly log: string[] = [];
  pickup: Vec2 | null = null;
  dropoff: Vec2 | null = null;

  constructor(private readonly city: City, private readonly broker: VehicleDataBroker, private readonly pose: Pose,
    private readonly autopilot: Autopilot, private readonly crowd: Crowd, private readonly osdvi: OsdviRuntime,
    private readonly freeBay: () => number | null, private readonly setSign: (on: boolean) => void) {}

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private changed(): void {
    this.listeners.forEach((cb) => cb());
  }

  private step(id: string, status: TaxiStep['status'], detail?: string): void {
    const s = this.steps.find((x) => x.id === id)!;
    s.status = status;
    if (detail !== undefined) s.detail = detail;
    this.changed();
  }

  private note(msg: string): void {
    this.log.unshift(msg);
    this.log.length = Math.min(this.log.length, 40);
    this.changed();
  }

  private async waitFor(cond: () => boolean, timeoutS: number): Promise<void> {
    const t0 = performance.now();
    while (!cond()) {
      if (this.cancelled) throw new Error('cancelled');
      if (performance.now() - t0 > timeoutS * 1000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async drive(target: Vec2, timeoutS = 240): Promise<void> {
    let arrived = false;
    let failed = '';
    const off = this.autopilot.on((ev, detail) => {
      if (ev === 'arrived') arrived = true;
      if (ev === 'disengaged') failed = String(detail);
    });
    try {
      if (!this.autopilot.driveTo(target)) throw new Error('no route');
      await this.waitFor(() => arrived || failed !== '', timeoutS);
      if (failed) throw new Error(`autopilot ${failed}`);
    } finally {
      off();
    }
  }

  /** A curbside point (sidewalk) next to a random lane far enough from the car. */
  private randomCurb(minDist: number): { lanePoint: Vec2; curb: Vec2 } {
    for (let k = 0; k < 200; k++) {
      const lane = this.city.lanes[Math.floor(Math.random() * this.city.lanes.length)];
      const s = 15 + Math.random() * (lane.length - 30);
      const p = { x: lane.points[0].x + lane.dir.x * s, z: lane.points[0].z + lane.dir.z * s };
      if (dist(p, this.pose) < minDist) continue;
      const r = { x: -lane.dir.z, z: lane.dir.x };
      const off = ROAD_HALF - LANE_OFFSET + 1.6;
      const curb = { x: p.x + r.x * off, z: p.z + r.z * off };
      // Keep clear of the parking lot block and the grass outside the city.
      if (this.city.heightAt(curb) > 0.16 || Math.max(Math.abs(curb.x), Math.abs(curb.z)) > coord(GRID - 1)) continue;
      return { lanePoint: p, curb };
    }
    throw new Error('no curb point found');
  }

  /** World position next to the passenger door of the stopped car. */
  private doorSide(outside: number): Vec2 {
    const f = forwardOf(this.pose.heading);
    const r = { x: -f.z, z: f.x };
    return { x: this.pose.x + r.x * outside - f.x * 0.7, z: this.pose.z + r.z * outside - f.z * 0.7 };
  }

  private hazards(on: boolean): void {
    this.broker.actuate('Vehicle.Body.Lights.Hazard.IsSignaling', on, SRC);
    this.note(`VSS actuate Hazard.IsSignaling = ${on}`);
  }

  private async door(open: boolean): Promise<void> {
    const api = this.osdvi.app('robotaxi');
    const r = api.Door.startMove(PAX_DOOR, open ? 100 : 0);
    this.note(`OSDVI Door.startMove(${PAX_DOOR}, ${open ? 100 : 0}) → ${r.returnValue}`);
    if (r.returnValue !== 'E_OK') throw new Error(`door ${r.returnValue}`);
    await this.waitFor(() => api.Door.getStatus(PAX_DOOR).status?.position === (open ? 100 : 0), 5);
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.autopilot.stop();
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    this.log.length = 0;
    this.steps.forEach((s) => ((s.status = 'pending'), (s.detail = undefined)));
    this.setSign(true);
    let current = 'hail';
    try {
      // 1. Hail
      this.step('hail', 'active');
      const pick = this.randomCurb(70);
      this.pickup = pick.curb;
      this.passenger = this.crowd.spawnScripted(pick.curb);
      this.step('hail', 'done', `at (${pick.curb.x.toFixed(0)}, ${pick.curb.z.toFixed(0)})`);

      // 2. Pickup
      current = 'pickup';
      this.step('pickup', 'active');
      this.autopilot.release();
      await this.drive(pick.lanePoint);
      this.step('pickup', 'done');

      // 3. Board
      current = 'board';
      this.step('board', 'active');
      this.hazards(true);
      await this.door(true);
      this.passenger.target = this.doorSide(1.4);
      await this.waitFor(() => this.passenger!.target === null, 30);
      this.passenger.hidden = true;
      this.note('Passenger boarded');
      await this.door(false);
      this.hazards(false);
      this.step('board', 'done');

      // 4. Ride
      current = 'ride';
      this.step('ride', 'active');
      const drop = this.randomCurb(120);
      this.dropoff = drop.curb;
      this.autopilot.release();
      await this.drive(drop.lanePoint);
      this.step('ride', 'done');

      // 5. Alight
      current = 'alight';
      this.step('alight', 'active');
      this.hazards(true);
      await this.door(true);
      this.passenger.p = this.doorSide(1.3);
      this.passenger.hidden = false;
      this.passenger.target = drop.curb;
      await this.waitFor(() => this.passenger!.target === null, 30);
      this.note('Passenger alighted');
      await this.door(false);
      this.hazards(false);
      const pax = this.passenger;
      setTimeout(() => this.crowd.remove(pax), 8000);
      this.passenger = null;
      this.step('alight', 'done');

      // 6. Park
      current = 'park';
      this.step('park', 'active');
      const bay = this.freeBay();
      if (bay === null) throw new Error('no free bay');
      this.autopilot.release();
      const result = await new Promise<ParkResult>((resolve, reject) => {
        const off = this.autopilot.on((ev, detail) => {
          if (ev === 'parked') { off(); resolve(detail as ParkResult); }
          if (ev === 'disengaged') { off(); reject(new Error(`autopilot ${detail}`)); }
        });
        if (!this.autopilot.park(bay)) { off(); reject(new Error('no route to the lot')); }
      });
      this.step('park', result.passed ? 'done' : 'failed', `bay ${result.bay}: ${result.positionError} m, ${result.headingErrorDeg}°`);
      this.note(`Service complete (parking ${result.passed ? 'PASS' : 'FAIL'})`);
    } catch (err) {
      this.step(current, 'failed', (err as Error).message);
      if (this.passenger) {
        this.passenger.hidden = false;
        this.crowd.remove(this.passenger);
        this.passenger = null;
      }
    } finally {
      this.running = false;
      this.setSign(false);
      this.changed();
    }
  }
}
