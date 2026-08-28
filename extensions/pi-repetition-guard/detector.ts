// Pure detection logic for pi-repetition-guard — no pi extension APIs here,
// so it is unit-testable in isolation (mirrors pi-todo's state.ts split).

// ── Tunable defaults (fixed, not user-configurable) ─────────────────────────
export const GUARD_STEER_MAX_RETRIES = 3;
/** Rescan cadence — we re-scan only after this many new chars accumulate. */
const CHECKPOINT_CHARS = 200;
/** Smallest loop unit (chars) we treat as a runaway tape-loop. */
const MIN_PERIOD = 30;
/** Largest loop unit to scan for; capped by message length at runtime. */
const MAX_PERIOD = 3000;
/** A loop is "proven" when the last `copies × P` chars are P-periodic. */
const HARD_PERIOD_COPIES = 2;
/** Repeated-block sample length for the steer message. */
export const SAMPLE_MAX_CHARS = 200;
/** Tool-loop trigger: same tool + same normalized input this many times in a
 *  sliding window of recent calls → blocked as a tool-call loop. */
export const TOOL_LOOP_MAX_REPEATS = 4;
/** Sliding window of recent tool calls used for tool-loop counting. */
const TOOL_LOOP_WINDOW = 8;
/** Two segments are "near-duplicates" when this fraction of their 5-gram
 *  shingles overlap (tolerates reworded copies). */
export const NEAR_DUP_OVERLAP_THRESH = 0.7;
/** A message is a variation-loop when this fraction of its SHORT segments are
 *  near-duplicates of another segment (within-message dominance). Calibrated on
 *  real data: clear degenerate loops 0.90-1.0, productive messages with a
 *  repetitive tail ~0.88 (kept quiet), normal messages median ~0.00. 0.9 (not
 *  0.85) cleanly separates clear loops from the productive+tail gray zone. */
export const NEAR_DUP_HARD_FRACTION = 0.9;
/** Only segments up to this length count toward variation-loop detection. This
 *  is what separates degenerate loops (dominated by short "Let me read X."
 *  restatements) from legitimate long thinking (built of long paragraphs that
 *  advance). Legit templated thinking has ~0 short segments → never fires. */
const NEAR_DUP_MAX_SEG_LEN = 100;
/** Need at least this many short segments before the signal is meaningful. */
const NEAR_DUP_MIN_SHORT_SEGS = 3;
/** Minimum message length to bother computing near-repetition dominance. */
const NEAR_DUP_MIN_CHARS = 200;

export interface DetectionResult {
  suspect: boolean;
  hard: boolean;
  /** Repeated unit, truncated to SAMPLE_MAX_CHARS, for the steer message. */
  sample: string;
}

/**
 * Find the smallest period P in [minP, cap] such that the trailing
 * `copies × P` characters of `text` are exactly P-periodic
 * (text[i] === text[i - P] for every i in the tail window).
 *
 * This is the tape-loop signature: a runaway re-emits the same block
 * contiguously, so the tail becomes a clean repetition of a fixed unit.
 *
 * Deliberately EXACT (no fuzzy tolerance): every measured "similarity" signal
 * (shingle novelty, block-repeat, fractional-period) was shown to false-trigger
 * on legitimate long structured thinking, while exact ≥2-copy contiguity never
 * does. A loop with minor noise may be missed — acceptable, since false
 * positives are the far worse failure here.
 *
 * Returns the period, or null when no period exists.
 */
export function findPeriod(
  text: string,
  copies = HARD_PERIOD_COPIES,
  minP = MIN_PERIOD,
  maxP = MAX_PERIOD,
): number | null {
  const cap = Math.min(maxP, Math.floor(text.length / copies));
  for (let P = minP; P <= cap; P++) {
    const start = text.length - Math.floor(copies * P);
    let ok = true;
    for (let i = start + P; i < text.length; i++) {
      if (text[i] !== text[i - P]) {
        ok = false;
        break;
      }
    }
    if (ok) return P;
  }
  return null;
}

/**
 * Within-message SHORT-segment near-repetition dominance: the fraction of a
 * message's SHORT segments (≤ NEAR_DUP_MAX_SEG_LEN chars) that are
 * near-duplicates (5-gram shingle overlap ≥ NEAR_DUP_OVERLAP_THRESH) of another
 * SHORT segment in the SAME message. Requires ≥ NEAR_DUP_MIN_SHORT_SEGS short
 * segments to be meaningful.
 *
 * Catches the "variation loop" class that exact tail periodicity misses: the
 * model rewording the same intent over and over ("Let me read L1000-1035" /
 * "Let me read the signature end" / ...) without advancing. Such loops are
 * DOMINATED by SHORT near-identical restatements (real data: 0.90-1.0), while
 * genuine messages — including legitimately long, templated thinking — are
 * built of long paragraphs and have ~0 short near-duplicates (median ~0.00).
 * Restricting to SHORT segments is what keeps this from false-positiving on
 * legit structured thinking. Strictly within-message; never cross-message.
 */
