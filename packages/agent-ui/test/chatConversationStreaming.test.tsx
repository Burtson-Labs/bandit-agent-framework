/**
 * Streaming re-render budget for the extension's chat list.
 *
 * During a turn the extension posts its whole state to the webview every
 * 16 ms, and the webview maps every entry to a fresh ChatMessage object.
 * Settled messages must not re-render (and re-run their markdown pipeline)
 * on each of those posts — only the streaming one changes.
 */
import { describe, expect, it } from 'vitest';

import { ChatConversation } from '../src/components/ChatConversation';
import { mount, rerender } from './_dom';

type Message = Parameters<typeof ChatConversation>[0]['messages'][number];

const body = (i: number) =>
  `Step ${i}: reading \`src/file${i}.ts\`.\n\n` +
  '```ts\n' + Array.from({ length: 10 }, (_, l) => `const v${l} = f(${i}, ${l});`).join('\n') + '\n```\n\n- one\n- two\n';

describe('ChatConversation while streaming', () => {
  it('re-renders markdown only for the message that changed', () => {
    let renders = 0;
    const renderMarkdown = (content: string) => {
      renders++;
      return `<p>${content.length}</p>`;
    };
    // Fresh objects every post, exactly like mapConversationToChat over a
    // structured-cloned state; callbacks are inline lambdas, as in App.tsx.
    const snapshot = (live: string): Message[] => [
      ...Array.from({ length: 80 }, (_, i) => ({
        id: `m${i}`,
        role: (i % 2 ? 'assistant' : 'user') as Message['role'],
        content: body(i),
        timestamp: 1_700_000_000_000 + i * 1000,
      })),
      { id: 'live', role: 'assistant', content: live, timestamp: 1_700_000_090_000 },
    ];
    const ui = (live: string) => (
      <ChatConversation
        messages={snapshot(live)}
        renderMarkdown={renderMarkdown}
        onPermissionChoice={() => {}}
        onSpeak={() => {}}
        streamingMessageId="live"
      />
    );
    mount(ui('t0 '));
    renders = 0;
    const started = performance.now();
    let live = 't0 ';
    for (let token = 1; token <= 60; token++) {
      live += `t${token} `;
      rerender(ui(live));
    }
    const elapsed = performance.now() - started;
    process.stdout.write(`[stall] 60 state posts over 80 messages: ${renders} markdown renders, ${elapsed.toFixed(0)} ms\n`);
    expect(renders).toBeLessThanOrEqual(60);
  });
});
