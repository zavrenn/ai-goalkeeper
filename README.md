# AI Goalkeeper

A browser demo that uses OpenAI's Decisions API to predict a penalty's direction from pre-contact video frames. A Three.js goalkeeper reacts to the prediction, while the interface shows left, center and right probabilities and measured response times.

## Requirements

- Node.js 22 or later.
- An OpenAI API key with access to the Decisions API.
- A desktop browser with `requestVideoFrameCallback`, such as Chrome or Edge.
- A local penalty video matching the included annotations, or your own video and updated annotations.

## Run locally

1. Run `npm ci` to install the pinned Three.js dependency.
2. Copy `.env.example` to `.env.local` and fill in `OPENAI_API_KEY`.
3. Put the video at `media/penalties.mp4`, or set `VIDEO_PATH` in `.env.local`.
4. Run `npm start` and open <http://127.0.0.1:8766>.

The included timestamps match this [Liverpool vs Chelsea penalty shootout montage](https://www.youtube.com/watch?v=AfDNWqFiHJg) from the 2022 Carabao Cup final. Use the same edit at its original timing and resolution (1280×720). Footage is supplied separately; it is not included in the source code.

The goalkeeper model and its animation clips are included in `assets/goalkeeper-animated.glb`. No separate model download or build step is required.

Click **Play** to run all annotated penalties in order. **Space** starts or stops playback, **F** hides the Play button, and **Escape** restores it. Each live run sends cropped frames to OpenAI and incurs API usage. `npm run dev` restarts the server when files change; `npm run check` checks JavaScript syntax.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Your server-side OpenAI API key | Required |
| `VIDEO_PATH` | Absolute video path, or path relative to the project | `media/penalties.mp4` |
| `PORT` | Local HTTP port | `8766` |

Environment files are loaded in order: `.env`, then `.env.local`. Existing process environment variables take precedence. Credentials remain on the local Node.js server. The public configuration response exposes only whether a key is configured, never its value. Local environment files, installed dependencies, footage, recordings and exports are excluded by `.gitignore`.

## How it works

1. The browser plays a prerecorded penalty at normal speed and captures cropped frames during the run-up.
2. The local server validates that each frame is inside the shot's confirmed pre-contact window, then sends it to the Decisions API.
3. The API chooses left, center or right. Direction uses the kicker/camera viewpoint, facing the goal.
4. At the annotated kick, the keeper uses the latest answer already received. If none is ready, it waits for the first usable late answer and displays the delay.
5. A result marker compares the committed direction with a manually reviewed outcome after the shot. Later answers cannot redirect an existing dive.

Only one request is in flight at a time. Pending frames are skipped rather than queued. Errors and refusals never produce a substitute prediction. Match identity, scores, annotated outcomes and kick deadlines are not included in the model input.

The opening greeting, warm-up and brief complaint use the model's embedded animation clips. The directional dives are animated through the keeper rig.

## Video annotations

`data/penalties.json` contains clip boundaries, approximate kick times, the final confirmed pre-contact frame, crop rectangles and optional outcome labels. To use different footage, update these fields and the source dimensions before running the app.

Kick timing is **manually annotated**, with approximately one source frame of uncertainty. This demo does not detect ball contact automatically. Some montage shots have very short run-ups, and crops may show only the player's lower body.

The displayed response time measures frame capture through JPEG encoding, the local upload, the OpenAI request and receipt of the answer. It is not pure model inference time. A correct direction does not establish a physical save or a reliable prediction accuracy rate.

## Project files

- `server.mjs`: local HTTP server, input validation, credentials and API requests.
- `lib/decisions.mjs`: Decisions request and response handling.
- `dist/`: browser interface, timing, sequence logic and Three.js scene.
- `data/penalties.json`: video and shot annotations.
- `assets/`: the goalkeeper model.

Reference: [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions).
