import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ADMIN_KEY = process.env.ADMIN_API_KEY || 'admin123';

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const parts = [];
  for (let block = 0; block < 4; block++) {
    let part = '';
    for (let i = 0; i < 4; i++) {
      part += chars[Math.floor(Math.random() * chars.length)];
    }
    parts.push(part);
  }
  return parts.join('-');
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const bodyKey = req.body?.admin_key || req.query?.admin_key;
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : bodyKey;

  if (apiKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid admin key' });
  }

  if (req.method === 'GET') {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from('user_keys')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, page, limit, total: count, keys: data });
  }

  if (req.method === 'POST') {
    const { count = 1, max_devices = 1, expires_in_days = null, notes = '' } = req.body;
    const maxCount = Math.min(Math.max(1, count), 100);
    const keys = [];

    for (let i = 0; i < maxCount; i++) {
      let keyValue;
      let isUnique = false;
      while (!isUnique) {
        keyValue = generateKey();
        const { data: existing } = await supabase
          .from('user_keys').select('id').eq('key_value', keyValue).single();
        isUnique = !existing;
      }

      keys.push({
        key_value: keyValue,
        max_devices: max_devices,
        expires_at: expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null,
        notes: notes,
        created_by: req.body.admin_label || 'web-admin',
        registered_serials: [],
      });
    }

    const { data, error } = await supabase.from('user_keys').insert(keys).select();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, count: data.length, keys: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
