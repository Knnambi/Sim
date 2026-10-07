import type { AppRuntime } from '../apps/vehicleApp';
import type { ChangeEvent, VehicleDataBroker } from '../vss/databroker';
import { AiError, MODEL, explainTrace, generateApp, generateScenario, getApiKey, setApiKey, type GeneratedApp, type Scenario } from '../ai/claude';
import { checkApp, toVehicleApp } from '../ai/appCompiler';
import { checkScenario, runScenario, type StepResult } from '../ai/scenarioRunner';
import { el } from './dom';

const MAX_EVENTS = 20000;


/** Runs an async action behind a button: disables it, shows progress and errors. */
function busy(button: HTMLButtonElement, status: HTMLElement, label: string, action: () => Promise<void>) {
  button.addEventListener('click', async () => {
    const text = button.textContent;
    button.disabled = true;
    button.textContent = label;
    status.textContent = '';
    status.className = 'ai-status';
    try {
      await action();
    } catch (err) {
      status.textContent = err instanceof AiError ? err.message : `Error: ${(err as Error).message}`;
      status.className = 'ai-status error';
    } finally {
      button.disabled = false;
      button.textContent = text;
    }
  });
}

function section(title: string, hint: string, ...children: Node[]): HTMLElement {
  return el('section', { className: 'ai-section' }, el('h3', { textContent: title }), el('p', { className: 'hint', textContent: hint }), ...children);
}

function keySection(): HTMLElement {
  const input = el('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', value: getApiKey() });
  input.setAttribute('aria-label', 'Anthropic API key');
  const save = el('button', { type: 'button', textContent: 'Save' });
  const forget = el('button', { type: 'button', className: 'link-button', textContent: 'Forget' });
  const state = el('span', { className: 'ai-status' });
  const show = () => (state.textContent = getApiKey() || input.value ? 'Key set for this browser.' : 'No key yet.');
  save.addEventListener('click', () => {
    setApiKey(input.value.trim());
    show();
  });
  forget.addEventListener('click', () => {
    input.value = '';
    setApiKey('');
    show();
  });
  show();
  return section(
    'Claude API key',
    `Requests go directly from this browser to api.anthropic.com (model ${MODEL}). The key is stored only in this browser's local storage — use a key you can revoke.`,
    el('div', { className: 'ai-row' }, input, save, forget),
    state,
  );
}

function appStudio(runtime: AppRuntime): HTMLElement {
  const prompt = el('textarea', { rows: 3, placeholder: 'e.g. Flash the hazard lights for 3 seconds whenever a door is opened while the car is moving faster than 3 km/h' });
  prompt.setAttribute('aria-label', 'Describe the vehicle app');
  const generate = el('button', { type: 'button', className: 'primary', textContent: 'Generate app' });
  const status = el('div', { className: 'ai-status' });
  const result = el('div');

  const show = (app: GeneratedApp) => {
    const check = checkApp(app);
    const run = el('button', { type: 'button', className: 'primary', textContent: 'Run app', disabled: !check.ok });
    const discard = el('button', { type: 'button', className: 'link-button', textContent: 'Discard' });
    run.addEventListener('click', () => {
      runtime.add(toVehicleApp(app, (msg) => {
        status.textContent = `Runtime error in ${msg}`;
        status.className = 'ai-status error';
      }));
      status.textContent = `"${app.name}" is running — see the Apps tab to stop or remove it.`;
      status.className = 'ai-status ok';
      result.replaceChildren();
    });
    discard.addEventListener('click', () => result.replaceChildren());
    result.replaceChildren(el('div', { className: 'ai-card' },
      el('strong', { textContent: app.name }),
      el('p', { textContent: app.description }),
      app.notes ? el('p', { className: 'hint', textContent: app.notes }) : '',
      el('pre', { className: 'ai-code', textContent: `function start(b, self) {\n${app.code}\n}` }),
      el('p', { className: 'hint', textContent: `Signals: ${app.signals.join(', ')}` }),
      check.ok
        ? el('p', { className: 'ai-status ok', textContent: '✓ Checks passed: known signals only, actuators only, no network/DOM access.' })
        : el('ul', { className: 'ai-problems' }, ...check.problems.map((p) => el('li', { textContent: p }))),
      el('div', { className: 'ai-row' }, run, discard),
    ));
  };

  busy(generate, status, 'Claude is writing the app…', async () => {
    if (!prompt.value.trim()) throw new AiError('Describe the feature first.');
    show(await generateApp(prompt.value.trim()));
  });
  return section('App Studio', 'Describe a feature in plain English; Claude writes a vehicle app against the VSS signals. Review the code, then run it.',
    prompt, el('div', { className: 'ai-row' }, generate), status, result);
}

