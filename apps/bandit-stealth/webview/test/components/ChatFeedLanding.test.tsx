import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatFeedLanding, LANDING_SUGGESTIONS } from '../../src/components/ChatFeedLanding';

afterEach(() => cleanup());

describe('ChatFeedLanding', () => {
  it('shows one line of copy and the starter prompts as buttons', () => {
    const onSuggestPrompt = vi.fn();
    render(
      <ChatFeedLanding heroLogoSrc="logo.png" ollamaStatus="ready" providerKind="bandit" ollamaModelMissing={undefined} onSuggestPrompt={onSuggestPrompt} />
    );
    expect(screen.getByRole('heading', { name: 'Bandit Stealth' })).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Suggested prompts' });
    expect(group.querySelectorAll('button')).toHaveLength(LANDING_SUGGESTIONS.length);
    fireEvent.click(screen.getByRole('button', { name: LANDING_SUGGESTIONS[1] }));
    expect(onSuggestPrompt).toHaveBeenCalledWith(LANDING_SUGGESTIONS[1]);
  });

  it('keeps the Ollama setup steps when Ollama is offline', () => {
    render(<ChatFeedLanding heroLogoSrc="logo.png" ollamaStatus="offline" providerKind="ollama" ollamaModelMissing={undefined} onSuggestPrompt={() => undefined} />);
    expect(screen.getByText('Ollama is not running.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Suggested prompts' })).toBeNull();
  });
});
