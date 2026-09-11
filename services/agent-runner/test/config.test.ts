/**
 * Config + fail-closed bind policy (SEC-001).
 *
 * The invariant worth a test: an unauthenticated runner is only ever
 * reachable from loopback. Not "documented as loopback" — refused at
 * startup. Everything else here guards the parse paths that decide it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BODY_BYTES, isLoopbackHost, loadRunnerConfig } from '../src/config';

describe('loadRunnerConfig — bind policy', () => {
  it('binds loopback only when no token is configured', () => {
    expect(loadRunnerConfig({}).host).toBe('127.0.0.1');
    expect(loadRunnerConfig({}).token).toBeUndefined();
  });

  it('refuses to start unauthenticated on a non-loopback interface', () => {
    expect(() => loadRunnerConfig({ AGENT_RUNNER_HOST: '0.0.0.0' })).toThrow(/not a loopback address/);
    expect(() => loadRunnerConfig({ AGENT_RUNNER_HOST: '10.1.2.3' })).toThrow(/AGENT_RUNNER_TOKEN/);
  });

  it('allows an explicit loopback host without a token', () => {
    expect(loadRunnerConfig({ AGENT_RUNNER_HOST: 'localhost' }).host).toBe('localhost');
    expect(loadRunnerConfig({ AGENT_RUNNER_HOST: '::1' }).host).toBe('::1');
  });

  it('binds all interfaces once a token is configured', () => {
    expect(loadRunnerConfig({ AGENT_RUNNER_TOKEN: 'secret' }).host).toBe('0.0.0.0');
    expect(loadRunnerConfig({ AGENT_RUNNER_TOKEN: 'secret', AGENT_RUNNER_HOST: '10.1.2.3' }).host).toBe(
      '10.1.2.3',
    );
  });

  it('treats a whitespace-only token as no token at all', () => {
    expect(() => loadRunnerConfig({ AGENT_RUNNER_TOKEN: '   ', AGENT_RUNNER_HOST: '0.0.0.0' })).toThrow(
      /not a loopback address/,
    );
  });
});

describe('isLoopbackHost', () => {
  it('recognises every loopback spelling the bind check has to cover', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.5', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const host of ['0.0.0.0', '10.0.0.1', '::', 'example.com', '127.0.0.1.evil.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('loadRunnerConfig — other settings', () => {
  it('parses the workspace root, provider allowlist and permission mode', () => {
    const config = loadRunnerConfig({
      AGENT_RUNNER_WORKSPACE_ROOT: '/srv/workspaces',
      AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS: ' Models.Example.com , other.example:11434 ,,',
      AGENT_RUNNER_PERMISSION_MODE: 'read-only',
    });

    expect(config.workspaceRoot).toBe('/srv/workspaces');
    expect(config.allowedProviderHosts).toEqual(['models.example.com', 'other.example:11434']);
    expect(config.permissionMode).toBe('read-only');
  });

  it('defaults the body cap and log level, and validates overrides', () => {
    expect(loadRunnerConfig({}).maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(loadRunnerConfig({}).logLevel).toBe('info');
    expect(loadRunnerConfig({ AGENT_RUNNER_MAX_BODY_BYTES: '4096' }).maxBodyBytes).toBe(4096);
    expect(() => loadRunnerConfig({ AGENT_RUNNER_MAX_BODY_BYTES: '0' })).toThrow(/positive integer/);
    expect(() => loadRunnerConfig({ AGENT_RUNNER_MAX_BODY_BYTES: 'lots' })).toThrow(/positive integer/);
    expect(() => loadRunnerConfig({ PORT: '70000' })).toThrow(/invalid PORT/);
    expect(() => loadRunnerConfig({ AGENT_RUNNER_PERMISSION_MODE: 'yolo' })).toThrow(
      /AGENT_RUNNER_PERMISSION_MODE/,
    );
  });
});
