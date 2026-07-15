/**
 * Default cover pools for bot-published posts, grouped by topic.
 *
 * When a feed item ships no image (and no og:image was scraped) we must still
 * send a coverUrl, otherwise every such post falls back to the backend's single
 * generic placeholder — the "all bot posts look identical" problem the owner hit.
 *
 * The old fix was ONE flat list of 5 images picked by a title hash: with only 5
 * slots the same few covers repeated constantly and never matched the subject.
 * This module fixes all of that:
 *   - LARGE, de-duplicated pool (dozens of images) → far fewer repeats;
 *   - picked BY MEANING: the post's normalized tags choose a topical pool
 *     (AI / security / dev / gadgets / science / business / tech), so an AI post
 *     gets AI imagery and a security post gets security imagery;
 *   - ROTATED, not hashed: the picker indexes the pool by the candidate's
 *     monotonic id, so consecutive posts of a topic get DIFFERENT covers and the
 *     pool cycles fully before any repeat (a title hash collided too often);
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
  "https://images.unsplash.com/photo-1677756119517-756a188d2d94?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1573164713988-8665fc963095?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1535378917042-10a22c95931a?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1697577418970-95d99b5a55cf?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1717501218385-55bc3a95be94?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526628953301-3e589a6a8b74?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1682687220015-186f63b8850a?auto=format&fit=crop&w=1200&q=80",
];

/** Cybersecurity — locks, code rain, network defence. */
const SECURITY_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1614064641938-3bbee52942c7?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1510511459019-5dda7724fd87?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1516339901601-2e1b62dc0c45?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1573164574511-73c773193279?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1618044733300-9472054094ee?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1592772874383-d08932d29db7?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1544890225-2f3faec4cd60?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1563013544-824ae1b704d3?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1633265486064-086b219458ec?auto=format&fit=crop&w=1200&q=80",
];

/** Software development — code on screen, editors, terminals. */
const DEV_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1555949963-aa79dcee981c?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1542831371-29b0f74f9713?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1587620962725-abab7fe55159?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1487058792275-0ad4aaf24ca7?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1607799279861-4dd421887fb3?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1516116216624-53e697fedbea?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1517180102446-f3ece451e9d8?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1592609931095-54a2168ae893?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1629654297299-c8506221ca97?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1571171637578-41bc2dd41cd2?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1550439062-609e1531270e?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1580927752452-89d86da3fa0a?auto=format&fit=crop&w=1200&q=80",
];

/** Gadgets & consumer hardware — phones, devices, desks. */
const GADGET_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1483058712412-4245e9b90334?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1573148195900-7845dcb9b127?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1580910051074-3eb694886505?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1585060544812-6b45742d762f?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1468495244123-6c6c332eeece?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=1200&q=80",
];

/** Science — labs, space, research. */
const SCIENCE_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1628595351029-c2bf17511435?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1576086213369-97a306d36557?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1507413245164-6160d8298b31?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1554475900-0a0350e3fc7b?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1518152006812-edab29b069ac?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1564325724739-bae0bd08762c?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1614730321146-b6fa6a46bcb4?auto=format&fit=crop&w=1200&q=80",
];

/** Business & markets — charts, analytics, finance. */
const BUSINESS_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1444653614773-995cb1ef9efa?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1642790551116-18e150f248e3?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1543286386-713bdd548da4?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1579532537598-459ecdaf39cc?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1556155092-490a1ba16284?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1611095973763-414019e72400?auto=format&fit=crop&w=1200&q=80",
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
  "https://images.unsplash.com/photo-1517430816045-df4b7de11d1d?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1483817101829-339b08e8d83f?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1591808216268-ce0b82787efe?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1558346490-a72e53ae2d4f?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1517077304055-6e89abbf09b0?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1518432031352-d6fc5c10da5a?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1560732488-6b0df240254a?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1451188214936-ec16af5ca155?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1488229297570-58520851e868?auto=format&fit=crop&w=1200&q=80",
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
  TECH_COVERS[12],
  AI_COVERS[0],
  AI_COVERS[4],
  SECURITY_COVERS[1],
  SCIENCE_COVERS[0],
  DEV_COVERS[0],
  BUSINESS_COVERS[0],
  GADGET_COVERS[0],
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
 * Resolves the topical cover pool for a post from its normalized tags. The first
 * tag with a topical mapping wins (`новости` and unmapped tags are skipped);
 * with no topical tag it falls back to the neutral universal pool.
 */
function poolFor(tags: readonly string[]): readonly string[] {
  const poolId = tags.map((tag) => TAG_TO_POOL[tag.toLowerCase().trim()]).find(Boolean) ?? "universal";
  return COVER_POOLS[poolId] ?? UNIVERSAL_COVERS;
}

/**
 * FNV-1a hash of a string → a non-negative seed. Lets a caller that only has a
 * title (no stable sequence number) still get a deterministic rotation index.
 */
export function coverSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash);
}

/**
 * Picks a default cover BY MEANING and ROTATED so posts don't repeat: the tags
 * select a topical pool, then `seq` indexes into it modulo the pool size. Pass
 * the candidate's monotonic id as `seq` — consecutive posts of the same topic
 * then get DIFFERENT covers and the whole pool cycles before any repeat. (The
 * previous title-hash pick collided ~1/poolSize on every pair, so covers came up
 * repeated far too often, which is exactly what the owner saw.) Deterministic
 * for a given (tags, seq): idempotent publish retries and the blog-vs-channel
 * cover always agree.
 */
export function pickDefaultCover(tags: readonly string[], seq: number): string {
  const pool = poolFor(tags);
  const size = pool.length;
  // Safe non-negative modulo; tolerate a fractional/NaN/negative seq defensively.
  const index = size > 0 ? ((Math.trunc(seq) % size) + size) % size : 0;
  // pool is a non-empty literal, so the indexed access is defined; the fallback
  // satisfies noUncheckedIndexedAccess without ever triggering.
  return pool[index] ?? pool[0] ?? "";
}
