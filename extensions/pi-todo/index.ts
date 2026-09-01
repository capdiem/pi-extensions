import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  MAX_TODO_TASKS,
  buildTodoNudge,
  createEmptyTodoState,
  formatChange,
  hasInProgress,
  isTodoStatus,
  isValidTodoState,
  replayTodoState,
  writeTodo,
  type TodoState,
  type TodoStatus,
  type TodoTask,
} from "./state.ts";

const TODO_TOOL_NAME = "todo";
const WIDGET_KEY = "pi-todo-widget";
const STATE_CUSTOM_TYPE = "pi-todo-state";

// Desktop-owned todo widget protocol (setWidget channel): the widget key and
// line format are defined by pi-agent-desktop
// (D:\Code\pi-agent-desktop\lib\todo-state.ts). This extension conforms by
// emitting the same key and JSON-per-line payload, so the desktop can route
// the `setWidget` request straight into its sidebar todo panel.
const TODO_WIDGET_KEY = "pi-agent-desktop:todo";

/** Serialize a TodoState to widget lines (one task per JSON line) for the
 * desktop todo widget protocol. Mirrors the desktop's serializer. */
function serializeTodoWidgetLines(state: TodoState): string[] {
  return state.tasks.map((task) => JSON.stringify(task));
}

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
  let widgetRegistered = false;
  let widgetTui: TUI | undefined;
  // Plan-B reconcile nudge state (run-end reminder). `nudgedThisTurn` is reset
  // only by a REAL user turn (a user message that is not our own nudge), so our
  // nudge's own delivery can never re-trigger it — no nudge loop.
  let nudgedThisTurn = false;
  const sentNudges = new Set<string>();

  const nudgeText = (): string => buildTodoNudge();

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
    // pi-agent-desktop todo widget protocol (RPC/desktop): push the live plan
    // over `setWidget` with the desktop-reserved key. Fire-and-forget — the
    // desktop parses the JSON lines into the sidebar panel. Cleared (undefined)
    // when the plan is empty so the panel hides. The TUI widget path below
    // stays separate and unchanged.
    if (!uiContext?.hasUI) return;
    if (uiContext.mode !== "tui") {
      // RPC / desktop host: live todo widget over the reserved key.
      try {
        uiContext.ui.setWidget(
          TODO_WIDGET_KEY,
          state.tasks.length > 0 ? serializeTodoWidgetLines(state) : undefined,
        );
      } catch {}
      return;
    }
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
      "Organize the plan by work content: a coherent objective that may span multiple turns, and a plan can hold several work contents worked across different turns. Give each work content a stable slug and prefix its todos' keys with it (e.g. auth.validate-token, auth.refresh-token) so pruning can target a whole work content.",
      "Write task subjects in the user's language (e.g. Chinese when the user writes in Chinese). Task keys must stay lowercase ASCII slugs (a-z, 0-9, . _ -) — they are stable identities, not display text.",
      "The list is one flat ordered sequence, not grouped sections: order todos by execution/dependency order, and when work contents are related keep their todos in sequence in the same list rather than splitting them into separate blocks. The UI renders this as a single ordered list — there are no work-content groups or headers.",
      "Each todo call replaces the task list. Include every key to keep; omitted keys are deleted.",
      "Keep keys stable. Existing tasks may omit unchanged fields; new tasks require subject and status. Include baseVersion when available.",
      "Only one task may be in_progress at a time.",
      "Completed todos are never auto-removed. Keep them struck through as history while their work content is still open.",
      "Prune completed todos only when their whole work content is complete: once every todo under a work content is done, remove all of that content's todos together in the next todo call. Work contents are pruned independently — a completed work content is removed even when other work contents remain open. Turn boundaries are not cleanup points.",
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

  pi.on("session_shutdown", async () => {
    clearWidget();
    uiContext = undefined;
  });

  // Plan B: run-end reconcile nudge. `agent_settled` fires exactly once per turn
  // (after any auto-retries/compactions/follow-ups), which is the point where Pi
  // confirms the agent will not continue running automatically. If tasks are
  // still in_progress and we have not nudged this logical turn, send one steer
  // reminding the agent to mark them completed if the work is actually done.
  pi.on("agent_settled", () => {
    if (nudgedThisTurn || !hasInProgress(state)) return;
    nudgedThisTurn = true;
    const text = nudgeText();
    sentNudges.add(text);
    pi.sendUserMessage(text, { deliverAs: "steer" });
  });

  // Reset the nudge budget on a REAL user turn. Our own nudge arrives back as a
  // user message with the exact text we sent — recognizing it by content (same
  // pattern as repetition-guard's RetryBudget) means the nudge's own agent run
  // is not treated as a new user turn, so it can't fire repeatedly in a loop.
  pi.on("message_start", (event) => {
    if (event.message?.role !== "user") return;
    const text = contentText(event.message.content);
    if (text && sentNudges.has(text)) {
      sentNudges.delete(text);
      return;
    }
    nudgedThisTurn = false;
  });
}

/** Concatenate the text of a user message, for matching against our nudge. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    if (item && typeof item === "object") {
      const t = (item as { text?: unknown }).text;
      if (typeof t === "string") text += t;
    }
  }
  return text;
}
