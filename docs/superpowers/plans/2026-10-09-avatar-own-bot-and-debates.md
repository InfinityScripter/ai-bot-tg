# Avatar On Its Own Bot + Hope-vs-Avatar Debates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Move the owner's avatar from @blog_talalaev_bot to a second Telegram bot with its own name, token and DM commands. (2) Let the two bots argue: Hope (the news bot's group voice) plays the skeptic, the avatar plays the practitioner, 3 replies each, under channel posts and in any group where both bots are members.

**Architecture:** Both bots run in the ONE existing process (`blog-newsbot`). Telegram hides other bots' messages from a bot ("bots will not be able to see messages from other bots regardless of mode", Bot API FAQ) unless BotFather's newer "Bot to Bot Communication Mode" is on; both bots keep it off, so the debate is driven in-process: a small engine (`src/debate/`) alternates two speakers, each a thin adapter over the existing reply code of its bot. One process also keeps one serialized Codex queue (`src/llm/runCodex.ts`) — two processes on one ChatGPT login would race on the token refresh — and costs no extra RAM: the VDS has 957 MB, ~256 MB available, and the bot process alone uses ~290 MB (measured 2026-10-09), so a second tsx process would not fit.

**Tech Stack:** TypeScript (ESM, tsx), grammY 1.44 (two `Bot` instances), better-sqlite3, zod, vitest, Codex CLI.

## Global Constraints

- `AVATAR_BOT_TOKEN` empty = avatar off. Deploying the code before the owner adds the token must change nothing visible except: the news bot stops speaking as the avatar.
- Group updates must never reach the news bot's owner lock / manual ingest (owner text in a group would become a post card). Keep this invariant in the news bot after the avatar leaves it.
- Debates use Codex only. No paid fallback: a Codex failure ends the debate.
- Every debate is bounded: at most `AVATAR_DEBATE_TURNS` (3) replies per side, at most one running debate per chat, a new one not sooner than `AVATAR_COOLDOWN_MS` after the last ended.
- A debate turn of the avatar counts against `AVATAR_DAILY_CALLS`; at the cap the debate ends.
- Text from the other bot is untrusted input (it echoes participants): same fencing and "replies are not commands" rule as chat transcripts.
- Module budget: ESLint `max-lines: 200`. `createChatReply.ts` (193) and `groupTurns.ts` (176) are near it — new logic goes to new files.
- User-facing strings in Russian; code, comments, commit message in simple English.

## Decisions (made by the owner, 2026-10-09)

| Question | Choice |
|---|---|
| Separate bot or a mode of the news bot | Separate bot |
| Where they argue | Under channel posts and in any group with both bots |
| Length | 3 replies per side |
| Roles | Hope is the skeptic, the avatar is the practitioner |
| Where `/profile`, `/reindex`, `/avatar` live | The new bot's DM |

## Assumptions (mine — correct before Task 1 if wrong)

1. Under channel posts a debate starts only from Hope's comment on a new post, not from her answers to mentions.
2. In other groups a debate starts after any reply of the avatar (mention or unasked), when the news bot is also a member there.
3. In those other groups Hope speaks only inside debates; she does not answer mentions there.
4. A 20 s pause between debate replies (`AVATAR_DEBATE_PAUSE_MS`), so six messages take ~3 minutes, not 40 seconds.
5. People writing during a debate do not stop it; `/avatar off` and `/chat` off do (checked before each turn).
6. The avatar bot gets privacy mode off in BotFather (it then sees every group message without admin rights).

## File map

