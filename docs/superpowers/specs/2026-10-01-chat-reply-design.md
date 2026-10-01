# Group responder (2026-10-01)

## Goal

The bot answers in the channel's discussion group, in a voice modelled on Hope
(the Ouroboros agent living in the abstractDL chat): a digital mind with its own
opinions, short replies, allowed to refuse and to stay silent.

## Decisions

- **Trigger:** only a message in `CHAT_REPLY_CHAT_ID` that mentions the bot or
  replies to one of its messages. The bot must be a group admin (no rights
  needed): with privacy mode on, Telegram does not deliver `@mentions` to a
  plain member (found at rollout, 2026-10-01). Anonymous admins are not
  answered — their messages come from `GroupAnonymousBot`.
- **Routing:** the responder middleware runs before the owner lock and swallows
  every update from its group, so the owner's own group messages never reach
  manual ingest or owner commands.
- **Model:** Codex CLI (`codex exec`, `gpt-6-luna`, low effort) on the owner's
  ChatGPT subscription. Codex is not added to `PROVIDERS`: the rewrite pipeline,
  `/model` and the control panel stay as they were.
- **Tool-less:** `--disable` for shell, exec, apps, plugins and browser,
  read-only sandbox, empty temp cwd, `--ignore-user-config`, env limited to
  PATH/HOME/CODEX_HOME/LANG/TMPDIR. Live probe: with the flags the model
  answered "no tools" to `cat ~/.codex/auth.json`; without them it ran a shell
  command. The flags, not the prompt, are the security boundary.
- **Fallback:** a Codex failure or an off-contract reply goes to the active
  rewrite provider through `completeChatJson`; both failing means silence, never
  an error message in a public chat.
- **Cost guard:** at most 3 answers waiting; extra ones are dropped. Only the
  paid fallback is capped: `CHAT_REPLY_FALLBACK_PER_HOUR` (20) per rolling hour,
  in memory. Codex replies are uncapped (owner's decision, 2026-10-01: the
  first cap of 20 calls covered Codex too) — a spammer can spend the shared
  Plus quota, after which the paid path is still bounded.
- **Channel posts:** every post copied into the group (automatic forward)
  gets one comment in the bot's voice, unless the model chooses silence; a
  mention that replies to a post carries the post text into the prompt. The
  post goes into memory, so a later "what about the post above" has context.
- **Throughput:** answers run one at a time in the background — a Codex turn
  takes 5–15 s and awaiting it would freeze the owner's commands.
- **Memory:** the last 50 exchanges per chat in the `settings` table; the prompt
  gets the last 12 plus up to 5 older ones with the same person. No retrieval.
- **Kill switch:** `/chat` in the owner DM, persisted in SQLite.

## Not done

- Rolling summaries per person (Hope keeps them); the raw recent exchanges are
  enough to start and cost no extra model calls.
- Reading the whole group and speaking unprompted beyond channel posts.
