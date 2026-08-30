import { pdf as pdfToImg } from "pdf-to-img";
import { imageSize } from "image-size";

const PDF_RENDER_SCALE = 2;

/**
 * Turns one uploaded File (a scanned PDF, or a plain image) into an ordered
 * array of page images the rest of the pipeline can work with.
 *
 * Each returned page is: { dataUrl, base64, mimeType, width, height, pageIndex }
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
