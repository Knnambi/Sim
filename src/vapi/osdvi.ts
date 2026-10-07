import type { VehicleDataBroker } from '../vss/databroker';

/**
 * Open SDV API (OSDVI, Open SDV Initiative / Nagoya University) on top of the VSS broker.
 *
 * Implements the subset of the logical API that this simulator can back, following
 * "Open SDV API 仕様 202603α": the Window, Door, Trunk and Wiper objects with their common
 * service calls (getConfigAll, getStatus, notify, getEvent, unnotify), MovableObject calls
 * (startMove, stopMove) and LockableObject calls (lock, unlock). Names, data types and return
 * codes follow the specification; descriptions here are our own.
 *
 * Simplifications (documented in the README):
 *  - Doors and the trunk move instantly in the simulator, so position is 0 or 100.
 *  - Risk control is reduced to one check: opening a door or the trunk while moving returns
 *    E_OBJECT_STATUS (the body ECU refuses it as well).
 *  - Wiper frequencyLevel/intervalLevel map onto the VSS wiper modes.
 */

/** `ReturnType` in the specification (renamed: it would shadow TypeScript's ReturnType<>). */
export type ReturnCode =
  | 'E_OK' | 'E_INVALID_ID' | 'E_INVALID_HANDLE' | 'E_INVALID_PARAMETER' | 'E_RISK_APPLICATION' | 'E_RISK_USER'
  | 'E_DENIED_PRIORITY' | 'E_DENIED_ACCESS' | 'E_OBJECT_FAULT' | 'E_OBJECT_LOCKED' | 'E_OBJECT_STATUS'
  | 'E_INFEASIBLE' | 'E_NO_DATA' | 'E_NO_MEMORY';

export type IdType = number; // UInt16 [1, 65535]
export type PositionType = number; // Int8 [0, 100] | UNKNOWN(-1) | NONZERO(-2)
export type PriorityType = number; // UInt8 [1, 100]
export type ApplicationIdType = string;
export type ZoneType = 'Left' | 'Right' | 'Center' | 'Top' | 'Bottom';

export interface PlacementType { row: number; zone: ZoneType }
export interface LockStatusType { locked: boolean; lockApplication?: ApplicationIdType; lockPriority?: PriorityType }
export interface ConfigType { instanceId: IdType; placement: PlacementType; capabilities: string[]; riskClasses: string[]; displayName: string }

export type ObjectName = 'Window' | 'Door' | 'Trunk' | 'Wiper';
export type EventKind =
  | 'ControlledBySelf' | 'ControlledByOther' | 'TargetReached' | 'FaultDetected' | 'FaultRecovered'
  | 'OwnLockRevoked' | 'OtherLockReleased' | 'EventOverflow';
export interface OsdviEvent { instanceId: IdType; eventInfo: { kind: EventKind; sourceApplication?: ApplicationIdType; noLostEvents?: number }; timestampMs: number }

export const DRIVER_ZONE: ZoneType = 'Left'; // the 3D car is left-hand drive
const PASSENGER_ZONE: ZoneType = 'Right';
const DEFAULT_PRIORITY = 50;
const QUEUE_LIMIT = 64;
const DOOR_RISK_SPEED_KMH = 5;

interface Instance {
  config: ConfigType;
  vss: string; // VSS signal backing the position
  lock: LockStatusType;
  target: PositionType | null; // target of a move requested through OSDVI
  mover?: ApplicationIdType; // app whose move is in progress
}

interface Queue { app: ApplicationIdType; object: ObjectName; instanceId: IdType | null; filter: Set<EventKind> | null; events: OsdviEvent[]; lost: number }

const doorPositions: [string, number, ZoneType][] = [
  ['Row1.DriverSide', 1, DRIVER_ZONE], ['Row1.PassengerSide', 1, PASSENGER_ZONE],
  ['Row2.DriverSide', 2, DRIVER_ZONE], ['Row2.PassengerSide', 2, PASSENGER_ZONE],
];

