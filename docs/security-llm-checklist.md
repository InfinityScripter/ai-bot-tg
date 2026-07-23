# LLM security checklist

Adapted from the OWASP GenAI Top 10 (https://genai.owasp.org/llm-top-10/) and
mapped to this bot's actual attack surfaces. Run through it whenever you touch
the LLM layer (`src/llm/`), prompts, the publish path, or add a provider /
tool / new LLM-powered feature. Items marked **[invariant]** already hold in
the codebase — do not regress them.

## Threat model in one paragraph

Every RSS item, manually ingested URL, and pasted text is **untrusted input
that ends up inside LLM prompts** (classification and rewrite). A hostile feed
can therefore attempt prompt injection. The model's output becomes a blog post
published over HTTP — so LLM output is also untrusted. The owner DM review
(🔄 → ✅) is the main human gate; the control server and blog API tokens are
the secrets worth stealing.

## Checklist

### LLM01 — Prompt injection
- [ ] **[invariant]** Feed/article text is data, not instructions: rewrite and
      relevance prompts must keep source content clearly delimited; never let
      fetched text define new tasks, tools, or output destinations.
- [ ] Permissions live in code, not in the system prompt: publishing requires
      the owner's ✅ press and the `BOT_API_TOKEN` path — a "please publish"
      inside an article must have no mechanism to act on.
- [ ] New prompt = new eval case: adversarial fixture with instructions
      embedded in the source text (`npm run eval`).

### LLM05 — Improper output handling
- [ ] **[invariant]** `finalizeRewrite` parses output Markdown into an AST,
      strips raw HTML, and allow-lists source-owned links/images. Any new
      output path (email digest, channel post, changelog) needs the same
      treatment — model output never reaches `innerHTML`/API payloads raw.
- [ ] Structured outputs go through zod schemas in `src/schemas/` — no
      `JSON.parse` + trust.

### LLM02 / LLM07 — Secret and system prompt disclosure
- [ ] No secrets in prompts: `BOT_API_TOKEN`, `BOT_CONTROL_TOKEN`, provider
      keys and `.env` values must never be interpolated into prompt text.
- [ ] Assume the system prompt can leak verbatim into a published post
      (injection + rewrite); keep it free of anything you would not publish.

### LLM06 — Excessive agency
- [ ] **[invariant]** The model rewrites text; it does not choose actions.
      Publishing, skipping, and model switching stay owner-initiated
      (✅ buttons, `/model`, control server). If a future feature gives the
      LLM tool access, destructive/irreversible calls require an explicit
      owner confirmation step.

### LLM10 — Unbounded consumption
- [ ] **[invariant]** Every provider call carries `LLM_TIMEOUT_MS` +
      `LLM_MAX_RETRIES`; the staged relevance filter keeps LLM calls to
      borderline items only. New LLM calls must reuse `chatCompletion.ts`
      and inherit these caps — no bare `fetch` to a provider.

### LLM03 / LLM04 — Supply chain and data poisoning
- [ ] New providers/models are added only in `providers.ts` after checking the
      vendor; lockfile stays pinned to `registry.npmjs.org` (see CLAUDE.md).
- [ ] New feeds are curated by hand; a feed is also a prompt-injection and
      poisoning vector, not just a content source.

### LLM09 — Misinformation
- [ ] **[invariant]** Owner reviews the PREVIEW card before publish — keep the
      human in the loop for anything reader-facing. Eval rules (no novel
      numbers, source-only links) are the automated backstop; extend them when
      the output contract grows.

## Non-LLM basics that still apply here

- Control server: localhost-only bind + constant-time Bearer comparison
  **[invariant]**; never widen the bind address for convenience.
- Error replies to Telegram must not include stack traces or SQL.
- `npm audit` on dependency bumps; watch `postinstall` scripts of new packages.
