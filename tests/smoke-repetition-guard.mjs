// Smoke test: load the built extension bundle and verify it wires up against a
// minimal fake pi. Run: node tests/smoke-repetition-guard.mjs
import assert from "node:assert/strict";
import ext from "../dist/pi-repetition-guard/index.min.js";

assert.equal(typeof ext, "function", "default export must be a factory function");

const seen = { events: [], commands: [] };
const fakePi = {
  on(event, _handler) {
    seen.events.push(event);
  },
  registerCommand(name, opts) {
    assert.equal(typeof opts.handler, "function", "command must have a handler");
    seen.commands.push(name);
  },
  sendUserMessage() {
    throw new Error("sendUserMessage must not be called during load");
  },
};

ext(fakePi);

assert.ok(
  seen.events.includes("message_update") &&
    seen.events.includes("message_start") &&
    seen.events.includes("message_end"),
  `expected stream events, got: ${seen.events.join(", ")}`,
);
assert.ok(seen.commands.includes("runaway"), `expected /runaway command, got: ${seen.commands.join(", ")}`);

console.log(`SMOKE OK — events: ${seen.events.join(", ")}; commands: ${seen.commands.join(", ")}`);
