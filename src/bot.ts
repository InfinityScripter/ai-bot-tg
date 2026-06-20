import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';

import { CONFIG } from './config.js';
import {
  modelButtons,
  parseCallback,
  providerButtons,
  statusText,
} from './bot-model.js';
import { listModels, pingModel } from './models.js';
import { PROVIDERS, hasActiveOverride, resolveActiveProvider } from './providers.js';
import { publishToBlog } from './publisher.js';
import type { ButtonSpec } from './bot-model.js';
import type { CandidateStore } from './store.js';
import type { Candidate, RewriteResult } from './types.js';
import { escapeMarkdown, truncate } from './utils.js';

/** Logs a swallowed edit error instead of hiding it entirely. */
function logEditError(context: string) {
  return (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[bot] ${context} failed: ${String(err)}`);
  };
}

/**
 * Answers a callback query best-effort. answerCallbackQuery THROWS when the
 * query is older than ~15s ("query is too old") — a routine event for any
 * lingering inline button. An unguarded throw here propagates out of the
 * handler and (without a bot.catch) crashes the whole process, so acking must
 * never reject. Always swallow + log.
 */
async function ackSilently(ctx: Context, opts?: { text: string }): Promise<void> {
  await ctx.answerCallbackQuery(opts).catch(logEditError('answerCallbackQuery'));
}

const APPROVE_PREFIX = 'approve_';
const SKIP_PREFIX = 'skip_';

/** Builds the inline keyboard for an approval message. */
function approvalKeyboard(candidateId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Опубликовать', `${APPROVE_PREFIX}${candidateId}`)
    .text('❌ Пропустить', `${SKIP_PREFIX}${candidateId}`);
}

/** Turns pure ButtonSpecs into a one-button-per-row inline keyboard. */
function keyboardFrom(buttons: ButtonSpec[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.text, b.data).row();
  return kb;
}

/** The /model status text + provider keyboard for the given store state. */
function modelMenu(store: CandidateStore): { text: string; keyboard: InlineKeyboard } {
  const active = resolveActiveProvider(store);
  const buttons = providerButtons();
  buttons.push({ text: '↩️ Сбросить на env', data: 'mreset' });
  return { text: statusText(active, hasActiveOverride(store)), keyboard: keyboardFrom(buttons) };
}

/**
 * Renders the DM body shown to the owner for review. All interpolated content
 * is escaped — feed/Claude text must not be able to break or hijack the
 * Markdown (e.g. a title containing '*' or '[').
 */
function renderApproval(candidate: Candidate, rewrite: RewriteResult): string {
  const tags = rewrite.tags.length ? `\n🏷 ${escapeMarkdown(rewrite.tags.join(', '))}` : '';
  return [
    `📰 *${escapeMarkdown(rewrite.title)}*`,
    '',
    escapeMarkdown(truncate(rewrite.description, 600)),
    tags,
    '',
    `Источник: ${escapeMarkdown(candidate.feedTitle ?? 'неизвестен')}`,
    escapeMarkdown(candidate.sourceUrl),
  ].join('\n');
}

/**
 * Creates the bot, locked to the owner, with /start, /ping, the approval
 * callback handler, and a `sendApproval` helper for the collector. `onFetch`
 * is invoked by the /fetch command (wired by the entrypoint to trigger a run).
 */
export function createBot(store: CandidateStore, onFetch: () => Promise<void> | void) {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

  // Global error boundary: grammy rethrows an uncaught handler error out of the
  // polling loop, which exits the process (systemd then restart-loops). Logging
  // here keeps the bot alive through any handler failure — a stale callback, a
  // Telegram 400, a transient network blip — instead of crashing on it.
  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[bot] unhandled error in update ${err.ctx.update.update_id}: ${String(err.error)}`);
  });

  // Tracks in-flight publish handlers so shutdown can drain them before the DB
  // is closed (a publish does a network call, then writes to the store).
  let inFlight = 0;

  // Owner-lock: silently ignore every update from anyone but the owner —
  // commands and callbacks alike. ctx.from is set for messages, callbacks,
  // edited messages, channel posts, and inline queries, so this gate covers
  // every update type that carries a sender.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== CONFIG.OWNER_TELEGRAM_ID) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Не авторизовано.' }).catch(() => {});
      return; // drop the update
    }
    await next();
  });

  bot.command('start', (ctx) =>
    ctx.reply(
      'Новостной бот на связи. /fetch — собрать новости сейчас. ' +
        '/model — провайдер/модель. /ping — проверка.'
    )
  );
  bot.command('ping', (ctx) => ctx.reply('pong'));
  bot.command('fetch', async (ctx) => {
    await ctx.reply('Запускаю сбор новостей…');
    try {
      await onFetch();
    } catch (err) {
      await ctx.reply(`Сбор завершился с ошибкой: ${String(err)}`);
    }
  });
  bot.command('model', async (ctx) => {
    const { text, keyboard } = modelMenu(store);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // /model callbacks are handled first; they don't touch a candidate.
    const modelCb = parseCallback(data);
    if (modelCb) {
      await handleModelCallback(ctx, modelCb);
      return;
    }

    const isApprove = data.startsWith(APPROVE_PREFIX);
    const isSkip = data.startsWith(SKIP_PREFIX);
    if (!isApprove && !isSkip) {
      await ackSilently(ctx);
      return;
    }

    const id = Number(data.slice(data.indexOf('_') + 1));
    const candidate = store.get(id);
    if (!candidate) {
      await ackSilently(ctx, { text: 'Кандидат не найден.' });
      return;
    }

    if (isSkip) {
      // Only skip a candidate still awaiting review; a stale tap is a no-op.
      if (candidate.state !== 'pending_review') {
        await ackSilently(ctx, { text: `Уже обработано (${candidate.state}).` });
        return;
      }
      store.setState(id, 'skipped');
      await ackSilently(ctx, { text: 'Пропущено.' });
      await ctx.editMessageReplyMarkup().catch(logEditError('skip clear markup'));
      await ctx
        .editMessageText(`❌ Пропущено: ${candidate.sourceTitle ?? candidate.sourceUrl}`)
        .catch(logEditError('skip edit text'));
      return;
    }

    // Approve → publish. Atomically claim pending_review → publishing in a
    // single UPDATE; only the caller that flips the row (changes === 1) wins.
    // A concurrent double-tap loses the race here and cannot double-post.
    const won = store.claimForPublishing(id);
    if (!won) {
      await ackSilently(ctx, { text: 'Уже обрабатывается.' });
      return;
    }

    inFlight += 1;
    try {
      await ackSilently(ctx, { text: 'Публикую…' });
      await ctx.editMessageReplyMarkup().catch(logEditError('publish clear markup'));

      const rewrite = store.getRewrite(candidate);
      if (!rewrite) {
        store.setState(id, 'publish_failed', 'Нет сохранённого rewrite.');
        await ctx
          .editMessageText('⚠️ Ошибка: нет данных для публикации.')
          .catch(logEditError('publish missing-rewrite text'));
        return;
      }

      try {
        const postId = await publishToBlog(rewrite, candidate.imageUrl);
        store.setPublished(id, postId);
        await ctx
          .editMessageText(`✅ Опубликовано: *${escapeMarkdown(rewrite.title)}*`, {
            parse_mode: 'Markdown',
          })
          .catch(logEditError('publish success text'));
      } catch (err) {
        // Reset to pending_review so the owner can retry via the restored buttons.
        store.setState(id, 'pending_review', String(err));
        await ctx
          .editMessageText(`⚠️ Не удалось опубликовать: ${err instanceof Error ? err.message : String(err)}`, {
            reply_markup: approvalKeyboard(id),
          })
          .catch(logEditError('publish failure text'));
      }
    } finally {
      inFlight -= 1;
    }
  });

  /**
   * Handles a /model inline-button tap: navigate provider → model, ping the
   * chosen model, and only persist the override if the ping succeeds. A failed
   * ping shows the error and keeps the model list so the owner can pick another.
   */
  async function handleModelCallback(
    ctx: Context,
    cb: NonNullable<ReturnType<typeof parseCallback>>
  ): Promise<void> {
    if (cb.kind === 'reset') {
      store.clearModelOverride();
      const { text, keyboard } = modelMenu(store);
      await ackSilently(ctx, { text: 'Сброшено на env.' });
      await ctx.editMessageText(text, { reply_markup: keyboard }).catch(logEditError('model reset'));
      return;
    }

    if (cb.kind === 'back') {
      const { text, keyboard } = modelMenu(store);
      await ackSilently(ctx);
      await ctx.editMessageText(text, { reply_markup: keyboard }).catch(logEditError('model back'));
      return;
    }

    if (cb.kind === 'provider') {
      await ackSilently(ctx);
      const models = await listModels(cb.provider);
      const label = PROVIDERS[cb.provider].label;
      await ctx
        .editMessageText(`Провайдер: ${label}. Выберите модель:`, {
          reply_markup: keyboardFrom(modelButtons(cb.provider, models)),
        })
        .catch(logEditError('model provider list'));
      return;
    }

    // cb.kind === 'model' — ping, then save on success only.
    await ackSilently(ctx, { text: 'Проверяю модель…' });
    const result = await pingModel(cb.provider, cb.model);
    const label = PROVIDERS[cb.provider].label;
    if (result.ok) {
      store.setModelOverride(cb.provider, cb.model);
      const confirm = `✅ Переключено: ${label} / ${cb.model}`;
      // The override IS saved; if the message can't be edited (too old/deleted),
      // send a fresh reply so the owner always gets the confirmation.
      await ctx.editMessageText(confirm).catch(async (err) => {
        logEditError('model switch ok')(err);
        await ctx.reply(confirm).catch(logEditError('model switch ok reply'));
      });
    } else {
      // keep the model list so the owner can try another model
      const models = await listModels(cb.provider);
      await ctx
        .editMessageText(`⚠️ ${result.error}\n\nВыберите другую модель:`, {
          reply_markup: keyboardFrom(modelButtons(cb.provider, models)),
        })
        .catch(logEditError('model switch fail'));
    }
  }

  /** Sends an approval DM for a pending candidate and records its message id. */
  async function sendApproval(candidate: Candidate, rewrite: RewriteResult): Promise<void> {
    const message = await bot.api.sendMessage(
      CONFIG.OWNER_TELEGRAM_ID,
      renderApproval(candidate, rewrite),
      { parse_mode: 'Markdown', reply_markup: approvalKeyboard(candidate.id) }
    );
    store.setTelegramMessage(candidate.id, message.message_id);
  }

  /**
   * Resolves once no publish handler is in flight (or a timeout elapses).
   * Shutdown awaits this before closing the store so a callback mid-publish
   * isn't cut off with a closed database.
   */
  async function drain(timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return { bot, sendApproval, drain };
}

export type BotBundle = ReturnType<typeof createBot>;
