import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GUARD_STEER_MAX_RETRIES,
  RepetitionDetector,
  buildSteer,
  extractText,
} from "./detector.ts";

/**
 * pi-repetition-guard — a repetition-loop guard for the Pi coding agent.
 *
 * Detects thinking-runaway / 万字复读 (the model repeating the same text in a
 * loop during long thinking or output) by observing `message_update` stream
 * events, then aborts the generation and re-steers the model with a corrective
 * steer message (ADR 0002: active abort, beyond ADR 0001's ask_user scope).
 *
 * Design (settled in grilling, see docs/adr/0002):
 * - Hybrid detection: block-repeat primary + n-gram shingle novelty confirmatory.
 * - Two-stage trigger: stage-1 "suspect" is record-only; stage-2 "hard" aborts.
 * - Intervention pipeline: ctx.abort() in message_update, then send the steer
 *   from message_end (race-free: the aborted message is finalized by then).
 * - Retry budget: max 2 steer retries per logical user turn, escalated wording
 *   on the 2nd, then give up (abort without steer).
 * - Control: `/runaway on|off` slash command, default on.
 */
export default function repetitionGuardExtension(pi: ExtensionAPI): void {
  const detector = new RepetitionDetector();
  let enabled = true;
  let steerBudget = GUARD_STEER_MAX_RETRIES;
  let pendingSteer: string | undefined;
  let steerInFlight = false;
  let suspectLogged = false;
  let hardTriggered = false;

  const diag = (message: string): void => {
    console.log(`[pi-repetition-guard] ${message}`);
  };

  const onHardTrigger = (ctx: ExtensionContext, sample: string): void => {
    steerBudget -= 1;
    const retryNum = GUARD_STEER_MAX_RETRIES - steerBudget; // 1-based: 1 or 2
    if (steerBudget >= 0) {
      pendingSteer = buildSteer(retryNum, sample);
      diag(`hard trigger — aborting, will steer (retry ${retryNum}/${GUARD_STEER_MAX_RETRIES})`);
    } else {
      diag("hard trigger — aborting, retry budget exhausted (giving up)");
    }
    ctx.abort();
  };

  // Track per-message state and the retry budget across logical user turns.
  pi.on("message_start", (event) => {
    const role = event.message?.role;
    if (role === "assistant") {
      detector.reset();
      suspectLogged = false;
      hardTriggered = false;
    } else if (role === "user") {
      if (steerInFlight) {
        steerInFlight = false; // our own steer — keep the budget
      } else {
        steerBudget = GUARD_STEER_MAX_RETRIES; // real user message — new turn
        diag(`new user turn — budget reset to ${GUARD_STEER_MAX_RETRIES}`);
      }
    }
  });

  // The one real-time observation point: stream updates with the accumulated
  // full message snapshot (thinking + final text).
  pi.on("message_update", (event, ctx) => {
    if (!enabled || hardTriggered) return;
    if (event.message.role !== "assistant") return;
    const result = detector.ingest(extractText(event.message.content));
    if (result.hard) {
      hardTriggered = true;
      onHardTrigger(ctx, result.sample);
    } else if (result.suspect && !suspectLogged) {
      suspectLogged = true;
      diag("suspect (stage-1): possible repetition loop, recording only");
    }
  });

  // Send the steer once the aborted message is finalized (avoids racing the
  // abort; message_end replacement is not used — ADR 0002, no cleanup).
  pi.on("message_end", (event) => {
    if (!pendingSteer) return;
    if (event.message.role !== "assistant") return;
    const steer = pendingSteer;
    pendingSteer = undefined;
    steerInFlight = true;
    diag("sending steer retry");
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
