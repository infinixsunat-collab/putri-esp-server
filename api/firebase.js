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

// ── DEVICE FINGERPRINT ──────────────────────────────────
function getDeviceId(pathParts) {
  // Path: /firebase/keys/<keyName>/devices/<devId>.json
  // We need devId which is the 5th segment (index 4)
  if (pathParts.length >= 5 && pathParts[3] === 'devices') {
    return pathParts[4].replace(/\.json$/i, '');
  }
  return null;
}

function getKeyName(pathParts) {
  // Path: /firebase/keys/<keyName>/...
  if (pathParts.length >= 2) {
    return pathParts[1];
  }
  return null;
}

function getSubPath(pathParts) {
  // Path: /firebase/keys/<keyName>/<subPath>.json
  if (pathParts.length >= 3) {
    return pathParts[2].replace(/\.json$/i, '');
  }
  return null;
}

// ── PARSE REQUEST URL ───────────────────────────────────
function parseRequest(url) {
  // Expected formats:
  //   GET  /firebase/keys.json
  //   GET  /firebase/keys/<keyName>/devices.json
  //   PUT  /firebase/keys/<keyName>/devices/<devId>.json
  const cleanPath = url.replace(/\/+$/, '');
  const parts = cleanPath.split('/');
  
  // parts[0] = '' (empty before first /)
  // parts[1] = 'firebase'
  // parts[2] = 'keys'
  // parts[3] = keyName (or null for /keys.json)
  // parts[4] = subPath (devices, bannedDevices, etc.)
  // parts[5] = deviceId (or null)
  
  if (parts[1] !== 'firebase' || parts[2] !== 'keys') {
    return null;
  }
  
  return parts;
}

// ── MAIN HANDLER ────────────────────────────────────────
export default async function handler(req, res) {
  // Set CORS
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const pathParts = parseRequest(req.url);
    if (!pathParts) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // ── GET /keys.json ──────────────────────────────────────
    // Returns all keys with their metadata
    if (pathParts.length === 3) {
      // Fetch all key pairs from user_keys table
      const { data: keys, error } = await supabase
        .from('user_keys')
        .select('key_value, max_devices, is_active, created_at')
        .eq('is_active', true);

      if (error) {
        console.error('DB error:', error);
        return res.status(200).json({});
      }

      // Build Firebase-compatible response
      const result = {};
      for (const k of keys || []) {
        const keyName = k.key_value;
        
        // Get registered devices for this key
        const { data: keyData } = await supabase
          .from('user_keys')
          .select('registered_serials')
          .eq('key_value', keyName)
          .single();
        
        const devices = {};
        if (keyData?.registered_serials) {
          for (const devId of keyData.registered_serials) {
            devices[devId] = true;
          }
        }

        result[keyName] = {
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
    if (pathParts.length === 4 && getSubPath(pathParts) === 'devices') {
      const keyName = getKeyName(pathParts);
      
      const { data: keyData, error } = await supabase
        .from('user_keys')
        .select('registered_serials')
        .eq('key_value', keyName)
        .single();

      if (error || !keyData) {
        return res.status(200).json({});
      }

      const devices = {};
      for (const devId of (keyData.registered_serials || [])) {
        devices[devId] = true;
      }

      return res.status(200).json(devices);
    }

    // ── PUT /keys/<keyName>/devices/<devId>.json ────────────
    if (pathParts.length === 5 && pathParts[3] === 'devices') {
      const keyName = getKeyName(pathParts);
      const devId = pathParts[4].replace(/\.json$/i, '');
      
      if (req.method !== 'PUT') {
        return res.status(405).json({ error: 'Use PUT' });
      }

      // Get current key data
      const { data: keyData, error: fetchError } = await supabase
        .from('user_keys')
        .select('*')
        .eq('key_value', keyName)
        .single();

      if (fetchError || !keyData) {
        return res.status(200).json({ error: 'Key not found' });
      }

      if (!keyData.is_active) {
        return res.status(200).json({ error: 'Key inactive' });
      }

      const serials = keyData.registered_serials || [];
      
      // Don't add if already exists
      if (!serials.includes(devId)) {
        if (serials.length >= keyData.max_devices) {
          return res.status(200).json({ error: 'Device limit reached' });
        }
        
        serials.push(devId);
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

      // Firebase returns the value that was PUT (true)
      return res.status(200).json(true);
    }

    // ── GET /keys/<keyName>/bannedDevices/<kdfId>.json ─────
    if (pathParts.length === 5 && pathParts[3] === 'bannedDevices') {
      // No banned devices
      return res.status(200).json(null);
    }

    return res.status(404).json({ error: 'Not found' });

  } catch (err) {
    console.error('Firebase handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
