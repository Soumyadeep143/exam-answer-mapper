# Answer Mapper

AI Assessment Extraction & Answer Mapping — a teacher uploads a printed question
paper and a student's handwritten answer sheet; the app extracts every question,
extracts every handwritten answer, maps each answer to its question, and lets the
teacher click a question to see exactly where on the answer sheet it was answered.

## Approach

**Core flow:** Upload → Convert to page images → Extract questions (GPT-4o vision)
→ Extract answers + bounding boxes (GPT-4o vision) → Map answers to questions →
Click-to-highlight viewer.

1. **Upload.** The teacher selects a question paper and an answer sheet (PDF and/or
   images, multiple files/pages supported). Nothing is written to a database —
   everything lives only for the lifetime of the request (in-memory), per the
   assignment's constraints.
2. **Convert to page images — in the browser, before upload.** Every uploaded page
   (PDF or image) is rasterized/downscaled to a capped-resolution, recompressed
   JPEG client-side (`lib/clientConvert.js`, using `pdfjs-dist` + canvas) before
   the request is sent. This is a deliberate fix, not just an optimization:
   Vercel's Serverless Functions reject request bodies over ~4.5MB with a
   plain-text "Request Entity Too Large" response (not JSON, and not
   configurable away for App Router route handlers), which broke uploads for
   any realistically-sized scan — a couple of phone-camera photos or a
   multi-page scanned PDF routinely exceed that on their own. Compressing
   client-side (a 4000×3000 test photo → ~1700px long side, JPEG quality 0.8)
   gets a typical page down to a few hundred KB, so a normal multi-page exam
   comfortably clears the limit; the app also checks the total compressed size
   before uploading and shows a clear error instead of a cryptic platform
   rejection if it's still too big. The server-side PDF rasterization path
   (`pdf-to-img` + `@napi-rs/canvas`, no native/system dependency) is kept as a
   fallback for direct API use. These compressed images are the *same* ones
   shown in the UI and sent to the model, so any bounding box the model
   returns lines up with what the teacher sees.
3. **Extract questions.** All question-paper page images are sent to a vision model
   in one call with a strict JSON schema (OpenAI Structured Outputs, or an
   equivalent prompted-JSON contract for the fallback providers — see below). The
   model is instructed to preserve the exact printed numbering and to treat
   labelled sub-parts (e.g. `11(a)` / `11(b)`) as separate questions, in printed
   order.
