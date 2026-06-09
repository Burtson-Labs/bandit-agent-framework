/**
 * Interaction skill — wraps the `ask_user` tool.
 *
 * Deliberately NOT part of createDefaultSkillRegistry(): a host should only
 * register it when it actually has an interactive surface to render the
 * questions on (the CLI registers it when stdin is a TTY; the extension will
 * register it once its webview card lands). Keeping it host-opt-in means
 * non-interactive runs (eval, CI, piped one-shots) never offer a tool that
 * can't be fulfilled, and the shared default registry's skill/tool counts
 * stay unchanged.
 */

import type { SkillManifest } from '../skill-types';
import { askUserTool } from '../ask-user-tool';

export const interactionSkill: SkillManifest = {
  id: 'core/interaction',
  name: 'Ask the User',
  version: '1.0.0',
  description: 'Ask the user clarifying questions with selectable options when blocked on a decision.',
  activation: 'always',
  tools: [askUserTool]
};
