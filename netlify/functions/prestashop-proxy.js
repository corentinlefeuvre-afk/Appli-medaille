// netlify/functions/prestashop-proxy.js
// Proxy serverless pour les appels PrestaShop
// Tourne côté serveur Netlify → pas de CORS

const PS_URL  = 'https://boutique-preprod.protection-civile.org/api';
const PS_KEY  = '5EPPRQ2EFSRG8Z3DF1PT2YF8MVWGDY1M';
const PS_AUTH = 'Basic ' + Buffer.from(PS_KEY + ':').toString('base64');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  'https://appli-medaille.netlify.app',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  const { path, method = 'GET', xml } = body;
  if (!path) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing path' }) };

  const url = `${PS_URL}${path}${path.includes('?') ? '&' : '?'}output_format=JSON`;

  try {
    const opts = {
      method,
      headers: {
        'Authorization': PS_AUTH,
        'Accept': 'application/json',
        'Output-Format': 'JSON',
        ...(xml ? { 'Content-Type': 'application/xml' } : {}),
      },
      ...(xml ? { body: xml } : {}),
    };

    const res  = await fetch(url, opts);
    const text = await res.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return {
      statusCode: res.status,
      headers,
      body: JSON.stringify({ ok: res.ok, status: res.status, data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
