// Run: node tests/voice-transcode.test.js   (uses the bundled ffmpeg binary)
// A quiet WebM/Opus "recording" (what Android Chrome produces) must come out as
// a playable, louder, mono AAC .m4a; a garbage file must fall back to null.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const { normalizeVoice } = require('../utils/voice');
const ok = n => console.log('  ✓', n);

const meanDb = (file) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr); return m ? Number(m[1]) : NaN;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-'));
  const src = path.join(dir, 'up-quiet');                       // no extension, like multer's temp files
  let r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-af', 'volume=-35dB', '-c:a', 'libopus', '-f', 'webm', src]);
  assert.equal(r.status, 0, 'could not build the test recording');
  const before = meanDb(src);

  const out = await normalizeVoice(src);
  assert.ok(out && fs.existsSync(out.path), 'converted'); assert.equal(out.mime, 'audio/mp4'); assert.equal(out.ext, 'm4a');
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', out.path], { encoding: 'utf8' }).stderr;
  assert.ok(/Audio: aac/.test(info) && /mono/.test(info) && /48000 Hz/.test(info), info);
  ok('WebM/Opus → mono 48 kHz AAC .m4a');
  const after = meanDb(out.path);
  assert.ok(after > before + 10, `louder: ${before} → ${after} dB`); ok(`quiet recording boosted (${before} dB → ${after} dB)`);
  fs.unlinkSync(out.path);

  const bad = path.join(dir, 'up-bad'); fs.writeFileSync(bad, Buffer.alloc(500, 7));
  let err = null; const res = await normalizeVoice(bad, { onError: e => { err = e; } });
  assert.equal(res, null); assert.ok(err); assert.ok(!fs.existsSync(bad + '.m4a')); ok('unreadable file → null (caller sends the original), no temp left behind');

  process.env.VOICE_TRANSCODE = 'off'; assert.equal(await normalizeVoice(src), null); ok('VOICE_TRANSCODE=off disables it');
  console.log('\nALL VOICE TRANSCODE CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
