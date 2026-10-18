const directions = ['left', 'center', 'right'];

/** Post-shot presentation only. Ground truth never changes a model decision. */
export function predictionResult(commit, evaluation, mediaTime) {
  if (!evaluation || !Number.isFinite(evaluation.visibleAtSeconds) || !Number.isFinite(mediaTime) || mediaTime < evaluation.visibleAtSeconds) return null;
  if (evaluation.kind === 'off-target') return Object.freeze({ type: 'unscored', label: 'Off target · unscored' });
  if (evaluation.kind === 'unclear') return Object.freeze({ type: 'unscored', label: 'Direction unclear · unscored' });
  if (!commit || !directions.includes(commit.direction) || !directions.includes(evaluation.zone)) return null;
  const correct = commit.direction === evaluation.zone;
  return Object.freeze({
    type: correct ? 'correct' : 'wrong', correct,
    predictedZone: commit.direction, actualZone: evaluation.zone,
    late: commit.timing === 'late',
    label: `${correct ? 'Correct prediction' : 'Wrong prediction'}${commit.timing === 'late' ? ' · late' : ''}`,
  });
}
