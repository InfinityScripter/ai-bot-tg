import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the rewriter so the bot's 🔄 handler is driven without a real LLM call.
const rewriteToPost = vi.fn();
vi.mock('../src/rewriter.js', () => ({
  rewriteToPost: (...a: unknown[]) => rewriteToPost(...a),
}));

// Mock only fetchArticle (the URL scraper) so the manual-ingest URL path is
// driven without a network call. classifyInput/feedItemFromText stay real.
const fetchArticle = vi.fn();
vi.mock('../src/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingest.js')>();
  return { ...actual, fetchArticle: (...a: unknown[]) => fetchArticle(...a) };
});

const { createBot } = await import('../src/bot.js');
const { CandidateStore } = await import('../src/store.js');
import type { FeedItem } from '../src/types.js';
import type { Update } from 'grammy/types';

const OWNER_ID = 123456789; // matches setup.ts OWNER_TELEGRAM_ID

const VALID_REWRITE = {
  title: 'Rewritten',
  description: 'Summary',
  content: 'Body',
  tags: ['t'],
  metaTitle: 'M',
  metaDescription: 'MD',
};

function rawItem(): FeedItem {
  return {
    dedupKey: 'k1',
    url: 'https://ex.com/1',
    title: 'Source title',
    snippet: 'raw body text',
    feedTitle: 'Feed',
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  };
}

/**
 * Builds a bot whose API calls are intercepted by `apiHandler`, so no network
 * happens. apiHandler receives (method, payload) and returns the API result
 * (or throws to simulate a Telegram error like "query is too old").
 */
function makeBot(apiHandler: (method: string, payload: unknown) => unknown) {
  const store = new CandidateStore(':memory:');
  const { bot } = createBot(store, async () => {});
  // grammy transformer: intercept every outgoing API call.
  bot.api.config.use((_prev, method, payload) => {
    const result = apiHandler(method, payload);
    return Promise.resolve({ ok: true, result } as never);
  });
  return { bot, store };
}

/** A callback_query update from the owner tapping an inline button. */
function callbackUpdate(data: string): Update {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: OWNER_ID, type: 'private', first_name: 'Owner' },
      },
    },
  } as Update;
}

/** A plain text message update from the owner. */
function messageUpdate(text: string): Update {
  return {
    update_id: 2,
    message: {
      message_id: 20,
      date: 0,
      text,
      from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
      chat: { id: OWNER_ID, type: 'private', first_name: 'Owner' },
    },
  } as Update;
}

afterEach(() => {
  vi.restoreAllMocks();
  rewriteToPost.mockReset();
  fetchArticle.mockReset();
});

describe('bot resilience: a stale callback must not crash the process', () => {
  it('does not reject from handleUpdate when answerCallbackQuery fails (query too old)', async () => {
    const { bot, store } = makeBot((method) => {
      if (method === 'answerCallbackQuery') {
        throw new Error('400: Bad Request: query is too old and response timeout expired');
      }
      return {}; // editMessageText etc. succeed
    });
    await bot.init();

    // A /model 'back' tap on an expired message: handler answers the callback
    // (which throws) — handleUpdate must still resolve, not reject.
    await expect(bot.handleUpdate(callbackUpdate('mback'))).resolves.toBeUndefined();
    store.close();
  });

  it('does not reject when editMessageText fails with "message is not modified"', async () => {
    const { bot, store } = makeBot((method) => {
      if (method === 'editMessageText') {
        throw new Error('400: Bad Request: message is not modified');
      }
      return {};
    });
    await bot.init();

    await expect(bot.handleUpdate(callbackUpdate('mback'))).resolves.toBeUndefined();
    store.close();
  });

  it('survives an approve tap whose answerCallbackQuery is stale', async () => {
    const { bot, store } = makeBot((method) => {
      if (method === 'answerCallbackQuery') {
        throw new Error('400: query is too old');
      }
      return {};
    });
    await bot.init();

    await expect(bot.handleUpdate(callbackUpdate('approve_999'))).resolves.toBeUndefined();
    store.close();
  });
});

