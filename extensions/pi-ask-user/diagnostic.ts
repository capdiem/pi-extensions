/**
 * Lightweight per-turn diagnostic for the ask_user triggering workstream.
 *
 * Supports the escalation gate (ADR-0001): classifies each assistant turn as a
 * "question round" and records whether it used ask_user, so we can judge
 * whether pure tool metadata is enough to make grilling/design-interview
 * rounds use the form, or whether we need to escalate to per-turn injection.
 *
 * Pure functions only — no pi imports — so it can be unit-tested directly.
 */

export interface TurnDiagnostic {
  /** Whether this turn was a question round (asked via ask_user or plain text). */
  isQuestionRound: boolean;
  /** Whether the turn called the ask_user tool. */
  usedAskUser: boolean;
  /** Whether the assistant wrote plain-text question markers (Q1..QN, ❓, …). */
  wrotePlainQuestions: boolean;
  /**
   * True when a question round was handled via ask_user without plain-text
   * question leakage. The ideal outcome for the metadata-first approach.
   */
  handledCleanly: boolean;
}

/** Heuristic markers for "this assistant text is a question round" (tunable). */
const QUESTION_MARKERS: RegExp[] = [
  /\bQ\s?\d+\b/i, // Q1, Q2, Q 3 — numbered question rounds
  /❓/u, // grilling question marker
  /recommended answer|推荐答案/i,
  /请回答|请选择|你决定|你的选择|你更倾向|选一个/i,
];

export function isQuestionRoundText(text: string): boolean {
  if (!text) return false;
  return QUESTION_MARKERS.some((re) => re.test(text));
}

/** Extract the assistant's answer text, skipping thinking content blocks. */
export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text",
    )
    .map((block) => (block as { text?: unknown }).text ?? "")
    .join("\n");
}

export function classifyTurn(assistantTextValue: string, usedAskUser: boolean): TurnDiagnostic {
  const wrotePlainQuestions = isQuestionRoundText(assistantTextValue);
  const isQuestionRound = usedAskUser || wrotePlainQuestions;
  return {
    isQuestionRound,
    usedAskUser,
    wrotePlainQuestions,
    handledCleanly: isQuestionRound && usedAskUser && !wrotePlainQuestions,
  };
}
