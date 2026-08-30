import { readFileSync, writeFileSync } from "node:fs";
import { pdf as pdfToImg } from "pdf-to-img";
import { imageSize } from "image-size";

const buffer = readFileSync(new URL("./sample.pdf", import.meta.url));
const doc = await pdfToImg(buffer, { scale: 2, format: "jpeg" });

let i = 0;
for await (const page of doc) {
  const dims = imageSize(page);
  console.log(`page ${i}: ${dims.width}x${dims.height}, ${page.length} bytes`);
  writeFileSync(new URL(`./out-page-${i}.jpg`, import.meta.url), page);
  i++;
}
console.log("OK, pages:", i);
