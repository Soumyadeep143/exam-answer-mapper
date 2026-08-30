// Verifies the OpenAI -> Gemini -> Groq fallback CONTROL FLOW in
// lib/openai.js, independent of whether any of the three providers are
// actually reachable from wherever this runs. It does this by giving all
// three fake-but-present API keys and a single tiny test image, then
// checking that:
//   1. All three providers are attempted, in order, when all three keys are
//      set and every call fails (e.g. no network, or fake keys).
//   2. Providers without a key configured are skipped entirely.
//
// This intentionally does NOT assert a successful extraction (that needs
// real keys + real network, which this sandbox doesn't have egress for) —
// it asserts the fallback *logic* is wired correctly. Run with:
//   node test/fallback-test.mjs
import fs from "node:fs";
import path from "node:path";

// A 1x1 white JPEG, base64-encoded, just so the provider calls have
// something image-shaped to send before they fail.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

process.env.OPENAI_API_KEY = "test-fake-openai-key";
process.env.GEMINI_API_KEY = "test-fake-gemini-key";
process.env.GROQ_API_KEY = "test-fake-groq-key";

const { extractQuestions } = await import("../lib/openai.js");

const page = {
  pageIndex: 0,
  dataUrl: `data:image/jpeg;base64,${TINY_JPEG_BASE64}`,
  width: 1,
  height: 1,
};

let failed = false;

console.log("--- Test 1: all three providers configured, all fail ---");
try {
  await extractQuestions([page]);
  console.log("FAIL: expected an error (no real network/keys available)");
  failed = true;
} catch (err) {
  const msg = err.message;
  const mentionsAll = ["OpenAI", "Gemini", "Groq"].every((p) => msg.includes(p));
  const inOrder =
    msg.indexOf("OpenAI") < msg.indexOf("Gemini") &&
    msg.indexOf("Gemini") < msg.indexOf("Groq");
  console.log("error message:", msg);
  if (mentionsAll && inOrder) {
    console.log("PASS: all three providers attempted, in order");
  } else {
    console.log("FAIL: providers missing or out of order");
    failed = true;
  }
}

console.log("\n--- Test 2: only Groq configured, others skipped ---");
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
try {
  await extractQuestions([page]);
  console.log("FAIL: expected an error (no real network/key available)");
  failed = true;
} catch (err) {
  const msg = err.message;
  const onlyGroq =
    msg.includes("Groq") && !msg.includes("OpenAI") && !msg.includes("Gemini");
  console.log("error message:", msg);
  if (onlyGroq) {
    console.log("PASS: OpenAI/Gemini correctly skipped (no key set)");
  } else {
    console.log("FAIL: expected only Groq to be attempted");
    failed = true;
  }
}

console.log("\n--- Test 3: no providers configured at all ---");
delete process.env.GROQ_API_KEY;
try {
  await extractQuestions([page]);
  console.log("FAIL: expected an error (no provider configured)");
  failed = true;
} catch (err) {
  console.log("error message:", err.message);
  if (err.message.includes("No AI provider is configured")) {
    console.log("PASS: clear error when nothing is configured");
  } else {
    failed = true;
  }
}

console.log("\n--- Test 4: MOCK_OPENAI short-circuit still works ---");
process.env.MOCK_OPENAI = "1";
const mockQuestions = await extractQuestions([page]);
if (Array.isArray(mockQuestions) && mockQuestions.length > 0) {
  console.log("PASS: mock path returns data without touching any provider");
} else {
  console.log("FAIL: mock path broken");
  failed = true;
}

console.log(failed ? "\nFALLBACK TESTS: FAILED" : "\nFALLBACK TESTS: ALL PASSED");
process.exit(failed ? 1 : 0);
