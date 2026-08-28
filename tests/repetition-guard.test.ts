import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUARD_STEER_MAX_RETRIES,
  NEAR_DUP_HARD_FRACTION,
  RepetitionDetector,
  RetryBudget,
  SAMPLE_MAX_CHARS,
  ToolLoopTracker,
  TOOL_LOOP_MAX_REPEATS,
  buildSteer,
  buildToolLoopSteer,
  extractText,
  findPeriod,
  nearDupDominance,
} from "../extensions/pi-repetition-guard/detector.ts";

/** Feed text in small chunks to simulate streaming. The guard aborts on the
 *  FIRST hard trigger (index.ts sets hardTriggered), so this returns whether
 *  the detector EVER reported hard during the stream, plus the final verdict. */
function streamAll(text: string): { suspect: boolean; hard: boolean; sample: string } {
  const detector = new RepetitionDetector();
  let everHard = false;
  let everSuspect = false;
  let result = { suspect: false, hard: false, sample: "" };
  for (let i = 0; i < text.length; i += 200) {
    result = detector.ingest(text.slice(0, i + 200));
    if (result.hard) everHard = true;
    if (result.suspect) everSuspect = true;
  }
  return { suspect: everSuspect, hard: everHard, sample: result.sample };
}

const runawayUnit =
  "The answer to the question is that we should consider the implications of the analysis and then implement the recommended changes without delay. ";

test("detector stays quiet on legitimate long xhigh thinking (regression)", () => {
  // The real-world false positive that motivated v2: long, productive thinking
  // with self-verification echoes and templated paragraphs must NOT trigger.
  const thinking = [
    "I need to solve this problem: implement a rate limiter with a sliding window and make it thread-safe.",
  ];
  for (let i = 0; i < 6; i++) {
    thinking.push(
      `Approach ${i + 1}: use a fixed window with a counter per bucket. The counter tracks how many requests arrived in the current window, and when the window expires the counter resets. This is simple but allows bursts at window boundaries, which may violate the rate limit contract for clients that send a burst exactly at the reset point.`,
    );
    thinking.push(
      `Let me verify approach ${i + 1} against the requirement again. The requirement says the limiter must allow at most N requests per second, averaged over the whole window, with no bursting above the limit. Fixed windows reset abruptly, so a client can send 2N requests in the instant straddling a boundary, which clearly violates the intent. So fixed windows are out.`,
    );
  }
  for (let i = 0; i < 5; i++) {
    thinking.push(
      `Sliding window alternative ${i + 1}: keep timestamps of the last N requests in a queue, evict entries older than the window, and accept when the queue length is below N. This guarantees the hard limit over any sliding interval and never allows bursts above N. The cost is O(N) memory per key and an O(1) amortized check, which is acceptable for the expected load of a few thousand distinct keys.`,
    );
    thinking.push(
      `Double-checking the sliding window: when a request arrives at time t, we remove every timestamp older than t - window, then count the remaining entries. If the count is less than N we accept and push t; otherwise we reject with a 429. This is correct for the sliding contract, and the queue is protected by a mutex so concurrent threads cannot corrupt it.`,
    );
  }
  thinking.push(
    "So the final decision is the sliding-window queue with a mutex. I will write the implementation, add a small test, and present it.",
  );
  const result = streamAll(thinking.join("\n"));
  assert.equal(result.hard, false, "legitimate long thinking must not hard-trigger");
});

test("detector stays quiet on normal non-repeating prose", () => {
  const paragraphs = [
    "First paragraph about the request being analyzed. It discusses the approach, considers alternatives, and arrives at a reasonable conclusion without ever looping back on itself. The sentences keep introducing fresh information and moving forward.",
    "Second paragraph continues with entirely new material. Different wording, varied structure, distinct vocabulary, nothing echoes the earlier passage. Numbers differ, examples differ, and the flow stays novel throughout this stretch of text.",
    "Third paragraph adds more original analysis before concluding. It references none of the prior phrasing, introduces a new concrete example, and closes the answer cleanly with a distinct final observation that was not stated anywhere above.",
    "Fourth paragraph rounds out the response with additional detail that has not appeared before in this message. Each clause adds novel information so that the trailing window of characters contains almost no repeats.",
    "Fifth paragraph provides the closing remarks. The wording here is deliberately unique, avoiding any shingle that appeared in the previous paragraphs, so the recent-novelty signal stays well below the trigger thresholds.",
  ];
  const result = streamAll(paragraphs.join("\n\n"));
  assert.equal(result.hard, false);
});

