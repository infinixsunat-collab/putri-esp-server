import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac } from 'node:crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SALT = process.env.SALT_SECRET || 'Vm8Lk7Uj2JmsjCPVPVjrLa7zgfx3uz9E';

function md5(data) {
  return createHash('md5').update(data).digest('hex');
}

function hmacMD5(key, data) {
  return createHmac('md5', key).update(data).digest('hex');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader(CORS_HEADERS).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ status: false, reason: 'Method not allowed' });
  }

  try {
    const { game, user_key, serial, hmac } = req.body;

    if (!user_key || !serial || !hmac) {
      return res.status(200).json({ status: false, reason: 'Missing required fields' });
    }

    // --- HMAC VERIFICATION (two-way auth) ---
    // Client must prove it knows the salt by signing (user_key + serial)
    const expectedHmac = hmacMD5(SALT, user_key + serial);
    if (hmac !== expectedHmac) {
      await logAttempt(supabase, user_key, serial, false, 'Invalid HMAC', req);
      return res.status(200).json({ status: false, reason: 'Invalid HMAC' });
    }

    // Cari key
    const { data: keyData, error: keyError } = await supabase
      .from('user_keys')
      .select('*')
      .eq('key_value', user_key)
      .single();

    if (keyError || !keyData) {
      await logAttempt(supabase, user_key, serial, false, 'Key not found', req);
      return res.status(200).json({ status: false, reason: 'Key not found' });
    }

    if (!keyData.is_active) {
      return res.status(200).json({ status: false, reason: 'Key is deactivated' });
    }

    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      return res.status(200).json({ status: false, reason: 'Key has expired' });
    }

    // --- DEVICE TRACKING SYSTEM ---
    // registered_serials = array of unique device serials
    const registeredSerials = keyData.registered_serials || [];
    const isRegisteredDevice = registeredSerials.includes(serial);

    if (!isRegisteredDevice) {
      // Device baru - cek quota
      if (registeredSerials.length >= keyData.max_devices) {
        await logAttempt(supabase, user_key, serial, false, 'Maximum device limit reached', req);
        return res.status(200).json({ status: false, reason: 'Maximum device limit reached' });
      }

      // Daftarkan device baru
      const updatedSerials = [...registeredSerials, serial];
      const { error: updateError } = await supabase
        .from('user_keys')
        .update({
          registered_serials: updatedSerials,
          used_count: updatedSerials.length,
          is_used: true,
          used_at: keyData.used_at || new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        })
        .eq('id', keyData.id);

      if (updateError) {
        console.error('Update error:', updateError);
        return res.status(200).json({ status: false, reason: 'Server error' });
      }
    } else {
      // Device sudah terdaftar - update last_used_at aja
      await supabase
        .from('user_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyData.id);
    }

    // Generate token (sama persis dengan native code)
    const authString = `ROV-${user_key}-${serial}-${SALT}`;
    const token = md5(authString);
    const rng = Math.floor(Date.now() / 1000);

    // Generate server HMAC so client can verify the response is from us
    const serverHmac = hmacMD5(SALT, token + rng.toString());

    // Log sukses
    await logAttempt(supabase, user_key, serial, true, 'OK', req);

    return res.status(200).json({
      status: true,
      data: { token, rng, hmac: serverHmac }
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(200).json({ status: false, reason: 'Internal server error' });
  }
}

async function logAttempt(supabase, key_value, serial, is_success, reason, req) {
  try {
    await supabase.from('login_logs').insert({
      key_value,
      serial,
      is_success,
      reason,
      ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
  } catch (e) {
    console.error('Log error:', e);
  }
}
