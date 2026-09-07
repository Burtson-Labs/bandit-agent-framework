import { existsSync } from 'node:fs';
import type { Page } from 'playwright';

export interface SceneStep {
  /** Short label used in logs + steps.json. */
  title?: string;
  /** One narration line — spoken via TTS and burned in as this step's subtitle. */
  narration: string;
  /**
   * Display text for the burned-in subtitle when it should differ from the
   * spoken line (e.g. subtitle "docs.burtson.ai" while TTS says
   * "docs dot burtson dot A I"). Defaults to `narration`.
   */
  subtitle?: string;
  /** Drives the page while this step's narration plays. Errors are logged, not fatal. */
  action: (page: Page) => Promise<void>;
  /** Minimum on-screen time for this step (ms). Defaults to narration length + padding. */
  minMs?: number;
}

export interface SceneContext {
  /** True when STORAGE_STATE points at an existing Playwright storage-state file. */
  authenticated: boolean;
}

export interface Scene {
  name: string;
  description?: string;
  /** Bandit TTS voice id — en_US-brian-premium (default) or en_US-jessica-premium. */
  voice?: string;
  viewport?: { width: number; height: number };
  /** Either a fixed step list, or a builder that can adapt to auth state. */
  steps: SceneStep[] | ((ctx: SceneContext) => SceneStep[]);
}

export interface ResolvedScene extends Omit<Scene, 'steps'> {
  steps: SceneStep[];
  /** The storage-state file to load into the browser context, if any. */
  storageStatePath?: string;
}

/** Path from STORAGE_STATE env, but only when the file actually exists. */
export function storageStatePath(): string | undefined {
  const p = process.env.STORAGE_STATE?.trim();
  if (p && existsSync(p)) return p;
  if (p) console.warn(`STORAGE_STATE=${p} does not exist — recording unauthenticated.`);
  return undefined;
}

/** Freeze a scene's steps for this run (auth-aware scenes pick their variant here). */
export function resolveScene(scene: Scene): ResolvedScene {
  const storage = storageStatePath();
  const ctx: SceneContext = { authenticated: Boolean(storage) };
  const steps = typeof scene.steps === 'function' ? scene.steps(ctx) : scene.steps;
  if (typeof scene.steps === 'function' && !ctx.authenticated) {
    console.warn(`scene "${scene.name}" supports authenticated recording — no STORAGE_STATE set, using the public variant.`);
  }
  return { ...scene, steps, storageStatePath: storage };
}
