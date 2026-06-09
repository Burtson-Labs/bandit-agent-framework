import { describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsString } from '../src/security/secretPatterns';

describe('redactSecrets', () => {
  it('returns input unchanged when there are no secrets', () => {
    const r = redactSecrets('hello world, nothing to hide here');
    expect(r.text).toBe('hello world, nothing to hide here');
    expect(r.redactionCount).toBe(0);
    expect(r.kinds).toEqual([]);
  });

  it('handles empty + null-ish input', () => {
    expect(redactSecrets('').text).toBe('');
    expect(redactSecrets('').redactionCount).toBe(0);
  });

  describe('GitHub tokens', () => {
    it('redacts a classic GitHub PAT', () => {
      const input = 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const r = redactSecrets(input);
      expect(r.text).not.toContain('ghp_abcdefghijklmnop');
      expect(r.text).toContain('<REDACTED:');
      expect(r.redactionCount).toBeGreaterThanOrEqual(1);
    });

    it('redacts a fine-grained GitHub PAT', () => {
      const input = `the token github_pat_${'A'.repeat(82)} should be hidden`;
      const r = redactSecrets(input);
      expect(r.text).not.toContain('github_pat_AAAA');
      expect(r.text).toContain('<REDACTED:github-pat-fine-grained>');
    });

    it('redacts GitHub OAuth, server, and user tokens', () => {
      const a = redactSecrets(`gho_${'x'.repeat(36)}`);
      const b = redactSecrets(`ghs_${'x'.repeat(36)}`);
      const c = redactSecrets(`ghu_${'x'.repeat(36)}`);
      expect(a.text).toContain('<REDACTED:github-oauth>');
      expect(b.text).toContain('<REDACTED:github-server-token>');
      expect(c.text).toContain('<REDACTED:github-user-token>');
    });
  });

  describe('Slack tokens', () => {
    it('redacts xoxb / xoxp / xoxa tokens', () => {
      const r = redactSecrets('bot=xoxb-1234567890-abcdef user=xoxp-9876543210-zyxwvu app=xoxa-fedcba');
      expect(r.text).not.toContain('xoxb-1234567890-abcdef');
      expect(r.text).not.toContain('xoxp-9876543210-zyxwvu');
      expect(r.text).not.toContain('xoxa-fedcba');
      expect(r.kinds).toContain('slack-bot-token');
    });
  });

  describe('AWS credentials', () => {
    it('redacts an AKIA-prefixed access key', () => {
      const r = redactSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
      expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(r.kinds).toContain('aws-access-key');
    });
  });

  describe('LLM provider keys', () => {
    it('redacts Anthropic sk-ant- key', () => {
      const r = redactSecrets(`key=sk-ant-${'x'.repeat(60)}`);
      expect(r.text).toContain('<REDACTED:anthropic-key>');
      expect(r.text).not.toContain(`sk-ant-${'x'.repeat(60)}`);
    });

    it('redacts OpenAI sk- key but not Anthropic (covered by sk-ant-)', () => {
      const r = redactSecrets(`openai=sk-${'x'.repeat(40)} ant=sk-ant-${'y'.repeat(40)}`);
      // Both kinds present, but Anthropic should be tagged correctly
      expect(r.kinds).toContain('anthropic-key');
      expect(r.kinds).toContain('openai-key');
      // Body should be redacted twice
      expect(r.redactionCount).toBeGreaterThanOrEqual(2);
    });

    it('redacts Bandit / Burtson Labs API key (bai_...)', () => {
      const r = redactSecrets(`X-API-Key: bai_${'q'.repeat(40)}`);
      expect(r.text).toContain('<REDACTED:bandit-api-key>');
    });
  });

  describe('Google credentials', () => {
    it('redacts a Google API key (AIza prefix + 35 chars)', () => {
      const r = redactSecrets(`AIza${'A'.repeat(35)}`);
      expect(r.text).toContain('<REDACTED:google-api-key>');
    });

    it('redacts a Google OAuth refresh token (1// prefix)', () => {
      const r = redactSecrets(`refresh=1//0g${'A'.repeat(50)}`);
      expect(r.text).toContain('<REDACTED:google-oauth-refresh>');
    });
  });

  describe('Stripe keys', () => {
    it('redacts both live + test secret keys', () => {
      const r = redactSecrets(`live=sk_live_${'x'.repeat(30)} test=sk_test_${'y'.repeat(30)}`);
      expect(r.text).not.toContain('sk_live_');
      expect(r.text).not.toContain('sk_test_');
      expect(r.kinds).toContain('stripe-secret-key');
    });
  });

  describe('JWT tokens', () => {
    it('redacts a three-segment JWT', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXJrIn0.signaturesignaturesignaturesig';
      const r = redactSecrets(`Authorization: Bearer ${jwt}`);
      expect(r.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(r.text).toContain('<REDACTED:jwt>');
    });
  });

  describe('private keys', () => {
    it('redacts a PEM RSA private key block', () => {
      const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${'A'.repeat(100)}\nfaketotallynotrealkeyMaterial\n-----END RSA PRIVATE KEY-----`;
      const r = redactSecrets(`here is my key:\n${pem}\nend`);
      expect(r.text).not.toContain('MIIEowIBAA');
      expect(r.text).toContain('<REDACTED:private-key>');
    });

    it('redacts a generic PRIVATE KEY block', () => {
      const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAA${'B'.repeat(60)}\n-----END PRIVATE KEY-----`;
      const r = redactSecrets(pem);
      expect(r.text).not.toContain('MIIEvQIBAD');
      expect(r.kinds).toContain('private-key');
    });
  });

  describe('JSON / camelCase config secrets (~/.bandit/config.json shape)', () => {
    // Regression: ~/.bandit/config.json uses camelCase keys like
    // {"bandit": {"apiKey": "bai_..."}}. The env-secret pattern only
    // matches SHOUTY_CASE names and missed this. Observed leak 2026-05-26.
    it('redacts an opaque value behind a camelCase "apiKey" JSON key', () => {
      const r = redactSecrets('"apiKey": "opaque-but-long-token-value"');
      expect(r.text).not.toContain('opaque-but-long-token-value');
      expect(r.text).toContain('"apiKey":');
      expect(r.text).toContain('<REDACTED:json-camelcase-secret>');
    });

    it('redacts the full ~/.bandit/config.json shape end-to-end', () => {
      const config = JSON.stringify({
        bandit: { apiKey: 'opaque-bandit-credential-12345', apiUrl: 'https://api.example.com' },
        openai: { apiKey: 'opaque-openai-credential-67890' }
      }, null, 2);
      const r = redactSecrets(config);
      expect(r.text).not.toContain('opaque-bandit-credential-12345');
      expect(r.text).not.toContain('opaque-openai-credential-67890');
      // The apiUrl is not a secret; should still be visible.
      expect(r.text).toContain('https://api.example.com');
      // Key names preserved so the model still knows what was hidden.
      expect(r.text).toContain('"apiKey"');
    });

    it('matches accessToken / refreshToken / clientSecret / privateKey camelCase keys', () => {
      const blocks = [
        '"accessToken": "tokenvalue1234567890"',
        '"refreshToken": "refreshvalue1234567"',
        '"clientSecret": "clientsecret1234567"',
        '"privateKey": "pkvalue1234567890abc"',
      ].join('\n');
      const r = redactSecrets(blocks);
      expect(r.text).not.toContain('tokenvalue1234567890');
      expect(r.text).not.toContain('refreshvalue1234567');
      expect(r.text).not.toContain('clientsecret1234567');
      expect(r.text).not.toContain('pkvalue1234567890abc');
      expect(r.text.split('<REDACTED:json-camelcase-secret>').length - 1).toBeGreaterThanOrEqual(4);
    });

    it('matches standalone lowercase "password" / "secret" keys', () => {
      const r = redactSecrets('{ "password": "hunter2hunter2x", "secret": "verysecretvalue" }');
      expect(r.text).not.toContain('hunter2hunter2x');
      expect(r.text).not.toContain('verysecretvalue');
    });

    it('supports both : and = separators (JS object vs config literal)', () => {
      const colon = redactSecrets('apiKey: "shouldberedactedvalue"');
      const equals = redactSecrets('apiKey = "shouldberedactedvalue"');
      expect(colon.text).not.toContain('shouldberedactedvalue');
      expect(equals.text).not.toContain('shouldberedactedvalue');
    });

    it('does NOT match values under 8 chars (avoids false positives)', () => {
      const r = redactSecrets('"apiKey": "short"');
      expect(r.text).toBe('"apiKey": "short"');
      expect(r.redactionCount).toBe(0);
    });

    it('does NOT match unrelated camelCase fields (e.g. apiVersion, endpoint)', () => {
      const r = redactSecrets('{ "apiVersion": "2026-01-01", "endpoint": "https://example.com" }');
      expect(r.text).toContain('"2026-01-01"');
      expect(r.text).toContain('"https://example.com"');
      expect(r.redactionCount).toBe(0);
    });

    it('lets a more-specific provider pattern win over the generic JSON pattern', () => {
      // bai_xxx and sk-ant-xxx should be tagged with their dedicated kinds.
      const r = redactSecrets(`{ "apiKey": "bai_${'q'.repeat(40)}" }`);
      expect(r.kinds).toContain('bandit-api-key');
      // The bandit-api-key pattern runs first and replaces bai_xxx with
      // its own placeholder; the JSON pattern then sees the placeholder
      // (which contains <>) and skips it.
      expect(r.text).toContain('<REDACTED:bandit-api-key>');
    });
  });

  describe('Authorization header tokens', () => {
    it('redacts a Bearer token while preserving header name + scheme', () => {
      const r = redactSecrets('Authorization: Bearer opaque-bearer-token-here-1234');
      expect(r.text).not.toContain('opaque-bearer-token-here-1234');
      expect(r.text).toContain('Authorization:');
      expect(r.text).toContain('Bearer <REDACTED:authorization-bearer>');
    });

    it('redacts a Token-scheme header', () => {
      const r = redactSecrets('Authorization: Token opaque-token-value-1234567890');
      expect(r.text).not.toContain('opaque-token-value-1234567890');
      expect(r.text).toContain('Token <REDACTED:authorization-bearer>');
    });

    it('handles quoted JSON header form ("Authorization": "Bearer ...")', () => {
      const r = redactSecrets('"Authorization": "Bearer opaque-bearer-value-1234567"');
      expect(r.text).not.toContain('opaque-bearer-value-1234567');
      expect(r.text).toContain('<REDACTED:authorization-bearer>');
    });

    it('still lets the JWT pattern win when the bearer value is a real JWT', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXJrIn0.signaturesignaturesignaturesig';
      const r = redactSecrets(`Authorization: Bearer ${jwt}`);
      // jwt pattern runs before authorization-bearer; bearer can't match
      // the placeholder because it contains <>.
      expect(r.kinds).toContain('jwt');
      expect(r.text).toContain('<REDACTED:jwt>');
    });
  });

  describe('env-style secrets (last-resort pattern)', () => {
    it('preserves the variable name and redacts the value', () => {
      const r = redactSecrets('GITHUB_TOKEN=abcdefghijklmnop');
      expect(r.text).toContain('GITHUB_TOKEN=');
      expect(r.text).toContain('<REDACTED:env-secret>');
      expect(r.text).not.toContain('abcdefghijklmnop');
    });

    it('matches *_KEY / *_SECRET / *_PASSWORD / *_API variations', () => {
      const lines = [
        'STRIPE_SECRET_KEY=verysecretvaluehere',
        'DATABASE_PASSWORD=mypassword12345',
        'INTERNAL_API=internalkeyabcdef99',
      ].join('\n');
      const r = redactSecrets(lines);
      expect(r.text.split('<REDACTED:env-secret>').length - 1).toBeGreaterThanOrEqual(3);
    });

    it('does not falsely match short values (< 8 chars)', () => {
      const r = redactSecrets('DEBUG=true');
      expect(r.text).toBe('DEBUG=true');
      expect(r.redactionCount).toBe(0);
    });

    it('handles quoted env values', () => {
      const r = redactSecrets('PASSWORD="hunter2hunter2"');
      expect(r.text).not.toContain('hunter2hunter2');
      expect(r.text).toContain('PASSWORD=<REDACTED:env-secret>');
    });
  });

  describe('counts and kinds reporting', () => {
    it('counts every match', () => {
      const r = redactSecrets(`ghp_${'a'.repeat(36)} and ghp_${'b'.repeat(36)}`);
      expect(r.redactionCount).toBe(2);
      expect(r.kinds).toEqual(['github-pat']);
    });

    it('deduplicates kinds across calls', () => {
      const r = redactSecrets(`ghp_${'a'.repeat(36)} xoxb-1234567890-abcdef AKIAIOSFODNN7EXAMPLE`);
      expect(r.kinds.length).toBe(3);
      expect(new Set(r.kinds).size).toBe(3);
    });
  });

  describe('regex state isolation', () => {
    it('produces consistent output across multiple invocations', () => {
      const input = `ghp_${'z'.repeat(36)}`;
      const first = redactSecrets(input).text;
      const second = redactSecrets(input).text;
      const third = redactSecrets(input).text;
      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });

  describe('redactSecretsString convenience helper', () => {
    it('returns just the masked text', () => {
      const out = redactSecretsString(`ghp_${'q'.repeat(36)}`);
      expect(out).toContain('<REDACTED:');
      expect(typeof out).toBe('string');
    });
  });
});
