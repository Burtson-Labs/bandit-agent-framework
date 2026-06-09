/**
 * Model behavior profiles describe how Bandit's harness should treat a
 * model, not just what the model can theoretically do.
 *
 * Capability profiles answer "does this model support tools / vision /
 * JSON?". Behavior profiles answer "which protocol should we try first,
 * how aggressively should we compact, how much parallelism is safe, and
 * what known failures should the UI or trace viewer explain?".
 */

export type ToolProtocol = 'native-tools' | 'text-tools';
export type ToolEnvelope = 'ollama-tools' | 'xml-json';
export type PromptTemplateId = 'qwen-agent' | 'gemma-compact' | 'llama-tool-lite' | 'default-agent';
export type CompactionMode = 'early' | 'normal' | 'aggressive';
export type ThinkingDefault = 'on' | 'off' | 'auto';
export const MODEL_BEHAVIOR_CONFIG_SCHEMA_VERSION = 1;

export interface ModelBehaviorProfile {
  /** Stable profile id, e.g. qwen3.6 or gemma4. */
  id: string;
  /** Prefixes matched against the configured model id. Longest wins. */
  match: string[];
  label: string;
  protocol: {
    preferred: ToolProtocol;
    fallback?: ToolProtocol;
    envelope: ToolEnvelope;
    nativeToolFailureFallback: boolean;
  };
  context: {
    safeInputTokens: number;
    outputBudgetTokens: number;
    compaction: CompactionMode;
  };
  prompting: {
    template: PromptTemplateId;
    examples: 'none' | 'minimal' | 'strict';
    thinking: ThinkingDefault;
  };
  reliability: {
    maxParallelTools: number;
    retryableErrors: string[];
    knownFailureModes: string[];
  };
}

export type ModelBehaviorOverride = Partial<Omit<ModelBehaviorProfile, 'protocol' | 'context' | 'prompting' | 'reliability'>> & {
  protocol?: Partial<ModelBehaviorProfile['protocol']>;
  context?: Partial<ModelBehaviorProfile['context']>;
  prompting?: Partial<ModelBehaviorProfile['prompting']>;
  reliability?: Partial<ModelBehaviorProfile['reliability']>;
};

export interface ModelBehaviorConfigEntry {
  /** Record key or id from the config file. Useful for diagnostics. */
  key: string;
  /** Prefixes that should receive this override. */
  match: string[];
  /** Sanitized override registered into the runtime. */
  override: ModelBehaviorOverride;
}

export interface ModelBehaviorConfigParseResult {
  entries: ModelBehaviorConfigEntry[];
  errors: string[];
  warnings: string[];
}

const COMMON_RETRYABLE_ERRORS = [
  '5xx gateway/model errors',
  'ECONNRESET / ECONNREFUSED / ETIMEDOUT',
  'fetch failed / socket hang up'
];

