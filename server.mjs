import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { AppError, MODEL, ENDPOINT, validateFrame, buildDecisionRequest, parseAnswer } from './lib/decisions.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const defaultCrop = { x: 200, y: 375, width: 580, height: 240 };
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/live.js', ['live.js', 'text/javascript; charset=utf-8']],
  ['/playlist.js', ['playlist.js', 'text/javascript; charset=utf-8']],
  ['/record.css', ['record.css', 'text/css; charset=utf-8']],
  ['/reaction.js', ['reaction.js', 'text/javascript; charset=utf-8']],
  ['/goal-scene.js', ['goal-scene.js', 'text/javascript; charset=utf-8']],
  ['/keeper-motion.js', ['keeper-motion.js', 'text/javascript; charset=utf-8']],
  ['/prediction-result.js', ['prediction-result.js', 'text/javascript; charset=utf-8']],
  ['/timing.js', ['timing.js', 'text/javascript; charset=utf-8']],
  ['/keeper-rig.js', ['keeper-rig.js', 'text/javascript; charset=utf-8']],
  ['/assets/goalkeeper-animated.glb', ['../assets/goalkeeper-animated.glb', 'model/gltf-binary']],
  ['/vendor/three.module.js', ['../node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.core.js', ['../node_modules/three/build/three.core.js', 'text/javascript; charset=utf-8']],
  ...['loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js'].map(path => [
    `/vendor/addons/${path}`, [`../node_modules/three/examples/jsm/${path}`, 'text/javascript; charset=utf-8'],
  ]),
]);

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new AppError(415, 'Use application/json.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1_100_000) throw new AppError(413, 'The frame is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'Invalid JSON.'); }
}

export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new AppError(416, 'Invalid video range.');
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new AppError(416, 'Invalid video range.');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new AppError(416, 'Invalid video range.');
  }
  return { start, end, partial: true };
}

