# pi-ask-user

An interactive `ask_user` form tool for the [Pi coding agent](https://pi.dev/).

When the model needs your decision, preference, or input — especially during a
[grilling](https://github.com/mattpocock/skills) / design-interview session — it
calls `ask_user` and you answer in an interactive **Custom UI** form instead of
reading a plain-text `Q1..QN` block and replying with numbered text. Each
question (with its `➡️ recommended answer`) becomes a selectable option or a
free-text field in the form.

## Features

- **Questions as a form, not text** — the official pi **Custom UI** mechanism
  (`ctx.ui.custom()`): a full-screen interactive form where each question is a
  selector (choice options with a free-text escape) or a free-text field. No
  more replying to a wall of `Q1..QN` text.
- **One call, many questions** — pass the whole round (a grilling frontier, a
  clarification batch) as a single form with up to 10 questions.
- **Choice and free-text** — each question is `type: "choice"` (options list,
  with an optional "Type something" free-text escape) or `type: "text"`.
- **Question numbering (optional)** — set `numbered: true` to label questions `Q1`, `Q2`, … in the form body with an optional short title (`Q1 - Scope:`), mirroring the original grilling format. Ordinary (non-grill) forms show just the prompt.
- **Recommended-answer hints** — each question may carry a `recommendation`
  (the grilling skill's `➡️ recommended answer`). When it matches one of a
  choice question's options, that option is marked with **`★`** and the
  recommendation shows beside it as `（推荐：…）`; otherwise it appears dimmed
  under the question as `Recommended: …`.
- **TUI mode** — a full-screen tabbed **Custom UI** form (↑↓ select, Tab/←→
  switch, Enter confirm, Esc cancel) via `ctx.ui.custom()`.
- **RPC mode** — the same questions as sequential `select`/`input` dialogs over
  the [extension UI protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#extension-ui-protocol).
  The recommended option's label carries the `（推荐：…）` detail merged in,
  and the selected display string is reverse-mapped back to the original option.
- **Graceful fallback** — in `print`/`json` modes it returns the questions as
  numbered text so the model asks in plain text, exactly like the old format.

## Install

```bash
pi install npm:@capdiem/pi-ask-user
```

To try it without installing:

```bash
pi -e ./extensions/pi-ask-user/index.ts
```

## Tool: `ask_user`

The model calls `ask_user` with a `questions` array. Each question:

```json
{
  "id": "q1",
  "title": "Scope",
  "prompt": "Should the scope include the migration path?",
  "type": "choice",
  "options": [
    { "value": "include", "label": "Include it", "description": "Safer, bigger" },
    { "value": "exclude", "label": "Exclude it", "description": "Faster to ship" }
  ],
  "allowOther": true,
  "recommendation": "include — deferring it now is much harder to reverse later"
}
```

For free-text questions use `type: "text"` (no `options` needed).

The top-level call accepts an optional `numbered` flag (default `false`):

- `numbered: true` — grilling style: each question is prefixed `Q1`, `Q2`, …
  in the form body (`Q1 - Scope: …`) and in results.
- omitted/false — ordinary form: only the prompt is shown (plus the optional
  `title`, e.g. `Scope: …`).

## Wiring it into grilling skills

`ask_user` ships strengthened `promptGuidelines` (since 0.2.0) that make the form
**mandatory** in grilling / domain-modeling / design-interview question rounds:
when a workflow presents question rounds as numbered plain-text blocks
(`Q1..QN`, `❓`, `recommended answer`), the model must call `ask_user` instead of
typing them out. The guidelines name the grilling family explicitly plus a
generic "成轮提问 / design-interview" fallback, so no third-party skill edits
are needed. See
[`docs/adr/0001-ask-user-triggering-metadata-first.md`](../../docs/adr/0001-ask-user-triggering-metadata-first.md).

It maps naturally onto [Matt Pocock's `grilling`
skill](https://github.com/mattpocock/skills) format:

| grilling skill | `ask_user` |
| --- | --- |
| `❓ Q1 - <title>: <body>` | numbered question (`numbered: true`) with title |
| choice options in the body | `type: "choice"` options |
| `➡️ <recommended answer>` | `recommendation` hint (marked `★` on the matching option) |
| free-form asks | `type: "text"` questions |

## Debugging trigger behavior

Pass `--ask-user-debug` to log one line per turn recording whether a question
round happened and whether it used `ask_user`:

```bash
pi --ask-user-debug
```

Example output: `[pi-ask-user] turn 3: question round via plain text
(wrotePlain=true, clean=false)`. This feeds the escalation gate (ADR-0001): if
repeated multi-scenario runs show most question rounds bypassing `ask_user`, the
metadata-first approach is judged insufficient and per-turn injection is
reconsidered.

## License

MIT
