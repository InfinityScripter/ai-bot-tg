import type { Api } from "grammy";
import type { ChatMemberUpdated } from "grammy/types";

import { CONFIG } from "../config.js";

import type { AvatarStore } from "./avatarStore.js";

export interface GuardDeps {
  store: AvatarStore;
  api: Api;
  /** Drops the avatar's RAM state for a chat it left. */
  forget: (chatId: number) => void;
  notifyOwner: (text: string) => Promise<unknown>;
  /** Telegram shows the bot every group message (privacy mode off). */
  readsAllMessages: boolean;
}

const OUT = new Set(["left", "kicked"]);

/**
 * Who may bring the bot into a group: only the owner. Telegram has no such
 * setting, and anyone's group would spend the owner's Codex quota and could
 * pull the owner's profile out of the avatar. So the bot leaves a group a
 * stranger added it to. Only a JOIN is judged: a later promotion or
 * restriction (for example in the channel's discussion group) never makes it
 * leave. Channels never reach here — the caller passes only groups.
 */
export async function onMemberUpdate(
  update: ChatMemberUpdated,
  title: string,
  deps: GuardDeps,
): Promise<void> {
  const { chat, from, old_chat_member: before, new_chat_member: after } = update;
  if (OUT.has(after.status)) {
    deps.store.forgetChat(chat.id);
    deps.forget(chat.id);
    console.log(`[avatar] removed from ${chat.id} «${title}»`);
    return;
  }
  if (!OUT.has(before.status)) return;
  if (from.id !== CONFIG.OWNER_TELEGRAM_ID) {
    console.warn(`[avatar] added to ${chat.id} «${title}» by ${from.id}, not the owner: leaving`);
    await deps.api
      .leaveChat(chat.id)
      .catch((err) => console.warn(`[avatar] leaving ${chat.id} failed: ${String(err)}`));
    return;
  }
  deps.store.allowChat(chat.id, title);
  console.log(`[avatar] the owner added the bot to ${chat.id} «${title}»`);
  const seesAll = deps.readsAllMessages || after.status === "administrator";
  await deps.notifyOwner(
    [
      `Я в группе «${title}» и говорю там как твой аватар.`,
      seesAll
        ? "Вижу все сообщения."
        : "Пока вижу только упоминания и ответы мне. Чтобы видеть всё, сделай меня администратором группы, права не нужны.",
      "Выключить везде: /avatar off.",
    ].join(" "),
  );
}

/** A group upgraded to a supergroup gets a new id; the owner's permission moves with it. */
export function onMigrated(oldId: number, newId: number, title: string, deps: GuardDeps): void {
  if (!deps.store.isAllowed(oldId)) return;
  deps.store.allowChat(newId, title);
  deps.store.forgetChat(oldId);
  deps.forget(oldId);
  console.log(`[avatar] ${oldId} became supergroup ${newId} «${title}»: permission moved`);
}
