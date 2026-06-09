import type { PlanStep } from '../internalTypes';
import type {
  HelperStepMetadata,
  HelperStepRole,
  CallerStepMetadata,
  RelatedStepMetadata,
  RelatedStepRole
} from '../internalTypes';

function readMetadataString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readMetadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => readMetadataString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function readHelperRole(value: unknown): HelperStepRole | undefined {
  if (value === 'rewrite' || value === 'write' || value === 'review') {
    return value;
  }
  return undefined;
}

function readRelatedRole(value: unknown): RelatedStepRole | undefined {
  if (value === 'read' || value === 'rewrite' || value === 'write' || value === 'review') {
    return value;
  }
  return undefined;
}

export function parseHelperStepMetadata(step: PlanStep): HelperStepMetadata | undefined {
  const metadata = step.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  if ((metadata as { chainKind?: unknown }).chainKind !== 'helper') {
    return undefined;
  }
  return {
    chainKind: 'helper',
    role: readHelperRole((metadata as { role?: unknown }).role),
    helperId: readMetadataString((metadata as { helperId?: unknown }).helperId),
    helperPath: readMetadataString((metadata as { helperPath?: unknown }).helperPath),
    snippetRef: readMetadataString((metadata as { snippetRef?: unknown }).snippetRef),
    pathRef: readMetadataString((metadata as { pathRef?: unknown }).pathRef),
    outputRef: readMetadataString((metadata as { outputRef?: unknown }).outputRef),
    diffRef: readMetadataString((metadata as { diffRef?: unknown }).diffRef),
    reviewRef: readMetadataString((metadata as { reviewRef?: unknown }).reviewRef)
  };
}

export function parseCallerStepMetadata(step: PlanStep): CallerStepMetadata | undefined {
  const metadata = step.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  if ((metadata as { chainKind?: unknown }).chainKind !== 'caller') {
    return undefined;
  }
  return {
    chainKind: 'caller',
    role: readHelperRole((metadata as { role?: unknown }).role),
    helperIds: readMetadataStringArray((metadata as { helperIds?: unknown }).helperIds),
    helperPaths: readMetadataStringArray((metadata as { helperPaths?: unknown }).helperPaths),
    snippetRef: readMetadataString((metadata as { snippetRef?: unknown }).snippetRef)
  };
}

export function parseRelatedStepMetadata(step: PlanStep): RelatedStepMetadata | undefined {
  const metadata = step.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  if ((metadata as { chainKind?: unknown }).chainKind !== 'related') {
    return undefined;
  }
  return {
    chainKind: 'related',
    role: readRelatedRole((metadata as { role?: unknown }).role),
    targetPath: readMetadataString((metadata as { targetPath?: unknown }).targetPath),
    pathRef: readMetadataString((metadata as { pathRef?: unknown }).pathRef),
    diffRef: readMetadataString((metadata as { diffRef?: unknown }).diffRef),
    reviewRef: readMetadataString((metadata as { reviewRef?: unknown }).reviewRef)
  };
}
