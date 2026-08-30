import { imageSize } from "image-size";

const PDF_RENDER_SCALE = 2;

/**
 * Turns one uploaded File (a scanned PDF, or a plain image) into an ordered
 * array of page images the rest of the pipeline can work with.
 *
 * Each returned page is: { dataUrl, base64, mimeType, width, height, pageIndex }
 *
 * NOTE: the UI (app/page.js + lib/clientConvert.js) always converts every
 * page to a JPEG client-side before upload, specifically so this function's
 * PDF branch is never exercised in normal use — pdf-to-img's dependency
 * chain references `DOMMatrix`, a browser API that isn't available in
 * Vercel's Node.js Serverless Function runtime, so it throws a
 * `ReferenceError: DOMMatrix is not defined` there (it works fine locally,
 * where Node happens to expose it). `pdf-to-img` is imported lazily, only if
 * a raw PDF actually reaches here (e.g. a direct API call bypassing the
 * UI), so that importing it doesn't risk affecting the normal JPEG-only
 * request path at all.
 */
export async function fileToPageImages(file) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const isPdf =
    file.type === "application/pdf" ||
    file.name?.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    // Already an image (png/jpg/webp/etc) - use as a single "page".
    const mimeType = file.type || "image/jpeg";
    const dims = safeImageSize(buffer);
    return [
      {
        pageIndex: 0,
        mimeType,
        base64: buffer.toString("base64"),
        dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      },
    ];
  }

  let pdfToImg;
  try {
    ({ pdf: pdfToImg } = await import("pdf-to-img"));
  } catch (err) {
    throw new Error(
      "Server-side PDF conversion isn't available in this deployment. Please upload from the app's UI, which converts PDFs to images in your browser before sending them."
    );
  }

  const doc = await pdfToImg(buffer, {
    scale: PDF_RENDER_SCALE,
    format: "jpeg",
  });

  const pages = [];
  let pageIndex = 0;
  for await (const pageBuffer of doc) {
    const dims = safeImageSize(pageBuffer);
    pages.push({
      pageIndex,
      mimeType: "image/jpeg",
      base64: pageBuffer.toString("base64"),
      dataUrl: `data:image/jpeg;base64,${pageBuffer.toString("base64")}`,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
    pageIndex += 1;
  }
  return pages;
}

function safeImageSize(buffer) {
  try {
    return imageSize(buffer);
  } catch {
    return null;
  }
}

/**
 * Converts an ordered list of uploaded Files into a single flat, ordered
 * array of page images (numbering pages continuously across files).
 */
export async function filesToPageImages(files) {
  const allPages = [];
  for (const file of files) {
    const pages = await fileToPageImages(file);
    for (const page of pages) {
      allPages.push({ ...page, pageIndex: allPages.length });
    }
  }
  return allPages;
}
