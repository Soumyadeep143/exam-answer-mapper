import OpenAI from "openai";

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to your environment variables."
      );
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

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

function imagesToContent(pages, label) {
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

export async function extractQuestions(questionPages) {
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
  const openai = getClient();
  const systemPrompt = `You are an exam paper parser. You will be shown every page of a printed question paper, in order.
Extract every question in the exact order they appear on the page(s).
Rules:
- Preserve the original numbering exactly as printed (e.g. "1", "2.", "Q3", "11(a)").
- Treat labelled sub-parts as SEPARATE entries. For example "11(a)" and "11(b)" must be two separate questions, not one "11" entry.
- Keep the printed order (top-to-bottom, left-to-right, across pages in the order given).
- Include the full question text.
- "page" is the 0-based index of the image (in the order provided) the question appears on.`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: imagesToContent(questionPages, "Question paper page"),
      },
    ],
    response_format: { type: "json_schema", json_schema: QUESTIONS_SCHEMA },
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  return parsed.questions;
}

export async function extractAnswers(answerPages, knownQuestionNumbers) {
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
  const openai = getClient();
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

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: imagesToContent(answerPages, "Answer sheet page"),
      },
    ],
    response_format: { type: "json_schema", json_schema: ANSWERS_SCHEMA },
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  return parsed.answers;
}