export function nearDupDominance(text: string): { fraction: number; sample: string } {
  if (text.length < NEAR_DUP_MIN_CHARS) return { fraction: 0, sample: "" };
  const segs = text.split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length <= NEAR_DUP_MAX_SEG_LEN);
  const n = segs.length;
  if (n < NEAR_DUP_MIN_SHORT_SEGS) return { fraction: 0, sample: "" };
  // Greedy near-duplicate clustering by 5-gram shingle overlap.
  const reps: string[] = [];
  const sizes: number[] = [];
  for (const seg of segs) {
    let placed = false;
    for (let k = 0; k < reps.length; k++) {
      if (Math.abs(reps[k].length - seg.length) <= 12 && shingleOverlap(reps[k], seg) >= NEAR_DUP_OVERLAP_THRESH) {
        sizes[k] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      reps.push(seg);
      sizes.push(1);
    }
  }
  const fraction = 1 - sizes.filter((v) => v === 1).length / n;
  let bestIdx = -1;
  let bestSize = 1;
  for (let k = 0; k < sizes.length; k++) {
    if (sizes[k] > bestSize) {
      bestSize = sizes[k];
      bestIdx = k;
    }
  }
  return { fraction, sample: bestIdx >= 0 ? reps[bestIdx] : "" };
}

/** Fraction of b's 5-char shingles that also appear in a (lowercased). */
function shingleOverlap(a: string, b: string): number {
  const n = 5;
  const set = new Set<string>();
  const ta = a.toLowerCase();
  for (let i = 0; i + n <= ta.length; i++) set.add(ta.slice(i, i + n));
  const tb = b.toLowerCase();
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= tb.length; i++) {
    if (set.has(tb.slice(i, i + n))) hit++;
    total++;
  }
  return total > 0 ? hit / total : 0;
}

/**
 * Repetition-loop detector over the accumulated text of one assistant message
 * (thinking + final blocks concatenated).
 *
 * v5: TWO within-message signals, OR'd:
 * 1. Exact tail periodicity (≥2 exact contiguous copies) — catches tape-loops.
 * 2. Short-segment near-repetition dominance (≥90% of the message's short
 *    segments are near-duplicates) — catches variation-loops (reworded copies).
 * Both are strictly within one message; no cross-message comparison.
 * `suspect` mirrors `hard` for API compatibility.
 */
export class RepetitionDetector {
  private text = "";
  private lastChecked = 0;
  private lastResult: DetectionResult = { suspect: false, hard: false, sample: "" };

  /** Start a fresh message: call on assistant message_start. */
  reset(): void {
    this.text = "";
    this.lastChecked = 0;
    this.lastResult = { suspect: false, hard: false, sample: "" };
  }

  /** Feed the latest full accumulated text; returns the current verdict. */
  ingest(newText: string): DetectionResult {
    this.text = newText;
    if (this.text.length - this.lastChecked >= CHECKPOINT_CHARS) {
      this.lastChecked = this.text.length;
      this.lastResult = this.scan();
    }
    return this.lastResult;
  }

  private scan(): DetectionResult {
    // 1) Exact tail periodicity (tape-loop).
    const period = findPeriod(this.text);
    if (period !== null) {
      const sample = this.text.slice(this.text.length - period);
      return {
        suspect: true,
        hard: true,
        sample: sample.length > SAMPLE_MAX_CHARS
          ? `${sample.slice(0, SAMPLE_MAX_CHARS)}…`
          : sample,
      };
    }
    // 2) Within-message short-segment near-repetition dominance (variation-loop).
    const nd = nearDupDominance(this.text);
    if (nd.fraction >= NEAR_DUP_HARD_FRACTION) {
      return {
        suspect: true,
        hard: true,
        sample: nd.sample.length > SAMPLE_MAX_CHARS
          ? `${nd.sample.slice(0, SAMPLE_MAX_CHARS)}…`
          : nd.sample,
      };
    }
    return { suspect: false, hard: false, sample: "" };
  }
}

