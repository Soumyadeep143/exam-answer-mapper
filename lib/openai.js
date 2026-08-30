import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";

// ---------------------------------------------------------------------------
// Multi-provider vision extraction with automatic fallback.
//
// Primary: OpenAI (GPT-4o) using Structured Outputs (strict JSON schema).
// Fallback 1: Google Gemini (gemini-2.5-flash).
// Fallback 2: Groq (Llama 4 Maverick, vision-capable).
//
// Gemini/Groq don't get OpenAI's strict schema enforcement here, so they're
// instead given a precise text description of the required JSON shape and
// their output is parsed defensively (markdown-fence stripped, shape
// validated) before being accepted.
//
// A provider is only attempted if its API key is configured, so this keeps
// working with just OPENAI_API_KEY set. If a provider errors (rate limit,
// outage, bad response, missing key) the next one is tried automatically.
// ---------------------------------------------------------------------------

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

let geminiClient = null;
function getGemini() {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

let groqClient = null;
function getGroq() {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

const QUESTIONS_SCHEMA = {
  name: "question_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            number: {
              type: "string",
              description:
                'Question number/label EXACTLY as printed, e.g. "1", "11(a)", "Q4".',
            },
            text: {
              type: "string",
              description: "Full text of the question, as printed.",
            },
            page: {
              type: "integer",
              description:
                "0-based index into the list of question-paper images this question appears on.",
            },
          },
          required: ["number", "text", "page"],
        },
      },
    },
    required: ["questions"],
  },
};

const ANSWERS_SCHEMA = {
  name: "answer_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            matchedQuestionNumber: {
              type: ["string", "null"],
              description:
                "Best guess of which question number (from the provided list) this handwritten answer belongs to, normalized to match that list exactly. Null if unclear or if it doesn't correspond to any known question.",
            },
            transcription: {
              type: "string",
              description:
                "Best-effort transcription of the handwritten answer text in this region.",
            },
            page: {
              type: "integer",
              description:
                "0-based index into the list of answer-sheet images this region is on.",
            },
            bbox: {
              type: "object",
              additionalProperties: false,
              description:
                "Bounding box of this answer's region, as fractions (0-1) of the page image, origin top-left.",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
              required: ["x", "y", "width", "height"],
            },
            confidence: {
              type: "number",
              description: "0-1 confidence that the region/match is correct.",
            },
          },
          required: [
            "matchedQuestionNumber",
            "transcription",
            "page",
            "bbox",
            "confidence",
          ],
        },
      },
    },
    required: ["answers"],
  },
};

// Text description of the same two shapes, for providers that don't get
// strict-schema enforcement (Gemini, Groq).
const QUESTIONS_JSON_SHAPE = `{"questions": [{"number": "<string, exact printed label>", "text": "<string>", "page": <integer, 0-based>}]}`;
const ANSWERS_JSON_SHAPE = `{"answers": [{"matchedQuestionNumber": "<string or null>", "transcription": "<string>", "page": <integer, 0-based>, "bbox": {"x": <0-1>, "y": <0-1>, "width": <0-1>, "height": <0-1>}, "confidence": <0-1>}]}`;

function imagesToOpenAIContent(pages, label) {
  const content = [];
  pages.forEach((page, i) => {
    content.push({ type: "text", text: `${label} ${i}:` });
    content.push({
      type: "image_url",
      image_url: { url: page.dataUrl, detail: "high" },
    });
  });
  return content;
}

function base64FromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

// Some models wrap JSON in ```json fences or add stray whitespace/text
// despite being asked not to. Strip fences and parse defensively.
function extractJsonObject(text) {
  if (!text) throw new Error("Empty response body");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice =
    start !== -1 && end !== -1 ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice.trim());
}

function requireArray(parsed, resultKey, providerName) {
  if (!parsed || !Array.isArray(parsed[resultKey])) {
    throw new Error(
      `${providerName} response did not contain a "${resultKey}" array`
    );
  }
  return parsed[resultKey];
}

async function callOpenAIVision({ systemPrompt, pages, label, schema, resultKey }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const openai = getOpenAI();
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: imagesToOpenAIContent(pages, label) },
    ],
    response_format: { type: "json_schema", json_schema: schema },
  });
  const parsed = JSON.parse(response.choices[0].message.content);
  return requireArray(parsed, resultKey, "OpenAI");
}

async function callGeminiVision({ systemPrompt, jsonShape, pages, label, resultKey }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const gemini = getGemini();
  const parts = [];
  pages.forEach((page, i) => {
    parts.push({ text: `${label} ${i}:` });
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: base64FromDataUrl(page.dataUrl) },
    });
  });
  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: `${systemPrompt}\n\nRespond with ONLY a single JSON object (no markdown fences, no commentary) of exactly this shape:\n${jsonShape}`,
      responseMimeType: "application/json",
    },
  });
  const text = typeof response.text === "function" ? response.text() : response.text;
  const parsed = extractJsonObject(text);
  return requireArray(parsed, resultKey, "Gemini");
}

async function callGroqVision({ systemPrompt, jsonShape, pages, label, resultKey }) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
  const groq = getGroq();
  const content = [
    {
      type: "text",
      text: `Respond with ONLY a single JSON object (no markdown fences, no commentary) of exactly this shape:\n${jsonShape}`,
    },
  ];
  pages.forEach((page, i) => {
    content.push({ type: "text", text: `${label} ${i}:` });
    content.push({ type: "image_url", image_url: { url: page.dataUrl } });
  });
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
  });
  const text = completion.choices[0].message.content;
  const parsed = extractJsonObject(text);
  return requireArray(parsed, resultKey, "Groq");
}

