# Pi Extensions

[![License: MIT](LICENSE)](LICENSE)

A small collection of extensions for the [Pi coding agent](https://pi.dev/),
published and versioned independently.

## Packages

| Extension | npm | What it adds |
| --- | --- | --- |
| [Todo](extensions/pi-todo/README.md) | `pi-todo` | Atomic whole-plan updates, three statuses, auto-cleanup, and a read-only TUI widget |
| [Ask User](extensions/pi-ask-user/README.md) | `pi-ask-user` | Interactive `ask_user` question form — choice or free-text questions with recommended-answer hints, in TUI and RPC |

## Quick start

Install the todo extension. Remove any other extension that owns the same
`todo` tool name first:

```bash
pi remove <the-other-todo-extension>
pi install npm:pi-todo
```

Install the ask-user extension (owns the `ask_user` tool name):

```bash
pi install npm:pi-ask-user
```

Or load it directly from source during development:

```bash
pi -e ./extensions/pi-todo/index.ts
```

## Development

The repository is a private Bun 1.3.14 workspace.

### Install, build, and test

```bash
bun install --frozen-lockfile
bun run build:all
bun run check
bun run pack:check
```

`bun run check` runs the privacy scanner, strict TypeScript checking, and the
unit test suite. The privacy scanner rejects developer-specific paths,
accounts, hosts, emails, private IPs, and credential-shaped material in
committed test fixtures.

### Build output

Builds never create package-local `dist/` directories. Each complete npm
staging package is generated under the repository root:

```text
dist/pi-todo/
├── index.min.js
├── index.min.js.map
├── package.json
├── README.md
└── LICENSE
```

dist/pi-ask-user/
├── index.min.js
├── index.min.js.map
├── package.json
├── README.md
└── LICENSE
```

Root `dist/` is ignored by Git and rebuilt from release tags.

### Repository layout

| Path | Contents |
| --- | --- |
| `extensions/pi-todo/` | The todo extension source |
| `extensions/pi-ask-user/` | The ask-user question-form extension source |
| `tests/` | Unit tests |
| `scripts/` | Build, privacy, and package validation scripts |

## License

[MIT](LICENSE)
