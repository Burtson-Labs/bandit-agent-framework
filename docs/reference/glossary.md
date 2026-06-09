# Glossary

Plain-English definitions for the terms you'll meet across these docs and the wider agent world. Two markers:

- **→** points to where Bandit implements the idea.
- **Source** links the primary reference, for the terms that have one.

---

- <span id="agent" class="gloss-anchor"></span>**Agent** — An LLM that uses tools in a loop, acting on real feedback instead of answering in one shot. The architecture is simple; the power is in the loop. → [The agent loop](./the-agent-loop.html). Source: [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents).

- <span id="chain-of-thought" class="gloss-anchor"></span>**Chain-of-thought (CoT)** — Prompting a model to reason step by step before answering, which lifts accuracy on hard problems. Source: [Wei et al., 2022](https://arxiv.org/abs/2201.11903).

- <span id="compaction" class="gloss-anchor"></span>**Compaction** — Summarizing older turns when the context window fills, so a long session can keep going. → [How a turn works](./how-a-turn-works.html).

- <span id="context-engineering" class="gloss-anchor"></span>**Context engineering** — The discipline of choosing what goes into the model's limited context window at each step. → [Retrieval & context](./retrieval-and-context.html). Source: [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

- <span id="context-window" class="gloss-anchor"></span>**Context window** — Everything the model can consider at once, measured in tokens — its working memory, like RAM. → [Providers & models](./providers-and-models.html).

- <span id="cosine-similarity" class="gloss-anchor"></span>**Cosine similarity** — A measure of how close two embedding vectors are; used to rank text by meaning. → [Retrieval & context](./retrieval-and-context.html).

- <span id="embedding" class="gloss-anchor"></span>**Embedding** — A vector of numbers capturing the meaning of text, so similar meanings land close together. Source: [Mikolov et al., 2013 (word2vec)](https://arxiv.org/abs/1301.3781).

- <span id="fine-tuning" class="gloss-anchor"></span>**Fine-tuning** — Further training a base model on extra data to specialize it — as opposed to prompting, which changes nothing in the weights.

- <span id="hallucination" class="gloss-anchor"></span>**Hallucination** — When a model states something false with confidence. The agent loop curbs it by grounding answers in real tool results. → [The agent loop](./the-agent-loop.html).

- <span id="host" class="gloss-anchor"></span>**Host** — The layer that wires a provider, tools, and environment adapters into a working agent. The Bandit CLI and extension are both hosts. → [Build your own host](./build-your-own-host.html).

- <span id="inference" class="gloss-anchor"></span>**Inference** — Running a trained model to produce output (versus training it in the first place).

- <span id="llm" class="gloss-anchor"></span>**LLM (large language model)** — A model trained to predict text. The engine inside every agent.

- <span id="local-model" class="gloss-anchor"></span>**Local model** — A model that runs on your own hardware (e.g. via Ollama), so prompts never leave the machine. → [Providers & models](./providers-and-models.html).

- <span id="mcp" class="gloss-anchor"></span>**MCP (Model Context Protocol)** — An open standard for exposing tools and data to an agent over a uniform interface. → [MCP connectors](./mcp.html). Source: [modelcontextprotocol.io](https://modelcontextprotocol.io).

- <span id="memory" class="gloss-anchor"></span>**Memory** — Durable facts an agent carries between sessions; in Bandit, curated markdown rather than a vector store. → [Memory](./memory.html), [Memory as synthesis](./memory-as-synthesis.html).

- <span id="multimodal" class="gloss-anchor"></span>**Multimodal** — A model that accepts more than text, such as images. → [Providers & models](./providers-and-models.html).

- <span id="prompt" class="gloss-anchor"></span>**Prompt** — The text given to a model. The **system prompt** sets the rules and context; the user prompt is the request.

- <span id="prompt-injection" class="gloss-anchor"></span>**Prompt injection** — An attack where untrusted input hijacks the model's instructions — SQL injection for prompts. Source: [Simon Willison, 2022](https://simonwillison.net/tags/prompt-injection/).

- <span id="provider" class="gloss-anchor"></span>**Provider** — The backend that runs a model: local (Ollama), an OpenAI-compatible endpoint, or a cloud gateway. → [Providers & models](./providers-and-models.html).

- <span id="quantization" class="gloss-anchor"></span>**Quantization** — Compressing a model's weights to lower precision so it runs on smaller hardware, trading a little accuracy for speed and size.

- <span id="rag" class="gloss-anchor"></span>**RAG (retrieval-augmented generation)** — Fetching relevant text and putting it in the prompt so the model answers from real sources, not just its weights. Source: [Lewis et al., 2020](https://arxiv.org/abs/2005.11401). → [Retrieval & context](./retrieval-and-context.html).

- <span id="react" class="gloss-anchor"></span>**ReAct** — Interleaving reasoning and actions so each tool result informs the next thought. Source: [Yao et al., 2022](https://arxiv.org/abs/2210.03629). → [The agent loop](./the-agent-loop.html).

- <span id="reasoning" class="gloss-anchor"></span>**Reasoning / thinking mode** — Models that produce an internal reasoning trace before answering; Bandit toggles it per model. → [Providers & models](./providers-and-models.html).

- <span id="skill" class="gloss-anchor"></span>**Skill** — A bundle of tools plus guidance and rules for when they activate. → [Skills](./skills.html).

- <span id="streaming" class="gloss-anchor"></span>**Streaming** — Returning output token by token as it's generated, rather than waiting for the whole response.

- <span id="subagent" class="gloss-anchor"></span>**Subagent** — A focused, short-lived agent spawned to handle a sub-task with its own budget. → [Tools](./tools.html) (the `task` tool).

- <span id="temperature" class="gloss-anchor"></span>**Temperature** — A sampling setting for randomness: lower is more deterministic, higher more varied.

- <span id="token" class="gloss-anchor"></span>**Token** — The unit of text a model reads and writes — roughly a word-piece. Context windows and budgets are counted in tokens.

- <span id="tool-use" class="gloss-anchor"></span>**Tool use (function calling)** — Giving a model the ability to call a defined function and act in the world. → [Tools](./tools.html). Source: [Writing Effective Tools for AI Agents](https://www.anthropic.com/engineering/writing-tools-for-agents).

- <span id="tool-calling-protocol" class="gloss-anchor"></span>**Tool-calling protocol** — How tool calls are encoded: native function-calling, or Bandit's text-based protocol (steadier for small models). → [Providers & models](./providers-and-models.html).

- <span id="transformer" class="gloss-anchor"></span>**Transformer** — The neural-network architecture behind modern LLMs, built on attention. Source: [Vaswani et al., 2017](https://arxiv.org/abs/1706.03762).

- <span id="vector-semantic-search" class="gloss-anchor"></span>**Vector / semantic search** — Searching by meaning using embeddings instead of keywords. → [Retrieval & context](./retrieval-and-context.html).

- <span id="workflow-vs-agent" class="gloss-anchor"></span>**Workflow vs. agent** — A workflow runs predefined steps; an agent decides its own steps in a loop. Source: [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents).

**Next:** [The agent loop](./the-agent-loop.html) · [Retrieval & context](./retrieval-and-context.html) · [Quickstart](./quickstart.html)
