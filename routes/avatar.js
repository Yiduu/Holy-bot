'use strict';

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const { getAvatarValue, setAvatarValue, clearAvatarValue } = require('../utils/avatar');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

module.exports = function avatarRoutes(supabase, requireAuth, bot) {
  const router = express.Router();
  const STORAGE_CHAT_ID = process.env.ADMIN_TELEGRAM_ID;

  // POST /api/avatar – upload a (already client-cropped) profile photo.
  // We don't run our own Storage bucket: the photo is sent to the bot's
  // existing admin chat purely to mint a stable Telegram file_id, and only
  // that file_id + a timestamp are kept in our DB.
  router.post('/', requireAuth, (req, res) => {
    upload.single('avatar')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      if (!STORAGE_CHAT_ID) {
        console.error('[POST /avatar] ADMIN_TELEGRAM_ID is not configured');
        return res.status(500).json({ error: 'Avatar storage is not configured' });
      }

      try {
        const sent = await bot.sendPhoto(
          STORAGE_CHAT_ID,
          req.file.buffer,
          { caption: `avatar:${req.telegramUser.id}` },
          { filename: 'avatar.jpg', contentType: req.file.mimetype }
        );

        const sizes = sent.photo || [];
        const largest = sizes[sizes.length - 1];
        if (!largest) return res.status(500).json({ error: 'Telegram did not return a photo file' });

        const now = new Date().toISOString();
        const { value, error, column } = await setAvatarValue(supabase, req.telegramUser.id, largest.file_id);

        if (error) return res.status(500).json({ error: error.message });

        const { data: userData, error: tsError } = await supabase
          .from('users')
          .update({ photo_updated_at: now })
          .eq('telegram_id', req.telegramUser.id)
          .select('photo_updated_at')
          .single();

        if (tsError) {
          console.warn('[POST /avatar] photo_updated_at update failed:', tsError.message);
        }

        res.json({
          photo_file_id: value,
          photo_updated_at: userData?.photo_updated_at || now,
          avatar_column: column,
        });
      } catch (e) {
        console.error('[POST /avatar] Error:', e.message);
        res.status(500).json({ error: 'Failed to upload photo' });
      }
    });
  });

  // DELETE /api/avatar – remove the uploaded photo, reverting to the
  // existing letter-initial fallback everywhere it's shown.
  router.delete('/', requireAuth, async (req, res) => {
    const { error } = await clearAvatarValue(supabase, req.telegramUser.id);

    if (error) return res.status(500).json({ error: error.message });

    const { error: tsError } = await supabase
      .from('users')
      .update({ photo_updated_at: null })
      .eq('telegram_id', req.telegramUser.id);

    if (tsError) console.warn('[DELETE /avatar] photo_updated_at clear failed:', tsError.message);
    res.json({ removed: true });
  });

  // GET /api/avatar/:telegram_id – stream the photo bytes through our own
  // authenticated endpoint, same approach as GET /api/messages/file/:file_id:
  // the bot token never reaches the client, and no Supabase Storage bucket
  // or public bucket policy is needed.
  router.get('/:telegram_id', requireAuth, async (req, res) => {
    const { telegram_id } = req.params;

    const { value, error } = await getAvatarValue(supabase, telegram_id);

    if (error) return res.status(500).json({ error: error.message });
    if (!value) return res.status(404).json({ error: 'No photo set' });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    try {
      const { data } = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
        params: { file_id: value },
      });

      if (!data.ok || !data.result?.file_path) {
        return res.status(404).json({ error: 'File not found' });
      }

      const fileUrl = `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
      const fileRes = await axios.get(fileUrl, { responseType: 'stream' });

      if (fileRes.headers['content-type']) res.setHeader('Content-Type', fileRes.headers['content-type']);
      if (fileRes.headers['content-length']) res.setHeader('Content-Length', fileRes.headers['content-length']);
      // Callers append ?v=<photo_updated_at> as a cache-buster, so a long
      // cache lifetime is safe — a new upload produces a new URL.
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');

      fileRes.data.pipe(res);
    } catch (err) {
      console.error('[GET /avatar/:telegram_id] Error:', err.message);
      res.status(500).json({ error: 'Failed to fetch photo' });
    }
  });

  return router;
};
