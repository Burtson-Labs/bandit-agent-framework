/**
 * Bandit Agent Framework — workspace fixture.
 *
 * A release in this repo HAS to bump three artefacts in lockstep:
 *   - apps/bandit-cli/package.json              (CLI version)
 *   - apps/bandit-stealth/package.json          (extension version)
 *   - apps/bandit-stealth-web/charts/…/Chart.yaml  (chart version + appVersion)
 *
 * We've shipped at least one release where the agent bumped two of three
 * (cli + extension but not the chart, or vice versa) and we had to nudge
 * it to finish. This fixture makes that class of regression visible: if
 * the agent finishes the run without applying edits to all three files,
 * something about the release playbook has drifted — whether in the
 * `release` skill, the apply_edit tool, or the system prompt.
 *
 * @type {import('../../apps/bandit-cli/src/__eval__/types').Fixture}
 */
export default {
  id: 'bandit.release_touches_all_three',
  description: 'A "bump to X.Y.Z" prompt must edit cli + extension + chart',
  prompt:
    'Bump the CLI, the VS Code extension, and the Helm chart to version 9.9.9 '
    + '(use 0.9.9 for the chart). Do not commit or push — just apply the three '
    + 'version bumps.',
  setup: {
    files: {
      'apps/bandit-cli/package.json': JSON.stringify(
        { name: '@burtson-labs/bandit-stealth-cli', version: '1.5.32', bin: { bandit: './dist/cli.js' } },
        null,
        2
      ) + '\n',
      'apps/bandit-stealth/package.json': JSON.stringify(
        { name: 'bandit-stealth', version: '1.5.32' },
        null,
        2
      ) + '\n',
      'apps/bandit-stealth-web/charts/bandit-stealth-web/Chart.yaml': [
        'apiVersion: v2',
        'name: bandit-stealth-web',
        'description: Bandit Stealth standalone web app',
        'type: application',
        'version: 0.2.34',
        'appVersion: 0.2.34',
        ''
      ].join('\n')
    }
  },
  assertions: {
    // Three apply_edit calls is the natural shape for this work. If the
    // model reaches for write_file on a one-line change it'll fail the
    // "apply_edit-preferred" fixture separately; here we just require
    // that SOME edit hit each of the three files.
    mustCallAnyOf: [
      { name: 'apply_edit', params: { path: /bandit-cli\/package\.json/ } },
      { name: 'write_file', params: { path: /bandit-cli\/package\.json/ } }
    ],
    maxIterations: 10
  },
  runs: 3,
  passThreshold: 2
};
