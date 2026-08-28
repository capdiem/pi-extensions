import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantText,
  classifyTurn,
  isQuestionRoundText,
} from "../extensions/pi-ask-user/diagnostic.ts";

test("assistantText extracts text blocks and skips thinking", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "Let me reason through this..." },
      { type: "text", text: "Here is the answer." },
      { type: "text", text: "And more." },
    ],
  };
  assert.equal(assistantText(message), "Here is the answer.\nAnd more.");
  assert.equal(assistantText({ content: "plain string" }), "plain string");
  assert.equal(assistantText({ content: [] }), "");
  assert.equal(assistantText({}), "");
  assert.equal(assistantText(null), "");
});

test("isQuestionRoundText detects numbered/grilling question markers", () => {
  assert.equal(isQuestionRoundText("Q1 - Scope: pick one"), true);
  assert.equal(isQuestionRoundText("Do it — recommended answer: include"), true);
  assert.equal(isQuestionRoundText("请回答：你更倾向哪个方案？"), true);
  assert.equal(isQuestionRoundText("❓ Should we escalate now?"), true);
  assert.equal(isQuestionRoundText("Here is the final implementation."), false);
  assert.equal(isQuestionRoundText(""), false);
  assert.equal(isQuestionRoundText(null as unknown as string), false);
});

test("classifyTurn classifies question rounds and cleanliness", () => {
  // ask_user used, no plain text → clean question round.
  assert.deepEqual(classifyTurn("", true), {
    isQuestionRound: true,
    usedAskUser: true,
    wrotePlainQuestions: false,
    handledCleanly: true,
  });

  // Plain-text Q1..QN without ask_user → dirty question round.
  assert.deepEqual(classifyTurn("Q1: pick a? Q2: pick b?", false), {
    isQuestionRound: true,
    usedAskUser: false,
    wrotePlainQuestions: true,
    handledCleanly: false,
  });

  // Neither → not a question round.
  assert.deepEqual(classifyTurn("Refactored the module.", false), {
    isQuestionRound: false,
    usedAskUser: false,
    wrotePlainQuestions: false,
    handledCleanly: false,
  });

  // ask_user used but plain text also leaked → not clean.
  assert.deepEqual(classifyTurn("Q1: ...", true), {
    isQuestionRound: true,
    usedAskUser: true,
    wrotePlainQuestions: true,
    handledCleanly: false,
  });
});
