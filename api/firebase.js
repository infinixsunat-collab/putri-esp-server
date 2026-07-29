// Firebase-compatible API endpoints for inject-mod
// Mimics Firebase Realtime Database REST API
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── PARSE REQUEST PATH ─────────────────────────────────
// Vercel rewrites /keys.json → /api/firebase
// After rewrite, req.url still contains the original path
// Examples:
//   /keys.json
//   /keys/NXE-FREE/devices.json
//   /keys/NXE-FREE/devices/DEVICE_ID.json
//   /bannedDevices/KDF_ID.json
function parseFirebasePath(url) {
  // Remove query string
  const path = url.split('?')[0];
  
  // /keys.json
  if (path === '/keys.json') {
    return { type: 'keys_list' };
  }
  
  // /keys/<keyName>/devices.json or /keys/<keyName>/devices/<devId>.json
  const keysMatch = path.match(/^\/keys\/([^\/]+)\/devices(?:\/([^\/]+))?\.json$/);
  if (keysMatch) {
    return {
      type: keysMatch[2] ? 'device_register' : 'device_list',
      keyName: keysMatch[1],
      devId: keysMatch[2] || null
    };
  }
  
  // /bannedDevices/<kdfId>.json
  const banMatch = path.match(/^\/bannedDevices\/([^\/]+)\.json$/);
  if (banMatch) {
    return { type: 'banned_check', kdfId: banMatch[1] };
  }
  
  return null;
}

// ── MAIN HANDLER ────────────────────────────────────────
export default async function handler(req, res) {
  // Set CORS
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const parsed = parseFirebasePath(req.url);
    if (!parsed) {
      return res.status(404).json({ error: 'Not found: ' + req.url });
    }

    // ── GET /keys.json ──────────────────────────────────────
    if (parsed.type === 'keys_list') {
      const { data: keys, error } = await supabase
        .from('user_keys')
        .select('*')
        .eq('is_active', true);

      if (error) {
        return res.status(200).json({});
      }

      const result = {};
      for (const k of keys || []) {
        const devices = {};
        for (const devId of (k.registered_serials || [])) {
          devices[devId] = true;
        }

        result[k.key_value] = {
          type: 'FREE',
          status: 'KOSKESHA',
          startDate: new Date(k.created_at).toISOString().split('T')[0],
          endDate: '2027-12-31',
          maxDevice: k.max_devices || 5,
          devices: devices
        };
      }

      return res.status(200).json(result);
    }

    // ── GET /keys/<keyName>/devices.json ────────────────────
    if (parsed.type === 'device_list') {
      const { data: keyData } = await supabase
        .from('user_keys')
        .select('registered_serials')
        .eq('key_value', parsed.keyName)
        .single();

      const devices = {};
      for (const devId of (keyData?.registered_serials || [])) {
        devices[devId] = true;
      }
      return res.status(200).json(devices);
    }

    // ── PUT /keys/<keyName>/devices/<devId>.json ────────────
    if (parsed.type === 'device_register') {
      if (req.method !== 'PUT') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const { data: keyData, error } = await supabase
        .from('user_keys')
        .select('*')
        .eq('key_value', parsed.keyName)
        .single();

      if (error || !keyData) {
        return res.status(200).json(false);
      }

      if (!keyData.is_active) {
        return res.status(200).json(false);
      }

      const serials = keyData.registered_serials || [];
      
      if (!serials.includes(parsed.devId)) {
        if (serials.length >= keyData.max_devices) {
          return res.status(200).json(false);
        }
        
        serials.push(parsed.devId);
        await supabase
          .from('user_keys')
          .update({
            registered_serials: serials,
            used_count: serials.length,
            is_used: true,
            last_used_at: new Date().toISOString()
          })
          .eq('id', keyData.id);
      }

      return res.status(200).json(true);
    }

    // ── GET /bannedDevices/<kdfId>.json ─────────────────────
    if (parsed.type === 'banned_check') {
      return res.status(200).json(null);
    }

    return res.status(404).json({ error: 'Unhandled path' });

  } catch (err) {
    console.error('Firebase handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
