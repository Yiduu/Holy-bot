'use strict';

function isMissingColumnError(error) {
  const message = (error?.message || '').toLowerCase();
  return (
    message.includes('schema cache') ||
    message.includes('could not find the') ||
    message.includes('column') && message.includes('users') ||
    error?.code === '42703'
  );
}

async function getAvatarValue(supabase, telegramId) {
  const columns = ['photo_file_id', 'avatar_file_id', 'avatar_url'];
  let lastError;

  for (const column of columns) {
    const { data, error } = await supabase
      .from('users')
      .select(column)
      .eq('telegram_id', telegramId)
      .single();

    if (!error) return { value: data?.[column] || null, column };
    lastError = error;
    if (!isMissingColumnError(error)) return { value: null, error };
  }

  return { value: null, error: lastError };
}

async function setAvatarValue(supabase, telegramId, value) {
  const columns = ['photo_file_id', 'avatar_file_id', 'avatar_url'];
  let lastError;

  for (const column of columns) {
    const { data, error } = await supabase
      .from('users')
      .update({ [column]: value })
      .eq('telegram_id', telegramId)
      .select(column)
      .single();

    if (!error) return { value: data?.[column] || value, column };
    lastError = error;
    if (!isMissingColumnError(error)) return { value: null, error };
  }

  return { value: null, error: lastError };
}

async function clearAvatarValue(supabase, telegramId) {
  return setAvatarValue(supabase, telegramId, null);
}

async function getAvatarMap(supabase, telegramIds = []) {
  const ids = [...new Set((telegramIds || []).filter(Boolean))];
  const map = {};

  for (const telegramId of ids) {
    const { value } = await getAvatarValue(supabase, telegramId);
    if (value) map[telegramId] = value;
  }

  return map;
}

module.exports = {
  getAvatarValue,
  setAvatarValue,
  clearAvatarValue,
  getAvatarMap,
};
