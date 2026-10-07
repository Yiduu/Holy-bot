'use strict';

// Voice-note normalisation.
//
// Browsers record in whatever they like: WebM/Opus (Android, desktop Chrome),
// MP4/AAC at a low bitrate (iOS), OGG/Opus (Firefox). Telegram refuses WebM as
// a voice note, older iOS web views cannot play WebM/OGG at all, and raw mic
// captures are often very quiet. So every recording is re-encoded once, on the
// server, into a mono 48 kHz AAC .m4a with a gentle loudness normalisation.
// M4A is accepted by sendVoice and plays in every Mini App web view.
//
// If ffmpeg is missing or fails, callers fall back to the original file, so
// this can only improve things. Set VOICE_TRANSCODE=off to disable.

const { spawn } = require('child_process');
const fs = require('fs');

const TIMEOUT_MS = 60 * 1000;
const MAX_PARALLEL = 2;           // keep a 512 MB instance safe
let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

function ffmpegBinary() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('@ffmpeg-installer/ffmpeg').path; } catch { /* fall through */ }
  return 'ffmpeg';
}

const FILTER = [
  'highpass=f=70',                       // rumble / handling noise
  'loudnorm=I=-16:TP=-1.5:LRA=11',       // quiet recordings become audible
  'aresample=48000',                     // loudnorm upsamples internally
].join(',');

// Returns { path, mime, ext } (caller deletes `path`) or null when not converted.
async function normalizeVoice(inPath, { onError } = {}) {
  if (String(process.env.VOICE_TRANSCODE || '').toLowerCase() === 'off') return null;
  const outPath = `${inPath}.m4a`;
  await acquire();
  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inPath, '-vn', '-map_metadata', '-1',
        '-af', FILTER,
        '-ac', '1', '-c:a', 'aac', '-b:a', '64k',
        '-movflags', '+faststart',
        outPath,
      ];
      const p = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { if (err.length < 2000) err += d; });
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, TIMEOUT_MS);
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
      });
    });
    const st = await fs.promises.stat(outPath);
    if (!st.size) throw new Error('ffmpeg produced an empty file');
    return { path: outPath, mime: 'audio/mp4', ext: 'm4a', size: st.size };
  } catch (e) {
    fs.unlink(outPath, () => { });
    if (onError) onError(e);
    return null;
  } finally {
    release();
  }
}

module.exports = { normalizeVoice };
