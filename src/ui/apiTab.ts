import type { VehicleDataBroker } from '../vss/databroker';
import { AttributeApi, validateProfile, type AttributeProfile, type ApiValue } from '../vapi/attributeApi';
import type { ObjectName, OsdviApp, OsdviEvent, OsdviRuntime } from '../vapi/osdvi';
import { el } from './dom';

const EXPLORER_APP = 'api-explorer';
const OBJECTS: ObjectName[] = ['Window', 'Door', 'Trunk', 'Wiper'];
const MAX_LOG = 40;

/** Live explorer for the Open SDV API: pick an object and instance, call service calls, watch events. */
function osdviExplorer(rt: OsdviRuntime): { root: HTMLElement; tick: () => void } {
  const api: OsdviApp = rt.app(EXPLORER_APP);
  const objectSel = el('select', {}, ...OBJECTS.map((o) => el('option', { value: o, textContent: o })));
  const instanceSel = el('select');
  objectSel.setAttribute('aria-label', 'OSDVI object');
  instanceSel.setAttribute('aria-label', 'Instance');
  const target = el('input', { type: 'number', min: '0', max: '100', value: '100' });
  const interval = el('input', { type: 'number', min: '0', max: '30', value: '0' });
  const priority = el('input', { type: 'number', min: '1', max: '100', value: '50' });
  target.setAttribute('aria-label', 'Target position or frequency level');
  interval.setAttribute('aria-label', 'Interval level');
  priority.setAttribute('aria-label', 'Priority');
  const targetLabel = el('label', {}, 'targetPosition ', target);
  const intervalLabel = el('label', {}, 'intervalLevel ', interval);
  const status = el('pre', { className: 'ai-code api-status' });
  const result = el('div', { className: 'ai-status' });
  const log = el('ol', { className: 'api-log', reversed: true });

  const object = () => objectSel.value as ObjectName;
  const instance = () => Number(instanceSel.value);
  const obj = () => api[object()] as unknown as Record<string, (...args: unknown[]) => { returnValue: string }>;

  const fillInstances = () => {
    const configs = api[object()].getConfigAll().config ?? [];
    instanceSel.replaceChildren(...configs.map((c) => el('option', { value: String(c.instanceId), textContent: `${c.instanceId} · ${c.displayName}` })));
    const wiper = object() === 'Wiper';
    targetLabel.firstChild!.textContent = wiper ? 'frequencyLevel ' : 'targetPosition ';
    target.value = wiper ? '55' : '100';
    intervalLabel.hidden = !wiper;
  };
  objectSel.addEventListener('change', fillInstances);
  fillInstances();

  const call = (name: string, ...args: unknown[]) => {
    const r = obj()[name](...args);
    const shown = args.map((a) => JSON.stringify(a)).join(', ');
    result.textContent = `${object()}.${name}(${shown}) → ${r.returnValue}`;
    result.className = `ai-status ${r.returnValue === 'E_OK' ? 'ok' : 'error'}`;
  };
  const button = (label: string, onClick: () => void) => {
    const b = el('button', { type: 'button', textContent: label });
    b.addEventListener('click', onClick);
    return b;
  };
  const pr = () => Number(priority.value) || 50;
  const actions = el('div', { className: 'ai-row api-actions' },
    button('startMove', () => (object() === 'Wiper'
      ? call('startMove', instance(), Number(target.value), Number(interval.value) || null, pr())
      : call('startMove', instance(), Number(target.value), 'Standard', pr()))),
    button('stopMove', () => call('stopMove', instance(), pr())),
    button('lock', () => call('lock', instance(), pr())),
    button('unlock', () => call('unlock', instance())),
  );

  // The explorer subscribes to every object's events, like any OSDVI client would.
  const handles = OBJECTS.map((o) => [o, api[o].notify(null, null).notifyHandle!] as const);

  const root = el('section', { className: 'ai-section' },
    el('h3', { textContent: 'Open SDV API (OSDVI)' }),
    el('p', { className: 'hint', textContent: 'Logical API of the Open SDV Initiative (spec 202603α), mapped onto the same VSS signals. Window/Door/Trunk/Wiper with startMove, stopMove, lock/unlock, getStatus and event queues. This explorer is OSDVI application "api-explorer".' }),
    el('div', { className: 'ai-row' }, objectSel, instanceSel),
    el('div', { className: 'ai-row api-params' }, targetLabel, intervalLabel, el('label', {}, 'priority ', priority)),
    actions, result,
    el('h4', { textContent: 'getStatus' }), status,
    el('h4', { textContent: 'Events (notify / getEvent)' }), log,
  );

  const fmt = (o: ObjectName, e: OsdviEvent) =>
    `${(e.timestampMs / 1000).toFixed(1)}s ${o}#${e.instanceId} ${e.eventInfo.kind}${e.eventInfo.sourceApplication ? ` by ${e.eventInfo.sourceApplication}` : ''}`;
  const tick = () => {
    for (const [o, h] of handles) {
      for (;;) {
        const r = api[o].getEvent(h);
        if (r.returnValue !== 'E_OK' || !r.event) break;
        log.prepend(el('li', { textContent: fmt(o, r.event) }));
        while (log.childElementCount > MAX_LOG) log.lastElementChild!.remove();
      }
    }
    if (root.isConnected) status.textContent = JSON.stringify(api[object()].getStatus(instance()).status ?? {}, null, 1);
  };
  return { root, tick };
}

