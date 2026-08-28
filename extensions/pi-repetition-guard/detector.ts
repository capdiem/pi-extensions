// Pure detection logic for pi-repetition-guard — no pi extension APIs here,
// so it is unit-testable in isolation (mirrors pi-todo's state.ts split).

// ── Tunable defaults (two-stage trigger: fixed, not user-configurable) ──────
export const GUARD_STEER_MAX_RETRIES = 2;
/** Rescan cadence — we re-scan only after this many new chars accumulate. */
const CHECKPOINT_CHARS = 200;
/** A block must be at least this long (chars) to count as a repeatable block. */
const MIN_BLOCK_CHARS = 60;
/** Block seen this many times → stage-1 suspect. */
const SUSPECT_BLOCK_REPEATS = 2;
/** Block seen this many times → stage-2 hard trigger. */
const HARD_BLOCK_REPEATS = 3;
/** Shingle length (chars) for the n-gram novelty signal. */
const SHINGLE_SIZE = 40;
/** "Recent" window = this many trailing shingles (~RECENT_SHINGLES × 40 chars). */
const RECENT_SHINGLES = 40;
/** Recent-window overlap ratio at or above this → stage-1 suspect. */
const SUSPECT_RECENT_RATIO = 0.8;
/** Recent-window overlap ratio at or above this → stage-2 hard trigger. */
const HARD_RECENT_RATIO = 0.95;
/** Repeated-block sample length for the steer message. */
export const SAMPLE_MAX_CHARS = 200;

export interface DetectionResult {
  suspect: boolean;
  hard: boolean;
  /** Most-repeated block, truncated to SAMPLE_MAX_CHARS, for the steer message. */
  sample: string;
}

/**
 * Hybrid repetition-loop detector over the accumulated text of one assistant
 * message (thinking + final blocks concatenated).
 *
 * Two signals:
 * 1. Block-repeat (primary, low false-positive): a long block (line) repeated
 *    2× → suspect, 3× → hard.
 * 2. Shingle novelty (confirmatory, earlier): over a trailing window of 40-char
 *    shingles, the fraction that already appeared earlier in the message. ≥80%
 *    → suspect, ≥95% → hard.
 */
export class RepetitionDetector {
  private text = "";
  private lastChecked = 0;
  private seenShingles = new Set<string>();
  private lastResult: DetectionResult = { suspect: false, hard: false, sample: "" };

  /** Start a fresh message: call on assistant message_start. */
  reset(): void {
    this.text = "";
    this.lastChecked = 0;
    this.seenShingles.clear();
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
    let suspect = false;
    let hard = false;
    let sample = "";

    // 1) Block-repeat (primary signal).
    const blockCounts = new Map<string, number>();
    let maxCount = 0;
    let mostRepeated = "";
    for (const rawBlock of this.text.split(/\n+/)) {
      const block = rawBlock.trim();
      if (block.length < MIN_BLOCK_CHARS) continue;
      const count = (blockCounts.get(block) ?? 0) + 1;
      blockCounts.set(block, count);
      if (count > maxCount) {
        maxCount = count;
        mostRepeated = block;
      }
    }
    if (maxCount >= HARD_BLOCK_REPEATS) {
      hard = true;
      sample = mostRepeated;
    } else if (maxCount >= SUSPECT_BLOCK_REPEATS) {
      suspect = true;
      sample = mostRepeated;
    }

    // 2) Shingle novelty (confirmatory signal). The seen-set persists across
    //    scans, so trailing shingles that repeat earlier content get flagged.
    const recent: boolean[] = [];
    for (let i = 0; i + SHINGLE_SIZE <= this.text.length; i++) {
      const shingle = this.text.slice(i, i + SHINGLE_SIZE);
      const isRepeat = this.seenShingles.has(shingle);
      if (recent.length < RECENT_SHINGLES) {
        recent.push(isRepeat);
      } else {
        recent.shift();
        recent.push(isRepeat);
      }
      this.seenShingles.add(shingle);
    }
    const recentRepeats = recent.filter(Boolean).length;
    const recentRatio = recent.length > 0 ? recentRepeats / recent.length : 0;
    if (recentRatio >= HARD_RECENT_RATIO) hard = true;
    else if (recentRatio >= SUSPECT_RECENT_RATIO) suspect = true;

    return {
      suspect,
      hard,
      sample: sample.length > SAMPLE_MAX_CHARS ? `${sample.slice(0, SAMPLE_MAX_CHARS)}…` : sample,
    };
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

/** Build the corrective steer message; retryNum is 1-based (1 = first retry). */
export function buildSteer(retryNum: number, sample: string): string {
  if (retryNum >= 2) {
    return (
      "[自动护栏] 你刚才再次陷入了复读循环，这是第 2 次。请立即停止重复，直接给出简洁、收敛的" +
      "最终回答。不要输出思考过程，不要复述任何已说过的内容，直接回答。"
    );
  }
  return (
    "[自动护栏] 检测到你陷入了复读循环（重复输出相同内容）。请立即停止重复，直接给出简洁、收敛的" +
    "最终回答，不要复述或重复任何已说过的内容。\n\n" +
    "刚才重复的片段（节选）：\n" +
    (sample || "（无样例）")
  );
}
