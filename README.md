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
2. **Convert to page images.** PDFs are rasterized server-side to JPEG page images
   (`pdf-to-img`, backed by `pdfjs-dist` + `@napi-rs/canvas`, so no native/system
   dependency is required — it installs cleanly on Vercel). Plain image uploads are
   used as-is. These are the *same* images shown in the UI and sent to the model, so
   any bounding box the model returns lines up with what the teacher sees.
3. **Extract questions.** All question-paper page images are sent to GPT-4o in one
   call with a strict JSON schema (OpenAI Structured Outputs). The model is
   instructed to preserve the exact printed numbering and to treat labelled
   sub-parts (e.g. `11(a)` / `11(b)`) as separate questions, in printed order.
4. **Extract answers.** All answer-sheet page images are sent to GPT-4o in a second
   call, along with the list of known question numbers from step 3. For every
   handwritten answer region the model transcribes the text, gives a normalized
   bounding box (fraction of the page image, top-left origin), and its best guess
   at which question number it belongs to (or `null` if it can't tell).
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
- **OpenAI GPT-4o** (vision + Structured Outputs) for both extraction steps —
  configurable via `OPENAI_MODEL` (e.g. swap to `gpt-4o-mini` for lower cost).
- **pdf-to-img / pdfjs-dist / @napi-rs/canvas** for PDF → image rendering
  (pure npm install, no Poppler/ImageMagick system dependency, so it deploys
  cleanly to Vercel's serverless functions).
- No database, no auth — in-memory only, as allowed by the assignment.

## Running locally

```bash
npm install
cp .env.example .env.local   # then fill in OPENAI_API_KEY
npm run dev
```

Open http://localhost:3000.

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
