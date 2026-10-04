import { describe, expect, it } from 'vitest';
import { ToolRegistry, type AgentTool } from '@burtson-labs/agent-core';
import { withCommandDeny } from '../src/__eval__/runner';

function fakeTool(name: string, calls: string[]): AgentTool {
  return {
    name,
    description: `${name} (fake)`,
    parameters: [],
    async execute(params) {
      calls.push(`${name}:${params.cmd ?? ''} ${params.args ?? ''}`.trim());
      return { output: 'ran' };
    }
  };
}

describe('replay command deny', () => {
  const deny = /(^|\s)(git\s+push|kubectl|npm\s+publish|curl\s+.*-X\s*(POST|PUT|DELETE))/i;

  it('refuses denied command lines on run_command and watch_command', async () => {
    const calls: string[] = [];
    const registry = withCommandDeny(
      new ToolRegistry().registerAll([fakeTool('run_command', calls), fakeTool('watch_command', calls), fakeTool('read_file', calls)]),
      deny
    );
    const blocked = await registry.get('run_command')!.execute({ cmd: 'git', args: 'push origin main' }, {} as never);
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toMatch(/blocked in this sandbox/);
    const watched = await registry.get('watch_command')!.execute({ cmd: 'kubectl get pods' }, {} as never);
    expect(watched.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('lets allowed commands and other tools through unchanged', async () => {
    const calls: string[] = [];
    const registry = withCommandDeny(
      new ToolRegistry().registerAll([fakeTool('run_command', calls), fakeTool('read_file', calls)]),
      deny
    );
    expect((await registry.get('run_command')!.execute({ cmd: 'npm', args: 'test' }, {} as never)).output).toBe('ran');
    expect((await registry.get('read_file')!.execute({ cmd: 'git push' }, {} as never)).output).toBe('ran');
    expect(calls).toEqual(['run_command:npm test', 'read_file:git push']);
    expect(registry.get('run_command')!.name).toBe('run_command');
  });
});
