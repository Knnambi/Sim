import type { VehicleApp } from './vehicleApp';

/** Switches the low beam on when it gets dark, and off again at daylight (with hysteresis). */
export const autoHeadlights: VehicleApp = {
  id: 'auto-headlights',
  name: 'Auto Headlights',
  description: 'Low beam on below 30% ambient light, off above 45%.',
  start(b) {
    const self = this.name;
    let switchedOnByUs = false;
    return b.subscribe(['Vehicle.Exterior.LightIntensity'], (e) => {
      const light = e.value as number;
      const lowOn = b.get('Vehicle.Body.Lights.Beam.Low.IsOn').value as boolean;
      if (light < 30 && !lowOn) {
        b.actuate('Vehicle.Body.Lights.Beam.Low.IsOn', true, self);
        switchedOnByUs = true;
      } else if (light > 45 && lowOn && switchedOnByUs) {
        b.actuate('Vehicle.Body.Lights.Beam.Low.IsOn', false, self);
        switchedOnByUs = false;
      }
    });
  },
};

/** High beam at speed in the dark; dips back below 50 km/h. */
export const autoHighBeam: VehicleApp = {
  id: 'auto-high-beam',
  name: 'Auto High Beam',
  description: 'High beam when dark (<20%) and faster than 60 km/h; off below 50 km/h.',
  start(b) {
    const self = this.name;
    return b.subscribe(['Vehicle.Speed', 'Vehicle.Exterior.LightIntensity'], () => {
      const speed = b.get('Vehicle.Speed').value as number;
      const dark = (b.get('Vehicle.Exterior.LightIntensity').value as number) < 20;
      const high = b.get('Vehicle.Body.Lights.Beam.High.IsOn').value as boolean;
      if (dark && speed > 60 && !high) b.actuate('Vehicle.Body.Lights.Beam.High.IsOn', true, self);
      else if ((!dark || speed < 50) && high) b.actuate('Vehicle.Body.Lights.Beam.High.IsOn', false, self);
    });
  },
};

/** Cancels the active indicator once the steering wheel returns after a turn. */
export const indicatorAutoCancel: VehicleApp = {
  id: 'indicator-auto-cancel',
  name: 'Indicator Auto-Cancel',
  description: 'Turns the indicator off when the wheel comes back to centre after a turn of more than 30°.',
  start(b) {
    const self = this.name;
    let turned = false;
    return b.subscribe(['Vehicle.Chassis.SteeringWheel.Angle'], (e) => {
      const angle = e.value as number;
      const left = b.get('Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling').value as boolean;
      const right = b.get('Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling').value as boolean;
      if ((left && angle > 30) || (right && angle < -30)) turned = true;
      if (turned && Math.abs(angle) < 5) {
        turned = false;
        if (left) b.actuate('Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling', false, self);
        if (right) b.actuate('Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling', false, self);
      }
    });
  },
};

/** Flashes the hazards on emergency braking from speed, and clears them on pulling away. */
export const emergencyBrakeHazard: VehicleApp = {
  id: 'emergency-brake-hazard',
  name: 'Emergency Brake Hazard',
  description: 'Hazards on when braking above 80% at more than 50 km/h; off once accelerating again.',
  start(b) {
    const self = this.name;
    let activatedByUs = false;
    return b.subscribe(['Vehicle.Chassis.Brake.PedalPosition', 'Vehicle.Chassis.Accelerator.PedalPosition'], () => {
      const brake = b.get('Vehicle.Chassis.Brake.PedalPosition').value as number;
      const throttle = b.get('Vehicle.Chassis.Accelerator.PedalPosition').value as number;
      const speed = b.get('Vehicle.Speed').value as number;
      if (brake > 80 && speed > 50 && !activatedByUs) {
        b.actuate('Vehicle.Body.Lights.Hazard.IsSignaling', true, self);
        activatedByUs = true;
      } else if (activatedByUs && throttle > 10) {
        b.actuate('Vehicle.Body.Lights.Hazard.IsSignaling', false, self);
        activatedByUs = false;
      }
    });
  },
};

/** Closes all open windows when it starts raining, and switches the wipers to the rain sensor. */
export const rainGuard: VehicleApp = {
  id: 'rain-guard',
  name: 'Rain Guard',
  description: 'When rain starts (> 20%): close open windows, wipers to RAIN_SENSOR if off.',
  start(b) {
    const self = this.name;
    const windows = ['Row1.DriverSide', 'Row1.PassengerSide', 'Row2.DriverSide', 'Row2.PassengerSide'].map(
      (pos) => `Vehicle.Cabin.Door.${pos}.Window.Position`,
    );
    let raining = false;
    return b.subscribe(['Vehicle.Body.Raindetection.Intensity'], (e) => {
      const nowRaining = (e.value as number) > 20;
      if (nowRaining && !raining) {
        // React to the start of rain only, so the driver can still open a window afterwards.
        for (const w of windows) if ((b.get(w).value as number) > 0) b.actuate(w, 0, self);
        if (b.get('Vehicle.Body.Windshield.Front.Wiping.Mode').value === 'OFF') {
          b.actuate('Vehicle.Body.Windshield.Front.Wiping.Mode', 'RAIN_SENSOR', self);
        }
      }
      raining = nowRaining;
    });
  },
};

export const SAMPLE_APPS: readonly VehicleApp[] = [autoHeadlights, autoHighBeam, indicatorAutoCancel, emergencyBrakeHazard, rainGuard];
