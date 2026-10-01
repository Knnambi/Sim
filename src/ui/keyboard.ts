import type { VehicleDataBroker } from '../vss/databroker';

const SRC = 'Driver (keyboard)';
const STEER_RATE = 140; // degrees per second
const PEDAL_RATE = 250; // percent per second

/**
 * Keyboard driving. Keys are mapped to the same VSS signals the panel writes,
 * so the broker sees driver input the same way regardless of where it came from.
 */
export class KeyboardDriver {
  private readonly down = new Set<string>();
  private steeringActive = false;
  private pedalsActive = false;

  constructor(private readonly broker: VehicleDataBroker) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.down.clear());
  }

  private onKey(e: KeyboardEvent, pressed: boolean): void {
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && (target as HTMLInputElement).type !== 'range') return;
    const key = e.key.toLowerCase();
    const driving = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
    if (driving.includes(key)) {
      e.preventDefault();
      if (pressed) this.down.add(key);
      else this.down.delete(key);
      return;
    }
    if (!pressed || e.repeat) return;

    const b = this.broker;
    const toggle = (path: string) => b.actuate(path, !(b.get(path).value as boolean), SRC);
    switch (key) {
      case 'q': toggle('Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling'); break;
      case 'e': toggle('Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling'); break;
      case 'h': toggle('Vehicle.Body.Lights.Hazard.IsSignaling'); break;
      case 'l': toggle('Vehicle.Body.Lights.Beam.Low.IsOn'); break;
      case 'k': toggle('Vehicle.Body.Lights.Beam.High.IsOn'); break;
      case 'r': {
        const gear = b.get('Vehicle.Powertrain.Transmission.SelectedGear').value as number;
        b.actuate('Vehicle.Powertrain.Transmission.SelectedGear', gear === -1 ? 1 : -1, SRC);
        break;
      }
      default: return;
    }
    e.preventDefault();
  }

  step(dt: number): void {
    const b = this.broker;
    const has = (...keys: string[]) => keys.some((k) => this.down.has(k));
    const approach = (current: number, target: number, rate: number) =>
      current < target ? Math.min(target, current + rate * dt) : Math.max(target, current - rate * dt);

    const gas = has('w', 'arrowup');
    const brake = has('s', 'arrowdown');
    if (gas || brake || this.pedalsActive) {
      const accel = b.get('Vehicle.Chassis.Accelerator.PedalPosition').value as number;
      const brk = b.get('Vehicle.Chassis.Brake.PedalPosition').value as number;
      b.publishValue('Vehicle.Chassis.Accelerator.PedalPosition', approach(accel, gas ? 100 : 0, PEDAL_RATE), SRC);
      b.publishValue('Vehicle.Chassis.Brake.PedalPosition', approach(brk, brake ? 100 : 0, PEDAL_RATE * 2), SRC);
      // Keep driving the pedals until they are fully released, then hand control back to the panel.
      this.pedalsActive = gas || brake || accel > 0 || brk > 0;
    }

    const left = has('a', 'arrowleft');
    const right = has('d', 'arrowright');
    if (left || right || this.steeringActive) {
      const angle = b.get('Vehicle.Chassis.SteeringWheel.Angle').value as number;
      const target = left === right ? 0 : left ? 90 : -90;
      const next = approach(angle, target, STEER_RATE);
      b.publishValue('Vehicle.Chassis.SteeringWheel.Angle', next, SRC);
      this.steeringActive = left || right || next !== 0;
    }
  }
}
