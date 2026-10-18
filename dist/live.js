import { canCaptureFrame, contactOffsetMs } from './timing.js';
import { createReactionState, updateReaction } from './reaction.js';
import { createGoalScene } from './goal-scene.js';
import { createSequence } from './playlist.js';
import { predictionResult } from './prediction-result.js';
import { COMPLAINT_SECONDS } from './keeper-motion.js';

const $ = id => document.getElementById(id);
const video = $('video');
const crop = $('cropCanvas');
const cropContext = crop.getContext('2d', { alpha: false });
const directions = ['left', 'center', 'right'];
const capitalize = value => value.charAt(0).toUpperCase() + value.slice(1);
const ms = value => Number.isFinite(value) ? String(Math.round(value)) : '—';
let config, keeper, currentRun, frameHandle, animationHandle, sequence, requestOwner;
let sequenceRuns = [];
let videoReady = false, keyReady = false, keeperReady = false, runNumber = 0;

function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function isCurrent(run) { return currentRun === run && !run.cancelled && run.generation === sequence?.state.generation; }
function isActive() { return sequence?.state.active ?? false; }
function canRun() { return videoReady && keeperReady && keyReady && !isActive() && 'requestVideoFrameCallback' in video; }
function notice(message = '') { text('notice', message); $('notice').hidden = !message; }
function badge(value, style = '') { text('liveState', value); $('liveBadge').className = `live-badge ${style}`; }

function updateControls() {
  const active = isActive();
  $('runButton').disabled = !canRun();
  $('runButton').innerHTML = !videoReady || !keeperReady ? 'Loading…' : active ? 'Playing…' : currentRun ? '<span aria-hidden="true">↻</span> Play again' : '<span aria-hidden="true">▶</span> Play';
  $('previewButton').disabled = !videoReady || !keeperReady || active;
  $('stopButton').hidden = !active;
  $('connectButton').disabled = active;
  $('apiKey').disabled = active;
  text('keyStatus', keyReady ? 'API key ready' : 'Add an OpenAI API key');
  $('keyDot').classList.toggle('ready', keyReady);
  if (!currentRun && videoReady && keeperReady) {
    badge('READY');
    text('runStatus', keyReady ? 'Ready for a live run.' : 'Add a key in Setup, or preview the video.');
  }
}

function drawCrop(run = currentRun) {
  if (!config || video.readyState < 2) return;
  const { x, y, width, height } = run?.crop ?? sequence?.state.current.crop ?? config.crop;
  cropContext.drawImage(video, x, y, width, height, 0, 0, crop.width, crop.height);
}

function latency(value) {
  $('responseTime').hidden = !Number.isFinite(value);
  $('latencyValue').replaceChildren(document.createTextNode(ms(value)), Object.assign(document.createElement('small'), { textContent: ' ms' }));
}

function showDecision(record, locked = false) {
  const probabilities = Object.fromEntries(record.probabilities.map(option => [option.value, option.probability]));
  for (const direction of directions) {
    $(`prob-${direction}`).replaceChildren(document.createTextNode(String(Math.round(probabilities[direction] * 100))), Object.assign(document.createElement('small'), { textContent: '%' }));
    $(`zone-${direction}`).classList.toggle('selected', record.choice === direction);
    $(`zone-${direction}`).classList.toggle('locked', locked && record.choice === direction);
  }
  keeper.setProbabilities(probabilities);
  keeper.highlight(record.choice);
  latency(record.totalMs);
}

function resetDisplay(mode) {
  notice(); keeper.reset(); latency(null);
  $('predictionResult').hidden = true;
  $('predictionResult').removeAttribute('data-result');
  text('resultIcon', ''); text('resultLabel', '');
  for (const direction of directions) {
    $(`prob-${direction}`).replaceChildren(document.createTextNode('—'));
    $(`zone-${direction}`).classList.remove('selected', 'locked');
  }
  text('phaseLabel', mode === 'preview' ? 'VIDEO PREVIEW · NORMAL SPEED' : 'READING THE RUN-UP');
  text('decisionLabel', mode === 'preview' ? 'Video preview' : 'AI is watching the player…');
  text('reactionStatus', mode === 'preview' ? 'No API requests · keeper stays ready' : 'The keeper waits for ball contact');
  $('reactionStatus').className = '';
  text('sourceStatus', mode === 'preview' ? 'VIDEO PREVIEW · NO API REQUESTS' : 'OPENAI DECISIONS · LIVE INFERENCE');
  text('detailStatus', mode === 'preview' ? 'Video preview. No frames are being sent to OpenAI.' : 'Live run. Percentages will lock to the decision used by the keeper.');
  text('answerCount', '0'); text('apiLatency', '—'); text('confidence', '—');
  $('requestRows').innerHTML = '<tr><td colspan="4">No requests yet.</td></tr>';
  $('exportButton').disabled = true;
  text('cropTime', 'No frame sent yet.');
  badge(mode === 'preview' ? 'VIDEO ONLY' : 'WATCHING', mode === 'ai' ? 'active' : '');
}