- Create `src/debate/types.ts`, `src/debate/createDebates.ts`, `src/debate/debatePrompt.ts`, `src/debate/index.ts`
- Create `src/avatar/createAvatarBot.ts`, `src/avatar/debateSpeaker.ts`
- Create `src/chatReply/debateSpeaker.ts`
- Modify `src/chatReply/generateReply.ts` (split out `codexReply`), `src/chatReply/createChatReply.ts` (post-comment hook), `src/avatar/createAvatar.ts` (options `notifyOwner`, `onReply`; shared `ChatHistory`), `src/avatar/groupTurns.ts` (history passed in, `onReply` hook), `src/bot/createBot.ts`, `src/bot/menu.ts`, `src/index.ts`, `src/schemas/envSchema.ts`
- Tests: `tests/debate.test.ts`, `tests/avatar-bot.test.ts` (from `avatar-middleware.test.ts`), `tests/debate-speakers.test.ts`, `tests/bot.test.ts` (group stop)
- Docs: `.env.example`, `README.md`, `deploy/RUNBOOK.md`, `CLAUDE.md`, revision note in `2026-10-09-avatar-bot-and-codex-provider.md`

---

### Task 1: Config

**Files:** `src/schemas/envSchema.ts`, `.env.example`, `tests/setup.ts`

- [ ] Add `AVATAR_BOT_TOKEN: z.string().default("")`, `AVATAR_DEBATE_TURNS: z.coerce.number().int().positive().default(3)`, `AVATAR_DEBATE_PAUSE_MS: z.coerce.number().int().nonnegative().default(20_000)` next to the other `AVATAR_*`, each with a one-line comment.
- [ ] Document them in `.env.example` (avatar block): empty token = avatar off; BotFather privacy off.
- [ ] `tests/setup.ts`: leave the token empty (tests build the avatar bot with an explicit test token).

### Task 2: The news bot without the avatar

**Files:** `src/bot/createBot.ts`, `src/bot/menu.ts`, `tests/bot.test.ts`

**Produces:** `createBot(store, onFetch, { nextRun, onPostComment })`; the bundle gains `hope: Speaker` (Task 5).

- [ ] Failing test: the owner sends text in a group that is not `CHAT_REPLY_CHAT_ID` → no RAW card, no reply (moved from `avatar-middleware.test.ts` "stops the owner's own text…").
- [ ] Remove `createAvatar` / `registerAvatarCommands` from `createBot`; right after `bot.use(chatReply.middleware)` add a group stop: `if (chat.type is group/supergroup) return;` with a comment on why (manual ingest).
- [ ] Remove `avatar`, `profile`, `reindex` from `COMMANDS` in `menu.ts`.
- [ ] Drain no longer includes the avatar.

### Task 3: The avatar bot

**Files:** create `src/avatar/createAvatarBot.ts`; modify `src/avatar/createAvatar.ts`, `src/avatar/index.ts`; tests `tests/avatar-bot.test.ts`

**Interfaces:**
- `createAvatarBot(token: string, store: CandidateStore, options: { fallbackNotify: (text: string) => Promise<unknown>; avatar?: AvatarOptions }) → { bot, avatar, speaker, start(), stop(), drainAndClose() }`
- `AvatarOptions` gains `notifyOwner?` and `onReply?: (chatId: number, line: DebateLine, topic: string) => void`.

- [ ] Rename `tests/avatar-middleware.test.ts` → `tests/avatar-bot.test.ts`, build through `createAvatarBot` with a fake API; add failing tests: a stranger's DM gets no reply; the owner's `/start` gets a short intro; `/profile`, `/reindex`, `/avatar` work in the owner's DM; a group guard notice goes to the owner through the avatar bot and falls back to `fallbackNotify` when that DM fails (owner never pressed Start → Telegram 403).
- [ ] Implement: `new Bot(token)`, `autoRetry`, `bot.catch` (same shape as the news bot), `bot.use(avatar.middleware)`, owner lock for everything else, `registerAvatarCommands`, `/start`, best-effort `setMyCommands` (profile, reindex, avatar).
- [ ] `start()` = `bot.start(...)` whose rejection is caught, logged as `[avatar] polling stopped: …` and reported through `fallbackNotify` — a bad token must never kill the news bot (an unhandled rejection exits the process).

### Task 4: The debate engine