function instancesFor(object: ObjectName): Map<IdType, Instance> {
  const m = new Map<IdType, Instance>();
  const lock = (): LockStatusType => ({ locked: false });
  if (object === 'Window' || object === 'Door') {
    doorPositions.forEach(([pos, row, zone], i) => m.set(i + 1, {
      config: {
        instanceId: i + 1, placement: { row, zone },
        capabilities: object === 'Window' ? ['Movable', 'ClosedDetectable'] : ['Movable', 'ClosedDetectable'],
        riskClasses: object === 'Window' ? ['RiskPinch'] : ['RiskOpen', 'RiskPinch'],
        displayName: `${object} row ${row} ${zone.toLowerCase()}`,
      },
      vss: object === 'Window' ? `Vehicle.Cabin.Door.${pos}.Window.Position` : `Vehicle.Cabin.Door.${pos}.IsOpen`,
      lock: lock(), target: null,
    }));
  } else if (object === 'Trunk') {
    m.set(1, { config: { instanceId: 1, placement: { row: 0, zone: 'Center' }, capabilities: ['Movable', 'ClosedDetectable'], riskClasses: ['RiskOpen', 'RiskPinch'], displayName: 'Rear trunk' }, vss: 'Vehicle.Body.Trunk.Rear.IsOpen', lock: lock(), target: null });
  } else {
    m.set(1, { config: { instanceId: 1, placement: { row: 1, zone: 'Center' }, capabilities: ['Movable'], riskClasses: ['RiskWipingOnTrip'], displayName: 'Front wiper' }, vss: 'Vehicle.Body.Windshield.Front.Wiping.Mode', lock: lock(), target: null });
  }
  return m;
}

/** Shared OSDVI runtime: owns object state, locks and event queues for all applications. */
export class OsdviRuntime {
  private readonly objects = new Map<ObjectName, Map<IdType, Instance>>();
  private readonly queues = new Map<number, Queue>();
  private nextHandle = 1;
  private readonly t0 = performance.now();

  constructor(readonly broker: VehicleDataBroker) {
    for (const name of ['Window', 'Door', 'Trunk', 'Wiper'] as const) this.objects.set(name, instancesFor(name));
    // Detect TargetReached when the backing VSS signal arrives at the requested target.
    for (const [name, instances] of this.objects) {
      for (const [id, inst] of instances) {
        broker.subscribe([inst.vss], () => {
          if (inst.target === null || name === 'Wiper') return;
          if (this.position(name, inst) === inst.target) {
            const app = inst.mover;
            inst.target = null;
            inst.mover = undefined;
            this.emit(name, id, 'TargetReached', app);
          }
        });
      }
    }
  }

  /** An application session; the id identifies it for locks and ControlledBy* events. */
  app(appId: ApplicationIdType): OsdviApp {
    return new OsdviApp(this, appId);
  }

  // --- helpers used by OsdviApp -----------------------------------------------------------

  instance(object: ObjectName, id: IdType): Instance | undefined {
    return this.objects.get(object)?.get(id);
  }

  all(object: ObjectName): Instance[] {
    return [...(this.objects.get(object)?.values() ?? [])];
  }

  position(object: ObjectName, inst: Instance): PositionType {
    const v = this.broker.get(inst.vss).value;
    if (object === 'Window') return Math.round(v as number);
    return v ? 100 : 0;
  }

  speed(): number {
    return this.broker.get('Vehicle.Speed').value as number;
  }

  emit(object: ObjectName, instanceId: IdType, kind: EventKind, sourceApplication?: ApplicationIdType, onlyApp?: ApplicationIdType): void {
    const ev: OsdviEvent = { instanceId, eventInfo: { kind, ...(sourceApplication ? { sourceApplication } : {}) }, timestampMs: Math.round(performance.now() - this.t0) >>> 0 };
    for (const q of this.queues.values()) {
      if (q.object !== object || (q.instanceId !== null && q.instanceId !== instanceId)) continue;
      if (onlyApp && q.app !== onlyApp) continue;
      // ControlledBySelf goes to the acting app, ControlledByOther to everyone else.
      let k = kind;
      if (kind === 'ControlledBySelf' && q.app !== sourceApplication) k = 'ControlledByOther';
      if (q.filter && !q.filter.has(k)) continue;
      if (q.events.length >= QUEUE_LIMIT) {
        q.lost++;
        continue;
      }
      if (q.lost) {
        q.events.push({ instanceId, eventInfo: { kind: 'EventOverflow', noLostEvents: q.lost }, timestampMs: ev.timestampMs });
        q.lost = 0;
      }
      q.events.push({ ...ev, eventInfo: { ...ev.eventInfo, kind: k } });
    }
  }

  addQueue(q: Queue): number {
    const h = this.nextHandle++;
    this.queues.set(h, q);
    return h;
  }

  queue(handle: number): Queue | undefined {
    return this.queues.get(handle);
  }

  removeQueue(handle: number): boolean {
    return this.queues.delete(handle);
  }
}

const KNOWN_EVENTS: EventKind[] = ['ControlledBySelf', 'ControlledByOther', 'TargetReached', 'FaultDetected', 'FaultRecovered', 'OwnLockRevoked', 'OtherLockReleased', 'EventOverflow'];

/** One application's view of the OSDVI API. Every call returns { returnValue, ... }. */
export class OsdviApp {
  /** Object accessors in the shape of the specification, e.g. app.Window.startMove(1, 0). */
  readonly Window: ReturnType<OsdviApp['movable']>;
  readonly Door: ReturnType<OsdviApp['movable']>;
  readonly Trunk: ReturnType<OsdviApp['movable']>;
  readonly Wiper: ReturnType<OsdviApp['wiper']>;

