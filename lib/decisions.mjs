export const MODEL = 'gpt-6-luna';
export const ENDPOINT = 'https://api.openai.com/v1/decisions';
export const DIRECTIONS = ['left', 'center', 'right'];

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateFrame(body, penalty) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'A frame is required.');
  }
  if (typeof body.frameTimeSeconds !== 'number'
      || !Number.isFinite(body.frameTimeSeconds)
      || body.frameTimeSeconds < penalty.runUpStartSeconds
      || body.frameTimeSeconds > penalty.latestConfirmedPreContactFrameSeconds + 0.000001) {
    throw new AppError(422, 'Only confirmed frames from before ball contact are allowed.');
  }
  if (typeof body.image !== 'string' || body.image.length > 1_000_000
      || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.image)) {
    throw new AppError(400, 'Send a small JPEG frame as a base64 data URL.');
  }
  if (!body.image.startsWith('data:image/jpeg;base64,/9j/')) {
    throw new AppError(400, 'The frame must contain JPEG image data.');
  }
  return { image: body.image, frameTimeSeconds: body.frameTimeSeconds };
}

export function buildDecisionRequest(frame) {
  return {
    model: MODEL,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'A cropped view of a penalty taker BEFORE ball contact. The camera is behind the taker, facing the goal. Use only visible body posture, approach, plant foot, and kicking leg. The goalkeeper and score are excluded. Infer the likely shooting direction; this is an uncertain prediction, not an observed ball trajectory.' },
        { type: 'input_image', image_url: frame.image },
      ],
    }],
    questions: [{
      type: 'choice',
      name: 'shot_direction',
      instructions: 'Predict which horizontal third of the goal the penalty taker is most likely to aim for. Left and right are from the KICKER / CAMERA viewpoint, facing the goal. Do not identify the match or rely on remembered results. Base the probability distribution only on the visible pre-contact cues.',
      choices: [
        { value: 'left', description: 'The left third of the goal as seen by the kicker and camera.' },
        { value: 'center', description: 'The middle third of the goal as seen by the kicker and camera.' },
        { value: 'right', description: 'The right third of the goal as seen by the kicker and camera.' },
      ],
    }],
  };
}

const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function parseAnswer(decision) {
  const answer = decision?.answers?.find(item => item.name === 'shot_direction');
  if (answer?.type === 'refusal') return { type: 'refusal', name: 'shot_direction' };
  if (answer?.type !== 'choice' || !DIRECTIONS.includes(answer.choice)
      || !isProbability(answer.confidence) || !Array.isArray(answer.probabilities)
      || answer.probabilities.length !== 3
      || new Set(answer.probabilities.map(item => item.value)).size !== 3
      || answer.probabilities.some(item => !DIRECTIONS.includes(item.value) || !isProbability(item.probability))
      || Math.abs(answer.probabilities.reduce((sum, item) => sum + item.probability, 0) - 1) > 0.02) {
    throw new AppError(502, 'OpenAI returned an unexpected decision. No prediction was substituted.');
  }
  return {
    type: 'choice',
    name: 'shot_direction',
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities.map(({ value, probability }) => ({ value, probability })),
  };
}