test("detector stays quiet on legit code, recap, and templated lists", () => {
  const code = [
    "function normalize(items) { const out = []; for (const it of items) { const t = it.trim().toLowerCase(); if (t) out.push(t); } return out; }",
    "function dedupe(values) { return Array.from(new Set(values)); }",
    "The first trims and lowercases, skipping empties; the second removes duplicates.",
  ].join("\n");
  assert.equal(streamAll(code).hard, false);

  const recap = [
    "The first consideration is error handling: validate inputs and return a clear failure instead of throwing mid-way, rejecting non-finite values and giving the caller a structured error.",
    "The second consideration is performance: avoid quadratic scans and prefer a single pass over the collection, picking the O(n) approach even when the constant factor is higher.",
    "In summary, the function validates inputs up front, uses a single linear pass for performance, and keeps the code plain and readable.",
  ].join("\n");
  assert.equal(streamAll(recap).hard, false, "a conclusion recap must not trigger");

  let bullets = "";
  for (let i = 0; i < 25; i++) {
    bullets += `- The recommended approach for concern number ${i + 1} is to evaluate trade-offs carefully and pick the option with the best balance of simplicity and robustness for the stated requirements. `;
  }
  assert.equal(streamAll(bullets).hard, false, "repeated bullet lead-ins must not trigger");
});

test("detector stays quiet on non-contiguous repeated blocks", () => {
  // Same block twice with new content in between is NOT a contiguous tape-loop
  // and must NOT trigger (v1's block-repeat/shingle signals wrongly flagged this).
  const interleaved =
    "Some distinct opening reasoning that introduces the topic and sets the stage for what follows. " +
    runawayUnit +
    "Then the reasoning moves on to new material that was not present before and continues forward. " +
    runawayUnit;
  assert.equal(streamAll(interleaved).hard, false, "non-contiguous repetition must not abort");
});

test("detector triggers hard on a contiguous tape-loop (runaway)", () => {
  const result = streamAll(runawayUnit.repeat(4));
  assert.equal(result.hard, true, "contiguous repeated block must hard-trigger");
  assert.equal(result.suspect, true);
  assert.ok(result.sample.length > 0, "sample must be the repeated unit");
  // The sample is a slice of the periodic tail (a cyclic rotation of the loop
  // unit), so it must appear within two concatenated copies of the unit.
  assert.ok(
    (runawayUnit + runawayUnit).includes(result.sample),
    "sample must be the repeating content",
  );
});

test("detector triggers hard on a long-block runaway", () => {
  const longUnit = "Long block that is exactly a thousand characters long. ".repeat(18) +
    "End of the long repeating unit used to simulate a long-block runaway loop. ";
  assert.equal(streamAll(longUnit.repeat(4)).hard, true, "long contiguous block must hard-trigger");
});

test("detector triggers hard on a runaway after a long legit preamble", () => {
  const preamble =
    "Let me lay out the plan. We receive, validate, route, and collect the results. ".repeat(2);
  const result = streamAll(preamble + runawayUnit.repeat(4));
  assert.equal(result.hard, true, "runaway after legit preamble must trigger");
});

test("detector does not flag a single checklist of short distinct lines", () => {
  let text = "";
  for (let i = 0; i < 30; i++) text += `item ${i}: done. `;
  assert.equal(streamAll(text).hard, false);
});