const BUILT_IN_BEHAVIOR_PROFILES: ModelBehaviorProfile[] = [
  {
    id: 'bandit-logic',
    match: ['bandit-logic'],
    label: 'Bandit Logic / Qwen 3.6 agent profile',
    protocol: {
      preferred: 'native-tools',
      fallback: 'text-tools',
      envelope: 'ollama-tools',
      nativeToolFailureFallback: true
    },
    context: {
      safeInputTokens: 64000,
      outputBudgetTokens: 8192,
      compaction: 'normal'
    },
    prompting: {
      template: 'qwen-agent',
      examples: 'minimal',
      thinking: 'on'
    },
    reliability: {
      maxParallelTools: 6,
      retryableErrors: [...COMMON_RETRYABLE_ERRORS, 'Qwen tool-call parser EOF'],
      knownFailureModes: [
        'Native tool parser can return upstream 500 on malformed/incomplete tool calls.',
        'Reasoning-only stalls are possible when thinking is disabled.'
      ]
    }
  },
  {
    id: 'qwen3.6',
    match: ['qwen3.6'],
    label: 'Qwen 3.6 agent profile',
    protocol: {
      preferred: 'native-tools',
      fallback: 'text-tools',
      envelope: 'ollama-tools',
      nativeToolFailureFallback: true
    },
    context: {
      safeInputTokens: 64000,
      outputBudgetTokens: 8192,
      compaction: 'normal'
    },
    prompting: {
      template: 'qwen-agent',
      examples: 'minimal',
      thinking: 'on'
    },
    reliability: {
      maxParallelTools: 6,
      retryableErrors: [...COMMON_RETRYABLE_ERRORS, 'Qwen tool-call parser EOF'],
      knownFailureModes: [
        'Can spend a long prefill/thinking phase before first token.',
        'Native tool parsing is valuable but should degrade to text tools on upstream parser failures.'
      ]
    }
  },
  {
    id: 'gemma4',
    match: ['gemma4', 'gemma3', 'bandit-core:12b', 'bandit-core:27b', 'bandit-core:31b'],
    label: 'Gemma-family / bandit-core agent profile',
    protocol: {
      // gemma3-derived models (gemma4, bandit-core ≥12B) expose native tool
      // calling in Ollama (`Capabilities: tools`). Prefer it — the chat
      // template enforces a structured tool call, which eliminates most of
      // the "narrate intent instead of acting" / malformed-XML failures the
      // text-tools path produced. Fall back to text-tools on upstream parser
      // failures (same safety net as bandit-logic/qwen).
      preferred: 'native-tools',
      fallback: 'text-tools',
      envelope: 'ollama-tools',
      nativeToolFailureFallback: true
    },
    context: {
      safeInputTokens: 24000,
      outputBudgetTokens: 2048,
      compaction: 'early'
    },
    prompting: {
      template: 'gemma-compact',
      examples: 'strict',
      thinking: 'auto'
    },
    reliability: {
      maxParallelTools: 2,
      retryableErrors: COMMON_RETRYABLE_ERRORS,
      knownFailureModes: [
        'More likely to narrate intent than emit a tool call without compact, explicit examples.',
        'Large multi-edit batches should be serialized.'
      ]
    }
  },
  {
    id: 'qwen2.5-coder',
    match: ['qwen2.5-coder'],
    label: 'Qwen 2.5 Coder profile',
    protocol: {
      preferred: 'native-tools',
      fallback: 'text-tools',
      envelope: 'ollama-tools',
      nativeToolFailureFallback: true
    },
    context: {
      safeInputTokens: 32000,
      outputBudgetTokens: 4096,
      compaction: 'normal'
    },
    prompting: {
      template: 'qwen-agent',
      examples: 'minimal',
      thinking: 'auto'
    },
    reliability: {
      maxParallelTools: 4,
      retryableErrors: COMMON_RETRYABLE_ERRORS,
      knownFailureModes: [
        'Completion-tuned variants may ask for paths instead of searching unless prompted to inspect first.'
      ]
    }
  },
  {
    id: 'llama3',
    match: ['llama3.2', 'llama3.1', 'llama3'],
    label: 'Llama lightweight tool profile',
    protocol: {
      preferred: 'text-tools',
      fallback: undefined,
      envelope: 'xml-json',
      nativeToolFailureFallback: false
    },
    context: {
      safeInputTokens: 12000,
      outputBudgetTokens: 1024,
      compaction: 'aggressive'
    },
    prompting: {
      template: 'llama-tool-lite',
      examples: 'strict',
      thinking: 'auto'
    },
    reliability: {
      maxParallelTools: 1,
      retryableErrors: COMMON_RETRYABLE_ERRORS,
      knownFailureModes: [
        'Small variants need narrow context and one tool at a time.'
      ]
    }
  },
  {
    id: 'deepseek-r1',
    match: ['deepseek-r1'],
    label: 'DeepSeek R1 reasoning profile',
    protocol: {
      preferred: 'text-tools',
      fallback: undefined,
      envelope: 'xml-json',
      nativeToolFailureFallback: false
    },
    context: {
      safeInputTokens: 24000,
      outputBudgetTokens: 2048,
      compaction: 'early'
    },
    prompting: {
      template: 'default-agent',
      examples: 'strict',
      thinking: 'on'
    },
    reliability: {
      maxParallelTools: 1,
      retryableErrors: COMMON_RETRYABLE_ERRORS,
      knownFailureModes: [
        'Reasoning models can narrate for a long time before acting; keep context narrow and tool calls serialized.'
      ]
    }
  },
  {
    id: 'default',
    match: [''],
    label: 'Default conservative profile',
    protocol: {
      preferred: 'text-tools',
      fallback: undefined,
      envelope: 'xml-json',
      nativeToolFailureFallback: false
    },
    context: {
      safeInputTokens: 8000,
      outputBudgetTokens: 1024,
      compaction: 'aggressive'
    },
    prompting: {
      template: 'default-agent',
      examples: 'strict',
      thinking: 'auto'
    },
    reliability: {
      maxParallelTools: 1,
      retryableErrors: COMMON_RETRYABLE_ERRORS,
      knownFailureModes: [
        'Unknown model: assume limited context, text tool protocol, and serialized tool use.'
      ]
    }
  }
];

