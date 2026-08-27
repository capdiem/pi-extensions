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

### Releasing

A [GitHub Actions workflow](.github/workflows/publish.yml) builds the staging
packages and publishes them to npm. It runs on version tags (`v*`) or manually
from the Actions tab.

To publish a new release:

```bash
bun run check          # privacy + lint + tests must pass
bun run pack:check     # verify both tarballs

git tag v0.1.0
# bump extensions/<name>/package.json version first if it has already been
# published at that version

git push origin v0.1.0
```

Publishing uses npm **Trusted Publishing**: the workflow authenticates to npm
through GitHub OIDC and signs each package with provenance, so **no npm token
secret is required**. Both packages publish from their `dist/` staging
directories at the versions declared in their `package.json`.

Configure a Trusted Publisher for each package once on
[npmjs.com](https://www.npmjs.com) — the entry is on the **package settings
page**, not the account menu:

1. npmjs.com → **Packages** → click `@capdiem/pi-todo` (and `@capdiem/pi-ask-user`)
2. On the package page → **Settings** tab → **Trusted publishing** section → Add Publisher
3. Choose **GitHub Actions** and fill in:
   - **Organization or user:** `capdiem`
   - **Repository:** `pi-extensions`
   - **Workflow filename:** `publish.yml`
   - **Environment name:** (leave empty)
   - **Allowed actions:** `npm publish`

### Repository layout

| Path | Contents |
| --- | --- |
| `extensions/pi-todo/` | The todo extension source |
| `extensions/pi-ask-user/` | The ask-user question-form extension source |
| `tests/` | Unit tests |
| `scripts/` | Build, privacy, and package validation scripts |

## License

[MIT](LICENSE)
