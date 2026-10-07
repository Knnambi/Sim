// Subset of the COVESA Vehicle Signal Specification (VSS 5.1, as shipped with Kuksa Databroker 0.6) used by the simulator.
// Paths follow the official spec so the same names work against a real Kuksa Databroker.

export type SignalValue = boolean | number | string;

export type SignalKind = 'sensor' | 'actuator' | 'attribute';

interface SignalBase {
  path: string;
  kind: SignalKind;
  description: string;
  /** Panel group in the UI. */
  group: string;
}

export interface BoolSignal extends SignalBase {
  type: 'boolean';
  default: boolean;
}

export interface NumberSignal extends SignalBase {
  type: 'float' | 'uint8' | 'int8' | 'int16' | 'uint16' | 'uint32';
  unit?: string;
  min: number;
  max: number;
  step?: number;
  default: number;
}

export interface StringSignal extends SignalBase {
  type: 'string';
  allowed: readonly string[];
  default: string;
}

export type SignalDef = BoolSignal | NumberSignal | StringSignal;

const doors = [
  ['Row1.DriverSide', 'front left'],
  ['Row1.PassengerSide', 'front right'],
  ['Row2.DriverSide', 'rear left'],
  ['Row2.PassengerSide', 'rear right'],
] as const;

export const SIGNALS: readonly SignalDef[] = [
  // Powertrain / driving
  { path: 'Vehicle.Speed', type: 'float', kind: 'sensor', unit: 'km/h', min: 0, max: 250, default: 0, group: 'Driving', description: 'Vehicle speed' },
  { path: 'Vehicle.Chassis.Accelerator.PedalPosition', type: 'uint8', kind: 'sensor', unit: '%', min: 0, max: 100, default: 0, group: 'Driving', description: 'Accelerator pedal position' },
  { path: 'Vehicle.Chassis.Brake.PedalPosition', type: 'uint8', kind: 'sensor', unit: '%', min: 0, max: 100, default: 0, group: 'Driving', description: 'Brake pedal position' },
  { path: 'Vehicle.Chassis.SteeringWheel.Angle', type: 'int16', kind: 'sensor', unit: 'degrees', min: -90, max: 90, default: 0, group: 'Driving', description: 'Steering angle (+ left)' },
  { path: 'Vehicle.Powertrain.Transmission.SelectedGear', type: 'int8', kind: 'actuator', min: -1, max: 1, step: 1, default: 1, group: 'Driving', description: 'Gear (-1 R, 0 N, 1 D)' },
  { path: 'Vehicle.TraveledDistance', type: 'float', kind: 'sensor', unit: 'km', min: 0, max: 1e6, default: 0, group: 'Driving', description: 'Odometer' },

  // Exterior lights
  { path: 'Vehicle.Body.Lights.Beam.Low.IsOn', type: 'boolean', kind: 'actuator', default: false, group: 'Lights', description: 'Low beam' },
  { path: 'Vehicle.Body.Lights.Beam.High.IsOn', type: 'boolean', kind: 'actuator', default: false, group: 'Lights', description: 'High beam' },
  { path: 'Vehicle.Body.Lights.Brake.IsActive', type: 'string', kind: 'actuator', allowed: ['INACTIVE', 'ACTIVE', 'ADAPTIVE'], default: 'INACTIVE', group: 'Lights', description: 'Brake lights' },
  { path: 'Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling', type: 'boolean', kind: 'actuator', default: false, group: 'Lights', description: 'Left indicator' },
  { path: 'Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling', type: 'boolean', kind: 'actuator', default: false, group: 'Lights', description: 'Right indicator' },
  { path: 'Vehicle.Body.Lights.Hazard.IsSignaling', type: 'boolean', kind: 'actuator', default: false, group: 'Lights', description: 'Hazard lights' },

  // Doors
  ...doors.map(([pos, label]): BoolSignal => ({
    path: `Vehicle.Cabin.Door.${pos}.IsOpen`, type: 'boolean', kind: 'actuator', default: false, group: 'Doors', description: `Door ${label} open`,
  })),
  { path: 'Vehicle.Body.Mirrors.DriverSide.IsFolded', type: 'boolean', kind: 'actuator', default: false, group: 'Mirrors', description: 'Driver mirror folded' },
  { path: 'Vehicle.Body.Mirrors.PassengerSide.IsFolded', type: 'boolean', kind: 'actuator', default: false, group: 'Mirrors', description: 'Passenger mirror folded' },
  { path: 'Vehicle.Body.Trunk.Rear.IsOpen', type: 'boolean', kind: 'actuator', default: false, group: 'Doors', description: 'Trunk open' },

  // Windows (comfort ECU)
  ...doors.map(([pos, label]): NumberSignal => ({
    path: `Vehicle.Cabin.Door.${pos}.Window.Position`, type: 'uint8', kind: 'actuator', unit: '%', min: 0, max: 100, default: 0, group: 'Windows', description: `Window ${label} (0 = closed)`,
  })),

  // Wipers (comfort ECU)
  { path: 'Vehicle.Body.Windshield.Front.Wiping.Mode', type: 'string', kind: 'actuator', allowed: ['OFF', 'SLOW', 'MEDIUM', 'FAST', 'INTERVAL', 'RAIN_SENSOR'], default: 'OFF', group: 'Wipers', description: 'Wiper mode' },
  { path: 'Vehicle.Body.Windshield.Front.Wiping.System.IsWiping', type: 'boolean', kind: 'sensor', default: false, group: 'Wipers', description: 'Wipers moving' },
  { path: 'Vehicle.Body.Windshield.Front.Wiping.System.Frequency', type: 'uint8', kind: 'actuator', unit: 'cpm', min: 0, max: 255, default: 0, group: 'Wipers', description: 'Wiping frequency' },

  // Environment
  { path: 'Vehicle.Exterior.LightIntensity', type: 'float', step: 1, kind: 'sensor', unit: '%', min: 0, max: 100, default: 100, group: 'Environment', description: 'Ambient light (0 = dark, 100 = full daylight)' },
  { path: 'Vehicle.Body.Raindetection.Intensity', type: 'uint8', kind: 'sensor', unit: '%', min: 0, max: 100, default: 0, group: 'Environment', description: 'Rain intensity (0 = dry)' },
  { path: 'Vehicle.Exterior.AirTemperature', type: 'float', kind: 'sensor', unit: 'celsius', min: -30, max: 50, default: 18, group: 'Environment', description: 'Outside air temperature' },
];

export const SIGNAL_BY_PATH: ReadonlyMap<string, SignalDef> = new Map(SIGNALS.map((s) => [s.path, s]));

/** Clamp and coerce a value to what the signal definition allows. Throws on type mismatch. */
export function coerce(def: SignalDef, value: SignalValue): SignalValue {
  switch (def.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new TypeError(`${def.path} expects boolean`);
      return value;
    case 'string':
      if (typeof value !== 'string' || !def.allowed.includes(value)) {
        throw new TypeError(`${def.path} expects one of ${def.allowed.join(', ')}`);
      }
      return value;
    default: {
      if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError(`${def.path} expects number`);
      const clamped = Math.min(def.max, Math.max(def.min, value));
      return def.type === 'float' ? clamped : Math.round(clamped);
    }
  }
}
