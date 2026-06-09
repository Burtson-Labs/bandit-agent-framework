# Retrieval & context

A model knows two things: what's baked into its weights (fixed, and often stale), and what's in its context window right now (fresh, but finite). Every capable agent lives or dies on how well it manages the second. This page covers the two techniques that do it — **retrieval** and **context engineering** — and how Bandit uses them.

---

## Retrieval (RAG)

**Retrieval-Augmented Generation** (Lewis et al., 2020) is the original move: instead of hoping the answer is in the model's weights, fetch relevant text from an external source and put it in the prompt, so the model generates an answer *grounded* in real documents. The 2020 paper paired a dense retriever over Wikipedia with a seq2seq generator and beat parametric-only models on knowledge-intensive tasks. The shape it introduced — **embed your corpus, embed the query, fetch the nearest chunks, generate over them** — is now everywhere.

Retrieval works because similarity in embedding space approximates relevance: encode text as vectors and the cosine distance between them tracks how related they are. That lets you search a million documents by *meaning*, not keywords.

## Context engineering

Retrieval answers "what do I fetch?" Context engineering answers the bigger question: "given a finite window, what belongs in it *right now*?" Anthropic frames it as a first-class discipline; Karpathy's framing is the sharpest — the LLM is a new kind of computer, and the **context window is its RAM**. The job is to fill that RAM, at each step, with exactly the information the next step needs — no more (tokens and attention are scarce) and no less.

Everything Bandit does with the prompt is context engineering: which files to show, how much [memory](./memory.html) to keep always-loaded versus index for later, when to compact older turns, which [tools](./tools.html) to expose for *this* task via [skills](./skills.html).

## How Bandit applies it

Bandit uses embeddings, but it's worth being precise about *where* — it is not classical answer-time RAG. Bandit retrieves to **decide what enters the context window**, not to inject document chunks into its answers:

- **Semantic code search** — the `search/semantic` [skill](./skills.html) (auto-activated on "how does…", "where is…") embeds code and finds the relevant spots by meaning, so the agent can navigate an unfamiliar repo.
- **Embedding-guided file selection** — when planning against a goal, Bandit embeds the goal and the workspace, and the nearest files are merged into the planning context. Embeddings narrow *which* files the planner sees; the planner then reads them with normal [tools](./tools.html).

The embedding model is `nomic-embed-text` locally via Ollama, or a managed index through the Bandit gateway, with cosine similarity and a plain file-index fallback when neither is available. The point of the distinction: most "RAG" you read about is retrieval for *grounding answers*; Bandit's is retrieval for *budgeting context* — same machinery, different job, and being honest about which keeps expectations right.

---

## Sources

- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) — Lewis et al., 2020. The original RAG paper.
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic. Context as a managed, finite resource.
- [Context Engineering for Agents](https://www.langchain.com/blog/context-engineering-for-agents) — LangChain. A survey of write / select / compress / isolate strategies.

**Next:** [Memory as synthesis](./memory-as-synthesis.html) · [Memory](./memory.html) · [Providers & models](./providers-and-models.html)
