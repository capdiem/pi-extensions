import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUARD_STEER_MAX_RETRIES,
  RepetitionDetector,
  SAMPLE_MAX_CHARS,
  buildSteer,
  extractText,
} from "../extensions/pi-repetition-guard/detector.ts";

/** Feed text in small chunks to simulate streaming, return the final verdict. */
function streamUntil(resultKind: "suspect" | "hard", text: string, chunk = 120): boolean {
  const detector = new RepetitionDetector();
  let result = { suspect: false, hard: false, sample: "" };
  for (let i = 0; i < text.length; i += chunk) {
    result = detector.ingest(text.slice(0, i + chunk));
  }
  return resultKind === "hard" ? result.hard : result.suspect || result.hard;
}

test("detector stays quiet on normal non-repeating prose", () => {
  const detector = new RepetitionDetector();
  // Long, genuinely distinct prose: no repeated blocks, no repeated shingles.
  // (Deliberately not built with .repeat — a verbatim second copy WOULD and
  // SHOULD trigger, because that is literally repetition.)
  const paragraphs = [
    "First paragraph about the request being analyzed. It discusses the approach, considers alternatives, and arrives at a reasonable conclusion without ever looping back on itself. The sentences keep introducing fresh information and moving forward.",
    "Second paragraph continues with entirely new material. Different wording, varied structure, distinct vocabulary, nothing echoes the earlier passage. Numbers differ, examples differ, and the flow stays novel throughout this stretch of text.",
    "Third paragraph adds more original analysis before concluding. It references none of the prior phrasing, introduces a new concrete example, and closes the answer cleanly with a distinct final observation that was not stated anywhere above.",
    "Fourth paragraph rounds out the response with additional detail that has not appeared before in this message. Each clause adds novel information so that the trailing window of characters contains almost no repeats.",
    "Fifth paragraph provides the closing remarks. The wording here is deliberately unique, avoiding any shingle that appeared in the previous paragraphs, so the recent-novelty signal stays well below the trigger thresholds.",
  ];
  const text = paragraphs.join("\n\n");
  let result = { suspect: false, hard: false, sample: "" };
  for (let i = 0; i < text.length; i += 200) {
    result = detector.ingest(text.slice(0, i + 200));
  }
  assert.equal(result.hard, false);
  assert.equal(result.suspect, false);
});

test("detector flags a repeated long block as suspect then hard", () => {
  const block = "The same long paragraph keeps being repeated verbatim again and again. ".repeat(2);
  // One copy of the block: quiet.
  const single = detectorFeed(block);
  assert.equal(single.suspect, false, "one copy must not trigger");
  // Two copies: suspect.
  const twice = streamUntil("suspect", block.repeat(2));
  assert.equal(twice, true, "two copies must be suspect");
  // Three copies: hard.
  const thrice = streamUntil("hard", block.repeat(3));
  assert.equal(thrice, true, "three copies must be hard");
});

function detectorFeed(text: string): { suspect: boolean; hard: boolean } {
  const detector = new RepetitionDetector();
  let result = { suspect: false, hard: false, sample: "" };
  for (let i = 0; i < text.length; i += 200) {
    result = detector.ingest(text.slice(0, i + 200));
  }
  return result;
}

test("detector triggers hard via low shingle novelty even without full-block repeats", () => {
  // Subtle runaway: the recent window mostly rehashes earlier content without
  // a verbatim long line (the classic "rewording the same thing" loop).
  const lead = "Intro sentence that is unique and not repeated anywhere else. ";
  const loopBody =
    "consequently we should reconsider the implications of the prior statement " +
    "and then reflect on whether the conclusion actually follows from it all. ";
  let text = lead;
  for (let i = 0; i < 40; i++) text += loopBody;
  const hard = streamUntil("hard", text);
  assert.equal(hard, true, "sustained low-novelty repetition must be hard");
});

test("detector does not flag a single checklist of short distinct lines", () => {
  // A normal, single-pass checklist: short distinct lines below MIN_BLOCK_CHARS.
  // Real usage outputs the list once — this must NOT trigger.
  const detector = new RepetitionDetector();
  let text = "";
  for (let i = 0; i < 30; i++) text += `item ${i}: done. `;
  let result = { suspect: false, hard: false, sample: "" };
  for (let i = 0; i < text.length; i += 200) {
    result = detector.ingest(text.slice(0, i + 200));
  }
  assert.equal(result.hard, false, "a single checklist must not hard-trigger");
  assert.equal(result.suspect, false, "a single checklist must not even be suspect");
});

test("detector flags a wholesale-repeated list as hard (it IS repetition)", () => {
  // The same list emitted twice wholesale IS a degenerate repetition loop —
  // the model is re-emitting old content verbatim. This must trigger.
  const detector = new RepetitionDetector();
  let list = "";
  for (let i = 0; i < 30; i++) list += `item ${i}: done. `;
  const text = `${list}\n${list}`;
  let result = { suspect: false, hard: false, sample: "" };
  for (let i = 0; i < text.length; i += 200) {
    result = detector.ingest(text.slice(0, i + 200));
  }
  assert.equal(result.hard, true, "a verbatim re-emission of the whole list is runaway");
});

test("extractText concatenates text and thinking blocks", () => {
  const content = [
    { type: "thinking", thinking: "Hmm, let me think about this. " },
    { type: "text", text: "The final answer." },
    { type: "toolCall", id: "x", name: "todo", args: {} },
  ];
  const text = extractText(content);
  assert.ok(text.includes("Hmm, let me think"));
  assert.ok(text.includes("The final answer."));
  assert.equal(text.includes("toolCall"), false);
  assert.equal(extractText(undefined), "");
  assert.equal(extractText("not-an-array"), "");
});

test("buildSteer includes the repeated sample on first retry and escalates on the second", () => {
  const first = buildSteer(1, "a repeated paragraph ".repeat(10));
  assert.match(first, /\[自动护栏\]/);
  assert.match(first, /a repeated paragraph/);
  const truncated = buildSteer(1, "x".repeat(SAMPLE_MAX_CHARS + 100));
  assert.ok(truncated.length <= SAMPLE_MAX_CHARS + 200, "sample must be truncated");

  const second = buildSteer(2, "whatever");
  assert.match(second, /第 2 次/);
  assert.equal(second.includes("whatever"), false, "escalated retry must not carry the sample");
  assert.equal(GUARD_STEER_MAX_RETRIES, 2);
});
