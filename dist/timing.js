export function canCaptureFrame(mediaTime, currentTime, penalty) {
  return Number.isFinite(mediaTime) && Number.isFinite(currentTime)
    && mediaTime >= penalty.runUpStartSeconds
    && mediaTime <= penalty.latestConfirmedPreContactFrameSeconds + 0.000001
    && currentTime < penalty.kickTimeEstimateSeconds;
}

export function latestAnswerAtContact(records, contactAt) {
  return records.filter(record => record.type === 'choice' && record.receivedAt <= contactAt)
    .sort((a, b) => a.receivedAt - b.receivedAt).at(-1) ?? null;
}

export function contactOffsetMs(receivedAt, contactAt) {
  return Number.isFinite(contactAt) ? receivedAt - contactAt : null;
}