/** Concatenate text + thinking blocks of an assistant message for detection. */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: unknown; text?: unknown; thinking?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "thinking") {
      if (typeof block.thinking === "string") parts.push(block.thinking);
      else if (typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Tool-call-loop detector over one agent run (reset on agent_start).
 *
 * The real-world failure the user hit (and that pure text signals miss): the
 * model repeatedly invokes the SAME tool with the SAME input — e.g. checking
 * `git status` / reading CHANGES.md over and over — and never settles. The text
 * it emits is near-identical *variations*, not an exact periodic loop, so text
 * periodicity does not fire. Counting identical (toolName, inputKey) calls in a
 * sliding window catches it directly.
 */
export class ToolLoopTracker {
  private calls: string[] = [];
  private counts = new Map<string, number>();

  /** Start a fresh agent run: call on agent_start. */
  reset(): void {
    this.calls = [];
    this.counts.clear();
  }

  /**
   * Record a tool call; returns true when the same (toolName, inputKey) has
   * been seen `TOOL_LOOP_MAX_REPEATS` times within the recent window.
   */
  record(toolName: string, inputKey: string): boolean {
    const key = `${toolName}:${inputKey}`;
    this.calls.push(key);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (this.calls.length > TOOL_LOOP_WINDOW) {
      const dropped = this.calls.shift()!;
      const c = this.counts.get(dropped)!;
      if (c <= 1) this.counts.delete(dropped);
      else this.counts.set(dropped, c - 1);
    }
    return (this.counts.get(key) ?? 0) >= TOOL_LOOP_MAX_REPEATS;
  }
}

/** Build the tool-loop steer message; retryNum is 1-based (1 = first retry).
 * Action-oriented: stop re-invoking, finish the goal from existing info.
 * Escalates over 3 retries. */
export function buildToolLoopSteer(retryNum: number, toolName: string, inputKey: string): string {
  if (retryNum >= 3) {
    return (
      "[自动护栏] 这是第 3 次工具循环。请立即停止调用工具，以最短篇幅完成任务目标，或明确声明" +
      "无法完成并说明原因。"
    );
  }
  if (retryNum >= 2) {
    return (
      "[自动护栏] 这是第 2 次工具循环。请停止调用 `" + toolName +
      "`，直接基于已有信息完成目标并给出简短结果；如果无法完成，明确说明卡在哪里。"
    );
  }
  const sample = inputKey.length > 80 ? `${inputKey.slice(0, 80)}…` : inputKey;
  return (
    "[自动护栏] 检测到你陷入了工具调用循环：连续多次调用 `" + toolName + "`（参数 " +
    (sample || "无参数") +
    "）却迟迟不完成任务。请停止重复调用同一工具，直接基于已有信息完成目标操作并给出结果，不要重复已执行过的操作。"
  );
}

/**
 * Retry budget shared by the text-loop and tool-loop paths, with a
 * deterministic "real user turn" reset.
 *
 * The budget must span one logical user turn (the original request + any number
 * of steer retries) and reset on the NEXT real user message. We identify our
 * own steer messages by their exact content (Pi delivers a queued steer as a
 * user message whose text matches what we sent — this is how Pi itself clears
 * its steering queue). Using a boolean "steer in flight" flag is fragile: if a
 * steer's message_start is missed in an abort/auto-continue race, the flag
 * sticks and the budget never resets — the bug reported as "after 3 retries the
 * count never resets".
 */
export class RetryBudget {
  private remaining: number;
  private sentSteers = new Set<string>();

  constructor(private readonly max: number) {
    this.remaining = max;
  }

  /** Consume one retry slot; 1-based retry number and whether a steer is still
   *  allowed. Shared by the text and tool-loop paths. */
  consume(): { retryNum: number; allowSteer: boolean } {
    this.remaining -= 1;
    return { retryNum: this.max - this.remaining, allowSteer: this.remaining >= 0 };
  }

  /** Record the exact text of a steer we sent, so its user-message delivery can
   *  be recognized and NOT treated as a new user turn. */
  recordSentSteer(steerText: string): void {
    this.sentSteers.add(steerText);
  }

  /**
   * Handle a user message_start. Returns true when it was a REAL user turn
   * (budget reset to max); false when it was our own steer (budget kept).
   */
  onUserMessage(text: string): boolean {
    if (text && this.sentSteers.has(text)) {
      this.sentSteers.delete(text);
      return false;
    }
    this.reset();
    return true;
  }

  reset(): void {
    this.remaining = this.max;
  }

  get remainingCount(): number {
    return this.remaining;
  }
}

/** Build the corrective steer message; retryNum is 1-based (1 = first retry).
 *
 * Action-oriented wording (v4): the real-world loop this guard catches is often
 * "rehearsing the next action without doing it" (e.g. repeating "let me check
 * git status" without ever committing). Telling a stuck model to "give a final
 * answer" does not break that — it must be told to EXECUTE. Escalates over 3
 * retries. */
export function buildSteer(retryNum: number, sample: string): string {
  if (retryNum >= 3) {
    return (
      "[自动护栏] 这是第 3 次。你一直循环未完成目标。请立即以最短篇幅完成任务目标，或明确声明" +
      "无法完成并说明原因。不要再重复任何已说过的内容。"
    );
  }
  if (retryNum >= 2) {
    return (
      "[自动护栏] 这是第 2 次检测到循环。你仍在重复却没有执行。请立即停止任何描述性文本，直接完成" +
      "当前任务的目标操作并给出简短结果；如果无法完成，明确说明卡在哪里。"
    );
  }
  return (
    "[自动护栏] 检测到你陷入了循环：反复复述同一个动作/内容却始终没有真正执行下一步。请立即停止" +
    "复述，直接执行你要做的操作并给出结果，不要描述你将要做什么。\n\n" +
    "刚才重复的片段（节选）：\n" +
    (sample || "（无样例）")
  );
}
