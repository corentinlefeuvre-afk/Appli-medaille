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

  const URL_SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const KEY_SB = (process.env.SUPABASE_SERVICE_KEY || '').trim().replace(/^Bearer\s+/i, '');
  if (!URL_SB) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error:"Configuration serveur incomplète : SUPABASE_URL manquante dans les variables Netlify." }) };
  }

  // Certaines clés Supabase (nouveau format sb_secret_…) n'acceptent pas les mêmes
  // en-têtes que les anciennes : on essaie les variantes, puis on retombe sur la
  // clé publique (déjà publique dans l'app) pour ne pas bloquer le formulaire.
  const KEY_FALLBACK = (process.env.SUPABASE_ANON_KEY || 'sb_publishable_wQ6UUNhMZI3D1yk_G-FJEw_F6Er5-6y').trim();
  const STRATEGIES = [
    { nom:'apikey+bearer(secret)', h: k => ({ apikey:k, Authorization:`Bearer ${k}` }), key: KEY_SB },
    { nom:'apikey(secret)',        h: k => ({ apikey:k }),                              key: KEY_SB },
    { nom:'bearer(secret)',        h: k => ({ Authorization:`Bearer ${k}` }),           key: KEY_SB },
    { nom:'apikey+bearer(public)', h: k => ({ apikey:k, Authorization:`Bearer ${k}` }), key: KEY_FALLBACK },
  ].filter(s => s.key);

  let auth = null; // stratégie retenue une fois validée

  const call = async (path, opts = {}, headers) => fetch(`${URL_SB}/rest/v1/${path}`, {
    ...opts,
    headers: { 'Content-Type':'application/json', ...headers, ...(opts.headers||{}) },
  });

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error:'Méthode non autorisée' }) };

  // Détermine la stratégie qui fonctionne (test en lecture)
  const resoudreAuth = async () => {
    const essais = [];
    for (const s of STRATEGIES) {
      const res = await call('app_requests?select=id&limit=1', {}, s.h(s.key));
      if (res.ok) { auth = s; return s; }
      essais.push(`${s.nom} → ${res.status}`);
    }
    const apercu = KEY_SB ? `${KEY_SB.slice(0,11)}…(${KEY_SB.length} car.)` : 'vide';
    throw new Error(`Aucune clé acceptée par Supabase. Essais : ${essais.join(' ; ')}. Clé secrète lue : ${apercu}. Vérifiez qu'elle appartient bien au projet ${URL_SB} et qu'elle n'a pas été régénérée.`);
  };

  const sb = async (path, opts = {}) => {
    if (!auth) await resoudreAuth();
    const res = await call(path, opts, auth.h(auth.key));
    if (!res.ok) throw new Error(`Supabase ${res.status} : ${await res.text()}`);
    const txt = await res.text();          // corps vide après une écriture (Prefer: return=minimal)
    return txt ? JSON.parse(txt) : null;
  };

  try {
    const p = JSON.parse(event.body || '{}');

    // ── Champs communs ──
    const email     = clean(p.email, 160);
    const demandeur = clean(p.demandeur, 120);
    const dept      = clean(p.dept, 120);
    const antenne   = clean(p.antenne, 120);
    const commentaireCommun = clean(p.commentaire, 2000);

    const errs = [];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.push('e-mail valide');
    if (!demandeur) errs.push('nom du demandeur');
    if (!dept)      errs.push('département');

    // Compatibilité : une seule demande (ancien format) ou plusieurs lignes
    const brutes = Array.isArray(p.lignes) && p.lignes.length ? p.lignes : [p];
    if (!brutes.length) errs.push('au moins un récipiendaire');
    if (brutes.length > 50) errs.push('50 lignes maximum par envoi');

    const an = new Date().getFullYear();
    const valides = [];
    brutes.forEach((b, i) => {
      const nom    = clean(b.nom, 80);
      const prenom = clean(b.prenom, 80);
      const annee  = parseInt(b.annee, 10);
      const medal  = MEDALS[clean(b.medal, 20)];
      const just   = clean(b.just, 4000);
      const manque = [];
      if (!nom)    manque.push('nom');
      if (!prenom) manque.push('prénom');
      if (!annee || annee < 1950 || annee > an) manque.push("année d'adhésion");
      if (!medal)  manque.push('distinction');
      if (!just)   manque.push('motivations');
      if (manque.length) { errs.push(`ligne ${i+1} : ${manque.join(', ')}`); return; }
      valides.push({ nom, prenom, annee, medal, just,
        genre: b.genre === 'F' ? 'F' : 'M',
        fonctions: clean(b.fonctions, 500), distinctions: clean(b.distinctions, 500) });
    });

    if (errs.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error:`Données incomplètes : ${errs.join(' ; ')}.` }) };
    }

    // ── Numérotation (une seule lecture, puis incrément) ──
    const rows = await sb(`app_requests?select=id&id=like.REQ-${an}-*`);
    let max = 0;
    (rows||[]).forEach(r => { const n = parseInt(String(r.id).split('-')[2], 10); if (!isNaN(n) && n > max) max = n; });

    const today = new Date().toISOString().split('T')[0];
    const ids = [];
    const lots = valides.map((v) => {
      const id = `REQ-${an}-${String(++max).padStart(3,'0')}`;
      ids.push(id);
      const commentaire = [commentaireCommun, `Agrafe souhaitée : ${AGRAFE}`].filter(Boolean).join(' — ');
      const demande = {
        id, diplomeId:null, statut:'en_commission',
        benevole: {
          id: `${v.prenom}-${v.nom}`.toLowerCase().replace(/\W+/g,'-'), type:'benevole',
          nom: v.nom, prenom: v.prenom, genre: v.genre, annee: v.annee,
          antenne, dept, adhesion:'', ans: an - v.annee,
          fonctions: v.fonctions, distinctions: v.distinctions,
        },
        medalType: v.medal,
        demandeur, emailDemandeur: email,
        dept, niveau:'antenne', dateCreation: today, notifications:true,
        agrafe: v.medal.id !== 'temoignage', agrafeDepts:[],
        paiement: v.medal.payant ? 'en_attente' : null, expedition:null,
        justification: v.just, dateReception:'',
        commentaire,
        commissionVotes: [],
        historique: [{ date: today, action:'Demande soumise via le formulaire', auteur: demandeur, comment:"Saisie hors application — transmise directement à la Commission FNPC." }],
      };
      return { id, data: demande, dept, statut:'en_commission' };
    });

    await sb('app_requests', {
      method:'POST',
      headers:{ Prefer:'return=minimal' },
      body: JSON.stringify(lots),
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok:true, ids, id: ids[0] }) };

  } catch (e) {
    console.error('submit-request', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
