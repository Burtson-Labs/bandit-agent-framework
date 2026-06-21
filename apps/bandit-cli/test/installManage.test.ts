import { describe, it, expect } from 'vitest';
import { isNewer, assetName } from '../src/install/manage';

// These two pure helpers decide whether `bandit upgrade` downloads anything and
// which release asset it fetches — a regression here means a skipped upgrade or
// a 404, so lock the behavior.
describe('isNewer', () => {
  it('is true only for a strictly greater x.y.z', () => {
    expect(isNewer('1.7.378', '1.7.379')).toBe(true);
    expect(isNewer('1.7.378', '1.8.0')).toBe(true);
    expect(isNewer('1.7.378', '2.0.0')).toBe(true);
    expect(isNewer('1.7.378', '1.7.378')).toBe(false);
    expect(isNewer('1.7.378', '1.7.377')).toBe(false);
    expect(isNewer('1.7.378', '1.6.999')).toBe(false);
  });
});

describe('assetName', () => {
  it('maps each supported platform/arch to its release asset', () => {
    expect(assetName('darwin', 'arm64')).toBe('bandit-darwin-arm64');
    expect(assetName('darwin', 'x64')).toBe('bandit-darwin-x64');
    expect(assetName('linux', 'arm64')).toBe('bandit-linux-arm64');
    expect(assetName('linux', 'x64')).toBe('bandit-linux-x64');
    expect(assetName('win32', 'x64')).toBe('bandit-windows-x64.exe');
  });

  it('returns null for unsupported combinations', () => {
    expect(assetName('win32', 'arm64')).toBeNull();
    expect(assetName('freebsd', 'x64')).toBeNull();
    expect(assetName('linux', 'ia32')).toBeNull();
  });
});
