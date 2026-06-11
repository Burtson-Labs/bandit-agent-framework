/**
 * Candidate lowercase forms of a model id for prefix matching against the
 * built-in capability/behavior tables, which use Ollama-style names
 * ('llama3.1', 'qwen2.5-coder', 'gemma4'). OpenAI-compatible servers and
 * routers report vendor-prefixed or HuggingFace-style ids
 * ('meta-llama/Llama-3.1-8B-Instruct', 'Qwen/Qwen2.5-Coder-32B-Instruct',
 * 'deepseek/deepseek-r1') that would otherwise miss every hand-tuned
 * profile and fall to worst-case defaults.
 *
 * Ordered most-literal first so an exact Ollama-style id always wins over
 * a transformed form.
 */
export function candidateModelIds(modelId: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value && !out.includes(value)) {out.push(value);}
  };
  const lower = modelId.toLowerCase().trim();
  push(lower);
  // 'qwen/qwen2.5-coder-32b-instruct' → 'qwen2.5-coder-32b-instruct'
  const slash = lower.lastIndexOf('/');
  const base = slash === -1 ? lower : lower.slice(slash + 1);
  push(base);
  // 'meta-llama-3.1-8b-instruct' → 'llama-3.1-8b-instruct'
  const unvendored = base.replace(/^meta-/, '');
  push(unvendored);
  // 'llama-3.1-8b-instruct' → 'llama3.1-8b-instruct' (Ollama family names
  // drop the dash between family and version digits)
  push(unvendored.replace(/^([a-z]+)-(?=\d)/, '$1'));
  return out;
}
