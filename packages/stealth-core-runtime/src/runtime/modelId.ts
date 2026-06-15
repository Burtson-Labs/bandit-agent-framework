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
  // Strip runtime/placement markers that don't change WHICH model it is, so
  // the variant resolves to the same family profile + runtime cache entry as
  // its base tag:
  //   - Ollama Cloud: a `-cloud` suffix on a tag ('kimi-k2:1t-cloud',
  //     'gpt-oss:120b-cloud') OR a bare `:cloud` tag ('kimi-k2.7-code:cloud').
  //   - Apple-silicon MLX builds: a `-mlx` suffix ('qwen3.6:27b-mlx',
  //     'gemma4:26b-mlx') — same weights, different runtime.
  const deSuffix = lower.replace(/(?:[-:]cloud|-mlx)$/, '');
  const forms = deSuffix !== lower ? [lower, deSuffix] : [lower];
  for (const form of forms) {
    push(form);
    // 'qwen/qwen2.5-coder-32b-instruct' → 'qwen2.5-coder-32b-instruct'
    const slash = form.lastIndexOf('/');
    const base = slash === -1 ? form : form.slice(slash + 1);
    push(base);
    // 'meta-llama-3.1-8b-instruct' → 'llama-3.1-8b-instruct'
    const unvendored = base.replace(/^meta-/, '');
    push(unvendored);
    // 'llama-3.1-8b-instruct' → 'llama3.1-8b-instruct' (Ollama family names
    // drop the dash between family and version digits)
    push(unvendored.replace(/^([a-z]+)-(?=\d)/, '$1'));
  }
  return out;
}
