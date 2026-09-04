import type { Fixture } from '../types';

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
      { name: /^(apply_edit|replace_range)$/, params: { path: /CHANGELOG\.md/ } }
    ],
    mustNotCall: ['write_file'],
    maxIterations: 5
  },
  runs: 3,
  passThreshold: 2
};
