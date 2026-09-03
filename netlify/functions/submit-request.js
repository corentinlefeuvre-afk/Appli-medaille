// ════════════════════════════════════════════════════════════════════════════
//  Enregistrement d'une demande envoyée depuis le formulaire public.
//  Le formulaire ne contient AUCUNE clé : c'est cette fonction (côté serveur)
//  qui écrit dans Supabase, avec une clé stockée dans les variables Netlify.
//
//  Variables Netlify attendues :
//    SUPABASE_URL          (ex. https://xxxx.supabase.co)
//    SUPABASE_SERVICE_KEY  (clé service_role — reste côté serveur)
// ════════════════════════════════════════════════════════════════════════════

const MEDALS = {
  temoignage: { id:'temoignage', label:'Témoignage de Reconnaissance',  shortLabel:'TDR',        years:2,  category:'temoignage',      color:'#8B7355', light:'#f5f0e8', payant:true  },
  bronze:     { id:'bronze',     label:'Médaille Échelon Bronze',        shortLabel:'Bronze',     years:5,  category:'medaille',        color:'#CD7F32', light:'#fdf3e3', payant:false },
  argent:     { id:'argent',     label:'Médaille Échelon Argent',        shortLabel:'Argent',     years:10, category:'medaille',        color:'#9BA7B0', light:'#f0f4f8', payant:false },
  vermeil:    { id:'vermeil',    label:'Médaille Échelon Vermeil',       shortLabel:'Vermeil',    years:15, category:'medaille',        color:'#CC5500', light:'#fff0e6', payant:false },
  grand_or:   { id:'grand_or',   label:'Médaille Échelon Grand Or',      shortLabel:'Grand Or',   years:20, category:'medaille',        color:'#CFB53B', light:'#fffbea', payant:false },
  gm_argent:  { id:'gm_argent',  label:'Grande Médaille Échelon Argent', shortLabel:'Gr. Argent', years:30, category:'grande_medaille', color:'#8C8C8C', light:'#f5f5f5', payant:false },
  gm_or:      { id:'gm_or',      label:'Grande Médaille Échelon Or',     shortLabel:'Gr. Or',     years:40, category:'grande_medaille', color:'#D4AF37', light:'#fefbe6', payant:false },
};

const AGRAFE = 'Feux de Forêt';
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);

export const handler = async (event) => {
  const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error:'Méthode non autorisée' }) };

  const URL_SB = process.env.SUPABASE_URL;
  const KEY_SB = process.env.SUPABASE_SERVICE_KEY;
  if (!URL_SB || !KEY_SB) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error:"Configuration serveur incomplète (SUPABASE_URL / SUPABASE_SERVICE_KEY manquantes dans Netlify)." }) };
  }

  const sb = async (path, opts = {}) => {
    const res = await fetch(`${URL_SB}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}`, 'Content-Type':'application/json', ...(opts.headers||{}) },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status} : ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };

  try {
    const p = JSON.parse(event.body || '{}');

    // ── Validation côté serveur ──
    const email     = clean(p.email, 160);
    const demandeur = clean(p.demandeur, 120);
    const dept      = clean(p.dept, 120);
    const nom       = clean(p.nom, 80);
    const prenom    = clean(p.prenom, 80);
    const annee     = parseInt(p.annee, 10);
    const medal     = MEDALS[clean(p.medal, 20)];
    const just      = clean(p.just, 4000);

    const manque = [];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) manque.push('e-mail valide');
    if (!demandeur) manque.push('nom du demandeur');
    if (!dept)      manque.push('département');
    if (!nom)       manque.push('nom');
    if (!prenom)    manque.push('prénom');
    if (!annee || annee < 1950 || annee > new Date().getFullYear()) manque.push("année d'adhésion valide");
    if (!medal)     manque.push('distinction');
    if (!just)      manque.push('motivations');
    if (manque.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error:`Données incomplètes : ${manque.join(', ')}.` }) };
    }

    // ── Numéro de demande (calculé côté serveur) ──
    const an = new Date().getFullYear();
    const rows = await sb(`app_requests?select=id&id=like.REQ-${an}-*`);
    let max = 0;
    (rows||[]).forEach(r => { const n = parseInt(String(r.id).split('-')[2], 10); if (!isNaN(n) && n > max) max = n; });
    const id = `REQ-${an}-${String(max+1).padStart(3,'0')}`;

    const today = new Date().toISOString().split('T')[0];
    const ans = an - annee;
    const commentaire = [clean(p.commentaire, 2000), `Agrafe souhaitée : ${AGRAFE}`].filter(Boolean).join(' — ');

    const demande = {
      id, diplomeId:null, statut:'soumis',
      benevole: {
        id: `${prenom}-${nom}`.toLowerCase().replace(/\W+/g,'-'), type:'benevole',
        nom, prenom, genre: p.genre === 'F' ? 'F' : 'M', annee,
        antenne: clean(p.antenne, 120), dept, adhesion:'', ans,
        fonctions: clean(p.fonctions, 500), distinctions: clean(p.distinctions, 500),
      },
      medalType: medal,
      demandeur, emailDemandeur: email,
      dept, niveau:'antenne', dateCreation: today, notifications:true,
      agrafe: medal.id !== 'temoignage', agrafeDepts:[],
      paiement: medal.payant ? 'en_attente' : null, expedition:null,
      justification: just, dateReception:'',
      commentaire,
      historique: [{ date: today, action:'Demande soumise via le formulaire', auteur: demandeur, comment:'Saisie hors application' }],
    };

    await sb('app_requests', {
      method:'POST',
      headers:{ Prefer:'return=minimal' },
      body: JSON.stringify({ id, data: demande, dept, statut:'soumis' }),
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok:true, id }) };
  } catch (e) {
    console.error('submit-request', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
