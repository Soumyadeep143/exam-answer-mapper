"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { filesToJpegBlobs, totalBlobBytes } from "@/lib/clientConvert";

const STEPS = [
  { key: "preparing", label: "Preparing files in your browser" },
  { key: "converting", label: "Converting uploaded files to page images" },
  { key: "questions", label: "Extracting questions from the question paper" },
  { key: "answers", label: "Reading handwriting on the answer sheet" },
  { key: "mapping", label: "Mapping answers to questions" },
];

// Vercel rejects request bodies over ~4.5MB with a non-JSON error before our
// code ever runs. Pages are compressed client-side first (see
// lib/clientConvert.js) to stay well under that, but a very long document
// can still add up — catch it here with a clear message instead of letting
// the raw platform error reach the user.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export default function Home() {
  const [stage, setStage] = useState("upload"); // upload | progress | viewer
  const [questionFiles, setQuestionFiles] = useState([]);
  const [answerFiles, setAnswerFiles] = useState([]);
  const [activeStep, setActiveStep] = useState(null);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const [selectedQuestionNumber, setSelectedQuestionNumber] = useState(null);
  const [selectedUnmatchedIndex, setSelectedUnmatchedIndex] = useState(null);
  const [rightView, setRightView] = useState("answers"); // "answers" | "questions"

  const pageRefs = useRef({});

  async function handleSubmit(e) {
    e.preventDefault();
    if (!questionFiles.length || !answerFiles.length) return;

    setError(null);
    setCompletedSteps([]);
    setActiveStep("preparing");
    setStage("progress");

    try {
      const [questionBlobs, answerBlobs] = await Promise.all([
        filesToJpegBlobs(questionFiles),
        filesToJpegBlobs(answerFiles),
      ]);

      const totalBytes = totalBlobBytes([questionBlobs, answerBlobs]);
      if (totalBytes > MAX_UPLOAD_BYTES) {
        throw new Error(
          `These files are too large even after compression (${(
            totalBytes /
            1024 /
            1024
          ).toFixed(1)}MB). Try fewer pages per upload, or lower-resolution scans/photos.`
        );
      }

      setCompletedSteps(["preparing"]);
      setActiveStep(STEPS[1].key);

      const formData = new FormData();
      questionBlobs.forEach((blob, i) =>
        formData.append("questionPaper", blob, `question-${i}.jpg`)
      );
      answerBlobs.forEach((blob, i) =>
        formData.append("answerSheet", blob, `answer-${i}.jpg`)
      );

      const res = await fetch("/api/process", { method: "POST", body: formData });
      if (!res.body) throw new Error("No response body from server.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const parseLine = (line) => {
        try {
          return JSON.parse(line);
        } catch {
          // The server always streams ndjson; anything else means a proxy/
          // platform in front of it rejected the request outright (e.g. a
          // plain-text "Request Entity Too Large") before our code ran.
          throw new Error(
            res.ok
              ? "The server sent back something unexpected. Please try again."
              : `Upload rejected (HTTP ${res.status}): ${line.slice(0, 200)}`
          );
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          handleEvent(parseLine(line));
        }
      }
      if (buffer.trim()) handleEvent(parseLine(buffer));
    } catch (err) {
      console.error(err);
      setError(err.message || "Something went wrong while processing.");
      setStage("upload");
    }
  }

  function handleEvent(event) {
    if (event.type === "status") {
      setCompletedSteps((prev) =>
        prev.includes(event.step) ? prev : [...prev, event.step]
      );
      setActiveStep(event.step);
    } else if (event.type === "result") {
      setResult(event.data);
      setCompletedSteps(STEPS.map((s) => s.key));
      setStage("viewer");
    } else if (event.type === "error") {
      setError(event.message);
      setStage("upload");
    }
  }

  function reset() {
    setStage("upload");
    setQuestionFiles([]);
    setAnswerFiles([]);
    setResult(null);
    setSelectedQuestionNumber(null);
    setSelectedUnmatchedIndex(null);
    setError(null);
  }

  const selectedQuestion = useMemo(
    () =>
      result?.questions.find((q) => q.number === selectedQuestionNumber) ??
      null,
    [result, selectedQuestionNumber]
  );

  const selectedUnmatched =
    result && selectedUnmatchedIndex != null
      ? result.unmatchedAnswers[selectedUnmatchedIndex]
      : null;

  useEffect(() => {
    const firstPage =
      selectedQuestion?.regions?.[0]?.page ?? selectedUnmatched?.page ?? null;
    if (firstPage != null && pageRefs.current[firstPage]) {
      pageRefs.current[firstPage].scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [selectedQuestion, selectedUnmatched]);

  function selectQuestion(number) {
    setSelectedUnmatchedIndex(null);
    setSelectedQuestionNumber((prev) => (prev === number ? null : number));
    setRightView("answers");
  }

  function selectUnmatched(idx) {
    setSelectedQuestionNumber(null);
    setSelectedUnmatchedIndex((prev) => (prev === idx ? null : idx));
    setRightView("answers");
  }

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>Answer Mapper</h1>
          <div className="subtitle">
            Question extraction &middot; answer extraction &middot; answer mapping
          </div>
        </div>
        {stage === "viewer" && (
          <button className="btn" onClick={reset}>
            Start over
          </button>
        )}
      </div>

      {stage === "upload" && (
        <UploadScreen
          questionFiles={questionFiles}
          answerFiles={answerFiles}
          setQuestionFiles={setQuestionFiles}
          setAnswerFiles={setAnswerFiles}
          onSubmit={handleSubmit}
          error={error}
        />
      )}

      {stage === "progress" && (
        <ProgressScreen activeStep={activeStep} completedSteps={completedSteps} />
      )}

      {stage === "viewer" && result && (
        <div className="viewer">
          <div className="panel questions-panel">
            <div className="panel-heading">Questions ({result.questions.length})</div>
            {result.questions.map((q) => (
              <QuestionCard
                key={q.number}
                question={q}
                selected={q.number === selectedQuestionNumber}
                onClick={() => selectQuestion(q.number)}
              />
            ))}

            {result.unmatchedAnswers.length > 0 && (
              <>
                <div className="panel-heading">
                  Unmatched answers ({result.unmatchedAnswers.length})
                </div>
                {result.unmatchedAnswers.map((a, idx) => (
                  <div
                    key={idx}
                    className={`question-card ${
                      selectedUnmatchedIndex === idx ? "selected" : ""
                    }`}
                    onClick={() => selectUnmatched(idx)}
                  >
                    <div className="qrow">
                      <div className="qnum-badge">?</div>
                      <div className="qbody">
                        <div className="qnum">Page {a.page + 1}</div>
                        <div className="qtext">{a.transcription}</div>
                        <span className="badge unmatched">Unmatched</span>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="panel answers-panel">
            <div className="view-toggle">
              <button
                className={rightView === "questions" ? "active" : ""}
                onClick={() => setRightView("questions")}
              >
                Question Paper
              </button>
              <button
                className={rightView === "answers" ? "active" : ""}
                onClick={() => setRightView("answers")}
              >
                Answer Sheet
              </button>
            </div>

            {rightView === "questions" &&
              result.questionPages.map((page) => (
                <div key={page.pageIndex} className="page-frame">
                  <span className="page-label">Page {page.pageIndex + 1}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.dataUrl}
                    alt={`Question paper page ${page.pageIndex + 1}`}
                  />
                </div>
              ))}

            {rightView === "answers" &&
              result.answerPages.map((page) => {
              const regionsHere = (selectedQuestion?.regions ?? []).filter(
                (r) => r.page === page.pageIndex
              );
              const unmatchedHere =
                selectedUnmatched && selectedUnmatched.page === page.pageIndex
                  ? [selectedUnmatched]
                  : [];

              return (
                <div
                  key={page.pageIndex}
                  className="page-frame"
                  ref={(el) => (pageRefs.current[page.pageIndex] = el)}
                >
                  <span className="page-label">Page {page.pageIndex + 1}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={page.dataUrl} alt={`Answer sheet page ${page.pageIndex + 1}`} />
                  {regionsHere.map((r, i) => (
                    <div
                      key={`q-${i}`}
                      className="highlight-box"
                      style={{
                        left: `${r.bbox.x * 100}%`,
                        top: `${r.bbox.y * 100}%`,
                        width: `${r.bbox.width * 100}%`,
                        height: `${r.bbox.height * 100}%`,
                      }}
                    />
                  ))}
                  {unmatchedHere.map((r, i) => (
                    <div
                      key={`u-${i}`}
                      className="highlight-box unmatched"
                      style={{
                        left: `${r.bbox.x * 100}%`,
                        top: `${r.bbox.y * 100}%`,
                        width: `${r.bbox.width * 100}%`,
                        height: `${r.bbox.height * 100}%`,
                      }}
                    />
                  ))}
                </div>
              );
            })}

            {rightView === "answers" &&
              selectedQuestion &&
              selectedQuestion.status === "unanswered" && (
              <div className="empty-state">
                No answer found for question {selectedQuestion.number}.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ question, selected, onClick }) {
  return (
    <div className={`question-card ${selected ? "selected" : ""}`} onClick={onClick}>
      <div className="qrow">
        <div className="qnum-badge">{question.number}</div>
        <div className="qbody">
          <div className="qtext">{question.text}</div>
          <span className={`badge ${question.status}`}>
            {question.status === "answered" ? "Answered" : "Unanswered"}
          </span>
        </div>
      </div>
    </div>
  );
}

function UploadScreen({
  questionFiles,
  answerFiles,
  setQuestionFiles,
  setAnswerFiles,
  onSubmit,
  error,
}) {
  return (
    <div className="upload-screen">
      <form className="upload-card" onSubmit={onSubmit}>
        <h2>Upload the question paper and an answer sheet</h2>
        <p>
          PDF or images. Sub-parts like 11(a)/11(b) are extracted as separate
          questions and matched to the student&apos;s handwritten answers.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <div className="dropzones">
          <FilePicker
            label="Question paper"
            hint="PDF or image(s), correct order"
            files={questionFiles}
            onChange={setQuestionFiles}
          />
          <FilePicker
            label="Student answer sheet"
            hint="PDF or image(s), correct order"
            files={answerFiles}
            onChange={setAnswerFiles}
          />
        </div>

        <div className="upload-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!questionFiles.length || !answerFiles.length}
          >
            Process
          </button>
        </div>
      </form>
    </div>
  );
}

function FilePicker({ label, hint, files, onChange }) {
  const inputRef = useRef(null);
  return (
    <div
      className={`dropzone ${files.length ? "has-files" : ""}`}
      onClick={() => inputRef.current?.click()}
    >
      <div className="label">{label}</div>
      <div className="hint">{files.length ? `${files.length} file(s) selected` : hint}</div>
      {files.length > 0 && (
        <div className="filelist">
          {files.map((f, i) => (
            <div key={i}>{f.name}</div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*"
        multiple
        hidden
        onChange={(e) => onChange(Array.from(e.target.files || []))}
      />
    </div>
  );
}

function ProgressScreen({ activeStep, completedSteps }) {
  return (
    <div className="progress-screen">
      <div className="progress-card">
        {STEPS.map((step) => {
          const isDone = completedSteps.includes(step.key) && step.key !== activeStep;
          const isActive = step.key === activeStep;
          return (
            <div
              key={step.key}
              className={`progress-step ${isActive ? "active" : ""} ${
                isDone ? "done" : ""
              }`}
            >
              <span className="progress-dot" />
              {step.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