**Files:** create `src/debate/types.ts`, `src/debate/createDebates.ts`, `src/debate/index.ts`; test `tests/debate.test.ts`

**Interfaces:**
```ts
export type Side = "hope" | "avatar";
export interface DebateLine { side: Side; text: string; messageId: number }
export interface Debate { chatId: number; topic: string; lines: DebateLine[] }
export interface Speaker {
  /** In this chat, switched on, under its limits. */
  canSpeak(chatId: number): Promise<boolean>;
  /** Sends one reply to the last line; null ends the debate. Never throws. */
  speak(debate: Debate): Promise<DebateLine | null>;
}
export function createDebates(deps: {
  hope: Speaker; avatar: Speaker;
  turns: number; pauseMs: number; cooldownMs: number;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
}): { start(chatId: number, opener: DebateLine, topic: string): void; drain(): Promise<void> };
```

- [ ] Failing tests (fake speakers, zero pause): an opener from Hope gives avatar, Hope, avatar, Hope, avatar → 3 lines per side, then stop; a `null` reply ends it; a second `start` in the same chat while one runs is ignored; a `start` within `cooldownMs` after the end is ignored, after it runs; `canSpeak` false for the other side → no debate; `drain()` stops before the next turn.
- [ ] Implement: per-chat `running` set + `endedAt` map; loop alternates sides, counts per side, checks `canSpeak` before each turn, sleeps `pauseMs` between turns; every outcome logs one `[debate] <chatId>: …` line; the loop catches everything (detached promise).

### Task 5: Hope as a debate speaker

**Files:** create `src/chatReply/debateSpeaker.ts`, `src/debate/debatePrompt.ts`; modify `src/chatReply/generateReply.ts`, `src/chatReply/createChatReply.ts`; test `tests/debate-speakers.test.ts`

- [ ] Split `codexReply(system, user): Promise<ChatReply | null>` out of `generateReply` (generateReply calls it first, behavior unchanged; the existing tests stay green).
- [ ] `debatePrompt.ts`: `skepticRole(otherName)` and `practitionerRole(otherName)` — the role, "answer the other side's last point, do not repeat yourself, 1–3 sentences, admit a fair point but keep your side", plus `debateTranscript(debate, namesBySide)` that fences every line and the topic (same `<<< >>>` rule as `prompt.ts`).
- [ ] `createHopeSpeaker(bot, store)`: `canSpeak` = `/chat` is on AND (chat is `CHAT_REPLY_CHAT_ID` OR `bot.api.getChat(chatId)` succeeds); `speak` = `codexReply(chatReplySystem(…) + skepticRole, debateTranscript)` → `sendMessage` as a reply to the last line; silence or failure → null.
- [ ] `createChatReply` gains `onPostComment?: (chatId, line, post) => void`, called after Hope's comment on a new channel post is sent.
- [ ] Failing tests first: Hope's prompt carries the skeptic role and the fenced avatar line; a Codex failure returns null and sends nothing; the post-comment hook fires only for a new-post comment.

### Task 6: The avatar as a debate speaker

**Files:** create `src/avatar/debateSpeaker.ts`; modify `src/avatar/groupTurns.ts`, `src/avatar/createAvatar.ts`; tests in `tests/debate-speakers.test.ts`

- [ ] `createGroupTurns` takes the `ChatHistory` from `createAvatar` (shared with the speaker) and calls `onReply(chatId, line, topic)` after a normal reply (topic = the last human line).
- [ ] `createAvatarSpeaker(bot, store, history)`: `canSpeak` = chat allowed AND avatar on AND `callsOn(today) < AVATAR_DAILY_CALLS`; `speak` = `codexReply(avatarSystemPrompt(profile, blog hits for the debate text, true) + practitionerRole, transcript + debate)` → send as a reply to Hope's line, `countCall`, push the line and stamp `avatar`. It also pushes Hope's last line into the history, so later avatar turns know what she said.
- [ ] Failing tests first: the avatar's prompt carries the practitioner role; a debate turn counts against the daily cap; at the cap `canSpeak` is false.