async function serveVideo(req, res, videoPath, {
  contentType = 'video/mp4', missingMessage = 'Video not found. Set VIDEO_PATH to the original MP4 and restart.',
} = {}) {
  let info;
  try { info = await stat(videoPath); if (!info.isFile() || !info.size) throw new Error('Not a media file.'); }
  catch { throw new AppError(404, missingMessage); }
  let range;
  try { range = parseRange(req.headers.range, info.size); }
  catch (error) { res.setHeader('Content-Range', `bytes */${info.size}`); throw error; }
  const { start, end, partial } = range;
  const headers = {
    'Content-Type': contentType, 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600',
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(videoPath, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export async function createApp(options = {}) {
  const manifest = options.manifest ?? JSON.parse(await readFile(join(root, 'data/penalties.json'), 'utf8'));
  const penalty = manifest.penalties[0];
  const penaltiesById = new Map(manifest.penalties.map(item => [item.id, item]));
  const publicPenalties = manifest.penalties.map(item => {
    const { x, y, width, height } = item.crop ?? defaultCrop;
    return {
      id: item.id, runUpStartSeconds: item.runUpStartSeconds,
      kickTimeEstimateSeconds: item.kickTimeEstimateSeconds,
      clipEndSeconds: item.clipEndSeconds,
      latestConfirmedPreContactFrameSeconds: item.latestConfirmedPreContactFrameSeconds,
      annotationUncertaintySeconds: item.annotation.uncertaintySeconds,
      crop: { x, y, width, height },
      ...(item.evaluation ? { evaluation: {
        zone: item.evaluation.zone, kind: item.evaluation.kind,
        visibleAtSeconds: item.evaluation.visibleAtSeconds,
      } } : {}),
    };
  });
  const videoPath = resolve(root, options.videoPath ?? process.env.VIDEO_PATH ?? manifest.sourceVideo.path);
  const fetchImpl = options.fetchImpl ?? fetch;
  const environmentKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  let sessionKey = '';
  let upstreamActive = false;

  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new AppError(403, 'Local requests only.');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AppError(403, 'Same-origin requests only.');
      const path = new URL(req.url, `http://${host}`).pathname;

      if (path === '/api/config' && req.method === 'GET') {
        let videoAvailable = false;
        try { videoAvailable = (await stat(videoPath)).isFile(); } catch {}
        return json(res, 200, {
          model: MODEL, keyConfigured: Boolean(sessionKey || environmentKey),
          keySource: sessionKey ? 'session' : environmentKey ? 'environment' : null,
          videoAvailable, videoUrl: '/media/penalty.mp4',
          video: { width: manifest.sourceVideo.width, height: manifest.sourceVideo.height },
          penalty: {
            id: penalty.id, runUpStartSeconds: penalty.runUpStartSeconds,
            kickTimeEstimateSeconds: penalty.kickTimeEstimateSeconds,
            clipEndSeconds: penalty.clipEndSeconds,
            latestConfirmedPreContactFrameSeconds: penalty.latestConfirmedPreContactFrameSeconds,
            annotationUncertaintySeconds: penalty.annotation.uncertaintySeconds,
          },
          crop: publicPenalties[0].crop,
          penalties: publicPenalties,
          sampleIntervalMs: 200,
        });
      }

      if (path === '/api/key' && req.method === 'POST') {
        const body = await readJson(req);
        const value = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (value.length < 20 || value.length > 512 || /[^\x21-\x7e]/.test(value)) {
          throw new AppError(400, 'Enter a valid OpenAI API key.');
        }
        sessionKey = value;
        return json(res, 200, { keyConfigured: true, keySource: 'session' });
      }

      if (path === '/api/predict' && req.method === 'POST') {
        const serverStartedAt = performance.now();
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new AppError(400, 'A frame is required.');
        }
        const penaltyId = body.penaltyId === undefined ? penalty.id : body.penaltyId;
        const selectedPenalty = typeof penaltyId === 'string' ? penaltiesById.get(penaltyId) : null;
        if (!selectedPenalty) throw new AppError(422, 'Choose a known penalty.');
        const frame = validateFrame(body, selectedPenalty);
        const apiKey = sessionKey || environmentKey;
        if (!apiKey) throw new AppError(503, 'Add your OpenAI API key to run live predictions.');
        if (upstreamActive) throw new AppError(409, 'A prediction is already running. Try again when it finishes.');
        upstreamActive = true;
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const apiStartedAt = performance.now();
        try {
          const response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildDecisionRequest(frame)),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          });
          // Never return upstream error text: authentication errors may echo part of a key.
          if (!response.ok) {
            await response.arrayBuffer();
            const messages = {
              401: 'OpenAI rejected the API key. Check the key and try again.',
              403: 'This API key does not have access to the Decisions API.',
              429: 'OpenAI rate or quota limit reached. Check your API account and retry.',
            };
            throw new AppError(response.status === 429 ? 429 : 502,
              messages[response.status] ?? `OpenAI could not process this frame (HTTP ${response.status}).`);
          }
          const decision = await response.json();
          const apiRoundTripMs = performance.now() - apiStartedAt;
          const answer = parseAnswer(decision);
          return json(res, 200, {
            model: decision.model ?? MODEL,
            penaltyId: selectedPenalty.id,
            frameTimeSeconds: frame.frameTimeSeconds,
            answer,
            apiRoundTripMs,
            serverTotalMs: performance.now() - serverStartedAt,
            usage: decision.usage ? { inputTokens: decision.usage.input_tokens } : null,
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          if (controller.signal.aborted) return;
          throw new AppError(504, error?.name === 'TimeoutError'
            ? 'OpenAI did not respond within 15 seconds. Replay to try again.'
            : 'Could not reach OpenAI. Check the server internet connection and retry.');
        } finally {
          upstreamActive = false;
        }
      }

      if (path === '/media/penalty.mp4' && ['GET', 'HEAD'].includes(req.method)) {
        return await serveVideo(req, res, videoPath);
      }
      if (staticFiles.has(path) && ['GET', 'HEAD'].includes(req.method)) {
        const [filename, type] = staticFiles.get(path);
        const body = await readFile(join(root, 'dist', filename));
        // Only the fixed document import maps need inline script permission.
        const importMap = filename.endsWith('.html') && body.toString().match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
        const importPermission = importMap ? ` 'sha256-${createHash('sha256').update(importMap).digest('base64')}'` : '';
        res.writeHead(200, {
          'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'self'; script-src 'self'${importPermission}; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self' blob:; base-uri 'none'; form-action 'self'`,
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      throw new AppError(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      json(res, error instanceof AppError ? error.status : 500,
        { error: error instanceof AppError ? error.message : 'The local server could not complete this request.' });
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 8766);
  const app = await createApp();
  app.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another local port.` : `Could not start the local test server (${error.code ?? 'unknown error'}). Set PORT to another local port.`);
    process.exitCode = 1;
  });
  app.listen(port, '127.0.0.1', () => console.log(`AI Goalkeeper: http://127.0.0.1:${port}`));
}