function seekToStart(run) {
  video.pause();
  const target = run.penalty.runUpStartSeconds;
  if (!video.seeking && Math.abs(video.currentTime - target) < .0001 && video.readyState >= 2) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const cleanup = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', failed); run.cancelSeek = null; };
    const done = () => {
      if (video.seeking || Math.abs(video.currentTime - target) > .05) return;
      cleanup(); resolve(isCurrent(run));
    };
    const failed = () => { cleanup(); reject(new Error('Could not seek to this penalty.')); };
    run.cancelSeek = () => { cleanup(); resolve(false); };
    video.addEventListener('seeked', done); video.addEventListener('error', failed, { once: true });
    try { video.currentTime = target; } catch (error) { cleanup(); reject(error); }
  });
}

async function startRun(mode) {
  if (isActive() || !videoReady || !keeperReady || (mode === 'ai' && !canRun())) return;
  sequenceRuns = [];
  await startShot(mode, sequence.start());
}

function waitForGreeting(run, duration) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(run.greetingTimer); run.cancelGreeting = null; resolve(); };
    run.cancelGreeting = done;
    run.greetingTimer = setTimeout(done, duration * 1000);
  });
}

async function startShot(mode, state) {
  if (!state.active || state.generation !== sequence.state.generation) return;
  const run = {
    id: ++runNumber, mode, records: [], sent: 0, busy: false, playing: false,
    generation: state.generation, index: state.index, penalty: state.current,
    crop: state.current.crop ?? config.crop,
    finished: false, cancelled: false, failed: false, contactAt: null,
    lastSentFrame: -Infinity, latest: null, controller: null,
    startedAt: new Date().toISOString(), reaction: createReactionState(mode), keeperStartedAt: null,
    preparedClockMs: performance.now(), playbackClockMs: null, endedClockMs: null,
    result: null, resultShownAt: null, complaintStartedAt: null,
    transitionPhase: null, transitionTimer: null, cancelTransition: null,
    recoveryStartedClockMs: null, readyClockMs: null, handoffReadyClockMs: null,
  };
  currentRun = run; sequenceRuns.push(run);
  crop.width = run.crop.width; crop.height = run.crop.height;
  text('shotCounter', `Penalty ${run.index + 1} of ${state.total}`);
  video.setAttribute('aria-label', `Penalty ${run.index + 1} of ${state.total}, played at normal speed`);
  text('contactCalibration', `${run.penalty.kickTimeEstimateSeconds.toFixed(2)} s ±${ms(run.penalty.annotationUncertaintySeconds * 1000)} ms`);
  resetDisplay(mode); updateControls(); text('runStatus', 'Preparing the clip…');
  try {
    await seekToStart(run);
    if (!isCurrent(run)) return;
    if (run.index === 0) {
      text('decisionLabel', 'Let’s see where the shots go.');
      await waitForGreeting(run, keeper.greet());
      if (!isCurrent(run)) return;
    }
    keeper.warmUp();
    if (run.index === 0) {
      // Let the greeting blend fully into the ready pose before motion starts.
      await waitForGreeting(run, .25);
      if (!isCurrent(run)) return;
    }
    text('decisionLabel', mode === 'preview' ? 'Video preview' : 'AI is watching the player…');
    video.playbackRate = 1; video.muted = true; run.playing = true;
    run.playbackClockMs = performance.now();
    await video.play();
    if (!isCurrent(run)) { if (!isActive()) video.pause(); return; }
    text('runStatus', mode === 'preview' ? 'Video preview · no API requests.' : 'Live predictions · normal speed.');
    if ('requestVideoFrameCallback' in video) frameHandle = video.requestVideoFrameCallback((now, metadata) => onFrame(run, now, metadata));
    animationHandle = requestAnimationFrame(now => tick(run, now));
  } catch (error) {
    if (!isCurrent(run)) return;
    run.failed = true; run.playing = false; run.finished = true;
    sequence.stop(); video.pause();
    notice(error.message || 'Playback could not start.'); badge('PLAYBACK ERROR', 'error');
    text('runStatus', 'Could not play the clip.'); updateControls();
  }
}

