import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GUARD_STEER_MAX_RETRIES,
  MAX_COMPACTION_RETRIES,
  RepetitionDetector,
  RetryBudget,
  ToolLoopTracker,
  buildPostCompactSteer,
  buildSteer,
  buildToolLoopSteer,
  extractText,
} from "./detector.ts";

/**
 * pi-repetition-guard — a repetition-loop guard for the Pi coding agent.
 *
 * Detects two distinct runaway failure modes and intervenes with
 * abort/re-steer (ADR 0002: active intervention, beyond ADR 0001's ask_user
 * scope):
 *
 * 1. Text repetition loop (thinking-runaway / 万字复读): the model repeats the
 *    same text contiguously during long thinking or output. Detected via tail
 *    periodicity on `message_update`; intervened with ctx.abort() + steer.
 * 2. Tool-call loop: the model repeatedly invokes the SAME tool with the SAME
 *    input and never settles (e.g. checking git status over and over). Detected
 *    on `tool_call`; intervened by blocking the repetitive call (block +
 *    terminate) and steering.
 *
 * Shared control: `/runaway on|off` (user-only), retry budget of 2 steers per
 * logical user turn (escalated wording 1→2). When the budget is exhausted we
 * auto-compact the context and retry once more (`MAX_COMPACTION_RETRIES`), then
 * give up — attacking the long-context degradation that feeds the loop. Still
 * hard-capped; the guard itself can never loop forever.
 */
export default function repetitionGuardExtension(pi: ExtensionAPI): void {
  const detector = new RepetitionDetector();
  const toolLoopTracker = new ToolLoopTracker();
  const budget = new RetryBudget(GUARD_STEER_MAX_RETRIES);
  let enabled = true;
  let pendingSteer: string | undefined;
  let pendingToolSteer: string | undefined;
  let pendingCompact = false;
  let compactionsUsed = 0;
  let hardTriggered = false;

  const diag = (message: string): void => {
    console.log(`[pi-repetition-guard] ${message}`);
  };

  const onHardTrigger = (ctx: ExtensionContext, sample: string): void => {
    const { retryNum, allowSteer } = budget.consume();
    if (allowSteer) {
      pendingSteer = buildSteer(retryNum, sample);
      diag(`text runaway — aborting, will steer (retry ${retryNum}/${GUARD_STEER_MAX_RETRIES})`);
    } else if (compactionsUsed < MAX_COMPACTION_RETRIES) {
      pendingCompact = true;
      diag("text runaway — aborting, will compact + continue");
    } else {
      diag("text runaway — aborting, retry budget exhausted (giving up)");
    }
    ctx.abort();
  };

  /**
   * Fire the queued compact-and-continue at a run settle point (`message_end`
   * for text loops, `agent_end` for tool loops) — same race-free discipline as
   * the steer delivery. On completion the retry budget resets and a "continue"
   * steer re-runs the task against the shrunk context. On failure we keep the
   * existing give-up behavior.
   */
  const maybeFireCompact = (ctx: ExtensionContext): void => {
    if (!pendingCompact) return;
    pendingCompact = false;
    if (compactionsUsed >= MAX_COMPACTION_RETRIES) {
      diag("compaction budget exhausted — giving up");
      return;
    }
    compactionsUsed += 1;
    diag(`triggering auto-compact (${compactionsUsed}/${MAX_COMPACTION_RETRIES})`);
    ctx.compact({
      onComplete: () => {
        budget.reset();
        const steer = buildPostCompactSteer();
        budget.recordSentSteer(steer);
        diag("compaction complete — sending continue steer");
        pi.sendUserMessage(steer, { deliverAs: "steer" });
      },
      onError: (error) => {
        diag(`compaction failed (${error.message}) — giving up`);
      },
    });
  };

  /** Track per-message state and the retry budget across logical turns. */
  pi.on("message_start", (event) => {
    const role = event.message?.role;
    if (role === "assistant") {
      detector.reset();
      hardTriggered = false;
    } else if (role === "user") {
      const text = contentText(event.message.content);
      if (budget.onUserMessage(text)) {
        compactionsUsed = 0;
        diag(`new user turn — budget reset to ${GUARD_STEER_MAX_RETRIES}`);
      }
    }
  });

  pi.on("agent_start", () => {
    toolLoopTracker.reset();
  });

  // Text runaway detection: the one real-time observation point, stream
  // updates with the accumulated full message snapshot (thinking + final text).
  pi.on("message_update", (event, ctx) => {
    if (!enabled || hardTriggered) return;
    if (event.message.role !== "assistant") return;
    const result = detector.ingest(extractText(event.message.content));
    if (result.hard) {
      hardTriggered = true;
      onHardTrigger(ctx, result.sample);
    }
  });

  // Tool-call-loop detection: same tool + same input repeated in a window.
  // Block the repetitive call and queue a tool-loop steer.
  pi.on("tool_call", (event) => {
    if (!enabled) return;
    const inputKey = normalizeInput(event.input);
    const isLoop = toolLoopTracker.record(event.toolName, inputKey);
    if (!isLoop) return;
    const { retryNum, allowSteer } = budget.consume();
    if (allowSteer) {
      pendingToolSteer = buildToolLoopSteer(retryNum, event.toolName, inputKey);
      diag(
        `tool-call loop — blocking ${event.toolName} (${inputKey.slice(0, 60)}), will steer ` +
          `(retry ${retryNum}/${GUARD_STEER_MAX_RETRIES})`,
      );
    } else if (compactionsUsed < MAX_COMPACTION_RETRIES) {
      pendingCompact = true;
      diag("tool-call loop — blocking, will compact + continue");
    } else {
      diag("tool-call loop — budget exhausted, blocking without steer");
    }
    return {
      block: true,
      reason: "Repetition guard: tool-call loop (same tool+args repeated)",
      terminate: true,
    };
  });

  // Send the text steer once the aborted message is finalized (race-free).
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    maybeFireCompact(ctx);
    if (!pendingSteer) return;
    const steer = pendingSteer;
    pendingSteer = undefined;
    budget.recordSentSteer(steer);
    diag("sending text steer retry");
    pi.sendUserMessage(steer, { deliverAs: "steer" });
  });

  // Send the tool-loop steer after the (terminated) run settles.
  pi.on("agent_end", (event, ctx) => {
    maybeFireCompact(ctx);
    if (!pendingToolSteer) return;
    const steer = pendingToolSteer;
    pendingToolSteer = undefined;
    budget.recordSentSteer(steer);
    diag("sending tool-loop steer retry");
    pi.sendUserMessage(steer, { deliverAs: "steer" });
  });

  // User-only control surface: the guard cannot be disabled by the LLM.
  pi.registerCommand("runaway", {
    description: "Toggle the repetition-loop guard (on | off). Default: on.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else enabled = !enabled;
      if (ctx.hasUI) {
        ctx.ui.notify(`Repetition guard ${enabled ? "ON" : "OFF"}`, enabled ? "info" : "warning");
      }
      if (ctx.mode === "tui") {
        ctx.ui.setStatus("pi-repetition-guard", enabled ? "guard:on" : "guard:off");
      }
    },
  });
}

/** Stable, order-insensitive string key for a tool input. */
function normalizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return stableStringify(input);
  } catch {
    return String(input);
  }
}

/** Concatenate the text of a user message, for matching against our steers. */
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
