import { describe, expect, it } from 'vitest';
import { openerCommand } from '../src/openExternal';

describe('openerCommand', () => {
  const url = 'https://example.com/cb?code=abc&state=x|y^z';

  it('passes the URL as one argument with no shell on Windows', () => {
    const { cmd, args } = openerCommand(url, 'win32');
    expect(cmd).toBe('rundll32');
    expect(args).toEqual(['url.dll,FileProtocolHandler', url]);
    expect(cmd).not.toMatch(/cmd|start/);
  });

  it('uses open on macOS and xdg-open elsewhere', () => {
    expect(openerCommand(url, 'darwin')).toEqual({ cmd: 'open', args: [url] });
    expect(openerCommand(url, 'linux')).toEqual({ cmd: 'xdg-open', args: [url] });
  });
});
