import type { HarnessAdapter } from "./types.js";
import { ompAdapter } from "./omp/adapter.js";
import { genericAdapter } from "./generic/adapter.js";

export { createResolver, adapterAcceptsKind, type AdapterResolver } from "./resolve.js";

/** A dedicated adapter wins for its kind; the generic adapter is the single `"any"` fallback (resolve.ts). */
export const harnesses: readonly HarnessAdapter[] = [ompAdapter, genericAdapter];

export const harnessById: Readonly<Record<string, HarnessAdapter>> = Object.fromEntries(
  harnesses.map((adapter) => [adapter.id, adapter]),
);

export function getHarness(id: string): HarnessAdapter | undefined {
  return harnessById[id];
}
