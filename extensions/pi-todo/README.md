# pi-todo

A minimal, atomic todo tool for the [Pi coding agent](https://pi.dev/). The model
writes the complete task plan in one call instead of issuing one `create` call
per task.

This is a deliberately small todo tool: it keeps the essential plan-maintenance
core and drops dependencies, reminders, settings menus, and collapse/expand.
It is a good starting point if you want to understand or extend a todo tool
without the production hardening of a full extension.

## Features

- One-call creation of a complete plan (snapshot semantics)
- Three statuses: `pending`, `in_progress`, `completed`
- Stable task keys; omission-based deletion (no `cancelled` or `archived` state)
- `baseVersion` stale-write guard against concurrent/out-of-order updates
- At most one `in_progress` task at a time
- Atomic validation — a failed write never mutates state
- Completed todos are never auto-removed; the model prunes them (by omitting
  their keys) once their whole work content is complete
- State persists in tool-result details and survives `/reload` and `/tree`
- A read-only widget above Pi's input box using markdown-style glyphs
  (`[ ]` pending, `[-]` in_progress, `[x]` completed); no collapse/expand

## Install

This extension registers the `todo` tool. Remove any other extension that
owns the same `todo` tool name before installing it, e.g.:

```bash
pi remove <the-other-todo-extension>
pi install npm:pi-todo
```

During local development:

```bash
pi -e ./extensions/pi-todo/index.ts
```

## Tool schema

The `todo` tool accepts the complete authoritative list of tasks to retain.
Existing tasks may omit unchanged fields; a new key requires `subject` and
`status`. Any current key omitted from `tasks` is permanently deleted:

```ts
todo({
  baseVersion?: number,
  tasks: Array<{
    key: string,
    subject?: string,
    status?: "pending" | "in_progress" | "completed",
  }>,
})
```

Example:

```json
{
  "baseVersion": 0,
  "tasks": [
    { "key": "inspect", "subject": "Inspect the existing implementation", "status": "in_progress" },
    { "key": "implement", "subject": "Implement the optimized protocol", "status": "pending" },
    { "key": "verify", "subject": "Verify the implementation", "status": "pending" }
  ]
}
```

To hand work off, include every current key but only send changed fields:

```json
{
  "baseVersion": 1,
  "tasks": [
    { "key": "inspect", "status": "completed" },
    { "key": "implement", "status": "in_progress" },
    { "key": "verify" }
  ]
}
```

Subjects are inherited from the previous snapshot; both status changes commit
atomically.

To cancel or otherwise delete work, omit its key from the next complete plan.
Deletion is permanent state removal — there is no `cancelled` status or
archived record.

## Semantics

- `key` is the task identity while that task remains in the plan.
- Existing keys inherit omitted fields from their previous state.
- New keys require `subject` and `status`.
- Every key present in `tasks` remains in the plan; omitted current keys are
  permanently deleted.
- Completed tasks remain visible (struck through) until the model prunes them
  by omitting their keys once their whole work content is complete.
- `tasks: []` clears the plan.
- `baseVersion`, when provided, rejects stale writes.
- At most one task may be `in_progress` at a time.
- Validation is all-or-nothing; failed writes do not mutate state.
- A write that leaves the plan unchanged does not bump the version.

Each successful result includes the current version and complete plan.

## Rendering

The task list is rendered in a read-only widget above Pi's input box. It always
shows the full list (no collapse/expand): a progress header plus every task with
a markdown-style status glyph. `in_progress` labels are bold, completed labels
are struck through. The widget appears only while a plan exists.

## Desktop integration

In `rpc` mode (e.g. hosted by [pi-agent-desktop](https://github.com/.../pi-agent-desktop)),
the plan is pushed to the host over the desktop-owned **todo widget extension point**
(defined by pi-agent-desktop, see its `lib/todo-state.ts` and
`docs/todo-widget.md`): a `setWidget` request with the desktop-reserved key
`"pi-agent-desktop:todo"`, one JSON `TodoTask` per line. The desktop routes it straight into its
sidebar todo panel. It is fire-and-forget (not persisted); when the desktop
opens a session, this extension's `session_start` restore re-emits the current
plan, so the panel shows the latest snapshot. The TUI keeps its own component
widget (see Rendering) and is unchanged.

## Persistence

Writes are stored in tool-result `details`. On `session_start` and `/tree`
navigation, the extension restores the latest valid state entry from the active
branch. (For backwards compatibility it also recognizes legacy hidden
custom-message snapshots emitted by older versions that auto-removed completed
tasks.)

This minimal extension does **not** handle compaction checkpoints: if compaction
drops every `todo` tool result from the branch, the plan resets to empty (the
model's own context still contains the plan text). Add compaction handling from
a full-featured todo extension if that matters to your workflow.

## License

MIT
