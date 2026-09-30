# Channel post branding: cover, rubric and "why it matters" line

## Goal

@ai_first_news had 3 subscribers and looked like a faceless aggregator: stock
photos from the sources, no reason to read us instead of the source channel.
Every post in the channel now carries a branded cover, a rubric hashtag and a
one-line practical takeaway for developers ("💡 Зачем тебе это:").

## Decisions (owner, 2026-10-01)

| Question | Decision |
|---|---|
| Logo | Variant B: black `>_` on an orange square (`assets/brand/`), set on the channel by hand |
| Which posts | Retellings and blog announcements (news, releases, digest) |
| When the cover is used | Always; source photos and blog covers are no longer posted |
| Renderer | `@resvg/resvg-js` (prebuilt binaries, no build on the VDS) + JetBrains Mono (OFL) |
| Evals | Re-recorded live on the production model (openrouter `openai/gpt-6-luna`) |

## Design

- **Dress** (`src/llm/dressForChannel.ts`): one short call of the active model
  per post returns `{rubric, why, coverTitle, coverFact}`. One prompt serves
  retellings and announcements, so the blog rewrite prompt is untouched.
  Decoration only: mock mode, a model error or an invalid reply give `null`
  and the post goes out plain. A why line over 180 characters or with a link,
  and a fact over one cover line, are dropped. A field with a number the post
  does not have is dropped; in the cover title it drops the whole dress (an
  invented figure on the cover reads as our claim). The model may not pick
  `дайджест`: only code sets it.
- **Retelling**: the prompt target goes from 700 to 560 visible characters and
  the cap from 900 to 720, so body + why line + hashtag + source line fit the
  1024-character photo caption. The dress is made from the final (humanized)
  text and stored with the retelling (`rewrite_json.dress`); the why line is
  not humanized, so the code-owned label cannot be rewritten.
- **Cover** (`src/blog/renderCover.ts`): 1280×720 SVG → PNG, rendered at
  publish time (a retelling saved before this change gets one too). JetBrains
  Mono is monospaced, so title wrapping is exact; a title that needs more than
  three lines at 76 px drops to 60 px, then ends in "…". All text is
  XML-escaped. A render failure falls back to the old behaviour (source
  photos / blog cover URL); Telegram rejecting the cover falls back to text.
- **Announcements**: `CrossPostContent.dress` is a thunk, called only when the
  post is announced. `crossPostToChannel` takes a signal factory, so the 5 s
  Telegram timeout of auto-publish starts after the model call, not before.
  `backfill:channel` sends covers without a dress: no model spend on old posts.

## Found on the way

- At `max_tokens` 400 gpt-6-luna spent the whole budget on reasoning (270–480
  tokens) and returned an empty dress in 3 of 6 cases; the budget is 1200.
- The retell call (1200 tokens, unchanged) runs away into reasoning on very
  long posts: `llm-under-hood` came back empty in 3 of 5 runs at the new target
  and 4 of 5 at the old one. Pre-existing, left for a separate change.
