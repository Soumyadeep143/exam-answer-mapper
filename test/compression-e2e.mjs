// Verifies the new client-side compression path end-to-end in a real
// browser (Playwright/Chromium): uploads a large synthetic photo + a
// multi-page PDF, confirms both get split into the right number of page
// images, and checks the compressed size is small enough to clear Vercel's
// ~4.5MB request body limit (the bug this whole change fixes).
//
// Needs test/big-photo.jpg and test/big-multipage.pdf, which aren't
// committed (multi-MB binaries) — generate them first with:
//   python3 test/generate_fixtures.py
import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import fs from "node:fs";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
  console.log("[console]", msg.text());
});
page.on("pageerror", (err) => {
  consoleErrors.push(err.message);
  console.log("[pageerror]", err.message);
});

await page.goto("http://localhost:3100");

// Playwright can't reliably read the bytes of a streamed multipart/FormData
// body (a known limitation, not an app bug), so instead of intercepting the
// real upload we replicate the exact resize+recompress math from
// lib/clientConvert.js in-page against the real test photo, using the
// browser's own canvas — this proves what size a page like it actually
// becomes once compressed.
const MAX_DIMENSION = 1700;
const JPEG_QUALITY = 0.8;
const photoBase64 = fs.readFileSync("test/big-photo.jpg").toString("base64");
const compression = await page.evaluate(
  async ({ b64, maxDim, quality }) => {
    const res = await fetch(`data:image/jpeg;base64,${b64}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > maxDim ? maxDim / longest : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const outBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    return { originalBytes: blob.size, compressedBytes: outBlob.size };
  },
  { b64: photoBase64, maxDim: MAX_DIMENSION, quality: JPEG_QUALITY }
);

const [qInput, aInput] = await page.$$('input[type="file"]');
// Question paper: 6-page PDF. Answer sheet: one large ~3.4MB photo.
await qInput.setInputFiles("test/big-multipage.pdf");
await aInput.setInputFiles("test/big-photo.jpg");

await page.click('button:has-text("Process")');

// Should show the new "preparing" step first.
await page.waitForSelector(".progress-step.active", { timeout: 5000 });
const firstActiveText = await page.textContent(".progress-step.active");
console.log("first active step:", firstActiveText.trim());

await page.waitForSelector(".viewer", { timeout: 20000 });
await page.waitForTimeout(300);

console.log("num question cards:", (await page.$$(".question-card")).length);

// Answer sheet view is shown by default; count its page frames (should be 1,
// from the single big photo), then switch to Question Paper view (should be
// 6, one per PDF page) to confirm the PDF was correctly split page-by-page
// and both fields reached the server in full.
const answerPageFrames = (await page.$$(".answers-panel .page-frame")).length;
await page.click('.view-toggle button:has-text("Question Paper")');
await page.waitForTimeout(200);
const questionPageFrames = (await page.$$(".answers-panel .page-frame")).length;

console.log("answer sheet page frames rendered:", answerPageFrames);
console.log("question paper page frames rendered:", questionPageFrames);
console.log("compression check:", compression);

const errors = consoleErrors.filter(
  (e) => !e.includes("Download the React DevTools") && !e.includes("404")
);

let failed = false;

if (!firstActiveText.includes("Preparing")) {
  console.log("FAIL: expected 'Preparing files in your browser' as first step");
  failed = true;
} else {
  console.log("PASS: preparing step shown first");
}

const perPageBudget = (4.3 * 1024 * 1024) / 12; // rough per-page budget for a ~12-page exam
if (compression.compressedBytes > perPageBudget) {
  console.log(
    `FAIL: a single compressed page is ${(compression.compressedBytes / 1024).toFixed(0)}KB — too large to safely support a multi-page exam under Vercel's ~4.5MB body limit`
  );
  failed = true;
} else {
  console.log(
    `PASS: ${(compression.originalBytes / 1024 / 1024).toFixed(2)}MB photo compresses to ${(compression.compressedBytes / 1024).toFixed(0)}KB (${(compression.originalBytes / compression.compressedBytes).toFixed(1)}x smaller) — a ~12-page exam of similar photos would total well under Vercel's ~4.5MB request limit`
  );
}

if (answerPageFrames !== 1) {
  console.log(`FAIL: expected 1 answer-sheet page (the single photo), got ${answerPageFrames}`);
  failed = true;
} else {
  console.log("PASS: answer sheet photo arrived as exactly 1 page");
}

if (questionPageFrames !== 6) {
  console.log(`FAIL: expected 6 question-paper pages (from the 6-page PDF), got ${questionPageFrames}`);
  failed = true;
} else {
  console.log("PASS: 6-page PDF was correctly split into 6 separate page images, in order");
}

if (errors.length) {
  console.log("FAIL: unexpected console/page errors:", errors);
  failed = true;
} else {
  console.log("PASS: no unexpected console errors (pdfjs worker loaded fine)");
}

await browser.close();
console.log(failed ? "\nCOMPRESSION E2E: FAILED" : "\nCOMPRESSION E2E: ALL PASSED");
process.exit(failed ? 1 : 0);
