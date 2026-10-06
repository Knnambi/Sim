import type { VehicleDataBroker } from '../vss/databroker';

const WHEELBASE_M = 2.7;
const MAX_ROAD_WHEEL_ANGLE_RAD = (35 * Math.PI) / 180;
const MAX_ACCEL = 4; // m/s² at full throttle
const MAX_DECEL = 9; // m/s² at full brake
const DRAG = 0.015; // per second, proportional to speed
const ROLLING = 0.25; // m/s² constant resistance while moving

/** Signals owned by the body ECU (lights, doors, trunk). */
export const isBodySignal = (path: string) => path.startsWith('Vehicle.Body.') || path.startsWith('Vehicle.Cabin.Door.');

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

  /**
   * @param bodyController run the body ECU rules here. Off when a real/virtual BCM owns the body
   *   signals (e.g. the CAN vECU in /vecu), so the browser only simulates motion.
   */
  constructor(private readonly broker: VehicleDataBroker, { bodyController = true } = {}) {
    if (bodyController) this.installBodyController();
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

  step(dt: number): void {
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