describe('rewrite-on-publish flow', () => {
  it('🔄 on a collected card rewrites with the active model and saves a preview', async () => {
    rewriteToPost.mockResolvedValue(VALID_REWRITE);
    const edits: string[] = [];
    const { bot, store } = makeBot((method, payload) => {
      if (method === 'editMessageText') edits.push((payload as { text: string }).text);
      return {};
    });
    await bot.init();
    const id = store.insertCollected(rawItem())!; // state 'collected'

    await bot.handleUpdate(callbackUpdate(`rewrite_${id}`));

    // rewriter was called with the rebuilt feed item + the store
    expect(rewriteToPost).toHaveBeenCalledTimes(1);
    const passedItem = rewriteToPost.mock.calls[0]![0] as FeedItem;
    expect(passedItem.snippet).toBe('raw body text');
    // candidate now holds the saved rewrite, awaiting publish
    const c = store.get(id)!;
    expect(c.state).toBe('pending_review');
    expect(store.getRewrite(c)).toEqual(VALID_REWRITE);
    // an "in progress" placeholder is shown first, then the preview
    expect(edits[0]).toContain('Перерабатываю');
    // the preview card shows the rewritten title AND the start of the body
    const preview = edits.at(-1)!;
    expect(preview).toContain('Rewritten'); // title
    expect(preview).toContain('Body'); // body text shown for review
    store.close();
  });

  it('a rewrite failure marks rewrite_failed and offers a retry, without crashing', async () => {
    rewriteToPost.mockRejectedValue(new Error('GLM ответил 429: rate limited'));
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    const id = store.insertCollected(rawItem())!;

    await expect(bot.handleUpdate(callbackUpdate(`rewrite_${id}`))).resolves.toBeUndefined();

    expect(store.get(id)!.state).toBe('rewrite_failed');
    store.close();
  });

  it('a model-not-found failure clears an active override', async () => {
    rewriteToPost.mockRejectedValue(new Error('GLM ответил 404: model not found'));
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    store.setModelOverride('glm', 'glm-retired');
    const id = store.insertCollected(rawItem())!;

    await bot.handleUpdate(callbackUpdate(`rewrite_${id}`));

    expect(store.getModelOverride()).toBeNull(); // cleared → env default next
    store.close();
  });

  it('🔄 Заново on a pending_review card re-runs the rewrite (overwrites preview)', async () => {
    rewriteToPost.mockResolvedValue(VALID_REWRITE);
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    const id = store.insertCollected(rawItem())!;
    store.attachRewrite(id, { ...VALID_REWRITE, title: 'Old' }); // → pending_review

    await bot.handleUpdate(callbackUpdate(`rewrite_${id}`));

    expect(rewriteToPost).toHaveBeenCalledTimes(1);
    expect(store.getRewrite(store.get(id)!)!.title).toBe('Rewritten'); // overwritten
    store.close();
  });

  it('a concurrent 🔄 double-tap runs the rewrite only once (atomic claim)', async () => {
    // rewriteToPost resolves after a tick so both taps overlap.
    rewriteToPost.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(VALID_REWRITE), 5))
    );
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    const id = store.insertCollected(rawItem())!;

    await Promise.all([
      bot.handleUpdate(callbackUpdate(`rewrite_${id}`)),
      bot.handleUpdate(callbackUpdate(`rewrite_${id}`)),
    ]);

    expect(rewriteToPost).toHaveBeenCalledTimes(1); // the loser bailed on the claim
    store.close();
  });

  it('publishing a skipped card is a no-op (already handled)', async () => {
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    const id = store.insertCollected(rawItem())!;
    store.setState(id, 'skipped');

    await bot.handleUpdate(callbackUpdate(`rewrite_${id}`));

    expect(rewriteToPost).not.toHaveBeenCalled(); // not rewritable
    expect(store.get(id)!.state).toBe('skipped');
    store.close();
  });

  it('a maybe-posted publish failure (5xx) routes to needs_verification, not pending_review', async () => {
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    const id = store.insertCollected(rawItem())!;
    store.attachRewrite(id, VALID_REWRITE); // → pending_review
    // publishToBlog uses real fetch — make it a 5xx (server may have committed).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));

    await bot.handleUpdate(callbackUpdate(`approve_${id}`));

    expect(store.get(id)!.state).toBe('needs_verification');
    vi.unstubAllGlobals();
    store.close();
  });

  it('a definitely-failed publish (4xx) routes back to pending_review', async () => {
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    const id = store.insertCollected(rawItem())!;
    store.attachRewrite(id, VALID_REWRITE);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 400 })));

    await bot.handleUpdate(callbackUpdate(`approve_${id}`));

    expect(store.get(id)!.state).toBe('pending_review');
    vi.unstubAllGlobals();
    store.close();
  });
});

