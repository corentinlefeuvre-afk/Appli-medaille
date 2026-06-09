// netlify/functions/prestashop-proxy.js
// Proxy serverless pour les appels PrestaShop
// Tourne côté serveur Netlify → pas de CORS

const PS_URL  = 'https://boutique-preprod.protection-civile.org/api';
const PS_KEY  = '5EPPRQ2EFSRG8Z3DF1PT2YF8MVWGDY1M';
const PS_AUTH = 'Basic ' + Buffer.from(PS_KEY + ':').toString('base64');

// Timeout en ms pour éviter qu'une PS lente bloque indéfiniment
const TIMEOUT_MS = 15000;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',   // autorise aussi les previews Netlify
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Health-check minimal (GET sans body)
  if (event.httpMethod === 'GET' && !event.body) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'prestashop-proxy opérationnel' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  const { path, method = 'GET', xml } = body;
  if (!path) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing path' }) };

  const url = `${PS_URL}${path}${path.includes('?') ? '&' : '?'}output_format=JSON`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const opts = {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': PS_AUTH,
        'Accept': 'application/json',
        'Output-Format': 'JSON',
        ...(xml ? { 'Content-Type': 'application/xml' } : {}),
      },
      ...(xml ? { body: xml } : {}),
    };

    let res, text;
    try {
      res  = await fetch(url, opts);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return {
      statusCode: res.status,
      headers,
      body: JSON.stringify({ ok: res.ok, status: res.status, data }),
    };
  } catch (err) {
    // AbortError = timeout
    if (err.name === 'AbortError') {
      return {
        statusCode: 504,
        headers,
        body: JSON.stringify({ error: `PrestaShop n'a pas répondu dans les ${TIMEOUT_MS / 1000}s (timeout)` }),
      };
    }
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