/** Table view of an attribute-style API profile, with live values and setters. */
function attributeView(broker: VehicleDataBroker, profile: AttributeProfile): HTMLElement {
  const api = new AttributeApi(broker, profile);
  const message = el('div', { className: 'ai-status' });
  const rows = api.list().map((a) => {
    const value = el('td', { className: 'api-value' });
    api.subscribe(a.id, (v) => (value.textContent = `${String(v)}${a.unit ? ` ${a.unit}` : ''}`));
    let control: Node = el('span', { className: 'hint', textContent: 'read' });
    if (a.access === 'readwrite') {
      const input: HTMLInputElement | HTMLSelectElement = a.valueMap
        ? el('select', {}, ...Object.keys(a.valueMap).map((k) => el('option', { value: k, textContent: k })))
        : el('input', { type: 'number', value: '0' });
      input.setAttribute('aria-label', `New value for ${a.id}`);
      const set = el('button', { type: 'button', textContent: 'Set' });
      set.addEventListener('click', () => {
        const v: ApiValue = a.valueMap ? input.value : Number(input.value);
        const r = api.set(a.id, v);
        message.textContent = r.ok ? `set ${a.id} = ${String(v)}` : r.error;
        message.className = `ai-status ${r.ok ? 'ok' : 'error'}`;
      });
      control = el('span', { className: 'api-set' }, input, set);
    }
    return el('tr', {}, el('td', { textContent: a.id, title: `${a.name}\n→ ${a.vss}` }), value, el('td', {}, control));
  });
  return el('section', { className: 'ai-section' },
    el('h3', { textContent: `${profile.name} ${profile.version}` }),
    profile.description ? el('p', { className: 'hint', textContent: profile.description }) : '',
    el('table', { className: 'trace api-table' },
      el('thead', {}, el('tr', {}, ...['Attribute', 'Value', 'Set'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...rows)),
    message,
  );
}

export function buildApiTab(broker: VehicleDataBroker, osdvi: OsdviRuntime, profiles: AttributeProfile[]): HTMLElement {
  const explorer = osdviExplorer(osdvi);
  const choice = el('select');
  choice.setAttribute('aria-label', 'Vehicle API');
  const body = el('div');
  const views = new Map<string, HTMLElement>([['osdvi', explorer.root]]);
  const addOption = (id: string, label: string) => choice.append(el('option', { value: id, textContent: label }));
  addOption('osdvi', 'Open SDV API (Japan, OSDVI)');
  for (const p of profiles) {
    views.set(p.id, attributeView(broker, p));
    addOption(p.id, p.name);
  }
  const show = () => body.replaceChildren(views.get(choice.value)!);
  choice.addEventListener('change', show);

  // Load an OEM / national attribute profile from a JSON file (stays in this browser).
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  file.setAttribute('aria-label', 'Load API profile JSON');
  const loadStatus = el('div', { className: 'ai-status' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const profile = JSON.parse(await f.text());
      const problems = validateProfile(profile);
      if (problems.length) throw new Error(problems.slice(0, 5).join(' '));
      if (views.has(profile.id)) throw new Error(`A profile with id "${profile.id}" is already loaded.`);
      views.set(profile.id, attributeView(broker, profile));
      addOption(profile.id, `${profile.name} (loaded)`);
      choice.value = profile.id;
      show();
      loadStatus.textContent = `Loaded ${profile.attributes.length} attributes from ${f.name}.`;
      loadStatus.className = 'ai-status ok';
    } catch (err) {
      loadStatus.textContent = `Could not load ${f.name}: ${(err as Error).message}`;
      loadStatus.className = 'ai-status error';
    } finally {
      file.value = '';
    }
  });

  setInterval(explorer.tick, 200);
  show();
  return el('div', { className: 'tab-body api-tab' },
    el('p', { className: 'hint', textContent: 'The same vehicle behind different Vehicle API standards. Every API maps onto the VSS signals, so it works in every mode (in-browser, Kuksa, CAN and SOME/IP ECUs).' }),
    el('div', { className: 'ai-row' }, choice),
    body,
    el('section', { className: 'ai-section' },
      el('h3', { textContent: 'Add an API profile' }),
      el('p', { className: 'hint', textContent: 'Attribute-style APIs (OEM-specific, K-SDV, …) are described in JSON: each attribute maps to a VSS signal with an optional value map. See src/vapi/profiles/acme-example.json for the format.' }),
      file, loadStatus),
  );
}
