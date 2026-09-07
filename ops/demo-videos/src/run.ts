/**
 * One-shot pipeline: narrate → record → assemble.
 *
 *   pnpm demo <scene-name>          e.g. pnpm demo artifacts-dashboard
 *
 * Final cut lands in ~/Desktop/bandit-demos/<scene>-<YYYY-MM-DD>.mp4
 * (override the folder with DEMO_DEST_DIR). Nothing is published.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { narrateScene } from './narrate.js';
import { recordScene } from './record.js';
import { resolveScene, type Scene } from './types.js';

const ROOT = resolve(import.meta.dirname, '..');

function listScenes(): string[] {
  return readdirSync(join(ROOT, 'scenes'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''));
}

function ensureChromium(): void {
  const local = join(ROOT, 'node_modules', '.bin', 'playwright');
  const cmd = existsSync(local) ? local : 'npx';
  const args = existsSync(local) ? ['install', 'chromium'] : ['playwright', 'install', 'chromium'];
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) throw new Error('`playwright install chromium` failed');
}

const name = process.argv[2];
if (!name) {
  console.error(`usage: pnpm demo <scene-name>\nscenes: ${listScenes().join(', ')}`);
  process.exit(1);
}
const scenePath = join(ROOT, 'scenes', `${name}.ts`);
if (!existsSync(scenePath)) {
  console.error(`No scene at scenes/${name}.ts — available: ${listScenes().join(', ')}`);
  process.exit(1);
}

const mod = (await import(pathToFileURL(scenePath).href)) as { default?: Scene; scene?: Scene };
const sceneDef = mod.default ?? mod.scene;
if (!sceneDef) {
  console.error(`scenes/${name}.ts must default-export a Scene`);
  process.exit(1);
}
const scene = resolveScene(sceneDef);

const outDir = join(ROOT, 'out', name);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`\n[1/4] chromium`);
ensureChromium();

console.log(`\n[2/4] narrate — ${scene.steps.length} lines`);
const narration = await narrateScene(scene, outDir);

console.log(`\n[3/4] record`);
await recordScene(scene, outDir, narration);

console.log(`\n[4/4] assemble`);
const res = spawnSync('bash', [join(ROOT, 'assemble.sh'), name], { stdio: 'inherit', cwd: ROOT });
process.exit(res.status ?? 1);
