import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloneTodoState,
  createEmptyTodoState,
  formatChange,
  isValidTodoState,
  removeCompletedTasks,
  replayTodoState,
  type TodoState,
  type TodoTaskInput,
  writeTodo,
} from "../extensions/pi-todo/state.ts";

const initialPlan: TodoTaskInput[] = [
  { key: "inspect", subject: "Inspect the existing extension", status: "in_progress" },
  { key: "implement", subject: "Implement the optimized protocol", status: "pending" },
  { key: "verify", subject: "Verify the implementation", status: "pending" },
];

function asState(details: TodoState): TodoState {
  return cloneTodoState(details);
}

test("todo writes a complete plan atomically and hands work off in one update", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan, baseVersion: 0 });
  assert.equal(first.version, 1);
  assert.deepEqual(first.tasks.map((task) => task.key), ["inspect", "implement", "verify"]);
  assert.deepEqual(first.tasks.map((task) => task.subject), [
    "Inspect the existing extension",
    "Implement the optimized protocol",
    "Verify the implementation",
  ]);
  assert.deepEqual(first.tasks.map((task) => task.status), ["in_progress", "pending", "pending"]);

  const handoff: TodoTaskInput[] = [
    { key: "inspect", status: "completed" },
    { key: "implement", status: "in_progress" },
    { key: "verify" },
  ];
  const second = writeTodo(asState(first), { tasks: handoff, baseVersion: 1 });
  assert.equal(second.version, 2);
  assert.deepEqual(second.tasks.map((task) => task.subject), initialPlan.map((task) => task.subject));
  assert.deepEqual(second.tasks.map((task) => task.status), ["completed", "in_progress", "pending"]);
});

test("todo sparse snapshots preserve omitted fields and reject incomplete new keys", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  const noOp = writeTodo(asState(first), {
    tasks: [{ key: "inspect" }, { key: "implement" }, { key: "verify" }],
    baseVersion: 1,
  });
  assert.equal(noOp.version, 1, "an unchanged plan must not bump the version");
  assert.deepEqual(noOp.tasks, first.tasks);

  const stable = asState(first);
  assert.throws(
    () => writeTodo(stable, { tasks: [{ key: "new-task" }] }),
    /subject is required for new task new-task/,
  );
  assert.throws(
    () => writeTodo(stable, { tasks: [{ key: "new-task", subject: "New task" }] }),
    /status is required for new task new-task/,
  );
  assert.throws(
    () => writeTodo(stable, { tasks: [{ key: "inspect" }, { key: "inspect" }] }),
    /duplicated/,
  );
  assert.deepEqual(stable, asState(first), "failed writes must not mutate state");
});

test("todo rejects stale versions without mutating state", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  const state = asState(first);
  const before = cloneTodoState(state);

  assert.throws(
    () => writeTodo(state, { tasks: initialPlan, baseVersion: 0 }),
    /stale todo version: expected 0, current version is 1/,
  );
  assert.throws(
    () => writeTodo(state, { tasks: initialPlan, baseVersion: 99 }),
    /stale todo version/,
  );
  assert.deepEqual(state, before, "failed validation must not mutate the input state");
});

test("todo enforces a single in_progress task", () => {
  assert.throws(
    () => writeTodo(createEmptyTodoState(), {
      tasks: [
        { key: "a", subject: "Task A", status: "in_progress" },
        { key: "b", subject: "Task B", status: "in_progress" },
      ],
    }),
    /only one task may be in_progress/,
  );
});

test("todo deletes omitted tasks without cancelled or archived state", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  const removed = writeTodo(asState(first), { tasks: [initialPlan[0]] });

  assert.equal(removed.version, 2);
  assert.deepEqual(removed.tasks.map((task) => task.key), ["inspect"]);
  assert.equal(JSON.stringify(removed).includes("cancelled"), false);
  assert.equal(JSON.stringify(removed).includes("archived"), false);
});

test("todo clears the plan with an empty list", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  const cleared = writeTodo(asState(first), { tasks: [] });
  assert.equal(cleared.version, 2);
  assert.deepEqual(cleared.tasks, []);
});

