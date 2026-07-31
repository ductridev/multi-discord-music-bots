# Slash Command Migration — Manual Test Plan

Branch `feat/slash-command-migration`, 22 commits off `e289dc6`. Nothing here has touched a live Discord connection: no agent ran the bot, and no `BotConfig` row was mutated. These tests are the first real exercise of the code.

**Setup for all tests:** three bots (B1/B2/B3) configured for one test guild, two voice channels (VC-A, VC-B), one alt account. **Tail the bot logs** — every test below depends on the resolver debug line added in the final fix wave:

```
resolve <command>: <reason> -> <chosen bot>
```

`reason` is one of `in_user_vc`, `receiver_idle`, `any_idle`, `all_busy`, `no_bots`. Without watching this line, several tests below cannot be distinguished from each other.

**Test 0 — before anything else.** Start the fleet and grep the boot log for `Successfully deployed slash commands!` and for `Invalid Form Body`. Slash commands auto-deploy on every ready (`Ready.ts:35`). If registration is failing, nothing else can pass because the commands won't appear in Discord at all.

---

## Ranked by likelihood of breaking

> **Making delegation happen at all.** Rung 2 of the ladder hands the command straight back to the receiving bot whenever that bot is idle, so a test where every bot is free never delegates — it just resolves `receiver_idle` and the bot you invoked does the work. **Every delegation test below therefore parks the receiving bot in another voice channel first.** Confirm the debug line says `any_idle` before trusting the result.

**1. Delegation happy path (rung 3).** Park **B3** playing in VC-B. You in VC-A, B1 and B2 idle. Run `/play` on **B3's** slash command.
Expect: `any_idle -> B1`. B3 posts a handoff notice; B1 (first idle in list order) joins VC-A and posts now-playing **as itself**. Check the now-playing embed's author and avatar are B1's, and that B1's player buttons respond. This is the whole architecture in one test.
If the log says `receiver_idle -> B3`, B3 was not actually busy — nothing delegated and this test proved nothing.

**2. Rung 1 continuity — highest consequence if wrong.** B1 already playing in VC-A, you in VC-A. Run `/play` on **B2**.
Expect: `in_user_vc` → B1, track appended to the existing queue, **no second bot joins**, and **no handoff notice** — the notice is suppressed for `in_user_vc` because B1 is visibly already there.
If you get `bot_already_in_channel`, the voice-state lookup fixed in the final wave has regressed.

**3. Rung 1 tie-break — the approved plan deviation.** Get B1 *and* B2 both into VC-A (B1 playing, B2 idle but present — via 24/7 or a manual join). You in VC-A, run `/play` on B3.
Expect: the bot **holding the queue** (B1) wins, not the idle co-occupant. `buildBotMeta` has no automated coverage, so this is the only check on that logic.

**4. All busy → guard ordering.** All three bots occupied in channels you are not in. Run `/play` **while in no voice channel at all**.
Expect: `no_voice_channel`, **not** `no_free_bots` — the busy check must come last. Then join VC-A and repeat: now expect `no_free_bots`.

**5. Guards validate the chosen bot, not the receiver.** Deny **B1** `Connect` on VC-A via channel overwrite; leave B2/B3 permitted. Park **B2** playing in VC-B so it cannot take its own command. You in VC-A, B1 and B3 idle, run `/play` on B2 — B1 gets picked by list order.
Expect: `any_idle -> B1`, then `no_connect_permission` **through B2's interaction reply**, and **no handoff notice** (guards run before the announcement). A handoff notice followed by silence means the wrong bot was validated — this is the specific correctness property the whole design exists for.

**6. Channel-visibility guard.** Deny **B1** `ViewChannel` on the text channel you're typing in, leave B2 permitted. Park **B2** in VC-B, keep B1 and B3 idle, then run `/play` on B2.
Expect: `any_idle -> B1` and a permission failure via B2's reply, not a silent hang.

