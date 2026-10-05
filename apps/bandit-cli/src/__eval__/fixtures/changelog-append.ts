import type { Fixture } from '../types';
import { targetedEditOf } from './shared';

/**
 * Doc maintenance: add an entry to an existing markdown doc in the
 * established format — an edit that respects surrounding structure instead
 * of clobbering the file.
 */
export const fixture: Fixture = {
  id: 'edit.changelog_append',
  description: 'Append a new CHANGELOG entry in the existing format via targeted edit',
  prompt: 'Add a CHANGELOG entry for version 1.2.0: "Added CSV export." Follow the existing format, newest first.',
  setup: {
    files: {
      'CHANGELOG.md': [
        '# Changelog',
        '',
        '## 1.1.0',
        '- Added user avatars.',
        '',
        '## 1.0.0',
        '- Initial release.',
        ''
      ].join('\n')
    }
  },
  assertions: {
    mustCallAllOf: [
      { name: 'read_file', params: { path: /CHANGELOG\.md/ } },
      targetedEditOf('CHANGELOG.md')
    ],
    mustNotCall: ['write_file'],
    // Newest first, same shape as the existing entries, older entries intact.
    finalFiles: {
      'CHANGELOG.md': /^# Changelog\s+## 1\.2\.0\s+- Added CSV export\.\s+## 1\.1\.0\s+- Added user avatars\.\s+## 1\.0\.0\s+- Initial release\.\s*$/
    },
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};