const runtimeBehaviorOverrides = new Map<string, ModelBehaviorOverride>();

export function registerModelBehaviorOverride(modelIdOrPrefix: string, override: ModelBehaviorOverride): void {
  const key = modelIdOrPrefix.trim().toLowerCase();
  if (!key) {return;}
  runtimeBehaviorOverrides.set(key, override);
}

export function registerModelBehaviorConfig(input: unknown): ModelBehaviorConfigParseResult {
  const result = parseModelBehaviorConfig(input);
  for (const entry of result.entries) {
    for (const prefix of entry.match) {
      registerModelBehaviorOverride(prefix, entry.override);
    }
  }
  return result;
}

export function clearModelBehaviorOverrides(): void {
  runtimeBehaviorOverrides.clear();
}

export function getBuiltInModelBehaviorProfiles(): ModelBehaviorProfile[] {
  return BUILT_IN_BEHAVIOR_PROFILES.map(cloneProfile);
}

export function getModelBehaviorProfile(modelId: string): ModelBehaviorProfile {
  const lower = modelId.toLowerCase();
  const base = cloneProfile(findBestProfile(lower));
  const override = findBestOverride(lower);
  return override ? mergeProfile(base, override) : base;
}

function findBestProfile(lowerModelId: string): ModelBehaviorProfile {
  let best = BUILT_IN_BEHAVIOR_PROFILES[BUILT_IN_BEHAVIOR_PROFILES.length - 1];
  let bestLength = -1;
  for (const profile of BUILT_IN_BEHAVIOR_PROFILES) {
    for (const prefix of profile.match) {
      const normalized = prefix.toLowerCase();
      if (lowerModelId.startsWith(normalized) && normalized.length > bestLength) {
        best = profile;
        bestLength = normalized.length;
      }
    }
  }
  return best;
}

function findBestOverride(lowerModelId: string): ModelBehaviorOverride | undefined {
  let best: ModelBehaviorOverride | undefined;
  let bestLength = -1;
  for (const [prefix, override] of runtimeBehaviorOverrides) {
    if (lowerModelId.startsWith(prefix) && prefix.length > bestLength) {
      best = override;
      bestLength = prefix.length;
    }
  }
  return best;
}

function cloneProfile(profile: ModelBehaviorProfile): ModelBehaviorProfile {
  return {
    ...profile,
    match: [...profile.match],
    protocol: { ...profile.protocol },
    context: { ...profile.context },
    prompting: { ...profile.prompting },
    reliability: {
      ...profile.reliability,
      retryableErrors: [...profile.reliability.retryableErrors],
      knownFailureModes: [...profile.reliability.knownFailureModes]
    }
  };
}

