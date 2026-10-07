import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Kenney CC0 models (public/models/kenney/*, see License.txt there), loaded once and cloned.
 * Kenney units are ~1 per "tile"; the scale factors below turn them into metres.
 */

const BASE = `${import.meta.env.BASE_URL}models/kenney/`;

export const CAR_MODELS = ['sedan', 'sedan-sports', 'hatchback-sports', 'suv', 'suv-luxury', 'taxi', 'police', 'van', 'delivery', 'truck', 'ambulance'];
export const COMMERCIAL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'].map((k) => `building-${k}`);
export const SKYSCRAPERS = ['a', 'b', 'c', 'd', 'e'].map((k) => `building-skyscraper-${k}`);
export const HOUSES = 'abcdefghijklmnop'.split('').map((k) => `building-type-${k}`);

export const SCALE = { car: 1.75, commercial: 14, suburban: 9, tree: 9, road: 10 };

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

function load(kit: string, name: string): Promise<THREE.Group> {
  const key = `${kit}/${name}`;
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(`${BASE}${kit}/${name}.glb`).then((gltf) => {
      gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return gltf.scene;
    });
    cache.set(key, p);
  }
  return p;
}

/** Loads all models up front; resolves to a synchronous clone factory. */
export async function loadAssets(): Promise<(kit: string, name: string, scale: number) => THREE.Group> {
  const all: [string, string][] = [
    ...CAR_MODELS.map((n) => ['cars', n] as [string, string]),
    ...COMMERCIAL.map((n) => ['commercial', n] as [string, string]),
    ...SKYSCRAPERS.map((n) => ['commercial', n] as [string, string]),
    ...HOUSES.map((n) => ['suburban', n] as [string, string]),
    ['suburban', 'tree-large'], ['suburban', 'tree-small'], ['suburban', 'planter'],
    ['roads', 'light-curved'], ['roads', 'dumpster'], ['roads', 'construction-cone'],
  ];
  const loaded = new Map<string, THREE.Group>();
  await Promise.all(all.map(async ([kit, name]) => loaded.set(`${kit}/${name}`, await load(kit, name))));
  return (kit, name, scale) => {
    const src = loaded.get(`${kit}/${name}`);
    if (!src) throw new Error(`Model ${kit}/${name} not loaded`);
    const obj = src.clone(true);
    obj.scale.setScalar(scale);
    return obj;
  };
}
