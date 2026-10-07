import type { VehicleDataBroker } from '../vss/databroker';
import { SIGNAL_BY_PATH, type SignalValue } from '../vss/signals';

/**
 * Attribute-style Vehicle APIs (OEM-specific APIs, or national ones such as K-SDV) described
 * declaratively in JSON and mapped onto VSS. A profile lists attributes; each attribute is backed
 * by one VSS signal, optionally with a value map (API value <-> VSS value) or a scale factor.
 *
 *   {
 *     "id": "acme-1.0", "name": "ACME Vehicle API", "version": "1.0",
 *     "attributes": [
 *       { "id": "body.door.frontLeft.state", "name": "Front left door", "access": "readwrite",
 *         "vss": "Vehicle.Cabin.Door.Row1.DriverSide.IsOpen",
 *         "valueMap": { "OPEN": true, "CLOSED": false } }
 *     ]
 *   }
 */

export type ApiValue = boolean | number | string;

export interface AttributeDef {
  id: string;
  name: string;
  access: 'read' | 'readwrite';
  vss: string;
  unit?: string;
  /** API value -> VSS value. Values not listed are rejected (set) or reported as-is (get). */
  valueMap?: Record<string, SignalValue>;
  /** api = vss * scale (numeric attributes only). */
  scale?: number;
  description?: string;
}

export interface AttributeProfile {
  id: string;
  name: string;
  version: string;
  description?: string;
  attributes: AttributeDef[];
}

export type AttrResult = { ok: true; value: ApiValue } | { ok: false; error: string };

/** Checks a profile against the VSS catalog; returns problems (empty = valid). */
export function validateProfile(p: unknown): string[] {
  const problems: string[] = [];
  const prof = p as AttributeProfile;
  if (!prof || typeof prof !== 'object') return ['Profile must be a JSON object.'];
  for (const key of ['id', 'name', 'version'] as const) if (typeof prof[key] !== 'string') problems.push(`Missing "${key}".`);
  if (!Array.isArray(prof.attributes)) return [...problems, 'Missing "attributes" array.'];
  const seen = new Set<string>();
  prof.attributes.forEach((a, i) => {
    const where = `attributes[${i}]${a?.id ? ` (${a.id})` : ''}`;
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') return problems.push(`${where}: needs "id" and "name".`);
    if (seen.has(a.id)) problems.push(`${where}: duplicate id.`);
    seen.add(a.id);
    const def = SIGNAL_BY_PATH.get(a.vss);
    if (!def) return problems.push(`${where}: unknown VSS signal "${a.vss}".`);
    if (a.access !== 'read' && a.access !== 'readwrite') problems.push(`${where}: access must be "read" or "readwrite".`);
    if (a.access === 'readwrite' && def.kind !== 'actuator') problems.push(`${where}: ${a.vss} is a ${def.kind}; only actuators can be written.`);
    if (a.scale !== undefined && (typeof a.scale !== 'number' || def.type === 'boolean' || def.type === 'string')) problems.push(`${where}: "scale" needs a numeric signal.`);
  });
  return problems;
}

export class AttributeApi {
  private readonly byId: Map<string, AttributeDef>;

  constructor(private readonly broker: VehicleDataBroker, readonly profile: AttributeProfile) {
    const problems = validateProfile(profile);
    if (problems.length) throw new Error(`Invalid profile ${profile?.id}: ${problems.join(' ')}`);
    this.byId = new Map(profile.attributes.map((a) => [a.id, a]));
  }

  list(): readonly AttributeDef[] {
    return this.profile.attributes;
  }

  private toApi(a: AttributeDef, v: SignalValue): ApiValue {
    if (a.valueMap) {
      const hit = Object.entries(a.valueMap).find(([, vssValue]) => vssValue === v);
      if (hit) return hit[0];
    }
    if (a.scale !== undefined && typeof v === 'number') return Math.round(v * a.scale * 1000) / 1000;
    return v;
  }

  private toVss(a: AttributeDef, value: ApiValue): SignalValue | undefined {
    if (a.valueMap) return Object.prototype.hasOwnProperty.call(a.valueMap, String(value)) ? a.valueMap[String(value)] : undefined;
    if (a.scale !== undefined) return typeof value === 'number' ? value / a.scale : undefined;
    return value;
  }

  get(id: string): AttrResult {
    const a = this.byId.get(id);
    if (!a) return { ok: false, error: `Unknown attribute ${id}` };
    return { ok: true, value: this.toApi(a, this.broker.get(a.vss).value) };
  }

  set(id: string, value: ApiValue, source = this.profile.name): AttrResult {
    const a = this.byId.get(id);
    if (!a) return { ok: false, error: `Unknown attribute ${id}` };
    if (a.access !== 'readwrite') return { ok: false, error: `${id} is read-only` };
    const v = this.toVss(a, value);
    if (v === undefined) return { ok: false, error: `Invalid value ${JSON.stringify(value)} for ${id}${a.valueMap ? ` (allowed: ${Object.keys(a.valueMap).join(', ')})` : ''}` };
    try {
      this.broker.actuate(a.vss, v, source);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    return { ok: true, value };
  }

  subscribe(id: string, cb: (value: ApiValue) => void): () => void {
    const a = this.byId.get(id);
    if (!a) throw new Error(`Unknown attribute ${id}`);
    return this.broker.subscribe([a.vss], (e) => cb(this.toApi(a, e.value)));
  }
}
