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

- **Hybrid detection** over the accumulated streamed text (`message_update`):
  - *Block-repeat* (primary, low false-positive): a long block (line) repeated
    2× → suspect, 3× → hard.
  - *Shingle novelty* (confirmatory, earlier): the trailing ~40×40-char window
    mostly re-emitting already-seen content → suspect at ≥80%, hard at ≥95%.
- **Two-stage trigger**: stage-1 "suspect" is **record-only** (a log line); only
  stage-2 "hard" aborts. This gives normal long-form content (code blocks,
  lists, prose) room before anything is interrupted.
- **Abort + re-steer** on hard trigger:
  - `ctx.abort()` stops the runaway generation in `message_update`.
  - A corrective `steer` message is sent from `message_end` (race-free — the
    aborted message is finalized by then): *"you are in a repetition loop, stop
    repeating, give a concise final answer"* plus a **truncated sample of the
    repeated block** so the model can see exactly what it was repeating.
- **Retry budget**: max **2** steer retries per logical user turn, with
  escalated wording on the 2nd; if it still runaways, it aborts without another
  steer (no infinite abort↔steer loop).
- **User-only control**: `/runaway on|off` slash command, default **on**. The
  guard cannot be disabled by the LLM itself (there is no LLM-callable toggle).

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

- **Normal operation:** you see nothing. Stage-1 "suspect" writes a
  `[pi-repetition-guard]` log line only.
- **Runaway detected:** the generation is aborted and a `steer` retry runs
  automatically. In the TUI you'll see the aborted message, then the corrective
  message, then a fresh answer. (The aborted junk stays in history — no cleanup,
  per the settled design; see ADR 0002.)
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
- **Wholesale repetition is always flagged:** re-emitting any content verbatim
  (even a "checklist") is, by definition, the runaway signature.
- **Sampling parameters are untouched:** Pi exposes no built-in
  `repetition_penalty` / `no_repeat_ngram_size`; this guard detects and
  intervenes client-side instead of relying on provider-side sampling knobs.

## Diagnostics

Detection events (stage-1 suspect, stage-2 hard trigger, retry count, budget
exhaustion) are logged with a `[pi-repetition-guard]` prefix. These records
support tuning the fixed two-stage thresholds over time — consistent with the
repo's diagnostics discipline (ADR 0001).

## License

MIT