function renderSituation(run) {
  if (run.transitionPhase) {
    const ready = run.transitionPhase === 'ready';
    badge(ready ? 'READY' : 'GETTING READY');
    text('phaseLabel', ready ? 'KEEPER READY' : 'KEEPER RECOVERING');
    text('decisionLabel', ready ? 'Keeper ready' : 'Getting ready…');
    text('reactionStatus', 'The clip stays paused until the keeper is ready');
    $('reactionStatus').className = 'ready';
    return;
  }
  const commit = run.reaction.commit;
  if (commit) {
    const late = commit.timing === 'late';
    badge(late ? 'LATE REACTION' : 'DECISION LOCKED', late ? 'late' : 'active');
    text('phaseLabel', late ? 'BALL STRUCK · LATE ANSWER' : 'BALL STRUCK · DECISION LOCKED');
    const action = commit.direction === 'center' ? 'AI covers the center' : `AI dives ${commit.direction}`;
    text('decisionLabel', `${action}${late ? ` · ${ms(commit.delayMs)} ms late` : ''}`);
    text('reactionStatus', late ? 'No prediction was ready at contact' : `Prediction ready ${ms(-commit.receivedOffsetMs)} ms before the kick`);
    $('reactionStatus').className = late ? 'late' : 'ready';
    return;
  }
  if (run.mode === 'preview') {
    if (run.contactAt !== null) { text('phaseLabel', 'BALL STRUCK · VIDEO PREVIEW'); text('decisionLabel', 'Video preview'); }
    return;
  }
  if (run.contactAt !== null) {
    badge(run.failed || (run.finished && !run.busy) ? 'NO PREDICTION' : 'WAITING FOR AI', run.failed ? 'error' : 'late');
    text('phaseLabel', 'BALL STRUCK · NO DECISION READY');
    text('decisionLabel', run.failed || (run.finished && !run.busy) ? 'AI couldn’t choose a side.' : 'The ball’s been kicked. AI is still thinking…');
    text('reactionStatus', run.busy ? 'The keeper will react when the answer arrives' : 'No direction has been substituted');
    $('reactionStatus').className = run.failed ? 'error' : 'late';
  } else if (run.latest) {
    badge('PREDICTING', 'active');
    text('decisionLabel', run.latest.choice === 'center' ? 'AI predicts the center' : `AI predicts ${run.latest.choice}`);
  } else if (run.failed) {
    badge('REQUEST ERROR', 'error'); text('decisionLabel', 'AI couldn’t choose a side.');
  }
}

function synchronize(run) {
  if (!isCurrent(run)) return;
  const now = performance.now();
  const mediaTime = video.currentTime;
  const kick = run.penalty.kickTimeEstimateSeconds;
  if (run.contactAt === null && run.playing && mediaTime >= kick) {
    // This video has an annotated contact instant. Sampling both clocks together
    // preserves sync through buffering; the source marker is uncertain ±1 frame.
    run.contactAt = now - (mediaTime - kick) * 1000;
  }
  const oldCommit = run.reaction.commit;
  run.reaction = updateReaction(run.reaction, { records: run.records, contactAt: run.contactAt, now });
  if (!oldCommit && run.reaction.commit) {
    const commit = run.reaction.commit;
    run.keeperStartedAt = performance.now();
    keeper.react(commit.direction, Math.max(0, now - commit.triggerAt) / 1000);
    showDecision(commit.decision, true);
    updateDetails(run);
  }
  renderSituation(run);
  showResult(run, now, mediaTime);
}

