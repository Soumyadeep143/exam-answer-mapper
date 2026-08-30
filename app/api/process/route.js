import { filesToPageImages } from "@/lib/pdf";
import { extractQuestions, extractAnswers } from "@/lib/openai";
import { mapAnswersToQuestions } from "@/lib/match";

export const runtime = "nodejs";
export const maxDuration = 60;

// Streams newline-delimited JSON progress events, then a final "result"
// event, so the UI can show real processing progress. Nothing is persisted
// server-side — everything lives only for the lifetime of this request (no
// DB, per the assignment's constraints).
export async function POST(request) {
  const formData = await request.formData();
  const questionFiles = formData.getAll("questionPaper");
  const answerFiles = formData.getAll("answerSheet");

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        if (!questionFiles.length || !answerFiles.length) {
          send({
            type: "error",
            message: "Both a question paper and an answer sheet are required.",
          });
          return;
        }

        send({
          step: "converting",
          type: "status",
          message: "Converting uploaded files to page images...",
        });
        const [questionPages, answerPages] = await Promise.all([
          filesToPageImages(questionFiles),
          filesToPageImages(answerFiles),
        ]);

        send({
          step: "questions",
          type: "status",
          message: `Extracting questions from ${questionPages.length} page(s)...`,
        });
        const questions = await extractQuestions(questionPages);

        send({
          step: "answers",
          type: "status",
          message: `Reading handwriting on ${answerPages.length} page(s)...`,
        });
        const knownNumbers = questions.map((q) => q.number);
        const answers = await extractAnswers(answerPages, knownNumbers);

        send({
          step: "mapping",
          type: "status",
          message: "Mapping answers to questions...",
        });
        const { questions: mappedQuestions, unmatchedAnswers } =
          mapAnswersToQuestions(questions, answers);

        const toClientPage = (p) => ({
          pageIndex: p.pageIndex,
          dataUrl: p.dataUrl,
          width: p.width,
          height: p.height,
        });

        send({
          type: "result",
          data: {
            questionPages: questionPages.map(toClientPage),
            answerPages: answerPages.map(toClientPage),
            questions: mappedQuestions,
            unmatchedAnswers,
          },
        });
      } catch (err) {
        console.error("Processing failed:", err);
        send({ type: "error", message: err.message || "Processing failed." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
