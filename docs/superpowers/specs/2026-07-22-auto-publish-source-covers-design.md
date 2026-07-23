# Automatic publishing and source covers

## Decision

Daily cron, `/fetch`, and `npm run fetch` process each fresh candidate through
the existing atomic lifecycle without waiting for Telegram approval:

`collected → rewriting → pending_review → publishing → published`

Manual URL/text ingest keeps the review buttons. Weekly email digest stays
unchanged.

## Safety

- Existing rewrite/publish claims remain the only state transition path.
- Definite publish failures return to `pending_review`.
- A response that may have committed moves to `needs_verification` and is never
  retried automatically.
- Telegram progress cards and channel cross-posts are best-effort; their failure
  cannot block or roll back a confirmed blog publish.
- Shutdown drains automatic jobs before closing SQLite.

## Cover priority

News publish resolves one cover for blog and Telegram:

1. RSS enclosure, Media RSS, or scraped OG cover in `imageUrl`.
2. First source article image persisted in `imageUrls`.
3. Existing themed default pool.

This also repairs already stored candidates whose source body image exists but
whose explicit cover is null.