function scenarioLab(broker: VehicleDataBroker, runtime: AppRuntime): HTMLElement {
  const prompt = el('textarea', { rows: 3, placeholder: 'e.g. Open all windows while parked, then let it rain heavily and check the windows close and the wipers start' });
  prompt.setAttribute('aria-label', 'Describe the test scenario');
  const generate = el('button', { type: 'button', className: 'primary', textContent: 'Generate scenario' });
  const status = el('div', { className: 'ai-status' });
  const result = el('div');
  let abort: AbortController | null = null;

  const show = (scenario: Scenario) => {
    const problems = checkScenario(scenario);
    const rows = scenario.steps.map((s) => {
      const state = el('td', { className: 'step-state', textContent: '·' });
      const verb = s.action === 'expect' ? `expect ${s.comparison === 'eq' ? '=' : s.comparison === 'gte' ? '≥' : '≤'}` : s.action;
      return {
        row: el('tr', {},
          el('td', { textContent: `${s.at}s` }),
          el('td', { textContent: verb }),
          el('td', { textContent: `${s.path.replace(/^Vehicle\./, '')} ${String(s.value)}${s.action === 'expect' ? ` (≤${s.within}s)` : ''}`, title: `${s.path} — ${s.note}` }),
          state,
        ),
        state,
      };
    });
    const run = el('button', { type: 'button', className: 'primary', textContent: 'Run scenario', disabled: problems.length > 0 });
    const stop = el('button', { type: 'button', className: 'link-button', textContent: 'Stop' });
    const summary = el('p', { className: 'ai-status' });
    stop.addEventListener('click', () => abort?.abort());
    run.addEventListener('click', async () => {
      abort = new AbortController();
      run.disabled = true;
      summary.textContent = 'Running…';
      summary.className = 'ai-status';
      rows.forEach((r) => (r.state.textContent = '·', r.state.className = 'step-state'));
      const icons: Record<StepResult['status'], string> = { pending: '·', running: '…', passed: '✓', failed: '✗', done: '✓', error: '!' };
      const { passed, failed } = await runScenario(broker, scenario, (i, res) => {
        rows[i].state.textContent = `${icons[res.status]}${res.detail ? ` ${res.detail}` : ''}`;
        rows[i].state.className = `step-state ${res.status}`;
      }, abort.signal);
      summary.textContent = abort.signal.aborted ? 'Stopped.' : `${passed} passed, ${failed} failed.`;
      summary.className = `ai-status ${failed ? 'error' : 'ok'}`;
      run.disabled = false;
    });
    result.replaceChildren(el('div', { className: 'ai-card' },
      el('strong', { textContent: scenario.title }),
      el('p', { textContent: scenario.summary }),
      el('table', { className: 'trace scenario' },
        el('thead', {}, el('tr', {}, ...['t', 'Action', 'Signal / value', 'Result'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...rows.map((r) => r.row)),
      ),
      problems.length ? el('ul', { className: 'ai-problems' }, ...problems.map((p) => el('li', { textContent: p }))) : '',
      el('div', { className: 'ai-row' }, run, stop),
      summary,
    ));
  };

  busy(generate, status, 'Claude is writing the scenario…', async () => {
    if (!prompt.value.trim()) throw new AiError('Describe the scenario first.');
    const active = runtime.apps.filter((a) => runtime.isRunning(a.id)).map((a) => a.name);
    show(await generateScenario(prompt.value.trim(), active));
  });
  return section('Scenario Lab', 'Describe what to test; Claude writes a timed scenario (stimuli + expectations), which runs against the live vehicle and reports pass/fail.',
    prompt, el('div', { className: 'ai-row' }, generate), status, result);
}

function traceExplain(broker: VehicleDataBroker, runtime: AppRuntime): HTMLElement {
  const events: ChangeEvent[] = [];
  broker.onAnyChange((e) => {
    events.push(e);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS / 2);
  });
  const question = el('input', { type: 'text', placeholder: 'e.g. Why did the hazard lights turn on?' });
  question.setAttribute('aria-label', 'Question about the trace');
  const ask = el('button', { type: 'button', className: 'primary', textContent: 'Explain' });
  const status = el('div', { className: 'ai-status' });
  const answer = el('div', { className: 'ai-answer' });
  busy(ask, status, 'Claude is reading the trace…', async () => {
    if (!events.length) throw new AiError('The trace is empty — do something with the car first.');
    const active = runtime.apps.filter((a) => runtime.isRunning(a.id)).map((a) => a.name);
    answer.textContent = await explainTrace(question.value.trim() || 'What happened, and why?', events, active);
  });
  return section('Explain the trace', 'Ask about what just happened. Claude reads the recorded signal trace (who changed what, when) and explains the cause–effect chain.',
    el('div', { className: 'ai-row' }, question, ask), status, answer);
}

export function buildAiTab(broker: VehicleDataBroker, runtime: AppRuntime): HTMLElement {
  return el('div', { className: 'tab-body ai-tab' },
    keySection(),
    appStudio(runtime),
    scenarioLab(broker, runtime),
    traceExplain(broker, runtime),
  );
}
