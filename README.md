# Pi Extensions

A small collection of extensions for the [Pi coding agent](https://pi.dev/),
published and versioned independently.

## Packages

| Extension | npm | What it adds |
| --- | --- | --- |
| [Todo](extensions/pi-todo/README.md) | `@capdiem/pi-todo` | Lightweight atomic whole-plan updates, with a TUI widget and a pi-agent-desktop sidebar panel |
| [Ask User](extensions/pi-ask-user/README.md) | `@capdiem/pi-ask-user` | Interactive `ask_user` Custom UI form — turns grilling questions into selectable options with recommended-answer hints |
| [Repetition Guard](extensions/pi-repetition-guard/README.md) | `@capdiem/pi-repetition-guard` | Detects thinking-runaway / 万字复读 repetition loops in streamed output and aborts + re-steers the model |

## Quick start

Install the todo extension. Remove any other extension that owns the same
`todo` tool name first:

```bash
pi remove <the-other-todo-extension>
pi install npm:@capdiem/pi-todo
```

Install the ask-user extension (owns the `ask_user` tool name):

```bash
pi install npm:@capdiem/pi-ask-user
```

Install the repetition-guard extension (detects thinking-runaway / 万字复读
repetition loops in streamed output, aborts and re-steers the model):

```bash
pi install npm:@capdiem/pi-repetition-guard
```

## License

[MIT](LICENSE)
