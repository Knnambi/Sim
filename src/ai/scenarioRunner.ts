import type { VehicleDataBroker } from '../vss/databroker';
import { SIGNAL_BY_PATH } from '../vss/signals';
import type { Scenario, ScenarioStep } from './claude';

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'done' | 'error';

export interface StepResult {
  status: StepStatus;
  detail?: string;
}

const SOURCE = 'Scenario';
const POLL_MS = 50;

/** Checks a generated scenario against the signal catalog before it may run. */
export function checkScenario(s: Scenario): string[] {
  const problems: string[] = [];
  s.steps.forEach((step, i) => {
    const def = SIGNAL_BY_PATH.get(step.path);
    const n = `Step ${i + 1}`;
    if (!def) return problems.push(`${n}: unknown signal ${step.path}.`);
    if (step.action === 'actuate' && def.kind !== 'actuator') problems.push(`${n}: ${step.path} is not an actuator.`);
    if (step.action === 'publish' && def.kind === 'actuator') problems.push(`${n}: ${step.path} is an actuator; use actuate.`);
    if (step.at < 0 || step.at > 600) problems.push(`${n}: time ${step.at}s out of range.`);
  });
  return problems;
}

function compare(actual: unknown, step: ScenarioStep): boolean {
  if (step.comparison === 'gte') return typeof actual === 'number' && actual >= Number(step.value);
  if (step.comparison === 'lte') return typeof actual === 'number' && actual <= Number(step.value);
  return actual === step.value || String(actual) === String(step.value);
}

/** Runs the steps on their timeline; expect steps poll until met or `within` runs out. */
export async function runScenario(
  broker: VehicleDataBroker,
  scenario: Scenario,
  onStep: (index: number, result: StepResult) => void,
  signal: AbortSignal,
): Promise<{ passed: number; failed: number }> {
  const t0 = performance.now();
  const order = scenario.steps.map((s, i) => [s, i] as const).sort((a, b) => a[0].at - b[0].at);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const expectations: Promise<void>[] = [];
  let passed = 0;
  let failed = 0;

  for (const [step, i] of order) {
    const wait = t0 + step.at * 1000 - performance.now();
    if (wait > 0) await sleep(wait);
    if (signal.aborted) break;
    onStep(i, { status: 'running' });
    try {
      if (step.action === 'publish') {
        broker.publishValue(step.path, step.value, SOURCE);
        onStep(i, { status: 'done' });
      } else if (step.action === 'actuate') {
        broker.actuate(step.path, step.value, SOURCE);
        onStep(i, { status: 'done' });
      } else {
        // Expectations run concurrently so a slow check doesn't delay later stimuli.
        expectations.push((async () => {
          const deadline = performance.now() + Math.max(step.within, 0) * 1000;
          for (;;) {
            const actual = broker.get(step.path).value;
            if (compare(actual, step)) {
              passed++;
              return onStep(i, { status: 'passed', detail: `= ${String(actual)}` });
            }
            if (performance.now() >= deadline || signal.aborted) {
              failed++;
              return onStep(i, { status: 'failed', detail: `got ${String(actual)}` });
            }
            await sleep(POLL_MS);
          }
        })());
      }
    } catch (err) {
      failed++;
      onStep(i, { status: 'error', detail: (err as Error).message });
    }
  }
  await Promise.all(expectations);
  return { passed, failed };
}
