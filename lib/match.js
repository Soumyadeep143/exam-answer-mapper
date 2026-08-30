function normalize(num) {
  return String(num ?? "")
    .toLowerCase()
    .replace(/^q\.?\s*/i, "")
    .replace(/[\s.()]/g, "")
    .trim();
}

/**
 * Combines extracted questions + extracted answers into the final,
 * UI-ready mapping:
 *  - every question gets a status (answered/unanswered) and a list of
 *    highlight regions (one per page it's answered on, supports
 *    multi-page answers)
 *  - answers that couldn't be matched to any known question are
 *    returned separately as unmatchedAnswers
 */
export function mapAnswersToQuestions(questions, answers) {
  const canonicalByKey = new Map();
  questions.forEach((q) => {
    canonicalByKey.set(normalize(q.number), q.number);
  });

  const questionMap = new Map(
    questions.map((q) => [
      q.number,
      { ...q, status: "unanswered", regions: [] },
    ])
  );

  const unmatchedAnswers = [];

  for (const a of answers) {
    const key = a.matchedQuestionNumber ? normalize(a.matchedQuestionNumber) : null;
    const canonicalNumber = key ? canonicalByKey.get(key) : undefined;

    if (canonicalNumber && questionMap.has(canonicalNumber)) {
      const q = questionMap.get(canonicalNumber);
      q.status = "answered";
      q.regions.push({
        page: a.page,
        bbox: a.bbox,
        transcription: a.transcription,
        confidence: a.confidence,
      });
    } else {
      unmatchedAnswers.push(a);
    }
  }

  for (const q of questionMap.values()) {
    q.regions.sort((r1, r2) => r1.page - r2.page);
  }

  return {
    questions: Array.from(questionMap.values()),
    unmatchedAnswers,
  };
}
