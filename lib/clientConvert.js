// Client-side file -> compressed page-image conversion, run in the browser
// BEFORE upload.
//
// Why this exists: Vercel's Serverless Functions reject request bodies over
// ~4.5MB with a plain-text "Request Entity Too Large" response (not JSON),
// which broke the upload for any realistically-sized scanned exam (a couple
// of phone-camera photos, or a multi-page scanned PDF, both routinely exceed
// that on their own). Route Handler body limits aren't configurable on
// Vercel, so instead of sending the original files, every page is rendered
// to a capped-resolution, recompressed JPEG here first. This keeps typical
// uploads at a few hundred KB per page instead of several MB, and as a
// bonus means the browser — not the serverless function — pays the PDF
// rasterization cost.
//
// Output shape matches what the server already expects: an ordered list of
// image Blobs appended under the same form field name. lib/pdf.js's
// fileToPageImages/filesToPageImages already treats each non-PDF file as one
// page and flattens multiple files in order, so nothing server-side needs to
// change — every "file" this module hands back is just a small JPEG image.

const MAX_DIMENSION = 1700; // longest side, px
const JPEG_QUALITY = 0.8;

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/build/pdf.mjs").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return mod;
    });
  }
  return pdfjsPromise;
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

function scaleToFit(width, height) {
  const longest = Math.max(width, height);
  return longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;
}

async function pdfFileToJpegBlobs(file) {
  const pdfjs = await getPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    throw new Error(
      `Couldn't read "${file.name}" as a PDF (is it valid and not password-protected?)`
    );
  }

  const blobs = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = scaleToFit(unscaled.width, unscaled.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    // White background first: scanned PDFs can have transparent regions
    // that would otherwise turn black once flattened to JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await canvasToJpegBlob(canvas);
    blobs.push(blob);
  }
  return blobs;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () =>
      reject(
        new Error(
          `Couldn't read "${file.name}" as an image (unsupported or corrupt file).`
        )
      );
    img.src = url;
  });
}

async function imageFileToJpegBlob(file) {
  const { img, url } = await loadImageElement(file);
  try {
    const scale = scaleToFit(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToJpegBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isPdfFile(file) {
  return (
    file.type === "application/pdf" ||
    file.name?.toLowerCase().endsWith(".pdf")
  );
}

/**
 * Converts an ordered list of File objects (PDFs and/or images) into an
 * ordered, flattened list of small JPEG Blobs (one per page), ready to be
 * appended to a FormData under a single field name.
 */
export async function filesToJpegBlobs(files) {
  const blobs = [];
  for (const file of files) {
    if (isPdfFile(file)) {
      blobs.push(...(await pdfFileToJpegBlobs(file)));
    } else {
      blobs.push(await imageFileToJpegBlob(file));
    }
  }
  return blobs;
}

export function totalBlobBytes(blobLists) {
  return blobLists.flat().reduce((sum, b) => sum + b.size, 0);
}