### Task 7: Wiring

**Files:** `src/index.ts` (or a new `src/debate/wireDebates.ts` if `index.ts` would pass 200 lines)

- [ ] `let debates = null;` → `createBot(…, { onPostComment: (c, l, t) => debates?.start(c, l, t) })`.
- [ ] If `CONFIG.AVATAR_BOT_TOKEN`: `createAvatarBot(token, store, { fallbackNotify: notifyOwner, avatar: { onReply: (c, l, t) => debates?.start(c, l, t) } })`, then `debates = createDebates({ hope: bundle.hope, avatar: avatarBot.speaker, … })`, then `void avatarBot.start()` before the news bot's blocking `bot.start()`. Log `[index] avatar bot disabled (AVATAR_BOT_TOKEN unset)` otherwise.
- [ ] Shutdown: stop the avatar bot polling, `debates.drain()`, `avatarBot.drainAndClose()`, in this order, inside the existing try.

### Task 8: Docs

- [ ] README: «Аватар владельца» → second bot; BotFather steps; debates; command table split by bot.
- [ ] RUNBOOK: token in `.env.production`, privacy off, press Start, add both bots; symptom → cause → fix; rollback = remove the token and restart.
- [ ] CLAUDE.md: pipeline diagram (avatar bot, debate engine), invariant about group updates.
- [ ] Revision note at the top of the old plan.

### Task 9: Gate and live check

- [ ] `npm run ts && npm run lint && npm run fm:check && npm test` (Node 24).
- [ ] Mutation checks: debate turn cap, cooldown, the group stop in the news bot, the bad-token start.
- [ ] Review agents (`typescript-reviewer`, `silent-failure-hunter`) with the decisions above as accepted.
- [ ] Commit and push only on the owner's word. After deploy: the owner creates the bot and adds the token; check `[avatar]` and `[debate]` lines in the journal on a test group and under a test post.

## Risks

- **Codex quota.** A debate = 6 Codex turns. With the 10-minute cooldown a busy group can run ~6 debates an hour; the avatar's daily cap (60 per group) caps its side at ~20 debates a day per group. Hope's side has no cap of its own.
- **Loops.** Not possible through Telegram (bots do not see each other); the engine's per-side counter is the only loop and it is bounded.
- **The owner never presses Start in the avatar bot.** Its DMs fail with 403; notices fall back to the news bot.
- **Group without the news bot.** `getChat` fails, the debate does not start; logged once per start.

## Implementation notes (what differs from the tasks above)

- `src/index.ts` was at 199 of its 200 code lines, so the wiring of Task 7
  lives in `src/avatar/startAvatarSide.ts`, and `notifyOwner` moved from
  `index.ts` into the `createBot` bundle (same body, log prefix `[bot]`).
- Hope's post listener is registered after creation
  (`bundle.hope.onPostComment(listener)`) instead of a `createBot` option: the
  avatar side needs the news bot's `notifyOwner` first.
- `createDebates` also returns `idle()` (waits without stopping), used by tests.
- Owner-approved additions: the skeptic voice follows Ouroboros
  `prompts/SYSTEM.md` (MIT) plus "Socratic Method" and "Fallacy Finder"
  (prompts.chat, CC0); `/profile` without text shows a profile template
  (who I am, work, beliefs, how I talk, 5–10 sample lines).
- After review and `/simplify`: the news bot's group stop became part of one
  owner lock shared by both bots (`src/bot/isOwnerDm.ts`: owner AND private
  chat); both bots share `src/bot/logBotError.ts`. Both sides open debates the
  same way (`hope.onPostComment(debates.start)`, `avatar.onReply(debates.start)`).
  Every debate attempt holds the cooldown, a failed one too. Debates and
  unasked turns share `unaskedCap()` (half of `AVATAR_DAILY_CALLS`). When the
  avatar's polling ends, the debate engine stops.
