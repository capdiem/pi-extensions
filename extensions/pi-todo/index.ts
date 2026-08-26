import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  MAX_TODO_TASKS,
  createEmptyTodoState,
  formatChange,
  isTodoStatus,
  isValidTodoState,
  removeCompletedTasks,
  replayTodoState,
  writeTodo,
  type TodoState,
  type TodoStatus,
  type TodoTask,
} from "./state.ts";

const TODO_TOOL_NAME = "todo";
const WIDGET_KEY = "pi-todo-widget";
const STATE_CUSTOM_TYPE = "pi-todo-state";
// pi-agent-desktop todo protocol: a custom message type (distinct from the
// `todo` tool name). Emitted with the canonical TodoState as `details` so the
// desktop panel can render it. See D:\Code\pi-agent-desktop\docs\todo-protocol.md.
const TODO_DESKTOP_PROTOCOL_TYPE = "todo";

const TodoKeySchema = Type.String({
  description:
    "Stable 1-40 character lowercase task key, e.g. inspect-api or write-tests",
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9][a-z0-9._-]*$",
});

const TodoTaskSchema = Type.Object({
  key: TodoKeySchema,
  subject: Type.Optional(
    Type.String({
      description:
        "Short imperative task subject; required for a new key, omitted to keep an existing value",
      minLength: 1,
      maxLength: 160,
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed"] as const, {
      description:
        "Task status; required for a new key, omitted to keep an existing value",
    }),
  ),
});

const TodoParamsSchema = Type.Object({
  tasks: Type.Array(TodoTaskSchema, {
    description:
      "Complete authoritative list of tasks to retain; omitted keys are deleted, existing tasks may omit unchanged fields, and new keys require subject and status",
    maxItems: MAX_TODO_TASKS,
  }),
  baseVersion: Type.Optional(
    Type.Integer({
      description:
        "Version shown in current todo context; rejects stale writes when provided",
      minimum: 0,
    }),
  ),
});

/** Markdown-style glyphs: [ ] pending, [-] in_progress, [x] completed. */
function todoGlyph(status: TodoStatus): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[-]" : "[ ]";
}

interface TodoDisplayTask {
  subject: string;
  status?: TodoStatus;
}

function renderTaskLine(task: TodoDisplayTask, theme: Theme): string {
  if (!task.status) return theme.fg("text", task.subject);
  const glyph = theme.fg(
    task.status === "completed"
      ? "success"
      : task.status === "in_progress"
        ? "warning"
        : "muted",
    todoGlyph(task.status),
  );
  let subject = theme.fg(
    task.status === "completed" ? "dim" : "text",
    task.subject,
  );
  if (task.status === "completed") subject = theme.strikethrough(subject);
  else if (task.status === "in_progress") subject = theme.bold(subject);
  return `${glyph} ${subject}`;
}

function renderTodoWidget(state: TodoState, width: number, theme: Theme): string[] {
  if (state.tasks.length === 0) return [];
  const completed = state.tasks.filter((task) => task.status === "completed").length;
  const lines = [
    theme.fg(
      "accent",
      theme.bold(`Todo ${completed}/${state.tasks.length} completed`),
    ) + theme.fg("dim", ` v${state.version}`),
  ];
  lines.push(...state.tasks.map((task) => renderTaskLine(task, theme)));
  return lines.map((line) => truncateToWidth(line, width, "…"));
}

/** Resolve a partially streamed `todo` call against current state for the live preview. */
function resolveDraftTasks(rawTasks: unknown, state: TodoState): TodoDisplayTask[] {
  if (!Array.isArray(rawTasks)) return [];
  const currentByKey = new Map(state.tasks.map((task) => [task.key, task]));
  const tasks: TodoDisplayTask[] = [];
  for (const rawTask of rawTasks) {
    const draft =
      rawTask && typeof rawTask === "object"
        ? (rawTask as { key?: unknown; subject?: unknown; status?: unknown })
        : {};
    const key = typeof draft.key === "string" ? draft.key.trim() : "";
    const current = key ? currentByKey.get(key) : undefined;
    const subject =
      typeof draft.subject === "string" && draft.subject.trim()
        ? draft.subject.trim()
        : current?.subject;
    if (!key || !subject) continue;
    tasks.push({
      subject,
      status: isTodoStatus(draft.status) ? draft.status : current?.status,
    });
  }
  return tasks;
}

