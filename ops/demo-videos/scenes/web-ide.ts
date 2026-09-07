/**
 * Bandit Stealth web IDE + artifacts dashboard (stealth.banditailabs.com).
 *
 * Auth-aware: with STORAGE_STATE pointing at a Playwright storage-state
 * file (see README "Authenticated scenes"), it walks the signed-in IDE and
 * the artifacts dashboard. Without one it degrades to the public sign-in
 * surface and says so. Credentials are never typed, stored, or prompted
 * for by this scene — auth comes only from the storage-state file.
 *
 * NOTE: the signed-in selectors are best-effort (the web IDE lives in its
 * own repo) — expect to tune titles/paths after the first authenticated run.
 */
import { glideDown, tryClick, visit } from '../src/actions.js';
import type { Scene, SceneStep } from '../src/types.js';

const BASE = 'https://stealth.banditailabs.com';

const authenticatedSteps: SceneStep[] = [
  {
    title: 'ide-home',
    narration: 'Bandit Stealth on the web — the full agent, signed in, in your browser.',
    action: async (page) => {
      await visit(page, BASE, 2200);
    },
  },
  {
    title: 'ide-workspace',
    narration: 'The same engine as the CLI and the VS Code extension — chat, tools, and runs.',
    action: async (page) => {
      await glideDown(page, 500);
    },
  },
  {
    title: 'artifacts-nav',
    narration: 'Artifacts turn any file your agent produces into a shareable page.',
    action: async (page) => {
      const clicked = await tryClick(page, /artifact/i);
      if (!clicked) await visit(page, `${BASE}/artifacts`, 1500);
    },
  },
  {
    title: 'artifacts-dashboard',
    narration: 'Publish, share, archive — the dashboard keeps every artifact in one place.',
    action: async (page) => {
      await glideDown(page, 600);
    },
  },
  {
    title: 'one-account',
    narration: 'The same account signs into the CLI, the extension, and the web — your work follows you.',
    action: async (page) => {
      await glideDown(page, 400);
    },
  },
  {
    title: 'outro',
    narration: 'Bandit Stealth web — one login, every surface.',
    action: async (page) => {
      await visit(page, BASE, 1200);
    },
  },
];

const publicSteps: SceneStep[] = [
  {
    title: 'stealth-login',
    narration: 'Bandit Stealth on the web — sign in, and the full agent runs in your browser.',
    action: async (page) => {
      await visit(page, BASE, 2200);
    },
  },
  {
    title: 'stealth-pitch',
    narration: 'Chat, tools, and artifacts — the full agent, behind one login.',
    action: async (page) => {
      await glideDown(page, 400);
    },
  },
  {
    title: 'stealth-artifacts',
    narration: 'Artifacts turn any file your agent produces into a page you can share.',
    action: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    title: 'outro',
    narration: 'One account, every surface — the CLI, the extension, and the web.',
    action: async (page) => {
      await page.waitForTimeout(500);
    },
  },
];

const scene: Scene = {
  name: 'web-ide',
  description: 'Bandit Stealth web IDE + artifacts dashboard (signed-in with STORAGE_STATE, public sign-in surface otherwise).',
  voice: 'en_US-brian-premium',
  viewport: { width: 1280, height: 720 },
  steps: ({ authenticated }) => {
    if (!authenticated) {
      console.warn('web-ide: no STORAGE_STATE — recording the public sign-in surface only (no login attempted).');
      return publicSteps;
    }
    return authenticatedSteps;
  },
};

export default scene;
