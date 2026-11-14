/**
 * Bandit Stash (formerly Artifacts) — model-facing copy. The tool NAMES stay
 * (publish_artifact, …: wire contract with models, evals and training data), but
 * every description says "Bandit Stash", and the git stash tool says it is not the
 * Bandit Stash, so "save report.html to my stash" steers to publish_artifact.
 */
import { describe, it, expect } from 'vitest';
import { createDefaultSkillRegistry, type AgentTool } from '@burtson-labs/agent-core';
import {
  buildPublishArtifactTool,
  buildShareArtifactTool,
  buildListArtifactsTool,
  buildDeleteArtifactTool,
  buildRestoreArtifactTool,
  buildGetArtifactTool,
  buildUpdateArtifactTool,
  buildEmailArtifactTool
} from '../src';

const opts = { token: 't', s3ApiBaseUrl: 'https://s3' };
const stashTools: AgentTool[] = [
  buildPublishArtifactTool(opts),
  buildShareArtifactTool(opts),
  buildListArtifactsTool(opts),
  buildDeleteArtifactTool(opts),
  buildRestoreArtifactTool(opts),
  buildGetArtifactTool(opts),
  buildUpdateArtifactTool(opts),
  buildEmailArtifactTool(opts)
];

function gitStashTool(prompt: string): AgentTool | undefined {
  const skills = createDefaultSkillRegistry();
  const { registry } = skills.buildToolRegistryWithMap(skills.resolveActiveSkills(prompt));
  return registry.get('git_stash');
}

describe('Bandit Stash tool copy', () => {
  it('keeps the tool names unchanged', () => {
    expect(stashTools.map((t) => t.name)).toEqual([
      'publish_artifact', 'share_artifact', 'list_artifacts', 'delete_artifact',
      'restore_artifact', 'get_artifact', 'update_artifact', 'email_artifact'
    ]);
  });

  it('every Stash tool description names the Bandit Stash and marks it as cloud', () => {
    for (const tool of stashTools) {
      expect(tool.description, tool.name).toMatch(/Bandit Stash/);
      expect(tool.description, tool.name).toMatch(/cloud/i);
      // no leftover "published artifact" product wording ("formerly Bandit Artifacts" is fine)
      expect(tool.description.replace(/formerly Bandit Artifacts/g, ''), tool.name).not.toMatch(/published artifact|Bandit Artifact/i);
    }
  });

  it('publish_artifact is the tool for "save … to my stash", and says it is not git stash', () => {
    const d = buildPublishArtifactTool(opts).description;
    expect(d).toMatch(/save it to my Stash/i);
    expect(d).toMatch(/NOT git stash/);
  });

  it('git_stash is still exposed, but says it is git only and points at publish_artifact', () => {
    const git = gitStashTool('save report.html to my stash');
    expect(git, 'git skill is always active').toBeDefined();
    expect(git!.description).toMatch(/^Run git stash \(save\/restore\/list uncommitted working-tree changes\)\. Not the Bandit Stash/);
    expect(git!.description).toContain('publish_artifact');
  });

  it('for "save report.html to my stash", only publish_artifact offers to save to the Bandit Stash', () => {
    const git = gitStashTool('save report.html to my stash')!;
    const savesToStash = (t: AgentTool) =>
      /\bsave\b[^.]*\bBandit Stash\b/i.test(t.description) && !/^Run git stash/.test(t.description);
    expect([...stashTools, git].filter(savesToStash).map((t) => t.name)).toEqual(['publish_artifact']);
  });
});

describe('Bandit Stash tool outputs', () => {
  it('list_artifacts says the Stash is empty, in Stash words', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ artifacts: [] }) } as Response)) as unknown as typeof fetch;
    const res = await buildListArtifactsTool({ ...opts, fetchImpl }).execute({}, {} as never);
    expect(res.output).toBe('The Bandit Stash is empty. Save a file to it with publish_artifact.');
  });

  it('delete_artifact reports the item left the Bandit Stash', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 204, json: async () => ({}) } as Response)) as unknown as typeof fetch;
    const res = await buildDeleteArtifactTool({ ...opts, fetchImpl }).execute({ url: 'https://stealth.banditailabs.com/stash?a=owner-1%2Fa.html' }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/^Deleted the item from Bandit Stash/);
  });
});
