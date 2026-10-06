import type { VehicleApp } from '../apps/vehicleApp';
import type { VehicleDataBroker } from '../vss/databroker';
import { SIGNAL_BY_PATH } from '../vss/signals';
import type { GeneratedApp } from './claude';

/**
 * Turns Claude-generated app code into a VehicleApp, after static checks.
 *
 * Generated code runs in this page, so it is checked before the user can run it:
 *  - every VSS path literal must exist; actuate() only on actuators
 *  - no access to network, storage, DOM, globals or dynamic code
 * At runtime the app only gets a narrowed broker (get / subscribe / actuate), and exceptions
 * in its callbacks are caught and reported instead of breaking the broker.
 */

const FORBIDDEN = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|import|eval|Function|constructor|prototype|__proto__|localStorage|sessionStorage|indexedDB|document|window|globalThis|self\s*\.|navigator|location|postMessage|Worker|sdv)\b/;

/**
 * Removes comments and the text of string/template literals (keeping `${...}` expressions),
 * so the identifier check below only sees code. "Close the window" in a comment is fine;
 * `window.open()` is not.
 */
export function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  const templateDepth: number[] = []; // brace depth at which each open template expression resumes
  let braces = 0;
  const inTemplateText = () => templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === -1;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inTemplateText()) {
      if (c === '\\') i += 2;
      else if (c === '`') { templateDepth.pop(); out += '``'; i++; }
      else if (c === '$' && next === '{') { templateDepth[templateDepth.length - 1] = braces; braces++; out += '${'; i += 2; }
      else i++;
      continue;
    }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      out += `${c}${c}`;
      i++;
      continue;
    }
    if (c === '`') { templateDepth.push(-1); i++; continue; }
    if (c === '{') braces++;
    if (c === '}') {
      braces--;
      if (templateDepth.length && templateDepth[templateDepth.length - 1] === braces) {
        templateDepth[templateDepth.length - 1] = -1; // back to template text
        out += '}';
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

export function checkApp(app: GeneratedApp): CheckResult {
  const problems: string[] = [];
  const forbidden = codeOnly(app.code).match(FORBIDDEN);
  if (forbidden) problems.push(`Uses "${forbidden[1]}", which vehicle apps may not access.`);

  for (const [, path] of app.code.matchAll(/['"`](Vehicle\.[A-Za-z0-9_.]+)['"`]/g)) {
    if (!SIGNAL_BY_PATH.has(path)) problems.push(`Unknown signal ${path}.`);
  }
  for (const [, path] of app.code.matchAll(/\.actuate\(\s*['"`](Vehicle\.[A-Za-z0-9_.]+)['"`]/g)) {
    const def = SIGNAL_BY_PATH.get(path);
    if (def && def.kind !== 'actuator') problems.push(`${path} is a ${def.kind}; apps can only actuate actuators.`);
  }
  if (/\.publishValue\s*\(/.test(codeOnly(app.code))) problems.push('Apps may not call publishValue; use actuate on actuators.');
  if (!/\breturn\b/.test(codeOnly(app.code))) problems.push('The code must return a stop function.');

  try {
    // Syntax check only; nothing runs here.
    new Function('b', 'self', app.code);
  } catch (err) {
    problems.push(`Syntax error: ${(err as Error).message}`);
  }
  return { ok: problems.length === 0, problems };
}

export function toVehicleApp(app: GeneratedApp, onError: (msg: string) => void): VehicleApp {
  const start = new Function('b', 'self', app.code) as (b: unknown, self: string) => unknown;
  const id = `ai-${app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
  const report = (where: string, err: unknown) => onError(`${app.name} (${where}): ${(err as Error)?.message ?? err}`);

  return {
    id,
    name: app.name,
    description: `✦ ${app.description}`,
    start(broker: VehicleDataBroker) {
      const narrowed = Object.freeze({
        get: (path: string) => broker.get(path),
        subscribe: (paths: string[], cb: (e: unknown) => void) =>
          broker.subscribe(paths, (e) => {
            try {
              cb(e);
            } catch (err) {
              report('callback', err);
            }
          }),
        actuate: (path: string, value: boolean | number | string, source?: string) => {
          try {
            broker.actuate(path, value, source ?? app.name);
          } catch (err) {
            report('actuate', err);
          }
        },
      });
      let stop: unknown;
      try {
        stop = start(narrowed, app.name);
      } catch (err) {
        report('start', err);
      }
      return () => {
        try {
          if (typeof stop === 'function') stop();
        } catch (err) {
          report('stop', err);
        }
      };
    },
  };
}
