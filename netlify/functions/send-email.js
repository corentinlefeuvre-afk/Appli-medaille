// netlify/functions/send-email.js
// Envoi d'e-mails côté serveur via SMTP (nodemailer).
// Tourne côté Netlify → pas de CORS, et les identifiants SMTP ne sont jamais exposés au navigateur.
// Variables à configurer dans Netlify → Site settings → Environment variables :
//   SMTP_HOST = smtp.votre-serveur.fr
//   SMTP_PORT = 587            (465 = SSL, 587 = STARTTLS)
//   SMTP_USER = compte SMTP    (optionnel selon serveur)
//   SMTP_PASS = mot de passe   (optionnel selon serveur)
//   SMTP_FROM = "FNPC Médailles <noreply@protection-civile.fr>"
//
// En prod sur vos serveurs : pointez SMTP_HOST vers votre serveur mail interne.
// Pour swapper vers un fournisseur (Brevo, Resend…), seul ce fichier change.

const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Méthode non autorisée' }) };
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_FROM) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ ok: false, error: 'E-mail non configuré : SMTP_HOST et SMTP_FROM manquants dans les variables Netlify.' }),
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Corps JSON invalide' }) }; }

  const { to, subject, body, html, cc } = payload;
  if (!to || !subject) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Champs "to" et "subject" requis' }) };
  }

  try {
    const port = Number(SMTP_PORT) || 587;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,                         // 465 = SSL implicite, sinon STARTTLS
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to,
      cc: cc || undefined,
      subject,
      text: body || '',
      html: html || (body || '').replace(/\n/g, '<br>'),
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, messageId: info.messageId }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }) };
  }
};
