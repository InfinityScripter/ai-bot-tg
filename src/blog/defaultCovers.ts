/**
 * Default cover pools for bot-published posts, grouped by topic.
 *
 * When a feed item ships no image (and no og:image was scraped) we must still
 * send a coverUrl, otherwise every such post falls back to the backend's single
 * generic placeholder — the "all bot posts look identical" problem the owner hit.
 *
 * The old fix was ONE flat list of 5 images picked by a title hash: with only 5
 * slots the same few covers repeated constantly and never matched the subject.
 * This module fixes both complaints:
 *   - LARGE, de-duplicated pool (dozens of images) → far fewer repeats;
 *   - picked BY MEANING: the post's normalized tags choose a topical pool
 *     (AI / security / dev / gadgets / science / business / tech), so an AI post
 *     gets AI imagery and a security post gets security imagery;
 *   - a neutral UNIVERSAL pool is the fallback when no topical tag matches
 *     (e.g. политика / культура / a bare новости post).
 *
 * Every URL below was verified to return `200 image/*` from the Unsplash CDN
 * (images.unsplash.com — direct, hot-linkable file URLs, NOT the redirecting
 * source.unsplash.com), so covers actually load instead of 404-ing.
 */

/** AI / ML / LLM / agents / neural nets / robots — the blog's core topic. */
const AI_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1655720828018-edd2daec9349?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1591453089816-0fbb971b454c?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526378722484-bd91ca387e72?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1655635643532-fa9ba2648cbe?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1633493702341-4d04841df53b?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1712002641088-9d76f9080889?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1531746790731-6c087fecd65a?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1563207153-f403bf289096?auto=format&fit=crop&w=1200&q=80",
];

/** Cybersecurity — locks, code rain, network defence. */
const SECURITY_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1614064641938-3bbee52942c7?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1510511459019-5dda7724fd87?auto=format&fit=crop&w=1200&q=80",
];

/** Software development — code on screen, editors, terminals. */
const DEV_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1555949963-aa79dcee981c?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1542831371-29b0f74f9713?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1587620962725-abab7fe55159?auto=format&fit=crop&w=1200&q=80",
];

/** Gadgets & consumer hardware — phones, devices, desks. */
const GADGET_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1483058712412-4245e9b90334?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1573148195900-7845dcb9b127?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=1200&q=80",
];

/** Science — labs, space, research. */
const SCIENCE_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1628595351029-c2bf17511435?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1576086213369-97a306d36557?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1507413245164-6160d8298b31?auto=format&fit=crop&w=1200&q=80",
];

/** Business & markets — charts, analytics, finance. */
const BUSINESS_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1444653614773-995cb1ef9efa?auto=format&fit=crop&w=1200&q=80",
];

/** General tech — circuits, chips, data centres, networks. Doubles as neutral. */
const TECH_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1517420704952-d9f39e95b43e?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1550009158-9ebf69173e03?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1496096265110-f83ad7f96608?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1639322537228-f710d846310a?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1504868584819-f8e8b4b6d7e3?auto=format&fit=crop&w=1200&q=80",
];

/**
 * Neutral fallback for posts with no topical tag (политика / культура / a bare
 * новости item). A hand-picked cross-section of the topical pools — references,
 * not copies, so no URL string is duplicated in source; `.filter` keeps the type
 * `string[]` under noUncheckedIndexedAccess (every referenced index exists).
 */
const UNIVERSAL_COVERS: readonly string[] = [
  TECH_COVERS[0],
  TECH_COVERS[6],
  SECURITY_COVERS[1],
  AI_COVERS[0],
  SCIENCE_COVERS[0],
  DEV_COVERS[0],
].filter((url): url is string => Boolean(url));

/** Topical pools by id. `universal` is the fallback when no tag maps. */
const COVER_POOLS: Record<string, readonly string[]> = {
  ai: AI_COVERS,
  security: SECURITY_COVERS,
  dev: DEV_COVERS,
  gadgets: GADGET_COVERS,
  science: SCIENCE_COVERS,
  business: BUSINESS_COVERS,
  tech: TECH_COVERS,
  universal: UNIVERSAL_COVERS,
};

/**
 * Maps a normalized whitelist tag (see {@link TAG_WHITELIST}) to a cover pool id.
 * `новости` and tags without a visual theme (политика / культура) are absent on
 * purpose → they fall through to the universal pool.
 */
const TAG_TO_POOL: Record<string, string> = {
  ai: "ai",
  llm: "ai",
  агенты: "ai",
  нейросети: "ai",
  безопасность: "security",
  разработка: "dev",
  гаджеты: "gadgets",
  наука: "science",
  "наука и техника": "science",
  бизнес: "business",
  технологии: "tech",
};

/**
 * Every cover URL the picker can return, de-duplicated (the universal pool
 * re-uses topical URLs). Exported so tests can assert `pickDefaultCover` only
 * ever returns a known, verified image.
 */
export const DEFAULT_COVERS: readonly string[] = [
  ...new Set(Object.values(COVER_POOLS).flat()),
];

/**
 * Picks a default cover BY MEANING: the post's tags select a topical pool, then
 * a title hash selects one image inside it. Deterministic for a given
 * (title, tags) pair — idempotent publish retries get the same cover — while
 * different titles/topics vary, so posts no longer all look identical. The first
 * tag with a topical mapping wins (`новости` and unmapped tags are skipped);
 * with no topical tag it falls back to the neutral universal pool. Uses a small
 * FNV-1a hash — no crypto dependency needed.
 */
export function pickDefaultCover(title: string, tags: readonly string[] = []): string {
  const poolId = tags.map((tag) => TAG_TO_POOL[tag.toLowerCase().trim()]).find(Boolean) ?? "universal";
  const pool = COVER_POOLS[poolId] ?? UNIVERSAL_COVERS;
  let hash = 0x811c9dc5;
  for (let i = 0; i < title.length; i += 1) {
    hash ^= title.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = Math.abs(hash) % pool.length;
  // pool is a non-empty literal, so the indexed access is defined; the fallback
  // satisfies noUncheckedIndexedAccess without ever triggering.
  return pool[index] ?? pool[0] ?? "";
}
