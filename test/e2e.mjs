import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto("http://localhost:3100");

const [qInput, aInput] = await page.$$('input[type="file"]');
await qInput.setInputFiles("test/sample.pdf");
await aInput.setInputFiles("test/sample.pdf");

await page.screenshot({ path: "test/shot-1-selected.png" });

await page.click('button:has-text("Process")');

// wait for viewer
await page.waitForSelector(".viewer", { timeout: 20000 });
await page.waitForTimeout(300);
await page.screenshot({ path: "test/shot-2-viewer.png" });

// click first question (answered)
await page.click(".question-card >> nth=0");
await page.waitForTimeout(200);
await page.screenshot({ path: "test/shot-3-highlight-q1.png" });

// click unanswered question (2(b) should be third card)
const cards = await page.$$(".question-card");
console.log("num question cards:", cards.length);
await cards[2].click();
await page.waitForTimeout(200);
await page.screenshot({ path: "test/shot-4-unanswered.png" });

// click unmatched answer
const unmatched = await page.$('.badge.unmatched');
if (unmatched) {
  const parentCard = await unmatched.evaluateHandle((el) => el.closest(".question-card"));
  await parentCard.asElement().click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test/shot-5-unmatched.png" });
}

await browser.close();
console.log("done");
