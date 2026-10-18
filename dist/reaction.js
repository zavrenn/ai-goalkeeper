const DIRECTIONS = new Set(['left', 'center', 'right']);

/** Start a fresh run. A new instance also discards any stopped run's commitment. */
export function createReactionState(mode = 'ai') {
  if (mode !== 'ai' && mode !== 'preview') throw new TypeError('Unknown reaction mode.');
  return Object.freeze({ mode, contactAt: null, commit: null });
}

function snapshotDecision(record) {
  const decision = { ...record };
  if (Array.isArray(record.probabilities)) {
    decision.probabilities = Object.freeze(record.probabilities.map(option => Object.freeze({ ...option })));
  }
  return Object.freeze(decision);
}

/**
 * Pure reducer: pass this run's complete records and the current performance.now().
 * Supply contactAt once playback reaches contact, using that same monotonic clock.
 * A commit starts at contact if a choice was ready, or at the first late receipt.
 * Callers trigger animation only when commit changes from null to an object; use
 * now - commit.triggerAt to catch up if a browser callback was delayed.
 */
export function updateReaction(state, { records = [], contactAt = state.contactAt, now } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('A finite current timestamp is required.');
  if (contactAt !== null && !Number.isFinite(contactAt)) throw new TypeError('Contact must use a finite timestamp.');
  if (!Array.isArray(records)) throw new TypeError('Reaction records must be an array.');
  if (state.commit) return state;

  // Keep the first measured contact time; later replies cannot move the kick.
  const kickAt = state.contactAt ?? contactAt;
  const next = kickAt === state.contactAt ? state : Object.freeze({ ...state, contactAt: kickAt });
  if (state.mode === 'preview' || kickAt === null || now < kickAt) return next;

  let ready = null;
  let late = null;
  for (const record of records) {
    if (record.type !== 'choice' || !DIRECTIONS.has(record.choice)
        || !Number.isFinite(record.receivedAt) || record.receivedAt > now) continue;
    if (record.receivedAt <= kickAt) {
      if (!ready || record.receivedAt >= ready.receivedAt) ready = record;
    } else if (!late || record.receivedAt < late.receivedAt) late = record;
  }

  const decision = ready ?? late;
  if (!decision) return next;
  const commit = Object.freeze({
    direction: decision.choice,
    timing: ready ? 'ready' : 'late',
    contactAt: kickAt,
    receivedAt: decision.receivedAt,
    triggerAt: ready ? kickAt : decision.receivedAt,
    delayMs: ready ? 0 : decision.receivedAt - kickAt,
    receivedOffsetMs: decision.receivedAt - kickAt,
    decision: snapshotDecision(decision),
  });
  return Object.freeze({ ...next, commit });
}