describe('/model mock toggle', () => {
  it('mmock_on sets the mock override; mmock_off clears it', async () => {
    const { bot, store } = makeBot(() => ({}));
    await bot.init();

    await bot.handleUpdate(callbackUpdate('mmock_on'));
    expect(store.getMockOverride()).toEqual({ enabled: true });

    await bot.handleUpdate(callbackUpdate('mmock_off'));
    expect(store.getMockOverride()).toEqual({ enabled: false });
    store.close();
  });

  it('"Сбросить на env" (mreset) clears BOTH the model and mock overrides', async () => {
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    store.setModelOverride('glm', 'glm-4.7-flash');
    store.setMockOverride(true);

    await bot.handleUpdate(callbackUpdate('mreset'));

    expect(store.getModelOverride()).toBeNull();
    expect(store.getMockOverride()).toBeNull();
    store.close();
  });

  it('picking the mock model clears a stale mock override so it applies cleanly', async () => {
    // 'mock' pings ok with no key, so this exercises the clearMockOverride path
    // in the model-pick branch without a network/key dependency.
    const { bot, store } = makeBot(() => ({}));
    await bot.init();
    store.setMockOverride(true);

    await bot.handleUpdate(callbackUpdate('mm_mock__mock'));

    expect(store.getModelOverride()).toEqual({ provider: 'mock', model: 'mock' });
    expect(store.getMockOverride()).toBeNull(); // mock override cleared on pick
    store.close();
  });
});

describe('manual ingest: owner sends a text or URL', () => {
  /** Collects every sendMessage text the bot emits during an update. */
  function captureSends(store: InstanceType<typeof CandidateStore>) {
    const sends: string[] = [];
    const { bot } = createBot(store, async () => {});
    bot.api.config.use((_prev, method, payload) => {
      if (method === 'sendMessage') sends.push((payload as { text: string }).text);
      return Promise.resolve({ ok: true, result: { message_id: 99 } } as never);
    });
    return { bot, sends };
  }

  it('free text → inserts a collected candidate and DMs a raw card', async () => {
    const store = new CandidateStore(':memory:');
    const { bot, sends } = captureSends(store);
    await bot.init();

    await bot.handleUpdate(messageUpdate('Заголовок\n\nТело новости про ИИ.'));

    const collected = store.listByState('collected');
    expect(collected).toHaveLength(1);
    expect(collected[0]!.sourceTitle).toBe('Заголовок');
    expect(collected[0]!.dedupKey).toMatch(/^manual:/);
    // A raw card was DM'd (the renderRaw card, containing the source title).
    expect(sends.some((t) => t.includes('Заголовок'))).toBe(true);
    store.close();
  });

  it('a URL → scrapes via fetchArticle, inserts, and DMs a raw card', async () => {
    fetchArticle.mockResolvedValue({
      dedupKey: 'https://ex.com/post',
      url: 'https://ex.com/post',
      title: 'Scraped title',
      snippet: 'scraped body',
      feedTitle: 'ex.com',
      imageUrl: null,
      imageUrls: [],
      publishedAt: null,
    });
    const store = new CandidateStore(':memory:');
    const { bot, sends } = captureSends(store);
    await bot.init();

    await bot.handleUpdate(messageUpdate('https://ex.com/post'));

    expect(fetchArticle).toHaveBeenCalledWith('https://ex.com/post');
    const collected = store.listByState('collected');
    expect(collected).toHaveLength(1);
    expect(collected[0]!.sourceTitle).toBe('Scraped title');
    expect(sends.some((t) => t.includes('Scraped title'))).toBe(true);
    store.close();
  });

  it('a URL fetch failure replies with the error and inserts nothing', async () => {
    fetchArticle.mockRejectedValue(new Error('Страница ответила 404.'));
    const store = new CandidateStore(':memory:');
    const { bot, sends } = captureSends(store);
    await bot.init();

    await bot.handleUpdate(messageUpdate('https://ex.com/missing'));

    expect(store.listByState('collected')).toHaveLength(0);
    expect(sends.some((t) => t.includes('Не удалось получить статью') && t.includes('404'))).toBe(
      true
    );
    store.close();
  });

  it('a duplicate (already-seen) item replies "уже была", not a second card', async () => {
    const store = new CandidateStore(':memory:');
    const { bot, sends } = captureSends(store);
    await bot.init();

    // First send inserts; second identical send dedups on the manual: key.
    await bot.handleUpdate(messageUpdate('Та же новость'));
    await bot.handleUpdate(messageUpdate('Та же новость'));

    expect(store.listByState('collected')).toHaveLength(1);
    expect(sends.some((t) => t.includes('уже была'))).toBe(true);
    store.close();
  });

  it('an unknown /command is not ingested as article text', async () => {
    const store = new CandidateStore(':memory:');
    const { bot, sends } = captureSends(store);
    await bot.init();

    await bot.handleUpdate(messageUpdate('/unknown'));

    expect(store.listByState('collected')).toHaveLength(0);
    expect(sends.some((t) => t.includes('Неизвестная команда'))).toBe(true);
    store.close();
  });
});