// Tries each configured provider in order (OpenAI -> Gemini -> Groq),
// returning the first one that succeeds. Providers without an API key set
// are skipped entirely. If every configured provider fails, throws an error
// that lists what each one said.
async function withProviderFallback(runners, onProvider) {
  const providers = [
    { name: "OpenAI", enabled: !!process.env.OPENAI_API_KEY, run: runners.openai },
    { name: "Gemini", enabled: !!process.env.GEMINI_API_KEY, run: runners.gemini },
    { name: "Groq", enabled: !!process.env.GROQ_API_KEY, run: runners.groq },
  ].filter((p) => p.enabled);

  if (!providers.length) {
    throw new Error(
      "No AI provider is configured. Set OPENAI_API_KEY, GEMINI_API_KEY, and/or GROQ_API_KEY."
    );
  }

  const errors = [];
  for (const provider of providers) {
    try {
      const result = await provider.run();
      if (onProvider) onProvider(provider.name, errors.slice());
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`[llm fallback] ${provider.name} failed: ${message}`);
      errors.push(`${provider.name}: ${message}`);
    }
  }
  throw new Error(`All configured AI providers failed — ${errors.join(" | ")}`);
}

export async function extractQuestions(questionPages, { onProvider } = {}) {
  // Lets the full upload -> extract -> map -> highlight pipeline be
  // exercised end-to-end (incl. e2e tests in /test) without spending API
  // credits. Never set in production.
  if (process.env.MOCK_OPENAI === "1") {
    return [
      { number: "1", text: "What is the capital of France?", page: 0 },
      { number: "2(a)", text: "Name a river in France.", page: 0 },
      { number: "2(b)", text: "Name a mountain range in France.", page: 0 },
    ];
  }

  const systemPrompt = `You are an exam paper parser. You will be shown every page of a printed question paper, in order.
Extract every question in the exact order they appear on the page(s).
Rules:
- Preserve the original numbering exactly as printed (e.g. "1", "2.", "Q3", "11(a)").
- Treat labelled sub-parts as SEPARATE entries. For example "11(a)" and "11(b)" must be two separate questions, not one "11" entry.
- Keep the printed order (top-to-bottom, left-to-right, across pages in the order given).
- Include the full question text.
- "page" is the 0-based index of the image (in the order provided) the question appears on.`;

  return withProviderFallback(
    {
      openai: () =>
        callOpenAIVision({
          systemPrompt,
          pages: questionPages,
          label: "Question paper page",
          schema: QUESTIONS_SCHEMA,
          resultKey: "questions",
        }),
      gemini: () =>
        callGeminiVision({
          systemPrompt,
          jsonShape: QUESTIONS_JSON_SHAPE,
          pages: questionPages,
          label: "Question paper page",
          resultKey: "questions",
        }),
      groq: () =>
        callGroqVision({
          systemPrompt,
          jsonShape: QUESTIONS_JSON_SHAPE,
          pages: questionPages,
          label: "Question paper page",
          resultKey: "questions",
        }),
    },
    onProvider
  );
}

export async function extractAnswers(
  answerPages,
  knownQuestionNumbers,
  { onProvider } = {}
) {
  if (process.env.MOCK_OPENAI === "1") {
    return [
      {
        matchedQuestionNumber: "1",
        transcription: "Paris",
        page: 0,
        bbox: { x: 0.12, y: 0.42, width: 0.3, height: 0.05 },
        confidence: 0.9,
      },
      {
        matchedQuestionNumber: "2(a)",
        transcription: "The Seine",
        page: 0,
        bbox: { x: 0.12, y: 0.5, width: 0.3, height: 0.05 },
        confidence: 0.85,
      },
      {
        matchedQuestionNumber: null,
        transcription: "extra scribble in the margin",
        page: 0,
        bbox: { x: 0.6, y: 0.8, width: 0.25, height: 0.04 },
        confidence: 0.4,
      },
    ];
  }

  const systemPrompt = `You are an exam answer-sheet parser. You will be shown every page of a student's handwritten answer sheet, in order.
The question paper contains exactly these question numbers, in this order: ${JSON.stringify(
    knownQuestionNumbers
  )}.

For every distinct answer region you can identify on the answer sheet:
- Read any question number the student wrote next to/above their answer, and match it to the closest entry in the known question number list above (normalize formatting differences like "11 a", "11a)", "Q11(a)" -> "11(a)"). If you cannot confidently match it to any known question, set matchedQuestionNumber to null.
- Transcribe the handwriting as best you can.
- Give the bounding box of ONLY that answer's handwritten region (not the whole page), as fractions of the image (0-1, origin top-left).
- If a single answer continues across multiple pages, output one entry per page (same matchedQuestionNumber, one bbox per page).
- If the student answered questions out of order, that's fine — just report what you see, in the order it appears on the page.
- "page" is the 0-based index of the image (in the order provided) the answer appears on.`;

  return withProviderFallback(
    {
      openai: () =>
        callOpenAIVision({
          systemPrompt,
          pages: answerPages,
          label: "Answer sheet page",
          schema: ANSWERS_SCHEMA,
          resultKey: "answers",
        }),
      gemini: () =>
        callGeminiVision({
          systemPrompt,
          jsonShape: ANSWERS_JSON_SHAPE,
          pages: answerPages,
          label: "Answer sheet page",
          resultKey: "answers",
        }),
      groq: () =>
        callGroqVision({
          systemPrompt,
          jsonShape: ANSWERS_JSON_SHAPE,
          pages: answerPages,
          label: "Answer sheet page",
          resultKey: "answers",
        }),
    },
    onProvider
  );
}
