/**
 * Small timer-free shot sequence. Keep the generation returned by start() when
 * scheduling advance(token); stop() and a new start() invalidate old callbacks.
 * Each frozen snapshot exposes the current caller-owned penalty metadata.
 */
export function createSequence(penalties) {
  if (!Array.isArray(penalties) || penalties.length === 0
      || penalties.some(penalty => !penalty || typeof penalty !== 'object' || Array.isArray(penalty))) {
    throw new TypeError('A sequence needs a non-empty array of penalty objects.');
  }
  const shots = [...penalties];
  const snapshot = (index, generation, active, completed) => Object.freeze({
    index, generation, active, completed, current: shots[index], total: shots.length,
  });
  let state = snapshot(0, 0, false, false);

  return Object.freeze({
    get state() { return state; },
    // Starting, including replaying a completed sequence, begins at shot one.
    start() {
      state = snapshot(0, state.generation + 1, true, false);
      return state;
    },
    stop() {
      state = snapshot(state.index, state.generation + 1, false, false);
      return state;
    },
    advance(token) {
      if (!state.active || token !== state.generation) return state;
      state = state.index + 1 < shots.length
        ? snapshot(state.index + 1, state.generation, true, false)
        : snapshot(state.index, state.generation, false, true);
      return state;
    },
  });
}