test("todo auto-removes all completed tasks and bumps the version", () => {
  const current = writeTodo(createEmptyTodoState(), {
    tasks: [
      { key: "step-a", subject: "Step A", status: "completed" },
      { key: "step-b", subject: "Step B", status: "in_progress" },
    ],
  });
  const before = cloneTodoState(current);
  const removed = removeCompletedTasks(before);
  assert.ok(removed);
  assert.equal(removed.version, 2);
  assert.deepEqual(removed.tasks.map((task) => task.key), ["step-b"]);
  assert.deepEqual(before, cloneTodoState(current), "automatic removal must not mutate its input state");

  assert.equal(removeCompletedTasks(removed), undefined, "nothing to remove returns undefined");
});

test("todo replay restores the latest valid tool result", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  const replayed = replayTodoState(
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "toolResult", toolName: "todo", details: first },
          },
        ],
      },
    },
    "todo",
    "pi-todo-state",
  );
  assert.equal(replayed.version, 1);
  assert.deepEqual(replayed.tasks.map((task) => task.key), ["inspect", "implement", "verify"]);
});

test("todo replay ignores malformed state and picks the last valid snapshot", () => {
  const valid = writeTodo(createEmptyTodoState(), { tasks: [{ key: "valid", subject: "Keep valid state", status: "pending" }] });
  const replayed = replayTodoState(
    {
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "toolResult", toolName: "todo", details: valid } },
          {
            type: "custom_message",
            customType: "pi-todo-state",
            details: {
              version: 99,
              tasks: [
                { key: "broken", subject: "Broken state", status: "in_progress" },
                { key: "also-broken", subject: "Also broken", status: "in_progress" },
              ],
            },
          },
        ],
      },
    },
    "todo",
    "pi-todo-state",
  );
  assert.equal(replayed.version, 1);
  assert.deepEqual(replayed.tasks.map((task) => task.key), ["valid"], "malformed later snapshot must be ignored");
});

test("todo replay picks up hidden cleanup checkpoints", () => {
  const afterCleanup = writeTodo(createEmptyTodoState(), {
    tasks: [{ key: "remaining", subject: "Remaining work", status: "in_progress" }],
  });
  const replayed = replayTodoState(
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom_message",
            customType: "pi-todo-state",
            details: afterCleanup,
          },
        ],
      },
    },
    "todo",
    "pi-todo-state",
  );
  assert.equal(replayed.version, 1);
  assert.deepEqual(replayed.tasks.map((task) => task.key), ["remaining"]);
});

test("todo validation rejects invalid keys and statuses", () => {
  assert.throws(
    () => writeTodo(createEmptyTodoState(), {
      tasks: [{ key: "UPPER", subject: "Bad key", status: "pending" }],
    }),
    /must be 1-40 lowercase/,
  );
  assert.throws(
    () => writeTodo(createEmptyTodoState(), {
      tasks: [{ key: "good-key", subject: "Good", status: "blocked" as "pending" }],
    }),
    /status is invalid/,
  );
  assert.throws(
    () => writeTodo(createEmptyTodoState(), {
      tasks: [{ key: "x", subject: "  ", status: "pending" }],
    }),
    /subject is required/,
  );
});

test("todo formatChange renders a readable plan and clear message", () => {
  const first = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  assert.match(formatChange(first), /Todo plan version 1:/);
  assert.match(formatChange(first), /\[in_progress\] inspect: Inspect the existing extension/);
  const cleared = writeTodo(asState(first), { tasks: [] });
  assert.match(formatChange(cleared), /Todo plan cleared \(version 2\)/);
});

test("todo isValidTodoState accepts valid state and rejects malformed state", () => {
  const valid = writeTodo(createEmptyTodoState(), { tasks: initialPlan });
  assert.equal(isValidTodoState(valid), true);
  assert.equal(isValidTodoState({ version: -1, tasks: [] }), false);
  assert.equal(isValidTodoState({ version: 1, tasks: "nope" }), false);
  assert.equal(
    isValidTodoState({
      version: 1,
      tasks: [
        { key: "a", subject: "A", status: "in_progress" },
        { key: "b", subject: "B", status: "in_progress" },
      ],
    }),
    false,
    "multiple in_progress tasks are invalid persisted state",
  );
});