**7. Pagination under delegation.** B1 playing in VC-A with 15+ tracks queued, you in VC-A. Run `/queue` on **B2**.
Expect: B1 posts the paginated embed and its own buttons page correctly. Repeat with `/lavalink`. A `40060 Interaction has already been acknowledged` means a regression.

**8. Defer resolution across every send shape.** Self-handled only. Run `/play`, `/queue`, `/ping`, `/lyrics`, `/grab`.
Expect: none leave a stuck "Bot is thinking…" placeholder. These five exercise four different send paths.

**9. Mention parity.** Repeat tests 1, 2 and 5 as `@B2 play <song>`. Then:
- `@B2` alone → help embed
- `@B2 nonsensecommand` → silence
- `@B2 play` with no query → missing-arguments embed

Known cosmetic wart: mention-delegated `skip`/`stop`/`skipto` produce no output from the chosen bot — you'll see the handoff notice plus a 👍 from the *receiver*, and silence from the bot that actually did the work. Confusing, not broken.

**10. Cross-bot search collector.** Park **B2** in VC-B, keep B1 idle, then run `/search <query>` on B2 so B1 is chosen.
Expect: `any_idle -> B1`, B1 posts the results, and **B1's** collector accepts your selection.

**11. Prefix path unchanged.** `!play` still works, still picks by consensus, and now emits the deprecation notice. Confirm only **one** bot responds.

**12. Setup channel, both interfaces.** In a guild with a setup channel: type a song name (works today), run `/play` there (expect a `setup_channel` rejection), then `@B1 play x` there (expect it swallowed by `setupSystem`). Run this to make the operational risk below concrete.

**13. The intent flip — nothing has tested this.** Set `messageContentIntent = false` on **one** bot only, restart the fleet, confirm it logs in. A wrong intent array fails login outright with `Used disallowed intents`. Then re-run tests 1, 2 and 9 against that bot.
Do this on one bot before all fifteen.

---

## RELEASE BLOCKER — setup-channel guilds, deadline 2026-08-27

**Owner: @ductridev. Must ship before the `MessageContent` revocation completes.**

**Guilds using the setup channel will have no working interface after the cutoff.** Three doors, all locked:

- `MessageCreate.ts` routes every setup-channel message to `setupSystem`, which reads `message.content` — empty once the intent is gone.
- `InteractionCreate.ts` actively **rejects** slash commands in a setup channel.
- A mention in a setup channel is swallowed by `setupSystem` before the mention branch runs.

This is not a regression in this branch — it is the intent loss meeting a pre-existing feature — so it does not block *merging* this branch. It does block the migration being complete: those guilds go from one working interface to zero.

The fix is to open one of the three doors, cheapest first: **drop the slash rejection in `InteractionCreate.ts`** and let the normal command path run in setup channels. Gating it on `messageContentIntent` would keep today's behaviour while the intent survives, but that gate becomes dead code the moment the revocation lands, so the unconditional version is the one to ship. Test 12 measures the current state; re-run it after the fix.

## Known-deferred items (none blocking)

- `locales/EnglishUS.json` has no `maintenance.*` namespace, so English guilds in maintenance mode see a Vietnamese-titled embed with an English body. Five string values; pre-existing, identical on the prefix path.
- Cooldowns are per-bot, so alternating a command across three bots gives 3× the intended rate. These are 5s anti-spam, and the prefix path behaved the same way.
- Four locale files (Dutch, Italian, PortuguesePT, Thai) are absent from the `Language` enum and never contribute slash-command localizations. Pre-existing.
- `npm run lint` cannot run — no eslint config exists anywhere in the repo's history.
- `Context.delegated`'s `members.resolve` is cache-only, and with `GuildMembers` dropped it can miss. A miss now **cancels the delegation** and the receiver handles the command locally, rather than silently validating the receiver's member while another bot executes. Watch the logs for `guild, channel or member not cached` during test 1 — frequent hits would mean delegation rarely happens in practice, which is a routing-quality problem, not a correctness one.
