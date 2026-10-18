const directions = ['left', 'center', 'right'];

/** Post-shot presentation only. Ground truth never changes a model decision. */
export function predictionResult(commit, evaluation, mediaTime) {
  if (!evaluation || !Number.isFinite(evaluation.visibleAtSeconds) || !Number.isFinite(mediaTime) || mediaTime < evaluation.visibleAtSeconds) return null;
  if (evaluation.kind === 'off-target') return Object.freeze({ type: 'unscored', label: 'Off target · unscored' });
  if (evaluation.kind === 'unclear') {
    const possibleZones = [...new Set(evaluation.possibleZones ?? [])].filter(zone => directions.includes(zone));
    // A boundary can leave two destinations plausible while still ruling out
    // the third. Excluding the chosen side is enough for a definite failure;
    // choosing either plausible side cannot establish a successful prediction.
    if (commit && directions.includes(commit.direction) && possibleZones.length > 0
        && possibleZones.length < directions.length && !possibleZones.includes(commit.direction)) {
      return Object.freeze({ type: 'wrong', correct: false, directionCorrect: false,
        predictedZone: commit.direction, actualZone: null, possibleZones: Object.freeze(possibleZones),
        late: commit.timing !== 'ready', label: 'Wrong direction' });
    }
    return Object.freeze({ type: 'unscored', label: 'Direction unclear · unscored' });
  }
  if (!commit || !directions.includes(commit.direction) || !directions.includes(evaluation.zone)) return null;
  const directionCorrect = commit.direction === evaluation.zone;
  const late = commit.timing !== 'ready';
  const correct = directionCorrect && !late;
  return Object.freeze({
    type: correct ? 'correct' : 'wrong', correct, directionCorrect,
    predictedZone: commit.direction, actualZone: evaluation.zone,
    late,
    label: correct ? 'Correct direction before the kick' : directionCorrect ? 'Correct direction, but late' : 'Wrong direction',
  });
}
