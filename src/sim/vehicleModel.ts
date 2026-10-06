import type { VehicleDataBroker } from '../vss/databroker';

const WHEELBASE_M = 2.7;
const MAX_ROAD_WHEEL_ANGLE_RAD = (35 * Math.PI) / 180;
const MAX_ACCEL = 4; // m/s² at full throttle
const MAX_DECEL = 9; // m/s² at full brake
const DRAG = 0.015; // per second, proportional to speed
const ROLLING = 0.25; // m/s² constant resistance while moving

/** Signals owned by the comfort ECU (windows, wipers). */
export const isComfortSignal = (path: string) => path.includes('.Window.') || path.startsWith('Vehicle.Body.Windshield.Front.Wiping');

/** Signals owned by the body ECU (lights, doors, trunk). */
export const isBodySignal = (path: string) =>
  (path.startsWith('Vehicle.Body.') || path.startsWith('Vehicle.Cabin.Door.')) && !isComfortSignal(path);

const WINDOW_PATHS = ['Row1.DriverSide', 'Row1.PassengerSide', 'Row2.DriverSide', 'Row2.PassengerSide'].map(
  (pos) => `Vehicle.Cabin.Door.${pos}.Window.Position`,
);
const WINDOW_SPEED = 20; // % per second
/** Wiping frequency in cycles/min per mode; RAIN_SENSOR derives it from rain intensity. */
const WIPER_CPM: Record<string, number> = { OFF: 0, SLOW: 40, MEDIUM: 55, FAST: 70, INTERVAL: 12 };
const rainSensorCpm = (rain: number) => (rain < 5 ? 0 : rain < 30 ? 12 : rain < 60 ? 40 : rain < 85 ? 55 : 70);

export interface Pose {
  x: number;
  z: number;
  /** Radians, 0 = facing -Z. */
  heading: number;
  /** Signed speed in m/s (negative when reversing). */
  velocity: number;
  /** Road wheel angle in radians, for rendering. */
  wheelAngle: number;
  /** Accumulated wheel rotation in radians, for rendering. */
  wheelSpin: number;
}

/**
 * Stand-in for the vehicle's ECUs: a kinematic bicycle model for motion (powertrain/chassis)
 * plus a small body controller. It reads driver inputs from the broker, publishes sensor
 * values back, and fulfils actuation requests the way a real body ECU would.
 */
export class VehicleModel {
  readonly pose: Pose = { x: 0, z: 0, heading: 0, velocity: 0, wheelAngle: 0, wheelSpin: 0 };
  private odometerKm = 0;
  private lastPublishedSpeed = -1;
  /** Window motor state, only used when the comfort controller runs here. */
  private windowPos: number[] | null = null;
  private readonly windowTarget = [0, 0, 0, 0];

  /**
   * @param bodyController run the body ECU rules here. Off when a real/virtual BCM owns the body
   *   signals (e.g. the CAN vECU in /vecu), so the browser only simulates motion.
   * @param comfortController run the window motors and wiper logic here. Off when the SOME/IP
   *   comfort vECU in /soa owns them.
   */
  constructor(private readonly broker: VehicleDataBroker, { bodyController = true, comfortController = true } = {}) {
    if (bodyController) this.installBodyController();
    if (comfortController) this.installComfortController();
  }

  private installBodyController(): void {
    const b = this.broker;
    const src = 'BodyECU';

    // Brake lights follow the brake pedal.
    b.subscribe(['Vehicle.Chassis.Brake.PedalPosition'], (e) => {
      b.publishValue('Vehicle.Body.Lights.Brake.IsActive', (e.value as number) > 5 ? 'ACTIVE' : 'INACTIVE', src);
    });

    // High beam only makes sense with the low beam on; switching low beam off drops high beam.
    b.provideActuation('Vehicle.Body.Lights.Beam.High.IsOn', (on, from) => {
      if (on) b.publishValue('Vehicle.Body.Lights.Beam.Low.IsOn', true, src);
      b.publishValue('Vehicle.Body.Lights.Beam.High.IsOn', on, from);
    });
    b.provideActuation('Vehicle.Body.Lights.Beam.Low.IsOn', (on, from) => {
      b.publishValue('Vehicle.Body.Lights.Beam.Low.IsOn', on, from);
      if (!on) b.publishValue('Vehicle.Body.Lights.Beam.High.IsOn', false, src);
    });

    // Left and right indicators are mutually exclusive.
    const sides = ['Left', 'Right'] as const;
    for (const side of sides) {
      const other = side === 'Left' ? 'Right' : 'Left';
      b.provideActuation(`Vehicle.Body.Lights.DirectionIndicator.${side}.IsSignaling`, (on, from) => {
        if (on) b.publishValue(`Vehicle.Body.Lights.DirectionIndicator.${other}.IsSignaling`, false, src);
        b.publishValue(`Vehicle.Body.Lights.DirectionIndicator.${side}.IsSignaling`, on, from);
      });
    }

    // Doors refuse to open above walking speed.
    const doorPaths = [
      'Vehicle.Cabin.Door.Row1.DriverSide.IsOpen',
      'Vehicle.Cabin.Door.Row1.PassengerSide.IsOpen',
      'Vehicle.Cabin.Door.Row2.DriverSide.IsOpen',
      'Vehicle.Cabin.Door.Row2.PassengerSide.IsOpen',
      'Vehicle.Body.Trunk.Rear.IsOpen',
    ];
    for (const path of doorPaths) {
      b.provideActuation(path, (open, from) => {
        if (open && (b.get('Vehicle.Speed').value as number) > 5) {
          console.warn(`[BodyECU] rejected ${path}=true from ${from}: vehicle moving`);
          return;
        }
        b.publishValue(path, open, from);
      });
    }
  }