4. **Extract answers.** All answer-sheet page images are sent to a vision model in
   a second call, along with the list of known question numbers from step 3. For
   every handwritten answer region the model transcribes the text, gives a
   normalized bounding box (fraction of the page image, top-left origin), and its
   best guess at which question number it belongs to (or `null` if it can't tell).
5. **Map.** Server-side code (`lib/match.js`) normalizes both sides' question
   numbers (case/whitespace/`Q`-prefix/punctuation insensitive) and joins them.
   Every question ends up `answered` (with one highlight region per page it
   appears on — multi-page answers are supported) or `unanswered`. Any answer the
   model couldn't confidently tie to a known question is kept separately as an
   **unmatched answer** rather than silently dropped or force-matched.
6. **Review.** The teacher gets a question list (with Answered/Unanswered status)
   on the left and the answer sheet on the right. Clicking a question overlays a
   box on the exact answer region(s) and scrolls to it; a toggle switches the right
   panel between the Answer Sheet and the original Question Paper for reference.
   Processing progress streams live (converting → extracting questions →
   extracting answers → mapping) via a newline-delimited JSON response instead of
   a single blocking request.

## Tech stack

- **Next.js 14** (App Router, JavaScript) — chosen per the assignment's
  recommendation. Single Node.js route handler (`app/api/process/route.js`) does
  all processing; no separate backend service.
- **Multi-provider vision extraction with automatic fallback** (`lib/openai.js`):
  primary is **OpenAI GPT-4o** (vision + Structured Outputs, strict JSON schema),
  with **Google Gemini** (`gemini-2.5-flash`) and **Groq** (Llama 4 Maverick,
  vision-capable) as automatic fallbacks. If a provider errors — rate limit,
  outage, malformed response — the next configured one is tried automatically, in
  that order. Gemini/Groq don't get OpenAI's strict schema enforcement, so they're
  given the same JSON shape spelled out in the prompt instead, and their output is
  parsed defensively (markdown-fence stripped, shape-validated) before being
  accepted. Only `OPENAI_API_KEY` is required; `GEMINI_API_KEY`/`GROQ_API_KEY` are
  optional — leave either blank to skip that fallback. Models are all
  configurable via `OPENAI_MODEL` / `GEMINI_MODEL` / `GROQ_MODEL`. The UI's
  processing-progress stream surfaces it when a fallback kicked in (e.g. "OpenAI
  unavailable — used Gemini instead").
- **pdfjs-dist (client-side)** renders/downscales every page to a compressed
  JPEG in the browser before upload — see the fallback rationale above. Pinned
  to the 4.x line rather than the latest major: pdf.js 6.x turned out to rely
  on `Map.prototype.getOrInsertComputed`, a JS engine method that only reached
  Baseline in February 2026, which would silently break the upload for anyone
  not on the very latest browser. 4.10.38 works everywhere evergreen browsers
  are supported. The matching worker file is committed at
  `public/pdfjs/pdf.worker.min.mjs` (same-origin, no CDN dependency/version-
  matching risk).
- **pdf-to-img / pdfjs-dist / @napi-rs/canvas** for server-side PDF → image
  rendering (pure npm install, no Poppler/ImageMagick system dependency, so it
  deploys cleanly to Vercel's serverless functions) — kept as a fallback path
  for direct API use, though the UI never sends raw PDFs anymore.
- No database, no auth — in-memory only, as allowed by the assignment.

## Running locally

```bash
npm install
cp .env.example .env.local   # then fill in OPENAI_API_KEY (and optionally GEMINI_API_KEY / GROQ_API_KEY)
npm run dev
```

Open http://localhost:3000.

`node test/fallback-test.mjs` exercises the fallback control flow in isolation
(provider order, key-skipping, error aggregation) without needing real API
access. `node test/compression-e2e.mjs` (after `python3 test/generate_fixtures.py`)
verifies the client-side compression path in a real browser against a large
synthetic photo and a 6-page PDF.

## Assumptions & limitations

- **Bounding-box accuracy is AI-estimated, not OCR-layout-exact.** GPT-4o is asked
  to return a normalized bounding box for each answer region; this is a strong
  best-effort but is not pixel-perfect the way a dedicated OCR/layout-detection
  model (e.g. Textract, Google Document AI) would be. For production use, a
  hybrid approach (OCR for precise geometry + LLM for semantic matching) would be
  more robust.
- **Question/answer number matching is normalization-based**, not fuzzy/semantic
  matching beyond what the model itself does when reading the answer sheet. Very
  unusual numbering schemes (e.g. a student renumbering questions entirely) may
  end up in "unmatched answers" rather than auto-corrected.
- **Request size.** Everything (page images) is processed and returned in a single
  request/response; very large scanned PDFs (many high-resolution pages) can
  approach Vercel's serverless request body limits. For typical exam-length
  documents (a few pages) this is not an issue.
- **Single in-flight document only** — there's intentionally no session/job
  storage (no DB, per the brief), so a page refresh mid-processing loses progress
  and requires re-uploading.
- **Grading/AI feedback was intentionally left out of scope** for this submission
  (the brief marks it optional) to prioritize getting the core extraction →
  mapping → highlighting flow correct and well-tested first.
- **Groq's vision-capable model accepts at most 5 images per request** at time of
  writing. If it's ever reached as a fallback with a longer document, that call
  will fail and error out (rather than silently truncating pages) — OpenAI and
  Gemini don't have this limitation.
- **Very long documents can still hit the request-size ceiling.** Client-side
  compression (see Tech stack) comfortably covers a normal multi-page exam, but
  an extremely long one, or unusually dense/high-contrast scans that don't
  compress as well, could still exceed Vercel's ~4.5MB request body limit. The
  app checks the total size before uploading and shows a clear error rather
  than the raw platform rejection if that happens.