function mergeProfile(base: ModelBehaviorProfile, override: ModelBehaviorOverride): ModelBehaviorProfile {
  return {
    ...base,
    ...override,
    match: override.match ? [...override.match] : base.match,
    protocol: { ...base.protocol, ...override.protocol },
    context: { ...base.context, ...override.context },
    prompting: { ...base.prompting, ...override.prompting },
    reliability: {
      ...base.reliability,
      ...override.reliability,
      retryableErrors: override.reliability?.retryableErrors
        ? [...override.reliability.retryableErrors]
        : base.reliability.retryableErrors,
      knownFailureModes: override.reliability?.knownFailureModes
        ? [...override.reliability.knownFailureModes]
        : base.reliability.knownFailureModes
    }
  };
}

export function parseModelBehaviorConfig(input: unknown): ModelBehaviorConfigParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = asRecord(input);
  if (!root) {
    return { entries: [], errors: ['model behavior config must be a JSON object'], warnings };
  }

  const version = root.version ?? root.schemaVersion;
  if (version !== undefined && version !== MODEL_BEHAVIOR_CONFIG_SCHEMA_VERSION) {
    warnings.push(`schema version ${String(version)} is not recognized; parsing compatible fields only`);
  }

  const rawProfiles = root.profiles ?? root.models;
  if (!rawProfiles) {
    return { entries: [], errors: ['model behavior config must define a profiles object'], warnings };
  }

  const rawEntries: Array<{ key: string; value: unknown }> = [];
  if (Array.isArray(rawProfiles)) {
    rawProfiles.forEach((value, index) => {
      const record = asRecord(value);
      const id = typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : `profiles[${index}]`;
      rawEntries.push({ key: id, value });
    });
  } else {
    const record = asRecord(rawProfiles);
    if (!record) {
      return { entries: [], errors: ['profiles must be an object or array'], warnings };
    }
    for (const [key, value] of Object.entries(record)) {
      rawEntries.push({ key, value });
    }
  }

  const entries: ModelBehaviorConfigEntry[] = [];
  for (const { key, value } of rawEntries) {
    const record = asRecord(value);
    if (!record) {
      warnings.push(`${key}: profile must be an object`);
      continue;
    }
    const match = stringList(record.match, `${key}.match`, warnings);
    const prefixes = match.length ? match : [key];
    const cleanPrefixes = prefixes.map((prefix) => prefix.trim()).filter(Boolean);
    if (cleanPrefixes.length === 0) {
      warnings.push(`${key}: profile has no usable match prefixes`);
      continue;
    }

    const override = parseModelBehaviorOverride(key, record, warnings);
    entries.push({ key, match: cleanPrefixes, override: { ...override, match: cleanPrefixes } });
  }

  return { entries, errors, warnings };
}