export default function todoMiniExtension(pi: ExtensionAPI): void {
  let state = createEmptyTodoState();
  let uiContext: ExtensionContext | undefined;
  // Desktop protocol guard: only emit when the version actually changes.
  let lastEmittedVersion = -1;
  let widgetRegistered = false;
  let widgetTui: TUI | undefined;

  const clearWidget = (): void => {
    if (widgetRegistered && uiContext?.hasUI) {
      try {
        uiContext.ui.setWidget(WIDGET_KEY, undefined);
      } catch {}
    }
    widgetRegistered = false;
    widgetTui = undefined;
  };

  const updateWidget = (ctx?: ExtensionContext): void => {
    if (ctx) uiContext = ctx;
    // pi-agent-desktop todo protocol: emit the current state whenever it
    // changes. Runs in every mode (TUI and RPC); the TUI widget logic below is
    // unchanged. `triggerTurn: false` persists immediately without steering the
    // agent or starting a new turn. The desktop protocol is minimal — it only
    // needs `tasks` — so the native state is emitted as-is, extra fields
    // (`version`, etc.) are ignored.
    if (state.version !== lastEmittedVersion) {
      lastEmittedVersion = state.version;
      try {
        pi.sendMessage(
          {
            customType: TODO_DESKTOP_PROTOCOL_TYPE,
            content: "",
            display: false,
            details: state,
          },
          { triggerTurn: false },
        );
      } catch {}
    }
    if (!uiContext?.hasUI || uiContext.mode !== "tui") return;
    if (state.tasks.length === 0) {
      clearWidget();
      return;
    }
    if (!widgetRegistered) {
      uiContext.ui.setWidget(
        WIDGET_KEY,
        (tui: TUI, theme: Theme) => {
          widgetTui = tui;
          return {
            render: (width: number) => renderTodoWidget(state, width, theme),
            invalidate: () => {},
            dispose: () => {
              if (widgetTui === tui) widgetTui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      widgetRegistered = true;
    } else {
      widgetTui?.requestRender();
    }
  };

  pi.registerTool({
    name: TODO_TOOL_NAME,
    label: "Todo",
    description: `Maintain the task plan with one atomic update. Every call replaces the task list: include each key to keep, and omit a key to delete it. Existing tasks may omit unchanged fields; new tasks require subject and status. At most one task may be in_progress. Up to ${MAX_TODO_TASKS} tasks; an empty list clears the plan.`,
    promptSnippet: "Maintain the task plan with one atomic update",
    promptGuidelines: [
      "When a task needs a plan of 3+ steps, define it yourself and call todo before beginning implementation or other substantive work.",
      "Each todo call replaces the task list. Include every key to keep; omitted keys are deleted.",
      "Keep keys stable. Existing tasks may omit unchanged fields; new tasks require subject and status. Include baseVersion when available.",
      "Only one task may be in_progress at a time.",
      "Mark work completed only after implementation and verification succeed. Completed tasks are removed next turn.",
      "While a todo plan exists, update todo immediately when task status, order, or scope changes, and reconcile actual progress before the final response. Do not issue a no-op todo call only to acknowledge a reminder.",
    ],
    parameters: TodoParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state = writeTodo(state, params);
      updateWidget(ctx);
      return {
        content: [{ type: "text", text: formatChange(state) }],
        details: state,
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const tasks = resolveDraftTasks(args.tasks, state);
      const hasTaskList = Array.isArray(args.tasks);
      const count = hasTaskList ? args.tasks.length : 0;
      const summary = hasTaskList
        ? theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`)
        : "";
      const lines = [
        [theme.fg("toolTitle", theme.bold("todo")), summary]
          .filter(Boolean)
          .join(" "),
      ];
      lines.push(...tasks.map((task) => renderTaskLine(task, theme)));
      text.setText(lines.join("\n"));
      return text;
    },

    renderResult(result, _opts, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (context.isError || !isValidTodoState(result.details)) {
        const output = result.content
          .filter(
            (item): item is { type: "text"; text: string } => item.type === "text",
          )
          .map((item) => item.text)
          .join("\n");
        text.setText(theme.fg("error", output));
        return text;
      }
      // A successful write is already rendered by the tool call above; keep this empty.
      text.setText("");
      return text;
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    clearWidget();
    state = replayTodoState(
      { sessionManager: { getBranch: () => ctx.sessionManager.getBranch() } },
      TODO_TOOL_NAME,
      STATE_CUSTOM_TYPE,
    );
    uiContext = ctx;
    updateWidget(ctx);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", async () => {
    const removed = removeCompletedTasks(state);
    if (!removed) return;
    state = removed;
    updateWidget();
    return {
      message: {
        customType: STATE_CUSTOM_TYPE,
        content: formatChange(removed),
        display: false,
        details: removed,
      },
    };
  });

  pi.on("session_shutdown", async () => {
    clearWidget();
    uiContext = undefined;
  });
}