  constructor(private readonly rt: OsdviRuntime, readonly appId: ApplicationIdType) {
    // Assigned here, not as field initializers: those would run before rt is set.
    this.Window = this.movable('Window');
    this.Door = this.movable('Door');
    this.Trunk = this.movable('Trunk');
    this.Wiper = this.wiper();
  }

  private common(object: ObjectName) {
    const rt = this.rt;
    const app = this.appId;
    return {
      getConfigAll: () => ({ returnValue: 'E_OK' as ReturnCode, config: rt.all(object).map((i) => structuredClone(i.config)) }),
      lock: (instanceId: IdType, priority: PriorityType = DEFAULT_PRIORITY) => {
        const inst = rt.instance(object, instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        if (priority < 1 || priority > 100) return { returnValue: 'E_INVALID_PARAMETER' as ReturnCode };
        const { lock } = inst;
        if (lock.locked && lock.lockApplication !== app) {
          if (priority <= (lock.lockPriority ?? 0)) return { returnValue: 'E_OBJECT_LOCKED' as ReturnCode };
          rt.emit(object, instanceId, 'OwnLockRevoked', app, lock.lockApplication); // higher priority takes over
        }
        inst.lock = { locked: true, lockApplication: app, lockPriority: priority };
        return { returnValue: 'E_OK' as ReturnCode };
      },
      unlock: (instanceId: IdType) => {
        const inst = rt.instance(object, instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        if (!inst.lock.locked || inst.lock.lockApplication !== app) return { returnValue: 'E_OBJECT_STATUS' as ReturnCode };
        inst.lock = { locked: false };
        rt.emit(object, instanceId, 'OtherLockReleased', app);
        return { returnValue: 'E_OK' as ReturnCode };
      },
      notify: (instanceId: IdType | null = null, eventFilter: EventKind[] | null = null) => {
        if (instanceId !== null && !rt.instance(object, instanceId)) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        if (eventFilter && eventFilter.some((k) => !KNOWN_EVENTS.includes(k))) return { returnValue: 'E_INVALID_PARAMETER' as ReturnCode };
        const notifyHandle = rt.addQueue({ app, object, instanceId, filter: eventFilter ? new Set(eventFilter) : null, events: [], lost: 0 });
        return { returnValue: 'E_OK' as ReturnCode, notifyHandle };
      },
      getEvent: (notifyHandle: number) => {
        const q = rt.queue(notifyHandle);
        if (!q || q.app !== app || q.object !== object) return { returnValue: 'E_INVALID_HANDLE' as ReturnCode };
        const event = q.events.shift();
        return event ? { returnValue: 'E_OK' as ReturnCode, event } : { returnValue: 'E_NO_DATA' as ReturnCode };
      },
      unnotify: (notifyHandle: number) => {
        const q = rt.queue(notifyHandle);
        if (!q || q.app !== app || q.object !== object) return { returnValue: 'E_INVALID_HANDLE' as ReturnCode };
        rt.removeQueue(notifyHandle);
        return { returnValue: 'E_OK' as ReturnCode };
      },
    };
  }

  /** Returns an error when another app holds the lock with a priority this call can't override. */
  private lockedOut(inst: Instance, priority: PriorityType): ReturnCode | null {
    const { lock } = inst;
    if (lock.locked && lock.lockApplication !== this.appId && priority <= (lock.lockPriority ?? 0)) return 'E_OBJECT_LOCKED';
    return null;
  }

  private movable(object: 'Window' | 'Door' | 'Trunk') {
    const rt = this.rt;
    const app = this.appId;
    const self = this;
    const mainStatus = (inst: Instance, pos: PositionType) => {
      const target = inst.target ?? pos;
      if (object === 'Window') return target > pos ? 'Opening' : target < pos ? 'Closing' : 'Stopped';
      return target > pos ? 'Opening' : target < pos ? 'Closing' : pos === 0 ? 'FullyStopped' : 'UnlatchedStopped';
    };
    return {
      ...this.common(object),
      getStatus: (instanceId: IdType) => {
        const inst = rt.instance(object, instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        const position = rt.position(object, inst);
        return {
          returnValue: 'E_OK' as ReturnCode,
          status: { mainStatus: mainStatus(inst, position), lockStatus: { ...inst.lock }, position, targetPosition: inst.target ?? position },
        };
      },
      startMove: (instanceId: IdType, targetPosition: PositionType, _moveProfile?: 'Standard' | 'Fast' | 'Slow', priority: PriorityType = DEFAULT_PRIORITY) => {
        const inst = rt.instance(object, instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        if (!Number.isInteger(targetPosition) || targetPosition < 0 || targetPosition > 100) return { returnValue: 'E_INVALID_PARAMETER' as ReturnCode };
        const locked = self.lockedOut(inst, priority);
        if (locked) return { returnValue: locked };
        // Doors and trunk only have two end positions in this simulator.
        const target = object === 'Window' ? targetPosition : targetPosition > 0 ? 100 : 0;
        if (object !== 'Window' && target > 0 && rt.speed() > DOOR_RISK_SPEED_KMH) return { returnValue: 'E_OBJECT_STATUS' as ReturnCode };
        inst.target = target;
        inst.mover = app;
        rt.emit(object, instanceId, 'ControlledBySelf', app);
        rt.broker.actuate(inst.vss, object === 'Window' ? target : target > 0, `OSDVI ${app}`);
        if (rt.position(object, inst) === target) {
          inst.target = null;
          inst.mover = undefined;
          rt.emit(object, instanceId, 'TargetReached', app); // already there, or moved instantly
        }
        return { returnValue: 'E_OK' as ReturnCode };
      },
      stopMove: (instanceId: IdType, priority: PriorityType = DEFAULT_PRIORITY) => {
        const inst = rt.instance(object, instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        const locked = self.lockedOut(inst, priority);
        if (locked) return { returnValue: locked };
        const here = rt.position(object, inst);
        rt.emit(object, instanceId, 'ControlledBySelf', app);
        inst.target = null;
        inst.mover = undefined;
        if (object === 'Window') rt.broker.actuate(inst.vss, here, `OSDVI ${app}`);
        rt.emit(object, instanceId, 'TargetReached', app);
        return { returnValue: 'E_OK' as ReturnCode };
      },
    };
  }

  private wiper() {
    const rt = this.rt;
    const app = this.appId;
    const self = this;
    const MODE = 'Vehicle.Body.Windshield.Front.Wiping.Mode';
    const toMode = (freq: number, interval: number) =>
      freq <= 0 ? 'OFF' : interval > 0 ? 'INTERVAL' : freq <= 45 ? 'SLOW' : freq <= 62 ? 'MEDIUM' : 'FAST';
    return {
      ...this.common('Wiper'),
      getStatus: (instanceId: IdType) => {
        const inst = rt.instance('Wiper', instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        const wiping = rt.broker.get('Vehicle.Body.Windshield.Front.Wiping.System.IsWiping').value as boolean;
        const freq = rt.broker.get('Vehicle.Body.Windshield.Front.Wiping.System.Frequency').value as number;
        const mode = rt.broker.get(MODE).value as string;
        return {
          returnValue: 'E_OK' as ReturnCode,
          status: {
            mainStatus: wiping ? 'Moving' : 'Stopped', lockStatus: { ...inst.lock },
            frequencyLevel: freq, intervalLevel: mode === 'INTERVAL' ? 4 : 0,
            wiperWearLevel: 0, washerStatus: 'NotSupported', washerWaterLevel: 0,
          },
        };
      },
      startMove: (instanceId: IdType, frequencyLevel: number, intervalLevel: number | null = null, priority: PriorityType = DEFAULT_PRIORITY) => {
        const inst = rt.instance('Wiper', instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        if (!Number.isInteger(frequencyLevel) || frequencyLevel < 0 || frequencyLevel > 100) return { returnValue: 'E_INVALID_PARAMETER' as ReturnCode };
        const locked = self.lockedOut(inst, priority);
        if (locked) return { returnValue: locked };
        rt.emit('Wiper', instanceId, 'ControlledBySelf', app);
        rt.broker.actuate(MODE, toMode(frequencyLevel, intervalLevel ?? 0), `OSDVI ${app}`);
        return { returnValue: 'E_OK' as ReturnCode };
      },
      stopMove: (instanceId: IdType, priority: PriorityType = DEFAULT_PRIORITY) => {
        const inst = rt.instance('Wiper', instanceId);
        if (!inst) return { returnValue: 'E_INVALID_ID' as ReturnCode };
        const locked = self.lockedOut(inst, priority);
        if (locked) return { returnValue: locked };
        rt.emit('Wiper', instanceId, 'ControlledBySelf', app);
        rt.broker.actuate(MODE, 'OFF', `OSDVI ${app}`);
        rt.emit('Wiper', instanceId, 'TargetReached', app);
        return { returnValue: 'E_OK' as ReturnCode };
      },
      startWasher: (instanceId: IdType) =>
        ({ returnValue: (rt.instance('Wiper', instanceId) ? 'E_INFEASIBLE' : 'E_INVALID_ID') as ReturnCode }), // no washer modelled
    };
  }
}
