import type { Context, InlineKeyboard } from "grammy";

import { CallbackKind } from "../enums.js";
import { MODEL_CALLBACK } from "../consts.js";
import { keyboardFrom } from "./keyboards.js";
import { ackSilently, logEditError } from "./edit.js";
import {
  statusText,
  modelButtons,
  parseCallback,
  providerButtons,
  mockToggleButton,
} from "./modelPick.js";
import {
  pingModel,
  PROVIDERS,
  listModels,
  isMockActive,
  hasActiveOverride,
  resolveActiveProvider,
} from "../llm/index.js";

import type { CandidateStore } from "../store/index.js";

/** The /model status text + provider keyboard for the given store state. */
export function modelMenu(store: CandidateStore): { text: string; keyboard: InlineKeyboard } {
  const active = resolveActiveProvider(store);
  const mockActive = isMockActive(store);
  const buttons = providerButtons();
  buttons.push(mockToggleButton(mockActive));
  buttons.push({ text: "↩️ Сбросить на env", data: MODEL_CALLBACK.RESET });
  return {
    text: statusText(active, hasActiveOverride(store), mockActive),
    keyboard: keyboardFrom(buttons),
  };
}

/**
 * Handles a /model inline-button tap: navigate provider → model, ping the
 * chosen model, and only persist the override if the ping succeeds. A failed
 * ping shows the error and keeps the model list so the owner can pick another.
 */
export async function handleModelCallback(
  ctx: Context,
  cb: NonNullable<ReturnType<typeof parseCallback>>,
  store: CandidateStore,
): Promise<void> {
  if (cb.kind === CallbackKind.Reset) {
    // Full reset to env: drop BOTH the model and the mock overrides, so the
    // "Сброшено на env" toast is truthful (a lingering mock override would
    // otherwise keep shadowing the env default).
    store.clearModelOverride();
    store.clearMockOverride();
    const { text, keyboard } = modelMenu(store);
    await ackSilently(ctx, { text: "Сброшено на env." });
    await ctx.editMessageText(text, { reply_markup: keyboard }).catch(logEditError("model reset"));
    return;
  }

  if (cb.kind === CallbackKind.Back) {
    const { text, keyboard } = modelMenu(store);
    await ackSilently(ctx);
    await ctx.editMessageText(text, { reply_markup: keyboard }).catch(logEditError("model back"));
    return;
  }

  if (cb.kind === CallbackKind.MockOn || cb.kind === CallbackKind.MockOff) {
    // Toggle the runtime mock (без LLM) override; the db value is strictly
    // authoritative over env REWRITE_MOCK (see resolveActiveProvider).
    store.setMockOverride(cb.kind === CallbackKind.MockOn);
    const { text, keyboard } = modelMenu(store);
    await ackSilently(ctx, {
      text: cb.kind === CallbackKind.MockOn ? "Mock включён." : "Mock выключен.",
    });
    await ctx.editMessageText(text, { reply_markup: keyboard }).catch(logEditError("mock toggle"));
    return;
  }

  if (cb.kind === CallbackKind.Provider) {
    await ackSilently(ctx);
    const models = await listModels(cb.provider);
    const { label } = PROVIDERS[cb.provider];
    await ctx
      .editMessageText(`Провайдер: ${label}. Выберите модель:`, {
        reply_markup: keyboardFrom(modelButtons(cb.provider, models)),
      })
      .catch(logEditError("model provider list"));
    return;
  }

  // cb.kind === 'model' — ping, then save on success only.
  await ackSilently(ctx, { text: "Проверяю модель…" });
  const result = await pingModel(cb.provider, cb.model);
  const { label } = PROVIDERS[cb.provider];
  if (result.ok) {
    store.setModelOverride(cb.provider, cb.model);
    // Picking a model is an explicit "use this provider" intent; clear any mock
    // override so the choice takes effect (mock otherwise wins in
    // resolveActiveProvider and the switch would be a silent no-op).
    const wasMock = isMockActive(store);
    store.clearMockOverride();
    const note = wasMock ? " (Mock выключен)" : "";
    const confirm = `✅ Переключено: ${label} / ${cb.model}${note}`;
    // The override IS saved; if the message can't be edited (too old/deleted),
    // send a fresh reply so the owner always gets the confirmation.
    await ctx.editMessageText(confirm).catch(async (err) => {
      logEditError("model switch ok")(err);
      await ctx.reply(confirm).catch(logEditError("model switch ok reply"));
    });
  } else {
    // keep the model list so the owner can try another model
    const models = await listModels(cb.provider);
    await ctx
      .editMessageText(`⚠️ ${result.error}\n\nВыберите другую модель:`, {
        reply_markup: keyboardFrom(modelButtons(cb.provider, models)),
      })
      .catch(logEditError("model switch fail"));
  }
}
