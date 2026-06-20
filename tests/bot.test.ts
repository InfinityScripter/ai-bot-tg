import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBot } from '../src/bot.js';
import { CandidateStore } from '../src/store.js';
import type { Update } from 'grammy/types';

const OWNER_ID = 123456789; // matches setup.ts OWNER_TELEGRAM_ID

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

afterEach(() => {
  vi.restoreAllMocks();
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
