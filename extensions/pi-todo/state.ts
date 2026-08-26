export type TodoStatus = "pending" | "in_progress" | "completed";

const TODO_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

export const MAX_TODO_TASKS = 50;
export const MAX_TASK_SUBJECT_LENGTH = 160;

export interface TodoTask {
  key: string;
  subject: string;
  status: TodoStatus;
}

export interface TodoState {
  version: number;
  tasks: TodoTask[];
}

export interface TodoTaskInput {
  key: string;
  subject?: string;
  status?: TodoStatus;
}

export interface TodoSnapshotInput {
  tasks: TodoTaskInput[];
  baseVersion?: number;
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.has(value);
}

export function createEmptyTodoState(): TodoState {
  return { version: 0, tasks: [] };
}

export function cloneTodoState(state: TodoState): TodoState {
  return { version: state.version, tasks: state.tasks.map((task) => ({ ...task })) };
}

function normalizeTaskKey(value: string, location: string): string {
  const key = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(key)) {
    throw new Error(
      `${location} must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return key;
}

function tasksEqual(left: readonly TodoTask[], right: readonly TodoTask[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a.key !== b.key || a.subject !== b.subject || a.status !== b.status) return false;
  }
  return true;
}

/**
 * Write the complete authoritative task list with one atomic update.
 *
 * Semantics:
 * - Every key present in `tasks` is retained; omitted current keys are permanently
 *   deleted (there is no cancelled or archived state).
 * - Existing keys inherit omitted fields (`subject`, `status`) from their previous
 *   value; a new key requires both.
 * - At most one task may be `in_progress` at a time.
 * - `baseVersion`, when provided, rejects stale writes: if it does not match the
 *   current version the write fails without mutating state.
 * - All validation is all-or-nothing: a failed write never mutates state.
 * - A write that leaves the plan unchanged does not bump the version, so redundant
 *   submissions do not invalidate the next write.
 */
export function writeTodo(state: TodoState, input: TodoSnapshotInput): TodoState {
  if (input.baseVersion !== undefined && input.baseVersion !== state.version) {
    throw new Error(
      `stale todo version: expected ${input.baseVersion}, current version is ${state.version}`,
    );
  }
  if (input.tasks.length > MAX_TODO_TASKS) {
    throw new Error(`tasks supports at most ${MAX_TODO_TASKS} items`);
  }

  const existingByKey = new Map(state.tasks.map((task) => [task.key, task]));
  const seenKeys = new Set<string>();
  const next: TodoTask[] = [];

  for (const [index, patch] of input.tasks.entries()) {
    const key = normalizeTaskKey(patch.key, `tasks[${index}].key`);
    if (seenKeys.has(key)) {
      throw new Error(`tasks[${index}].key is duplicated: ${key}`);
    }
    seenKeys.add(key);

    const existing = existingByKey.get(key);
    const subject = patch.subject ?? existing?.subject;
    if (subject === undefined) {
      throw new Error(`tasks[${index}].subject is required for new task ${key}`);
    }
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      throw new Error(`tasks[${index}].subject is required for new task ${key}`);
    }
    if (trimmedSubject.length > MAX_TASK_SUBJECT_LENGTH) {
      throw new Error(
        `tasks[${index}].subject must be at most ${MAX_TASK_SUBJECT_LENGTH} characters`,
      );
    }
    const status = patch.status ?? existing?.status;
    if (status === undefined) {
      throw new Error(`tasks[${index}].status is required for new task ${key}`);
    }
    if (!isTodoStatus(status)) {
      throw new Error(`tasks[${index}].status is invalid: ${String(status)}`);
    }

    next.push({ key, subject: trimmedSubject, status });
  }

  const active = next.filter((task) => task.status === "in_progress");
  if (active.length > 1) {
    throw new Error(
      `only one task may be in_progress at a time (got ${active.length}: ${active.map((task) => task.key).join(", ")})`,
    );
  }

  return {
    version: tasksEqual(state.tasks, next) ? state.version : state.version + 1,
    tasks: next,
  };
}

/**
 * Remove completed tasks that are no longer needed. Without dependencies, every
 * completed task can be dropped once the turn that completed it is over. Returns
 * undefined when there is nothing to remove.
 */
export function removeCompletedTasks(state: TodoState): TodoState | undefined {
  if (!state.tasks.some((task) => task.status === "completed")) return undefined;
  return writeTodo(state, {
    tasks: state.tasks.filter((task) => task.status !== "completed"),
    baseVersion: state.version,
  });
}

export function isValidTodoState(value: unknown): value is TodoState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; tasks?: unknown };
  if (
    typeof candidate.version !== "number"
    || !Number.isSafeInteger(candidate.version)
    || candidate.version < 0
  ) {
    return false;
  }
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length > MAX_TODO_TASKS) {
    return false;
  }
  const seen = new Set<string>();
  for (const rawTask of candidate.tasks) {
    if (!rawTask || typeof rawTask !== "object") return false;
    const task = rawTask as { key?: unknown; subject?: unknown; status?: unknown };
    if (
      typeof task.key !== "string"
      || typeof task.subject !== "string"
      || typeof task.subject.trim() !== "string"
      || !task.subject.trim()
      || task.subject.length > MAX_TASK_SUBJECT_LENGTH
      || !isTodoStatus(task.status)
    ) {
      return false;
    }
    let key: string;
    try {
      key = normalizeTaskKey(task.key, "key");
    } catch {
      return false;
    }
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const active = (candidate.tasks as TodoTask[]).filter((task) => task.status === "in_progress");
  if (active.length > 1) return false;
  return true;
}

/**
 * Reconstruct the current state by replaying the branch. The latest valid tool
 * result (or hidden cleanup message) for the `todo` tool wins.
 */
export function replayTodoState(
  ctx: { sessionManager: { getBranch(): Iterable<unknown> } },
  toolName: string,
  customType: string,
): TodoState {
  let state = createEmptyTodoState();
  for (const rawEntry of ctx.sessionManager.getBranch()) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as {
      type?: unknown;
      customType?: unknown;
      details?: unknown;
      message?: { role?: unknown; toolName?: unknown; details?: unknown };
    };
    let restored: TodoState | undefined;

    if (
      entry.type === "custom_message"
      && entry.customType === customType
      && isValidTodoState(entry.details)
    ) {
      restored = entry.details;
    } else if (
      entry.type === "message"
      && entry.message
      && entry.message.role === "toolResult"
      && entry.message.toolName === toolName
      && isValidTodoState(entry.message.details)
    ) {
      restored = entry.message.details;
    }

    if (restored) state = cloneTodoState(restored);
  }
  return state;
}

export function formatChange(state: TodoState): string {
  if (state.tasks.length === 0) {
    return `Todo plan cleared (version ${state.version}).`;
  }
  const lines = state.tasks.map(
    (task) => `[${task.status}] ${task.key}: ${task.subject}`,
  );
  return `Todo plan version ${state.version}:\n${lines.join("\n")}`;
}
