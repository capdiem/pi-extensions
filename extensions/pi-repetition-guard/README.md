# pi-repetition-guard

A **repetition-loop guard** for the [Pi coding agent](https://pi.dev/). It
detects **thinking-runaway / 万字复读** — the failure mode where a model in a
long-thinking (or plain output) stage starts repeating the same text in a loop,
producing tens of thousands of redundant characters instead of converging to an
answer — and **aborts + re-steers** the model so you get a real answer instead
of a wall of repeated prose.

It is model-agnostic: it wraps whatever model Pi is calling, observes the
streamed output, and never rewrites mid-stream (Pi does not allow that — see
[ADR 0001](../../docs/adr/0001-ask-user-triggering-metadata-first.md)). It works
purely on the assistant message text, covering both the `thinking` stream and
the final `text` stream (whichever hits the threshold first).

> **Design note (ADR 0002):** this extension deliberately performs *active
> intervention* (`ctx.abort()` + a corrective `steer` message), which goes
> beyond the "no active injection" decision in ADR 0001. That ADR was scoped to
> `ask_user` triggering; the repetition guard is a safety mechanism where
> active abort is the whole point. See
> [docs/adr/0002-repetition-guard-active-abort.md](../../docs/adr/0002-repetition-guard-active-abort.md).

## Features

- **Two runaway detectors**, both model-agnostic and strictly within-message:
  - **Text repetition loop** (thinking-runaway / 万字复读) — the model re-emits
    the same text contiguously during long thinking or output. Detected via
    **tail periodicity** on `message_update`: the trailing `2×P` characters
    being an exact repetition of a fixed unit `P` (a "tape loop").
  - **Variation loop** (v5) — the model rewording the same intent over and over
    ("Let me read L1000-1035" / "Let me read the signature end" / ...) without
    advancing. Detected via **short-segment near-repetition dominance**: if
    ≥90% of a message's short segments (≤100 chars) are near-duplicates of each
    other (5-gram shingle overlap ≥0.7), the message is a loop. Restricting to
    short segments is what keeps it from false-positiving on legitimately long,
    templated thinking (which is built of long paragraphs).
  - **Tool-call loop** — the model repeatedly invokes the **same tool with the
    same input** and never settles (e.g. checking `git status` / reading a file
    over and over). Detected on `tool_call` by counting identical
    (tool, normalized-input) calls in a sliding window.
- The text signals are OR'd: a message triggers if either exact tail
  periodicity OR short-segment near-repetition dominance fires.
- **Zero false positives on legitimate content** — long self-verifying thinking,
  recaps, code, and templated lists interleave new material, so their tails are
  never periodic; varied tool usage (distinct calls) never trips the tool-loop
  counter. (v1 used a trailing-window shingle-novelty signal that
  false-triggered on legitimate long thinking — the bug this v2/v3 line fixes.
  See [ADR 0002](#design-notes-adr-0002) and [CONTEXT.md](../../CONTEXT.md)
  触发策略.)
- **Intervention**, per failure mode:
  - *Text loop*: `ctx.abort()` stops the generation, then a corrective `steer`
    is sent from `message_end` with a **truncated sample of the repeated unit**.
  - *Tool loop*: the repetitive tool call is **blocked** (`tool_call` →
    `{ block, terminate }`), then a steer naming the tool + repeated input is
    sent after the run settles.
- **Action-oriented steering (v4)**: steer messages redirect the model to
  *execute*, not to "give an answer" — a stuck loop is usually "rehearsing the
  next action without doing it" (e.g. repeating "let me check git status"
  without ever committing), so the steer tells it to stop describing and do the
  operation.
- **Retry budget**: max **3** steer retries per logical user turn, with
  escalating wording (1 → 2 → 3) and a clear "give up or state the blocker"
  fallback on the final retry. Still hard-capped — no infinite loop.
- **User-only control**: `/runaway on|off` slash command, default **on**. The
  guard cannot be disabled by the LLM itself (there is no LLM-callable toggle).

> **Why is there no "stage-1 / two-stage" trigger anymore?** The original design
> had a two-stage trigger (record a "suspect" early, abort only on a harder
> threshold). Measured against realistic content, *every* early-warning signal
> (shingle novelty, block-repeat, fractional-period) false-triggers on
> legitimate long structured thinking, while exact ≥2-copy contiguity never
> does. So the two-stage was collapsed into the single clean signal. See
> CONTEXT.md 触发策略 for the record.

## Install

```bash
pi install npm:@capdiem/pi-repetition-guard
```

To try it without installing:

```bash
pi -e ./extensions/pi-repetition-guard/index.ts
```

## Usage

Nothing to configure — it is on by default and runs silently in the background.

- **Normal operation:** you see nothing. The guard only acts on an unambiguous
  contiguous tape-loop or a repeated identical tool call.
- **Text runaway detected:** the generation is aborted and a `steer` retry runs
  automatically. In the TUI you'll see the aborted message, then the corrective
  message, then a fresh answer. (The aborted junk stays in history — no cleanup,
  per the settled design; see ADR 0002.)
- **Tool-call loop detected:** the repetitive tool call is blocked (a
  "Repetition guard: tool-call loop" reason), the run terminates, and a steer
  naming the tool + repeated input is sent. If it loops again, later steers
  escalate (2nd, 3rd); after the final retry it stops.
- **Disable / re-enable:**
  ```
  /runaway off
  /runaway on
  ```
  A bare `/runaway` toggles. In the TUI the footer status shows `guard:on` /
  `guard:off`.

## Behavior details

- **Budget reset:** a new logical user turn (a user message that is *not* our
  own steer) resets the retry budget to 2.
- **Scope:** only the current assistant message's own text is compared — the
  detector does not compare against the user's message or prior assistant
  messages, so restating the user's words never false-triggers.
- **Trigger signal (text):** either exact tail periodicity (≥2 exact copies of a
  ≥30-char unit at the tail) OR short-segment near-repetition dominance (≥90% of
  the message's short ≤100-char segments are near-duplicates). Both strictly
  within one message. Wholesale contiguous repetition is, by definition, the
  runaway signature; content that merely *echoes* earlier material while still
  advancing is not.
- **Trigger signal (tool):** the same tool called with the same normalized input
  ≥4 times within the last 8 calls. Varied legitimate tool usage never trips it.
- **Known limitation:** the text signals are deliberately conservative — a
  message is only flagged when either exactly periodic OR dominated by short
  near-duplicate restatements. A loop that is neither (long-form repetition with
  meaningful variation between copies) may slip through. This is the accepted
  trade-off to keep false positives at zero. See ADR 0002.
- **Sampling parameters are untouched:** Pi exposes no built-in
  `repetition_penalty` / `no_repeat_ngram_size`; this guard detects and
  intervenes client-side instead of relying on provider-side sampling knobs.

## Diagnostics

Detection events (hard trigger, retry count, budget exhaustion) are logged with
a `[pi-repetition-guard]` prefix. These records support tuning the fixed
detection thresholds over time — consistent with the repo's diagnostics
discipline (ADR 0001).

## License

MIT