function parseModelBehaviorOverride(
  key: string,
  record: Record<string, unknown>,
  warnings: string[]
): ModelBehaviorOverride {
  const override: ModelBehaviorOverride = {};
  const id = stringValue(record.id, `${key}.id`, warnings);
  const label = stringValue(record.label, `${key}.label`, warnings);
  if (id) {override.id = id;}
  if (label) {override.label = label;}

  const protocol = asRecord(record.protocol);
  if (protocol) {
    const parsedProtocol: ModelBehaviorOverride['protocol'] = {};
    const preferred = enumValue<ToolProtocol>(protocol.preferred, ['native-tools', 'text-tools'], `${key}.protocol.preferred`, warnings);
    const fallback = enumValue<ToolProtocol>(protocol.fallback, ['native-tools', 'text-tools'], `${key}.protocol.fallback`, warnings, true);
    const envelope = enumValue<ToolEnvelope>(protocol.envelope, ['ollama-tools', 'xml-json'], `${key}.protocol.envelope`, warnings);
    const nativeFallback = booleanValue(protocol.nativeToolFailureFallback, `${key}.protocol.nativeToolFailureFallback`, warnings);
    if (preferred) {parsedProtocol.preferred = preferred;}
    if ('fallback' in protocol) {parsedProtocol.fallback = fallback;}
    if (envelope) {parsedProtocol.envelope = envelope;}
    if (nativeFallback !== undefined) {parsedProtocol.nativeToolFailureFallback = nativeFallback;}
    override.protocol = parsedProtocol;
  } else if (record.protocol !== undefined) {
    warnings.push(`${key}.protocol must be an object`);
  }

  const context = asRecord(record.context);
  if (context) {
    const parsedContext: ModelBehaviorOverride['context'] = {};
    const safeInputTokens = positiveInteger(context.safeInputTokens, `${key}.context.safeInputTokens`, warnings);
    const outputBudgetTokens = positiveInteger(context.outputBudgetTokens, `${key}.context.outputBudgetTokens`, warnings);
    const compaction = enumValue<CompactionMode>(context.compaction, ['early', 'normal', 'aggressive'], `${key}.context.compaction`, warnings);
    if (safeInputTokens !== undefined) {parsedContext.safeInputTokens = safeInputTokens;}
    if (outputBudgetTokens !== undefined) {parsedContext.outputBudgetTokens = outputBudgetTokens;}
    if (compaction) {parsedContext.compaction = compaction;}
    override.context = parsedContext;
  } else if (record.context !== undefined) {
    warnings.push(`${key}.context must be an object`);
  }

  const prompting = asRecord(record.prompting);
  if (prompting) {
    const parsedPrompting: ModelBehaviorOverride['prompting'] = {};
    const template = enumValue<PromptTemplateId>(prompting.template, ['qwen-agent', 'gemma-compact', 'llama-tool-lite', 'default-agent'], `${key}.prompting.template`, warnings);
    const examples = enumValue<'none' | 'minimal' | 'strict'>(prompting.examples, ['none', 'minimal', 'strict'], `${key}.prompting.examples`, warnings);
    const thinking = enumValue<ThinkingDefault>(prompting.thinking, ['on', 'off', 'auto'], `${key}.prompting.thinking`, warnings);
    if (template) {parsedPrompting.template = template;}
    if (examples) {parsedPrompting.examples = examples;}
    if (thinking) {parsedPrompting.thinking = thinking;}
    override.prompting = parsedPrompting;
  } else if (record.prompting !== undefined) {
    warnings.push(`${key}.prompting must be an object`);
  }

  const reliability = asRecord(record.reliability);
  if (reliability) {
    const parsedReliability: ModelBehaviorOverride['reliability'] = {};
    const maxParallelTools = positiveInteger(reliability.maxParallelTools, `${key}.reliability.maxParallelTools`, warnings);
    const retryableErrors = stringList(reliability.retryableErrors, `${key}.reliability.retryableErrors`, warnings);
    const knownFailureModes = stringList(reliability.knownFailureModes, `${key}.reliability.knownFailureModes`, warnings);
    if (maxParallelTools !== undefined) {parsedReliability.maxParallelTools = maxParallelTools;}
    if (Array.isArray(reliability.retryableErrors)) {parsedReliability.retryableErrors = retryableErrors;}
    if (Array.isArray(reliability.knownFailureModes)) {parsedReliability.knownFailureModes = knownFailureModes;}
    override.reliability = parsedReliability;
  } else if (record.reliability !== undefined) {
    warnings.push(`${key}.reliability must be an object`);
  }

  return override;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown, field: string, warnings: string[]): string | undefined {
  if (value === undefined) {return undefined;}
  if (typeof value !== 'string') {
    warnings.push(`${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function stringList(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) {return [];}
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${field} must be a string or string array`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    } else {
      warnings.push(`${field} contains a non-string entry`);
    }
  }
  return out;
}

function booleanValue(value: unknown, field: string, warnings: string[]): boolean | undefined {
  if (value === undefined) {return undefined;}
  if (typeof value === 'boolean') {return value;}
  warnings.push(`${field} must be a boolean`);
  return undefined;
}

function positiveInteger(value: unknown, field: string, warnings: string[]): number | undefined {
  if (value === undefined) {return undefined;}
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {return value;}
  warnings.push(`${field} must be a positive integer`);
  return undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  warnings: string[],
  allowNull = false
): T | undefined {
  if (value === undefined) {return undefined;}
  if (value === null && allowNull) {return undefined;}
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {return value as T;}
  warnings.push(`${field} must be one of: ${allowed.join(', ')}`);
  return undefined;
}
