/**
 * The /api/show capability probe for direct-Ollama sessions, and a way to wait for it.
 *
 * What Ollama reports about a model (declared context length, parameter tier, whether its
 * template takes tools) is what gives a model outside the built-in table a usable window
 * and the native tool channel. The REPL used to fire this probe and forget it, so a first
 * prompt sent before it landed ran on the unknown-model fallback, and one-shot mode
 * (`bandit -p …`) never ran it at all. Each turn now waits for the probe of the model it
 * is about to use. The wait is bounded by the probe's own 5 s timeout, costs nothing once
 * the probe has answered, and never throws: a failed probe leaves the fallback in place.
 */
import { queryOllamaModelCapabilities, registerModelCapabilities } from '@burtson-labs/stealth-core-runtime';

const probes = new Map<string, Promise<void>>();

const probeKey = (modelId: string, baseUrl: string): string => `${baseUrl.replace(/\/$/, '')}\n${modelId.toLowerCase()}`;

/** Start (or reuse) the probe for this model on this server. Safe to call without awaiting. */
export function probeOllamaModel(modelId: string, baseUrl: string): Promise<void> {
  if (!modelId) {return Promise.resolve();}
  const key = probeKey(modelId, baseUrl);
  let pending = probes.get(key);
  if (!pending) {
    pending = queryOllamaModelCapabilities(modelId, baseUrl)
      .then((caps) => {
        if (caps) {
          registerModelCapabilities(modelId, caps);
        } else {
          // Not reachable or not installed: let a later turn try again.
          probes.delete(key);
        }
      })
      .catch(() => { probes.delete(key); });
    probes.set(key, pending);
  }
  return pending;
}

/** Test hook: forget every probe. */
export function __resetOllamaProbesForTests(): void {
  probes.clear();
}