function showResult(run, now, mediaTime) {
  if (run.mode !== 'ai') return;
  const result = run.result ?? predictionResult(run.reaction.commit, run.penalty.evaluation, mediaTime);
  if (!result) return;
  if (!run.result) {
    run.result = result; run.resultShownAt = now;
    text('resultIcon', result.type === 'correct' ? '✓' : result.type === 'wrong' ? '✕' : '—');
    text('resultLabel', result.label);
    $('predictionResult').dataset.result = result.type;
    $('predictionResult').dataset.side = run.reaction.commit?.direction === 'right' ? 'left' : 'right';
    $('predictionResult').hidden = false;
  }
  // The verdict can appear while the ball arrives, but the keeper must finish
  // its dive before the brief complaint takes control of the skeleton.
  if (result.type === 'wrong' && run.complaintStartedAt === null
      && now >= run.keeperStartedAt + 1100) {
    keeper.complain(); run.complaintStartedAt = now;
  }
}

function onFrame(run, now, metadata) {
  if (!isCurrent(run) || !run.playing) return;
  synchronize(run);
  const time = metadata.mediaTime;
  if (run.mode === 'ai' && !run.failed && !run.busy && !requestOwner
      && canCaptureFrame(time, video.currentTime, run.penalty)
      && (time - run.lastSentFrame) * 1000 >= config.sampleIntervalMs - 1) submitFrame(run, time);
  if (run.mode === 'preview' && canCaptureFrame(time, video.currentTime, run.penalty)) {
    drawCrop(run); text('cropTime', `${time.toFixed(2)} s · preview only, not sent`);
  }
  if (video.currentTime >= run.penalty.clipEndSeconds) finishPlayback(run);
  if (run.playing) frameHandle = video.requestVideoFrameCallback((nextNow, nextMetadata) => onFrame(run, nextNow, nextMetadata));
}

function tick(run, now) {
  if (!isCurrent(run) || run.finished) return;
  synchronize(run);
  if (run.playing && video.currentTime >= run.penalty.clipEndSeconds) finishPlayback(run);
  if (!run.finished) animationHandle = requestAnimationFrame(nextNow => tick(run, nextNow));
}

function finishPlayback(run) {
  if (!isCurrent(run) || !run.playing) return;
  synchronize(run);
  run.playing = false; video.pause();
  run.endedClockMs = performance.now();
  if (frameHandle !== undefined && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(frameHandle);
  if (run.busy) text('runStatus', 'Shot complete · waiting for the final answer…');
  else finishRun(run);
}

function waitForTransition(run, durationMs) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(run.transitionTimer);
      run.transitionTimer = null; run.cancelTransition = null;
      resolve(isCurrent(run) && isActive());
    };
    run.cancelTransition = done;
    run.transitionTimer = setTimeout(done, Math.max(0, durationMs));
  });
}

async function finishRun(run) {
  if (!isCurrent(run) || run.finished) return;
  // A final response may arrive after playback paused. Grade and lock that
  // actual response before starting the result hold or recovery.
  synchronize(run);
  run.finished = true; cancelAnimationFrame(animationHandle);
  const answerCount = run.records.filter(record => record.type === 'choice').length;
  text('runStatus', run.failed ? 'Request failed. See Setup & results.' : run.mode === 'preview' ? 'Preview complete · no API requests.' : `Complete · ${answerCount} live prediction${answerCount === 1 ? '' : 's'}`);
  renderSituation(run); updateDetails(run); updateControls();
  // Keep this shot and its counter on screen through the result, full dive,
  // gesture and recovery. Nothing seeks, plays or samples the next shot yet.
  const now = performance.now();
  const holdMs = Math.max(400, run.keeperStartedAt === null ? 0 : run.keeperStartedAt + 1500 - now,
    run.resultShownAt === null ? 0 : run.resultShownAt + 1000 - now);
  if (!await waitForTransition(run, holdMs)) return;
  if (run.result?.type === 'wrong') {
    if (run.complaintStartedAt === null) {
      keeper.complain(); run.complaintStartedAt = performance.now();
    }
    if (!await waitForTransition(run, run.complaintStartedAt + COMPLAINT_SECONDS * 1000 + 100 - performance.now())) return;
  }
  run.recoveryStartedClockMs = performance.now(); run.transitionPhase = 'recovering';
  renderSituation(run);
  const recoverySeconds = keeper.recover ? keeper.recover() : (keeper.warmUp(), .45);
  if (!await waitForTransition(run, Math.max(500, (recoverySeconds || .45) * 1000))) return;
  run.readyClockMs = performance.now(); run.transitionPhase = 'ready';
  renderSituation(run);
  // A distinct upright beat makes the next start legible at recording speed.
  if (!await waitForTransition(run, 500)) return;
  run.handoffReadyClockMs = performance.now();
  const next = sequence.advance(run.generation);
  if (next.completed) {
    badge('COMPLETE'); text('runStatus', 'All penalties complete. Ready to play again.');
    updateControls();
  } else startShot(run.mode, next);
}

