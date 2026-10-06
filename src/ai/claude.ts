import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { SIGNALS } from '../vss/signals';
import type { ChangeEvent } from '../vss/databroker';

export const MODEL = 'claude-opus-5-5';
const KEY_STORAGE = 'sdv-sim.anthropic-key';
// Server-side refusal fallback: a declined request is retried on Anthropic's recommended model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// --- API key (bring your own; kept only in this browser) -------------------------------

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable: the key lives for this page only */
  }
  sessionKey = key;
}

let sessionKey = '';

function client(): Anthropic {
  const apiKey = sessionKey || getApiKey();
  if (!apiKey) throw new AiError('Add your Anthropic API key first (AI tab → API key).');
  // The page is static (GitHub Pages), so requests go straight from the browser with the
  // user's own key. Don't publish a page with a key baked in.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

export class AiError extends Error {}

function describeError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError('The API key was rejected (401).');
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('This API key has no access to the model (403).');
  if (err instanceof Anthropic.RateLimitError) return new AiError('Rate limited by the API (429). Try again in a moment.');
  if (err instanceof Anthropic.BadRequestError) return new AiError(`Request rejected: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AiError('Could not reach api.anthropic.com.');
  if (err instanceof Anthropic.APIError) return new AiError(`API error ${err.status}: ${err.message}`);
  return new AiError(String(err));
}

function checkStop(message: Anthropic.Beta.BetaMessage): void {
  if (message.stop_reason === 'refusal') {
    throw new AiError(`Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`);
  }
  if (message.stop_reason === 'max_tokens') throw new AiError('The answer was cut off (max_tokens). Try a smaller request.');
}

// --- Shared context: the vehicle API Claude writes against ------------------------------

function catalog(): string {
  return SIGNALS.map((s) => {
    const range = s.type === 'boolean' ? '' : s.type === 'string' ? ` one of ${s.allowed.join('|')}` : ` ${s.min}..${s.max}${s.unit ? ` ${s.unit}` : ''}`;
    return `- ${s.path} (${s.kind}, ${s.type}${range}): ${s.description}`;
  }).join('\n');
}

const SYSTEM = `You work inside a software-defined-vehicle simulator. Vehicle state is exposed as
COVESA VSS signals through a data broker (modelled on Eclipse Kuksa). These are ALL the signals
that exist; never use any other path:

${catalog()}

Broker API available to vehicle apps as \`b\`:
- b.get(path).value -> current value (boolean | number | string)
- b.subscribe(paths: string[], cb: (e) => void) -> unsubscribe function. cb is called once
  immediately with the current value of each path, then on every change.
  e = { path, value, previous, source, timestamp }
- b.actuate(path, value, source) -> request an actuator (only kind "actuator"); the owning ECU
  may apply rules (e.g. doors stay closed above 5 km/h) and publishes the result.
- b.publishValue(path, value, source) -> set a sensor value (use only for sensors).

Vehicle facts: Speed is km/h. Window.Position 0 = closed, 100 = open; windows move 20 %/s.
Brake lights follow the brake pedal (> 5 %). Indicators are mutually exclusive.`;

const APP_RULES = `Write the body of a JavaScript function \`start(b, self)\` for a vehicle app:
- \`self\` is the app name string; pass it as the source of every actuate call.
- Use only b.get / b.subscribe / b.actuate (no publishValue on actuators), plain JS (ES2020),
  no imports, no DOM, no network, no timers longer than needed (setTimeout/setInterval are
  allowed but must be cleared in the returned function).
- React to changes (subscribe), avoid actuating on every event: only when the state should change.
- Return a single function that stops the app (unsubscribe everything, clear timers).
- Keep it short and readable; comment the intent in one or two lines.`;

// --- 1. Natural language -> vehicle app ------------------------------------------------

const GeneratedApp = z.object({
  name: z.string().describe('Short app name, 2-4 words'),
  description: z.string().describe('One sentence: what the app does'),
  code: z.string().describe('Body of start(b, self); must end with a return statement returning the stop function'),
  signals: z.array(z.string()).describe('Every VSS path the code reads or actuates'),
  notes: z.string().describe('Assumptions or limitations, one or two sentences; empty if none'),
});
export type GeneratedApp = z.infer<typeof GeneratedApp>;

export async function generateApp(request: string): Promise<GeneratedApp> {
  try {
    const message = await client().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: [{ type: 'text', text: `${SYSTEM}\n\n${APP_RULES}`, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: betaZodOutputFormat(GeneratedApp) },
      messages: [{ role: 'user', content: `Feature request:\n${request}` }],
    });
    checkStop(message);
    if (!message.parsed_output) throw new AiError('Claude did not return an app.');
    return message.parsed_output;
  } catch (err) {
    throw describeError(err);
  }
}

// --- 2. Natural language -> test scenario ---------------------------------------------

const ScenarioStep = z.object({
  at: z.number().describe('Seconds after scenario start'),
  action: z.enum(['publish', 'actuate', 'expect']).describe('publish = set a sensor, actuate = request an actuator, expect = check a value'),
  path: z.string(),
  value: z.union([z.boolean(), z.number(), z.string()]),
  comparison: z.enum(['eq', 'gte', 'lte']).describe('For expect steps; use eq for publish/actuate'),
  within: z.number().describe('For expect: seconds the value may take to be reached; 0 for other steps'),
  note: z.string().describe('Why this step exists, a few words'),
});
const Scenario = z.object({
  title: z.string(),
  summary: z.string().describe('One sentence on what is being tested'),
  steps: z.array(ScenarioStep),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioStep = z.infer<typeof ScenarioStep>;

const SCENARIO_RULES = `Write a test scenario as a timeline of steps that drives the simulated vehicle and checks
its reaction. Drive it with sensors (pedals, steering, light intensity, rain) via publish, and
actuators via actuate. To drive at a speed, publish Accelerator.PedalPosition and expect Speed
with gte; the car reaches ~50 km/h after ~4 s at 100 %. Put an expect after each behaviour you
want to verify, with a realistic "within" (e.g. 6 s for a window to close fully). Finish by
returning the car to rest (pedals 0, brake briefly). Keep it under 25 steps.`;

export async function generateScenario(request: string, activeApps: string[]): Promise<Scenario> {
  try {
    const message = await client().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: [{ type: 'text', text: `${SYSTEM}\n\n${SCENARIO_RULES}`, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: betaZodOutputFormat(Scenario) },
      messages: [{
        role: 'user',
        content: `Apps currently running: ${activeApps.join(', ') || 'none'}.\nScenario to test:\n${request}`,
      }],
    });
    checkStop(message);
    if (!message.parsed_output) throw new AiError('Claude did not return a scenario.');
    return message.parsed_output;
  } catch (err) {
    throw describeError(err);
  }
}

// --- 3. Explain a signal trace ---------------------------------------------------------

export async function explainTrace(question: string, events: readonly ChangeEvent[], activeApps: string[]): Promise<string> {
  // Discrete events in full; high-rate signals only every ~0.5 s, so long traces stay small.
  const continuous = /Speed$|PedalPosition$|SteeringWheel\.Angle$|TraveledDistance$/;
  const lastKept = new Map<string, number>();
  const lines: string[] = [];
  for (const e of events.slice(-3000)) {
    if (continuous.test(e.path)) {
      if (e.timestamp - (lastKept.get(e.path) ?? -Infinity) < 500) continue;
      lastKept.set(e.path, e.timestamp);
    }
    lines.push(`${(e.timestamp / 1000).toFixed(2)}s ${e.source}: ${e.path} = ${String(e.value)}`);
  }
  try {
    const message = await client().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: [{
        type: 'text',
        text: `${SYSTEM}\n\nYou explain signal traces from this simulator to automotive engineers. Each line is
"time source: path = value"; the source is who caused the change (driver input, an app, an ECU,
or Kuksa for changes from outside this page). Answer the question directly, cite the trace lines
(by time) that show it, and say plainly when the trace doesn't contain enough information.
Plain text, short paragraphs or a short list.`,
        cache_control: { type: 'ephemeral' },
      }],
      output_config: { effort: 'medium' },
      messages: [{
        role: 'user',
        content: `Apps running: ${activeApps.join(', ') || 'none'}\n\nTrace (${lines.length} lines, oldest first):\n${lines.join('\n')}\n\nQuestion: ${question}`,
      }],
    });
    checkStop(message);
    return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
  } catch (err) {
    throw describeError(err);
  }
}