  private installComfortController(): void {
    const b = this.broker;
    const src = 'ComfortECU';
    this.windowPos = WINDOW_PATHS.map((p) => b.get(p).value as number);
    WINDOW_PATHS.forEach((path, i) => {
      this.windowTarget[i] = this.windowPos![i];
      // The motor moves towards the requested position; step() publishes the actual position.
      b.provideActuation(path, (target) => (this.windowTarget[i] = target as number));
    });

    const mode = 'Vehicle.Body.Windshield.Front.Wiping.Mode';
    const updateWipers = () => {
      const m = b.get(mode).value as string;
      const cpm = m === 'RAIN_SENSOR' ? rainSensorCpm(b.get('Vehicle.Body.Raindetection.Intensity').value as number) : WIPER_CPM[m] ?? 0;
      b.publishValue('Vehicle.Body.Windshield.Front.Wiping.System.Frequency', cpm, src);
      b.publishValue('Vehicle.Body.Windshield.Front.Wiping.System.IsWiping', cpm > 0, src);
    };
    b.provideActuation(mode, (value, from) => {
      b.publishValue(mode, value, from);
      updateWipers();
    });
    b.subscribe(['Vehicle.Body.Raindetection.Intensity'], updateWipers);
  }

  private stepWindows(dt: number): void {
    if (!this.windowPos) return;
    WINDOW_PATHS.forEach((path, i) => {
      const pos = this.windowPos![i];
      const target = this.windowTarget[i];
      if (pos === target) return;
      const step = WINDOW_SPEED * dt;
      this.windowPos![i] = Math.abs(target - pos) <= step ? target : pos + Math.sign(target - pos) * step;
      this.broker.publishValue(path, Math.round(this.windowPos![i]), 'ComfortECU');
    });
  }

  step(dt: number): void {
    this.stepWindows(dt);
    const b = this.broker;
    const throttle = (b.get('Vehicle.Chassis.Accelerator.PedalPosition').value as number) / 100;
    const brake = (b.get('Vehicle.Chassis.Brake.PedalPosition').value as number) / 100;
    const gear = b.get('Vehicle.Powertrain.Transmission.SelectedGear').value as number;
    const steering = b.get('Vehicle.Chassis.SteeringWheel.Angle').value as number;
    const p = this.pose;

    // Longitudinal dynamics.
    let v = p.velocity;
    v += throttle * MAX_ACCEL * gear * dt;
    const resist = (brake * MAX_DECEL + (v !== 0 ? ROLLING : 0)) * dt + Math.abs(v) * DRAG * dt;
    v = Math.abs(v) <= resist ? 0 : v - Math.sign(v) * resist;
    p.velocity = v;

    // Kinematic bicycle model for lateral motion.
    p.wheelAngle = (steering / 90) * MAX_ROAD_WHEEL_ANGLE_RAD;
    p.heading += (v / WHEELBASE_M) * Math.tan(p.wheelAngle) * dt;
    p.x -= Math.sin(p.heading) * v * dt;
    p.z -= Math.cos(p.heading) * v * dt;
    p.wheelSpin += (v / 0.34) * dt;

    // Publish sensors (speed rounded to 0.1 km/h to avoid flooding subscribers).
    const kmh = Math.round(Math.abs(v) * 3.6 * 10) / 10;
    if (kmh !== this.lastPublishedSpeed) {
      this.lastPublishedSpeed = kmh;
      b.publishValue('Vehicle.Speed', kmh, 'PowertrainECU');
    }
    this.odometerKm += (Math.abs(v) * dt) / 1000;
    const odo = Math.round(this.odometerKm * 100) / 100;
    if (odo !== b.get('Vehicle.TraveledDistance').value) b.publishValue('Vehicle.TraveledDistance', odo, 'PowertrainECU');
  }
}
