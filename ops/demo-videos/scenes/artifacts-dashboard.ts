/**
 * Public-surfaces walkthrough — no auth anywhere:
 *   burtson.ai (landing) → docs.burtson.ai (incl. Bandit Engine + Bandit API)
 *   → stealth.banditailabs.com login page (viewed only, never logs in).
 */
import { glideDown, visit } from '../src/actions.js';
import type { Scene } from '../src/types.js';

const scene: Scene = {
  name: 'artifacts-dashboard',
  description: 'Bandit public surfaces: landing, docs (Engine + API), and the Stealth web sign-in.',
  voice: 'en_US-brian-premium',
  viewport: { width: 1280, height: 720 },
  steps: [
    {
      title: 'landing',
      narration: 'Meet Bandit — the local-first AI coding agent from Burtson Labs.',
      action: async (page) => {
        await visit(page, 'https://burtson.ai', 1600);
      },
    },
    {
      title: 'landing-surfaces',
      narration: 'One agent, every surface: a CLI, a VS Code extension, and a full web IDE.',
      action: async (page) => {
        await glideDown(page, 900);
      },
    },
    {
      title: 'landing-local-first',
      narration: 'Your code stays on your machine — local models are first-class, cloud is optional.',
      action: async (page) => {
        await glideDown(page, 1100);
      },
    },
    {
      title: 'docs-home',
      narration: 'Everything ships documented, at docs dot burtson dot A I.',
      subtitle: 'Everything ships documented, at docs.burtson.ai.',
      action: async (page) => {
        await visit(page, 'https://docs.burtson.ai', 1400);
      },
    },
    {
      title: 'docs-engine',
      narration: 'The Bandit Engine — a production-ready chat framework you can point at your own gateway.',
      action: async (page) => {
        await visit(page, 'https://docs.burtson.ai/engine-intro.html', 1000);
        await glideDown(page, 500);
      },
    },
    {
      title: 'docs-api',
      narration: 'And one API at api dot burtson dot A I — the same gateway every Bandit surface talks to.',
      subtitle: 'And one API at api.burtson.ai — the same gateway every Bandit surface talks to.',
      action: async (page) => {
        await visit(page, 'https://docs.burtson.ai/api-overview.html', 1000);
        await glideDown(page, 500);
      },
    },
    {
      title: 'stealth-login',
      narration: 'This is Bandit Stealth on the web — sign in, and your agent meets you in the browser.',
      action: async (page) => {
        await visit(page, 'https://stealth.banditailabs.com', 1800);
      },
    },
    {
      title: 'stealth-artifacts',
      narration: 'Artifacts turn agent output into shareable pages — publish, share, archive. One login away.',
      action: async (page) => {
        await glideDown(page, 400);
      },
    },
    {
      title: 'outro',
      narration: 'Bandit, by Burtson Labs. Local-first. Open source. Ready to work.',
      action: async (page) => {
        await visit(page, 'https://burtson.ai', 1200);
      },
    },
  ],
};

export default scene;
