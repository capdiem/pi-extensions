# Pi Ask User

An interactive `ask_user` form tool for the [Pi coding agent](https://pi.dev/).

When the model needs your decision, preference, or input — especially during a
grilling / design-interview session — it calls `ask_user` and you answer in an
interactive form instead of reading a plain-text `Q1..QN` block and replying
with numbered text.

## Features

- **One call, many questions** — pass the whole round (a grilling frontier, a
  clarification batch) as a single form with up to 10 questions.
- **Choice and free-text** — each question is `type: "choice"` (options list,
  with an optional "Type something" free-text escape) or `type: "text"`.
- **Question numbering (optional)** — set `numbered: true` to label questions `Q1`, `Q2`, … in the form body with an optional short title (`Q1 - Scope:`), mirroring the original grilling format. Ordinary (non-grill) forms show just the prompt.
- **Recommended-answer hints** — each question may carry a `recommendation` (the grilling skill's `➡️ recommended answer`). When it matches one of a choice question's options, that option is marked with a **`★`** between the option number and the label (bold label), and its description (muted) plus the recommendation detail (default + bold, wrapped as `（推荐：…）`) are shown together on one line — a leading title in the recommendation is stripped (grill shape `<标题> - <详情>`, taking only the `<详情>` after the first dash). Otherwise the recommendation appears dimmed under the question as `Recommended: …`.
- **TUI mode** — a full-screen tabbed form (↑↓ select, Tab/←→ switch, Enter
  confirm, Esc cancel) via `ctx.ui.custom()`.
- **RPC mode** — the same questions as sequential `select`/`input` dialogs over
  the [extension UI protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#extension-ui-protocol).
  The recommended option's label carries the `（推荐：…）` detail merged in,
  and the selected display string is reverse-mapped back to the original option.
- **Graceful fallback** — in `print`/`json` modes it returns the questions as
  numbered text so the model asks in plain text, exactly like the old format.

## Install

```bash
pi install npm:pi-ask-user
```

Or load it directly from source during development:

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

`ask_user` ships `promptGuidelines` that tell the model to prefer the form over
plain-text `Q1..QN`. To make a grilling skill (e.g. Matt Pocock's
`/grilling`) deterministic, add one line to the skill:

> Present each round's frontier via the `ask_user` tool as a form. If the
> `ask_user` tool is not available, fall back to numbered plain-text questions.

## License

MIT