function updateDetails(run) {
  const choices = run.records.filter(record => record.type === 'choice');
  text('answerCount', String(choices.length));
  const commit = run.reaction.commit;
  const shownDecision = commit?.decision ?? run.latest;
  if (shownDecision) {
    text('apiLatency', `${ms(shownDecision.apiMs)} ms`);
    text('confidence', `${Math.round(shownDecision.confidence * 100)}%`);
  }
  if (commit) text('detailStatus', `${capitalize(commit.direction)} locked for the keeper. Answer ${ms(Math.abs(commit.receivedOffsetMs))} ms ${commit.receivedOffsetMs <= 0 ? 'before' : 'after'} contact. Zone percentages stay on this decision; the table includes later replies.`);
  $('exportButton').disabled = !run.records.some(record => record.type !== 'pending');
  if (!run.records.length) return;
  $('requestRows').replaceChildren();
  for (const record of [...run.records].reverse()) {
    const offset = record.type === 'choice' ? contactOffsetMs(record.receivedAt, run.contactAt) : null;
    const row = document.createElement('tr');
    const values = [`${record.frameTimeSeconds.toFixed(2)} s`, record.type === 'choice' ? capitalize(record.choice) : record.type === 'pending' ? 'Waiting…' : capitalize(record.type), Number.isFinite(record.totalMs) ? `${ms(record.totalMs)} ms` : '—', offset === null ? '—' : `${ms(Math.abs(offset))} ms ${offset <= 0 ? 'early' : 'late'}`];
    values.forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value;
      if (index === 3 && offset !== null) cell.className = offset <= 0 ? 'cell-ready' : 'cell-late';
      if (index === 1 && record.type === 'error') cell.className = 'cell-error';
      row.append(cell);
    });
    $('requestRows').append(row);
  }
}

async function submitFrame(run, frameTimeSeconds) {
  if (!isCurrent(run) || requestOwner) return;
  requestOwner = run;
  run.busy = true; run.lastSentFrame = frameTimeSeconds;
  const record = { type: 'pending', frameTimeSeconds, capturedAt: performance.now() };
  run.records.push(record); run.controller = new AbortController();
  try {
    // Copy pre-contact pixels synchronously, before asynchronous JPEG encoding.
    drawCrop(run); text('cropTime', `${frameTimeSeconds.toFixed(2)} s · captured before contact`);
    const blob = await new Promise(resolve => crop.toBlob(resolve, 'image/jpeg', .84));
    if (!blob) throw new Error('Could not encode the video frame.');
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not prepare the captured frame.')); reader.readAsDataURL(blob);
    });
    if (!isCurrent(run)) return;
    run.sent++; updateDetails(run); text('cropTime', `${frameTimeSeconds.toFixed(2)} s · sent to OpenAI`);
    const response = await fetch('/api/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, frameTimeSeconds, penaltyId: run.penalty.id }),
      signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(18_000)]),
    });
    const body = await response.json();
    if (!isCurrent(run)) return;
    record.receivedAt = performance.now(); record.totalMs = record.receivedAt - record.capturedAt;
    // A cancelled browser request can settle before its server-side upstream.
    // Skip this frame and try a newer one, rather than failing the replay shot.
    if (response.status === 409) {
      record.type = 'skipped'; record.reason = 'An earlier request is still settling.';
      return;
    }
    if (!response.ok) throw new Error(body.error || `Prediction failed (${response.status}).`);
    if (body.penaltyId !== undefined && body.penaltyId !== run.penalty.id) throw new Error('The prediction belongs to another penalty.');
    record.apiMs = body.apiRoundTripMs; record.serverTotalMs = body.serverTotalMs;
    record.model = body.model; record.usage = body.usage;
    Object.assign(record, body.answer);
    if (record.type === 'choice') run.latest = record;
    // Observe contact BEFORE displaying a new answer: a just-late reply cannot
    // overwrite the earlier decision when the video tick has not run yet.
    synchronize(run);
    if (record.type === 'choice' && !run.reaction.commit) showDecision(record);
    if (record.type !== 'choice') text('detailStatus', `OpenAI declined to answer for frame ${frameTimeSeconds.toFixed(2)} s. No direction has been substituted.`);
  } catch (error) {
    if (!isCurrent(run)) return;
    record.type = 'error'; record.receivedAt ??= performance.now(); record.totalMs ??= record.receivedAt - record.capturedAt;
    record.error = error.name === 'TimeoutError' ? 'The request timed out. Replay to try again.' : error.message;
    run.failed = true; notice(record.error); synchronize(run);
  } finally {
    run.busy = false;
    if (requestOwner === run) requestOwner = null;
    if (isCurrent(run)) {
      synchronize(run); updateDetails(run);
      if (!run.playing) finishRun(run);
    }
  }
}

