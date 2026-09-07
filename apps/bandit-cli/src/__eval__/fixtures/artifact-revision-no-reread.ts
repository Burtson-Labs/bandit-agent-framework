import type { Fixture } from '../types';

/**
 * Context reuse on artifact revisions. In the publish→revise flow the agent
 * has JUST written the artifact file — its full contents sit in the previous
 * assistant message. Re-reading the file before a one-line revision is a
 * wasted round-trip (and on big artifacts, a context-window tax) that reads
 * as the model not trusting its own transcript. The correct trace is a
 * single targeted edit straight from context.
 *
 * The prior turn frames the artifact as auto-republishing from the file on
 * change, so the fixture never tempts the model toward host-only publish
 * tools (publish_artifact is registered by the host, not the eval sandbox).
 */
const ARTIFACT_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Fleet Status</title>',
  '<style>',
  '  :root { --bg: #ffffff; --fg: #111111; }',
  '  @media (prefers-color-scheme: dark) { :root { --bg: #111111; --fg: #eeeeee; } }',
  '  body { background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; margin: 2rem; }',
  '</style>',
  '</head>',
  '<body>',
  '<h1>Fleet Status</h1>',
  '<p>All nodes reporting healthy.</p>',
  '</body>',
  '</html>',
  ''
].join('\n');

export const fixture: Fixture = {
  id: 'context_reuse.artifact_revision',
  description: 'Revising a just-published artifact edits from context instead of re-reading the file it was handed',
  prompt: 'Change the page heading and title from "Fleet Status" to "Fleet Health" in the published artifact. Nothing else.',
  priorMessages: [
    {
      role: 'user',
      content: 'Create a tiny status page artifact at status.html and publish it.'
    },
    {
      role: 'assistant',
      content: [
        'Done — I wrote `status.html` with the following content and published it:',
        '',
        '```html',
        ARTIFACT_HTML.trimEnd(),
        '```',
        '',
        'It is live at https://artifacts.example/fleet-status. The published artifact republishes automatically whenever `status.html` changes on disk.'
      ].join('\n')
    }
  ],
  setup: {
    files: {
      'status.html': ARTIFACT_HTML
    }
  },
  assertions: {
    // The file's full contents are in the immediately-preceding assistant
    // message — any read-path call (read_file, cat/grep via run_command,
    // search, listing) is the exact failure this fixture pins.
    mustNotCall: ['read_file', 'list_files', 'ls', 'search_code', 'run_command'],
    // Any write route is acceptable: apply_edit/replace_range are the
    // natural shape, but a full write_file from context is still "edited
    // without re-reading" — the re-read is the only failure under test.
    mustCallAnyOf: [
      { name: /^(apply_edit|replace_range|write_file)$/, params: { path: /status\.html/ } }
    ],
    maxIterations: 4
  },
  runs: 3,
  passThreshold: 2
};