test("findPeriod returns the loop unit for periodic tails and null otherwise", () => {
  assert.equal(findPeriod(runawayUnit.repeat(3)), runawayUnit.length);
  assert.equal(findPeriod("abc".repeat(10)), null, "period below MIN_PERIOD is ignored");
  assert.equal(
    findPeriod("A novel sentence that never repeats itself in the tail at all. ".repeat(1)),
    null,
  );
  const tail = "prefix that is unique and not repeated. ".repeat(2) + runawayUnit.repeat(2);
  assert.equal(findPeriod(tail), runawayUnit.length, "period found in the tail");
  assert.equal(
    findPeriod("A B A B C A B A B C A B A B C"),
    null,
    "periodic with gaps / no clean tail period is ignored",
  );
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

test("buildSteer is action-oriented, carries the sample on retry 1, escalates on 2 and 3", () => {
  const first = buildSteer(1, "a repeated paragraph ".repeat(10));
  assert.match(first, /\[自动护栏\]/);
  assert.match(first, /a repeated paragraph/);
  assert.match(first, /直接执行/, "retry 1 must redirect to action, not just 'answer'");
  const truncated = buildSteer(1, "x".repeat(SAMPLE_MAX_CHARS + 100));
  assert.ok(truncated.length <= SAMPLE_MAX_CHARS + 200, "sample must be truncated");

  const second = buildSteer(2, "whatever");
  assert.match(second, /第 2 次/);
  assert.equal(second.includes("whatever"), false, "escalated retry must not carry the sample");

  const third = buildSteer(3, "whatever");
  assert.match(third, /第 3 次/);
  assert.match(third, /无法完成/, "final retry must offer a clear fallback");
  assert.equal(third.includes("whatever"), false);
  assert.equal(GUARD_STEER_MAX_RETRIES, 3);
});

test("tool-loop tracker fires on the same tool+input repeated within a window", () => {
  const t = new ToolLoopTracker();
  const hits: boolean[] = [];
  // Realistic git-status tool-loop: same tool, same input, many times.
  for (let i = 0; i < TOOL_LOOP_MAX_REPEATS + 2; i++) {
    hits.push(t.record("bash", '{"command":"git status"}'));
  }
  // Fires on the 4th identical call and stays true after.
  assert.equal(
    hits.slice(0, TOOL_LOOP_MAX_REPEATS - 1).every((h) => h === false),
    true,
    "must not fire before the threshold",
  );
  assert.equal(hits[TOOL_LOOP_MAX_REPEATS - 1], true, "must fire at the threshold");
  assert.equal(
    hits.slice(TOOL_LOOP_MAX_REPEATS - 1).every(Boolean),
    true,
    "stays fired while the loop continues",
  );
});

test("tool-loop tracker does not fire on varied legitimate tool usage", () => {
  const t = new ToolLoopTracker();
  const calls: Array<[string, string]> = [
    ["bash", '{"command":"git status"}'],
    ["read", '{"path":"CHANGES.md"}'],
    ["edit", '{"path":"CHANGES.md","newText":"..."}'],
    ["bash", '{"command":"git diff"}'],
    ["bash", '{"command":"git add -A"}'],
    ["bash", '{"command":"git commit -m \\"update\\""}'],
    ["bash", '{"command":"git status"}'],
  ];
  const fired = calls.map(([name, key]) => t.record(name, key));
  // Same tool+input ("git status") appears only twice in 7 calls — below the
  // threshold; every other call is distinct.
  assert.equal(fired.includes(true), false, "normal varied workflow must not fire");
});

test("tool-loop tracker resets per agent run and slides out of the window", () => {
  const t = new ToolLoopTracker();
  for (let i = 0; i < TOOL_LOOP_MAX_REPEATS; i++) t.record("bash", '{"command":"git status"}');
  t.reset();
  assert.equal(t.record("bash", '{"command":"git status"}'), false, "reset must clear state");

  // Old calls slide out of the window: 4 repeats, then 8+ other calls, then the
  // same call again — the old count is gone.
  const t2 = new ToolLoopTracker();
  for (let i = 0; i < TOOL_LOOP_MAX_REPEATS; i++) t2.record("bash", '{"command":"git status"}');
  for (let i = 0; i < 8; i++) t2.record(`other${i}`, '{"x":1}');
  assert.equal(t2.record("bash", '{"command":"git status"}'), false, "old repeats must expire");
});

test("buildToolLoopSteer names the tool and escalates on the second retry", () => {
  const first = buildToolLoopSteer(1, "bash", '{"command":"git status"}');
  assert.match(first, /\[自动护栏\]/);
  assert.match(first, /bash/);
  assert.match(first, /git status/);
  assert.match(first, /完成目标/, "tool-loop retry 1 must redirect to finishing the goal");
  const longKey = "x".repeat(200);
  assert.ok(buildToolLoopSteer(1, "read", longKey).length < 400, "input sample must be truncated");
  const second = buildToolLoopSteer(2, "bash", "whatever");
  assert.match(second, /第 2 次/);
  assert.match(second, /bash/, "retry 2 must name the tool to stop calling");
  assert.equal(second.includes("whatever"), false, "retry 2 must not carry the input sample");
  const third = buildToolLoopSteer(3, "bash", "whatever");
  assert.match(third, /第 3 次/);
  assert.equal(third.includes("bash"), false, "final retry must drop tool details");
  assert.equal(third.includes("whatever"), false);
});

test("RetryBudget caps steers within a turn and resets on a real user message", () => {
  const b = new RetryBudget(3);
  // consume 3 → retry 1,2,3; 4th is disallowed
  assert.deepEqual(b.consume(), { retryNum: 1, allowSteer: true });
  assert.deepEqual(b.consume(), { retryNum: 2, allowSteer: true });
  assert.deepEqual(b.consume(), { retryNum: 3, allowSteer: true });
  assert.equal(b.consume().allowSteer, false, "4th steer must be disallowed");

  // a REAL user message (not our steer) resets the budget
  assert.equal(b.onUserMessage("还有优化方向吗"), true, "real user message resets");
  assert.deepEqual(b.consume(), { retryNum: 1, allowSteer: true }, "budget reset after real user turn");
});

test("RetryBudget does NOT treat our own steer as a new user turn (regression)", () => {
  const b = new RetryBudget(3);
  // send a steer, then its user-message delivery arrives with the same text
  const steer = "[自动护栏] 检测到你陷入了循环……";
  b.recordSentSteer(steer);
  assert.equal(b.onUserMessage(steer), false, "our own steer must not reset the budget");

  // budget is still at 3; a real user message afterwards resets
  assert.equal(b.remainingCount, 3, "budget untouched by our own steer");
  assert.equal(b.onUserMessage("继续"), true, "real user message resets after steer");
});

test("RetryBudget consumes then resets across a full steer cycle", () => {
  const b = new RetryBudget(3);
  const sent = new Set<string>();
  // simulate: hard → steer → steer delivery → hard → steer → delivery → ...
  const steers: string[] = ["steer-1", "steer-2", "steer-3"];
  for (let i = 0; i < 3; i++) {
    b.consume();
    sent.add(steers[i]);
    b.recordSentSteer(steers[i]);
    // delivery: user message matching the sent steer → NOT a new turn
    assert.equal(b.onUserMessage(steers[i]), false, "steer delivery is not a new turn");
  }
  assert.equal(b.consume().allowSteer, false, "exhausted after 3 steers");
  // new user turn resets
  assert.equal(b.onUserMessage("全新问题"), true);
  assert.equal(b.remainingCount, 3, "fresh budget for the next turn");
});

test("nearDupDominance flags a within-message variation loop (reworded copies)", () => {
  // The real-world pattern (b80c3738, measured 0.95): ONE prototype line
  // repeated with tiny word substitutions — not many distinct phrasings.
  const proto = "Let me read the _build_contractions_from signature end and add the zigzag memo.";
  const variants = [
    "Let me read the _build_contractions_from signature end and add the zigzag memo.",
    "Let me read the _build_contractions_from signature end, adding the zigzag memo.",
    "Let me read the signature end and add the zigzag_memo parameter.",
    "Let me read the signature end so I can add the zigzag memo.",
    "Let me read L1000-1035 and add the zigzag_memo parameter there.",
    "Let me read the signature end, then add the zigzag memo.",
    "Let me read L1000-1035 to add the zigzag_memo param.",
    "Let me read the _build_contractions_from signature end for the memo.",
    "Let me read the signature end and place the zigzag_memo param.",
    "Let me read L1000-1035, then add the zigzag memo param.",
  ];
  const text = [proto, ...variants, proto, ...variants.slice(0, 3)].join("\n");
  const { fraction, sample } = nearDupDominance(text);
  assert.ok(fraction >= NEAR_DUP_HARD_FRACTION, `variation loop must be dominant, got ${fraction.toFixed(2)}`);
  assert.ok(sample.length > 0, "sample must be a repeated segment");

  const result = streamAll(text);
  assert.equal(result.hard, true, "variation loop must hard-trigger via near-dup dominance");
});

test("nearDupDominance stays quiet on a long, internally-diverse message", () => {
  const paragraphs = [
    "First paragraph about the request being analyzed. It discusses the approach, considers alternatives, and arrives at a reasonable conclusion without ever looping back on itself. The sentences keep introducing fresh information and moving forward.",
    "Second paragraph continues with entirely new material. Different wording, varied structure, distinct vocabulary, nothing echoes the earlier passage. Numbers differ, examples differ, and the flow stays novel throughout this stretch of text.",
    "Third paragraph adds more original analysis before concluding. It references none of the prior phrasing, introduces a new concrete example, and closes the answer cleanly with a distinct final observation that was not stated anywhere above.",
    "Fourth paragraph rounds out the response with additional detail that has not appeared before in this message. Each clause adds novel information so that the trailing window of characters contains almost no repeats.",
    "Fifth paragraph provides the closing remarks. The wording here is deliberately unique, avoiding any shingle that appeared in the previous paragraphs, so the recent-novelty signal stays well below the trigger thresholds.",
  ];
  const { fraction } = nearDupDominance(paragraphs.join("\n\n"));
  assert.ok(fraction < NEAR_DUP_HARD_FRACTION, `diverse prose must stay below hard, got ${fraction.toFixed(2)}`);
  assert.equal(streamAll(paragraphs.join("\n\n")).hard, false);
});

test("nearDupDominance treats a productive message with a short repetitive tail as not-hard", () => {
  // Real results + a small repetitive tail (the 0.5-0.7 gray-zone shape) must
  // stay below 0.85 — the hard threshold is for messages DOMINATED by repeats.
  const text = [
    "Optimization confirmed: _read_csv tottime 8.32s to 2.58s, total Phase 1 104.7s to 93.5s, all 58 reports byte-identical.",
    "Let me clean up temp scripts and update CHANGES.md.",
    "Let me clean up and update docs.",
    "Let me clean up temp scripts and update the changelog.",
    "Let me finalize the todo state.",
  ].join("\n");
  const { fraction } = nearDupDominance(text);
  assert.ok(fraction < NEAR_DUP_HARD_FRACTION, `semi-productive must not hard-trigger, got ${fraction.toFixed(2)}`);
  assert.equal(streamAll(text).hard, false);
});