function stopRun() {
  const run = currentRun;
  if (!run || !isActive()) return;
  sequence.stop();
  run.cancelled = true; run.playing = false; run.finished = true;
  run.cancelSeek?.();
  run.cancelGreeting?.(); run.cancelTransition?.();
  run.controller?.abort(); run.busy = false; video.pause(); keeper.stop();
  cancelAnimationFrame(animationHandle);
  if (frameHandle !== undefined && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(frameHandle);
  const pending = run.records.find(record => record.type === 'pending');
  if (pending) pending.type = 'cancelled';
  badge('STOPPED'); text('phaseLabel', 'TEST STOPPED'); text('decisionLabel', 'Press play to try again.');
  text('reactionStatus', run.contactAt === null ? 'Stopped before the kick' : 'Stopped · pending request cancelled');
  $('reactionStatus').className = ''; text('runStatus', 'Stopped. Ready to replay.');
  updateDetails(run); updateControls();
}

function runEvidence() {
  if (!currentRun) return null;
  const serialize = run => {
    const commit = run.reaction.commit;
    return {
      index: run.index, startedAt: run.startedAt, penalty: run.penalty, crop: run.crop,
      preparedClockMs: run.preparedClockMs, playbackClockMs: run.playbackClockMs,
      endedClockMs: run.endedClockMs, contactClockMs: run.contactAt,
      keeperClockMs: run.keeperStartedAt, resultClockMs: run.resultShownAt,
      recoveryStartedClockMs: run.recoveryStartedClockMs, readyClockMs: run.readyClockMs,
      handoffReadyClockMs: run.handoffReadyClockMs,
      uprightHoldMs: run.handoffReadyClockMs === null ? null : run.handoffReadyClockMs - run.readyClockMs,
      cancelled: run.cancelled, finished: run.finished,
      readyAtContact: commit?.timing === 'ready' ? commit.direction : null,
      predictionResult: run.result,
      keeperReaction: commit ? { direction: commit.direction, timing: commit.timing, answerOffsetFromContactMs: commit.receivedOffsetMs, startedOffsetFromContactMs: run.keeperStartedAt - run.contactAt, sourceFrameSeconds: commit.decision.frameTimeSeconds, responseMs: commit.decision.totalMs, probabilities: commit.decision.probabilities, confidence: commit.decision.confidence } : null,
      records: run.records.map(({ capturedAt, receivedAt, ...record }) => ({ ...record, capturedClockMs: capturedAt, receivedClockMs: receivedAt, receivedOffsetFromContactMs: contactOffsetMs(receivedAt, run.contactAt) })),
    };
  };
  const run = currentRun;
  return {
    experiment: 'AI Goalkeeper / penalty sequence / live 3D', model: config.model, mode: run.mode,
    sampleTargetMs: config.sampleIntervalMs, viewpoint: 'kicker', ...serialize(run),
    sequence: { total: sequence.state.total, completed: sequence.state.completed, active: sequence.state.active },
    runs: sequenceRuns.map(serialize),
  };
}

function exportRun() {
  const data = runEvidence();
  if (!data) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `goalkeeper-live-${currentRun.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cleanView(value = !document.body.classList.contains('recording')) {
  document.body.classList.toggle('recording', value);
  $('recordButton').setAttribute('aria-pressed', String(value)); $('exitClean').hidden = !value;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

$('runButton').addEventListener('click', () => startRun('ai'));
$('previewButton').addEventListener('click', () => startRun('preview'));
$('stopButton').addEventListener('click', stopRun);
$('exportButton').addEventListener('click', exportRun);
$('recordButton').addEventListener('click', () => cleanView());
$('exitClean').addEventListener('click', () => cleanView(false));
$('setupButton').addEventListener('click', () => $('setupDialog').showModal());
$('closeSetup').addEventListener('click', () => $('setupDialog').close());
$('setupDialog').addEventListener('click', event => { if (event.target === $('setupDialog')) { const box = $('setupDialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('setupDialog').close(); } });
$('keyForm').addEventListener('submit', async event => {
  event.preventDefault(); if (isActive()) return;
  $('connectButton').disabled = true; text('keyMessage', '');
  const apiKey = $('apiKey').value.trim(); $('apiKey').value = '';
  try {
    const response = await fetch('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error);
    keyReady = true; $('connectionDetails').open = false; text('keyMessage', 'API key ready.'); updateControls();
  } catch (error) { text('keyMessage', error.message || 'Could not set the key.'); }
  finally { updateControls(); }
});

document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || $('setupDialog').open || event.target.closest('input,textarea,select,[contenteditable]')) return;
  if (event.key === 'Escape') { cleanView(false); return; }
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); cleanView(); return; }
  if (event.code === 'Space' && !event.repeat) {
    if (event.target.closest('a,summary,button') && !['runButton', 'stopButton'].includes(event.target.id) && !document.body.classList.contains('recording')) return;
    event.preventDefault(); if (isActive()) stopRun(); else if (canRun()) startRun('ai');
  }
});

video.addEventListener('loadeddata', () => { videoReady = true; $('videoLoading').hidden = true; drawCrop(); updateControls(); });
video.addEventListener('ended', () => {
  if (currentRun && isCurrent(currentRun) && currentRun.playing) finishPlayback(currentRun);
});
video.addEventListener('error', () => {
  videoReady = false; if (isActive()) stopRun();
  notice('The video could not load. Check the original MP4 path and restart the server.'); updateControls();
});

async function initializeConfig() {
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error('Could not load the test configuration.');
    config = await response.json(); keyReady = config.keyConfigured;
    sequence = createSequence(config.penalties?.length ? config.penalties : [{ ...config.penalty, crop: config.crop }]);
    text('shotCounter', `Penalty 1 of ${sequence.state.total}`);
    $('connectionDetails').open = !keyReady;
    text('contactCalibration', `${sequence.state.current.kickTimeEstimateSeconds.toFixed(2)} s ±${ms(sequence.state.current.annotationUncertaintySeconds * 1000)} ms`);
    if (!config.videoAvailable) throw new Error('Add your video at media/penalties.mp4 or set VIDEO_PATH in .env.local, then restart.');
    if (!keyReady) notice('Add OPENAI_API_KEY to .env.local, then restart to enable live predictions.');
    if (!('requestVideoFrameCallback' in video)) notice('Use a current Chrome or Edge browser for frame-accurate capture. Preview remains available.');
    video.src = config.videoUrl; video.load(); updateControls();
  } catch (error) { notice(error.message); text('runStatus', 'Setup needs attention.'); badge('SETUP NEEDED', 'error'); }
}

async function initializeKeeper() {
  try {
    keeper = await createGoalScene($('goalCanvas'), { onZoneLayout(layout) {
      for (const direction of directions) {
        const zone = $(`zone-${direction}`), point = layout[direction];
        zone.style.left = `${point.x * 100}%`; zone.style.top = `${point.y * 100}%`; zone.style.width = `${point.width * 100}%`;
      }
    } });
    keeperReady = true; $('keeperLoading').hidden = true; updateControls();
  } catch (error) { console.error(error); notice('The goalkeeper could not load. Reload to retry.'); text('keeperLoading', 'Goalkeeper unavailable'); badge('SETUP NEEDED', 'error'); }
}

initializeConfig(); initializeKeeper();
