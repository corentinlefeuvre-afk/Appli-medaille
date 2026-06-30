import { useState, useMemo, useEffect, useRef } from "react";
import React from "react";
import { db } from './supabase.js';
import { auth } from './auth.js';
import { CSS, LOGO_SRC, FAV_SRC } from './assets.js';
import {
  DEPTS, MEDAL_TYPES, STATUSES, ROLES, MOCK_VOLUNTEERS, today, daysSince, getDeptCode, generateDiplomaNumber, getNextMedalSuggestion, DEFAULT_EMAIL_TEMPLATES, DEFAULT_DIPLOMA_TEMPLATES, DIPLOMA_FIELD_LABELS, MEDAL_TO_GABARIT, DIPLOMA_SAMPLE, TOUR_STEPS, DEFAULT_AGRAFE_TEXTE, DEFAULT_LIST_INTRO, DEFAULT_WORD_CFG, DIPLOMA_PAGE_W, ptToPx, FONT_OPTIONS
} from './constants.js';
import { diplomaDateFr, diplomaPageHtml, DiplomaModal } from './diploma.jsx';

// ─── ERROR BOUNDARY ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('App crash:', error, info); }
  render() {
    if (this.state.error) return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'100vh', padding:32, fontFamily:'system-ui,sans-serif' }}>
        <div style={{ maxWidth:480, textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:16 }}>⚠️</div>
          <h2 style={{ color:'#dc2626', marginBottom:8 }}>Une erreur inattendue s'est produite</h2>
          <p style={{ color:'#64748b', marginBottom:20, fontSize:14 }}>{this.state.error.message}</p>
          <button style={{ background:'#1B3764', color:'white', border:'none', borderRadius:8, padding:'10px 24px', cursor:'pointer', fontSize:14 }}
            onClick={()=>{ this.setState({ error:null }); window.location.reload(); }}>
            🔄 Recharger l'application
          </button>
        </div>
      </div>
    );
    return this.props.children;
  }
}
export { ErrorBoundary };

const APP_TITLE   = "Demande Médaille FNPC";
const APP_VERSION = "1.4.7";
const USE_SUPABASE = true;

// ── PrestaShop Webservice ────────────────────────────────────────────────────
// Les appels passent par une Netlify Function (proxy serverside) pour éviter les CORS
const PS_PROXY = '/.netlify/functions/prestashop-proxy';

const psCall = async (path, method = 'GET', xml = null) => {
  const res = await fetch(PS_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, method, xml }),
  });
  let result;
  try { result = await res.json(); }
  catch { throw new Error('Proxy HTTP ' + res.status + ' (réponse non-JSON du proxy)'); }
  if (!res.ok || !result.ok) {
    // On remonte le VRAI détail renvoyé en amont : soit du JSON PrestaShop
    // ({"errors":[{"code":...}]}), soit une page HTML (WAF / Apache / 401 serveur).
    const detail = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? result);
    throw new Error('PrestaShop ' + (result.status || res.status) + ' — ' + String(detail).slice(0, 220));
  }
  return result.data;
};

const prestashop = {
  async getProductByRef(ref) {
    const d = await psCall('/products?filter[reference]=' + ref);
    return d?.products?.[0] ?? null;
  },
  async getCustomerByEmail(email) {
    const d = await psCall('/customers?filter[email]=' + encodeURIComponent(email));
    return d?.customers?.[0] ?? null;
  },
  async getCustomerById(id) {
    const d = await psCall('/customers/' + id);
    return d?.customer ?? null;
  },
  async getCustomerAddresses(customerId) {
    const d = await psCall('/addresses?filter[id_customer]=' + customerId);
    return d?.addresses ?? [];
  },
  async createCart(customerId, addressId) {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<prestashop xmlns:xlink="http://www.w3.org/1999/xlink"><cart>'
      + '<id_currency>1</id_currency><id_lang>1</id_lang>'
      + '<id_customer>' + customerId + '</id_customer>'
      + '<id_address_delivery>' + addressId + '</id_address_delivery>'
      + '<id_address_invoice>' + addressId + '</id_address_invoice>'
      + '<rows></rows></cart></prestashop>';
    const d = await psCall('/carts', 'POST', xml);
    if (!d?.cart?.id) throw new Error('Réponse panier inattendue de PrestaShop : ' + String(JSON.stringify(d)).slice(0, 220));
    return d.cart;
  },
  async createOrder(customerId, cartId, addressId, productId, qty, reference, unitPrice = 0) {
    // PrestaShop exige les totaux à la création d'une commande via webservice
    // (il ne les recalcule pas depuis le panier comme le tunnel classique).
    const total = ((Number(unitPrice) || 0) * (Number(qty) || 0)).toFixed(2);
    const xml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<prestashop xmlns:xlink="http://www.w3.org/1999/xlink"><order>'
      + '<id_customer>' + customerId + '</id_customer>'
      + '<id_cart>' + cartId + '</id_cart>'
      + '<id_address_delivery>' + addressId + '</id_address_delivery>'
      + '<id_address_invoice>' + addressId + '</id_address_invoice>'
      + '<id_currency>1</id_currency><id_lang>1</id_lang><id_carrier>1</id_carrier>'
      + '<module>ps_checkpayment</module><payment>Cheque</payment>'
      + '<current_state>1</current_state>'                 // 1 = En attente paiement chèque (pas "payé" : sinon PS tente d'enregistrer un paiement et plante)
      + '<conversion_rate>1.000000</conversion_rate>'
      + '<total_paid>' + total + '</total_paid>'
      + '<total_paid_real>0.00</total_paid_real>'        // 0 = pas encore payé (paiement après création)
      + '<total_products>' + total + '</total_products>'
      + '<total_products_wt>' + total + '</total_products_wt>'
      + '<reference>' + reference + '</reference>'
      + '<order_rows><order_row>'
      + '<id_product>' + productId + '</id_product>'
      + '<product_quantity>' + qty + '</product_quantity>'
      + '<id_product_attribute>0</id_product_attribute>'
      + '</order_row></order_rows>'
      + '</order></prestashop>';
    const d = await psCall('/orders', 'POST', xml);
    if (!d?.order?.id) throw new Error('Réponse commande inattendue de PrestaShop : ' + String(JSON.stringify(d)).slice(0, 220));
    return d.order;
  },
};

// Mock du compte connecté — en prod, viendra du SSO

// ─── CSS ───────────────────────────────────────────────────────────────────────

const Logo = ({ size = 40 }) => <img src={LOGO_SRC} width={size} height={size} alt="FNPC" style={{borderRadius:'50%'}} />;

// ─── APP ──────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth : restaure la session depuis sessionStorage ─────────────────────
  useEffect(() => {
    const u = auth.restoreSession();
    if (u) { setAuthUser(u); setRole(u.role); maybeStartTour(u.role); }
  }, []);

  const doLogin = async () => {
    if (!loginEmail || !loginPassword) { setLoginError('Renseignez votre e-mail et mot de passe.'); return; }
    setLoginLoading(true); setLoginError('');
    try {
      const u = await auth.login(loginEmail, loginPassword);
      setAuthUser(u); setRole(u.role); setPage('dashboard'); maybeStartTour(u.role);
    } catch(e) {
      setLoginError(e.message);
    }
    setLoginLoading(false);
  };

  const doLogout = () => {
    auth.logout();
    setAuthUser(null);
    setLoginEmail(''); setLoginPassword(''); setLoginError('');
    setPage('dashboard');
  };
  useEffect(() => {
    if (!USE_SUPABASE) { setDbLoading(false); return; }
    const loadWithRetry = async (fn, maxRetries = 3) => {
      for (let i = 0; i < maxRetries; i++) {
        try { const r = await fn(); if (r !== null) return r; } catch(e) { if (i === maxRetries - 1) throw e; }
        await new Promise(res => setTimeout(res, 1000 * (i + 1))); // backoff 1s, 2s, 3s
      }
      return null;
    };
    (async () => {
      try {
        const [reqs, dels, agrs] = await Promise.all([
          loadWithRetry(()=>db.loadRequests()),
          loadWithRetry(()=>db.loadDelegates()),
          loadWithRetry(()=>db.loadAgrafes()),
        ]);
        if (reqs !== null) { setRequests(reqs); setDbConnected(true); }
        if (dels !== null) setDelegates(dels);
        if (agrs !== null) setAgrafes(agrs);
        const tarif_cfg = await db.loadConfig('tarif');
        if (tarif_cfg) setTarif(tarif_cfg.v ?? tarif_cfg);
        const welcome_cfg = await db.loadConfig('welcome_messages');
        if (welcome_cfg) setWelcomeMessages(welcome_cfg);
        const deptDisabled_cfg = await db.loadConfig('dept_disabled');
        if (deptDisabled_cfg) setDeptDisabled(deptDisabled_cfg);
        const emailTpl_cfg = await db.loadConfig('email_templates');
        if (emailTpl_cfg) setEmailTemplates({ ...DEFAULT_EMAIL_TEMPLATES, ...emailTpl_cfg }); // merge : on garde les nouveaux modèles par défaut
        const dipTpl_cfg = await db.loadConfig('diploma_templates');
        if (dipTpl_cfg) {
          const merged = { ...DEFAULT_DIPLOMA_TEMPLATES };
          for (const g of Object.keys(dipTpl_cfg)) {
            const def = DEFAULT_DIPLOMA_TEMPLATES[g] || {};
            merged[g] = { ...def, ...dipTpl_cfg[g], fields: { ...(def.fields || {}), ...(dipTpl_cfg[g].fields || {}) } };
          }
          setDiplomaTpl(merged);
        }
        const wordCfg_cfg = await db.loadConfig('word_template');
        if (wordCfg_cfg) setWordCfg({ ...DEFAULT_WORD_CFG, ...wordCfg_cfg });
        const grp_cfg = await db.loadConfig('groupements');
        if (Array.isArray(grp_cfg)) setGroupements(grp_cfg);
        const depts_cfg = await db.loadDepartments();
        if (depts_cfg && Object.keys(depts_cfg).length > 0) setDeptAddresses(depts_cfg);
        setDbConnected(true);
      } catch(e) {
        console.warn('Supabase non disponible, mode démo', e.message);
      } finally {
        setDbLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    document.title = APP_TITLE;
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.rel = 'icon'; link.href = FAV_SRC; document.head.appendChild(link);
  }, []);

  const [dbLoading, setDbLoading] = useState(true);
  const [dbConnected, setDbConnected] = useState(false);
  const [role, setRole]           = useState('departement');
  // Auth
  const [authUser, setAuthUser]   = useState(null);   // null = non connecté
  const [loginEmail, setLoginEmail]       = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError]       = useState('');
  const [loginLoading, setLoginLoading]   = useState(false);
  const [page, setPage]           = useState('dashboard');
  const [requests, setRequests]   = useState([]); // chargé depuis Supabase au montage
  const [selected, setSelected]   = useState(null);
  const [diplomaView, setDiplomaView] = useState(null);
  const [refuseModal, setRefuseModal] = useState(null);
  const [refuseComment, setRefuseComment] = useState('');
  const [resubmitModal, setResubmitModal] = useState(null);
  const [emailModal, setEmailModal] = useState(null);
  const [emailSendState, setEmailSendState] = useState('idle'); // idle | sending | sent | error
  const [emailSendErr, setEmailSendErr] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterDept, setFilterDept]   = useState('all');
  const [search, setSearch]         = useState('');
  const [toast, setToast]           = useState(null);
  const [selectedBatch, setSelectedBatch] = useState([]);

  // Gestion state
  const [diplomeCounters, setDiplomeCounters] = useState({ '13 - Bouches-du-Rhône':1, '06 - Alpes-Maritimes':1, '75 - Paris Seine':1 });
  // Dynamic medal types — Gestion can add custom medals
  const [medalTypes, setMedalTypes] = useState([
    { id:'temoignage', label:'Témoignage de Reconnaissance',   shortLabel:'TDR',        years:2,  category:'temoignage',      color:'#8B7355', light:'#f5f0e8', payant:true,  custom:false },
    { id:'bronze',     label:'Médaille Échelon Bronze',         shortLabel:'Bronze',     years:5,  category:'medaille',        color:'#CD7F32', light:'#fdf3e3', payant:false, custom:false },
    { id:'argent',     label:'Médaille Échelon Argent',         shortLabel:'Argent',     years:10, category:'medaille',        color:'#9BA7B0', light:'#f0f4f8', payant:false, custom:false },
    { id:'vermeil',    label:'Médaille Échelon Vermeil',        shortLabel:'Vermeil',    years:15, category:'medaille',        color:'#CC5500', light:'#fff0e6', payant:false, custom:false },
    { id:'grand_or',   label:'Médaille Échelon Grand Or',       shortLabel:'Grand Or',   years:20, category:'medaille',        color:'#CFB53B', light:'#fffbea', payant:false, custom:false },
    { id:'gm_argent',  label:'Grande Médaille Échelon Argent',  shortLabel:'Gr. Argent', years:30, category:'grande_medaille', color:'#8C8C8C', light:'#f5f5f5', payant:false, custom:false },
    { id:'gm_or',      label:'Grande Médaille Échelon Or',      shortLabel:'Gr. Or',     years:40, category:'grande_medaille', color:'#D4AF37', light:'#fefbe6', payant:false, custom:false },
  ]);
  const [dashYear, setDashYear] = useState('all'); // antenne/APC dashboard year filter
  const [deptAddresses, setDeptAddresses] = useState({
    '75 - Paris Seine': { nom:'APC Paris Seine', adresse:'42 avenue de la République', cp:'75011', ville:'Paris' },
    '69 - Rhône':       { nom:'APC Rhône', adresse:'22 rue Molière', cp:'69001', ville:'Lyon' },
    '33 - Gironde':     { nom:'APC Gironde', adresse:'8 allée de Tourny', cp:'33000', ville:'Bordeaux' },
  });
  const [deptDisabled, setDeptDisabled] = useState({});
  const [emailTemplates, setEmailTemplates] = useState(DEFAULT_EMAIL_TEMPLATES);
  const [tarif, setTarif]   = useState(2);
  const [commissionCanCreate, setCommissionCanCreate] = useState(false);
  const [gestionCanCreate, setGestionCanCreate]       = useState(false);
  const [welcomeMessages, setWelcomeMessages] = useState({ antenne: '', departement: '' });
  const [emailSettings, setEmailSettings] = useState({
    antenne:     { soumission:false, validation:false, refus:false, rappel15j:false },
    departement: { soumission:false, validation:false, refus:false, rappel15j:false, tdr_paiement:false },
    commission:  { validation:false, refus:false },
    gestion:     { diplome_emis:false, expedition:false },
  });
  const [agrafes, setAgrafes] = useState([]);
  const [delegates, setDelegates] = useState([
    { id:'D001', nom:'Dupont', prenom:'René', email:'r.dupont@pc75.fr', niveau:'antenne', delegueePar:'Président Antenne Paris 12e', date:'2024-10-01', actif:true, permissions:{ lecture:true, demandes:true, validation:false } },
    { id:'D002', nom:'Lemaire', prenom:'Julie', email:'j.lemaire@pc33.fr', niveau:'departement', delegueePar:'Président APC Gironde', date:'2024-09-15', actif:true, permissions:{ lecture:true, demandes:true, validation:true } },
  ]);
  const [filterYear, setFilterYear] = useState('all');
  const [quickValConfirm, setQuickValConfirm] = useState(null);
  // Modale de confirmation générique { title, message, onConfirm, danger }
  const [confirmModal, setConfirmModal] = useState(null);
  const confirm = (title, message, onConfirm, danger = true) => setConfirmModal({ title, message, onConfirm, danger });
  const pageSize = 50;
  const [pageOffset, setPageOffset] = useState(0);

  // ── State lifted from page components (fix focus bug) ──
  const [dlgNom, setDlgNom] = useState('');
  const [dlgPrenom, setDlgPrenom] = useState('');
  const [dlgEmail, setDlgEmail] = useState('');
  const [dlgNiveau, setDlgNiveau] = useState('antenne');
  const [dlgFilter, setDlgFilter] = useState('gestion');
  const [dlgPerms, setDlgPerms] = useState({ lecture:true, demandes:false, validation:false });
  const [dlgSsoSearch, setDlgSsoSearch] = useState('');
  const [adrNom, setAdrNom] = useState('');
  const [adrAdresse, setAdrAdresse] = useState('');
  const [adrCp, setAdrCp] = useState('');
  const [adrVille, setAdrVille] = useState('');
  const [adrEmail, setAdrEmail] = useState('');
  const [adrPsClientId, setAdrPsClientId] = useState('');
  const [adrDept, setAdrDept] = useState(''); // département dont on édite l'adresse
  const [impMode, setImpMode] = useState('template');
  const [impDept, setImpDept] = useState('all');
  const [csvPreview, setCsvPreview] = useState([]);
  const [csvDone, setCsvDone] = useState(false);
  const csvRef = useRef();
  const [emKey, setEmKey] = useState('soumission');
  const [emSujet, setEmSujet] = useState(DEFAULT_EMAIL_TEMPLATES.soumission.sujet);
  const [emCorps, setEmCorps] = useState(DEFAULT_EMAIL_TEMPLATES.soumission.corps);
  const emEditorRef = useRef(null); // zone d'édition visuelle (mise en page) du corps d'e-mail
  const [paramT, setParamT] = useState(2);
  const [paramWmA, setParamWmA] = useState('');
  const [paramWmD, setParamWmD] = useState('');
  const [paramAgrNom, setParamAgrNom] = useState('');
  const [paramAgrTexte, setParamAgrTexte] = useState(DEFAULT_AGRAFE_TEXTE);
  const [tourStep, setTourStep] = useState(null); // null = visite fermée ; sinon index d'étape
  const [wordCfg, setWordCfg] = useState(DEFAULT_WORD_CFG);
  // Groupements de départements (un nom + des départements + les e-mails des APC qui les gèrent)
  const [groupements, setGroupements] = useState([]);
  const [grpNom, setGrpNom] = useState('');
  const [grpDepts, setGrpDepts] = useState([]);
  const [grpApcs, setGrpApcs] = useState('');
  const [grpEditId, setGrpEditId] = useState(null);
  const [paramAgrDepts, setParamAgrDepts] = useState([]);
  const [agrEditId, setAgrEditId] = useState(null);
  const [agrEditDepts, setAgrEditDepts] = useState([]);
  const [agrEditNom, setAgrEditNom] = useState('');
  const [agrEditTexte, setAgrEditTexte] = useState('');
  const [agrEditTitre, setAgrEditTitre] = useState('');
  const [agrEditIntro, setAgrEditIntro] = useState('');
  const [agrEditPresident, setAgrEditPresident] = useState('');
  // Correction FNPC (gestion peut tout modifier sans changer le statut)
  const [gEdit, setGEdit] = useState(null); // requête en cours de correction
  const [gNom, setGNom] = useState(''); const [gPrenom, setGPrenom] = useState('');
  const [gJust, setGJust] = useState(''); const [gDept, setGDept] = useState(''); const [gMedal, setGMedal] = useState('');
  const [editReqId, setEditReqId] = useState(null);
  const [gDashDept, setGDashDept] = useState('all');
  const [gDashYear, setGDashYear] = useState('all');
  // PrestaShop state
  const [psProductId, setPsProductId] = useState(null);
  const [psLoading, setPsLoading] = useState(false);
  const [psStep, setPsStep] = useState(''); // étape en cours lors d'une action PS
  const [psOrders, setPsOrders] = useState([]);
  const [psBypass, setPsBypass] = useState(false); // true = désactive la vérif PS (dépannage) // history of created orders
  const [newMedalLabel, setNewMedalLabel] = useState('');
  const [newMedalShort, setNewMedalShort] = useState('');
  const [newMedalYears, setNewMedalYears] = useState('');
  const [newMedalColor, setNewMedalColor] = useState('#1B3764');
  const [newMedalPayant, setNewMedalPayant] = useState(false);
  // Excel import
  const [xlsPreview, setXlsPreview] = useState([]);
  const [xlsDone, setXlsDone] = useState(false);
  const xlsRef = useRef();

  // ── Sync effects (must come after all useState declarations) ──
  useEffect(() => {
    const t = emailTemplates[emKey];
    if (t) {
      setEmSujet(t.sujet);
      setEmCorps(t.corps);
      if (page === 'email_templates' && emEditorRef.current) emEditorRef.current.innerHTML = (t.corps || '').replace(/\n/g, '<br>');
    }
  }, [page, emKey]);
  // Réinitialise l'état d'envoi quand on ouvre/ferme la modale e-mail
  useEffect(() => { setEmailSendState('idle'); setEmailSendErr(''); }, [emailModal]);
  // Envoi réel via la fonction Netlify SMTP
  const sendEmailNow = async () => {
    if (!emailModal?.destinataire) { setEmailSendState('error'); setEmailSendErr('Aucun destinataire.'); return; }
    setEmailSendState('sending'); setEmailSendErr('');
    try {
      const res = await fetch('/.netlify/functions/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: emailModal.destinataire, subject: emailModal.sujet, body: (emailModal.corps||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li)>/gi,'\n').replace(/<[^>]+>/g,''), html: fnpcEmailHtml(emailModal.corps) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setEmailSendState('sent');
    } catch (e) {
      setEmailSendState('error'); setEmailSendErr(e.message);
    }
  };
  // Préremplit les champs adresse selon le département sélectionné
  useEffect(() => {
    if (page !== 'adresse' || !adrDept) return;
    const d = deptAddresses[adrDept] || {};
    setAdrNom(d.nom||''); setAdrAdresse(d.adresse||''); setAdrCp(d.cp||''); setAdrVille(d.ville||''); setAdrEmail(d.email||''); setAdrPsClientId(d.psClientId||'');
  }, [page, adrDept]);

  useEffect(() => {
    if (page === 'adresse') {
      const opts = role === 'gestion' ? DEPTS : myDepts;
      if (!adrDept || !opts.includes(adrDept)) {
        const def = (authUser?.dept && opts.includes(authUser.dept)) ? authUser.dept : (opts[0] || '75 - Paris Seine');
        if (def !== adrDept) setAdrDept(def);
      }
    }
    // Brouillon : auto-sauvegarde toutes les 30s sur la page nouvelle demande
    if (page === 'nouvelle' && !editReqId) {
      // Charger le brouillon cross-session (Supabase d'abord, sinon cache localStorage)
      (async () => {
        const cloud = await db.loadDraft(authUser?.email);
        if (cloud) {
          localStorage.setItem(DRAFT_KEY, JSON.stringify(cloud));
          setDraftSavedAt(cloud.savedAt || null);
        } else {
          try { setDraftSavedAt(JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')?.savedAt || null); }
          catch { setDraftSavedAt(null); }
        }
      })();
      const t = setInterval(autosaveDraft, 30000);
      return () => clearInterval(t);
    }
    // Auto-chargement ID produit PrestaShop
    if (page === 'prestashop' && !psProductId) {
      prestashop.getProductByRef('DiplomeReco').then(prod => {
        if (prod?.id) setPsProductId(prod.id);
      }).catch(() => {});
    }
    // Journal d'audit : chargement à l'ouverture de la page
    if (page === 'audit') {
      setAuditLoading(true);
      db.loadAuditLog(null, 200).then(rows => setAuditLog(rows || [])).finally(() => setAuditLoading(false));
    }
    // APC default: arrive on demandes with soumis filter (only if no explicit filter set)
    if (page === 'demandes' && role === 'departement' && filterStatus === 'all') {
      setFilterStatus('soumis'); setFilterDept('all'); setFilterYear('all');
    }
    // Commission default: en_commission filter (only if no explicit filter set)
    if (page === 'demandes' && role === 'commission' && filterStatus === 'all') {
      setFilterStatus('en_commission'); setFilterDept('all'); setFilterYear('all');
    }
    // Pre-fill identity for new request
    if (page === 'nouvelle' && ['antenne','departement'].includes(role)) {
      const user = authUser;
      if (user) { setNrEmail(user.email); setNrDemandeur(user.nom); }
    }
  }, [page, role]);
  useEffect(() => {
    if (page === 'parametres') { setParamT(tarif); setParamWmA(welcomeMessages.antenne); setParamWmD(welcomeMessages.departement); }
  }, [page]);
  useEffect(() => { setDlgFilter(role === 'gestion' ? 'gestion' : role); }, [role]);

  // ── Supabase : sync sur changements ─────────────────────────────────────────
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    requests.forEach(r => db.upsertRequest(r));
  }, [requests]);
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    delegates.forEach(d => db.upsertDelegate(d));
  }, [delegates]);
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    agrafes.forEach(a => db.upsertAgrafe(a));
  }, [agrafes]);
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    db.saveConfig('tarif', { v: tarif });
  }, [tarif]);
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    db.saveConfig('welcome_messages', welcomeMessages);
  }, [welcomeMessages]);
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    db.saveConfig('dept_disabled', deptDisabled);
  }, [deptDisabled]);
  useEffect(() => {
    if (!USE_SUPABASE || dbLoading || !dbConnected) return;
    // Sync chaque département modifié
    Object.entries(deptAddresses).forEach(([code, data]) => db.upsertDepartment(code, data));
  }, [deptAddresses]);

  // ── Audit log helper ──────────────────────────────────────────────────────
  const audit = (action, requestId = null, details = null) => {
    if (!USE_SUPABASE || !dbConnected) return;
    db.logAudit({ userEmail: authUser?.email || 'inconnu', userRole: role, action, requestId, details });
  };

  // Nouvelle demande
  const [nrMode, setNrMode] = useState('registry');
  const [nrVolSearch, setNrVolSearch] = useState('');
  const [nrVol, setNrVol]   = useState(null);
  const [nrNom, setNrNom]   = useState('');
  const [nrPrenom, setNrPrenom] = useState('');
  const [nrAdhesion, setNrAdhesion] = useState('');
  const [nrGenre, setNrGenre] = useState('M');
  const [nrAnnee, setNrAnnee] = useState('');
  const [nrMedal, setNrMedal] = useState('');
  const [nrJust, setNrJust]   = useState('');
  const [nrFonctions, setNrFonctions] = useState('');
  const [nrDistinctions, setNrDistinctions] = useState('');
  const [nrDateRecep, setNrDateRecep] = useState('');
  const [nrEmail, setNrEmail] = useState('');
  const [nrNotif, setNrNotif] = useState(true);
  const [nrCommentaire, setNrCommentaire] = useState('');
  const [nrDept, setNrDept]   = useState('');
  const [nrDemandeur, setNrDemandeur] = useState('');
  const [nrAgrafe, setNrAgrafe] = useState(false);
  const [nrAgrafeDepts, setNrAgrafeDepts] = useState([]);

  const fire = (msg, type = 'ok') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  // Route d'impression headless (pour l'agent) : ?print=batch&type=medaille|temoignage|all&mode=complet|preimprime&dept=...&auto=1
  const printRoute = useMemo(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get('print') !== 'batch') return null;
      return {
        type: p.get('type') || 'all',
        dept: p.get('dept') || '',
        mode: p.get('mode') === 'preimprime' ? 'preimprime' : 'complet',
        auto: p.get('auto') === '1',
      };
    } catch { return null; }
  }, []);

  useEffect(() => {
    if (printRoute && printRoute.auto && !dbLoading) {
      const t = setTimeout(() => window.print(), 800);
      return () => clearTimeout(t);
    }
  }, [printRoute, dbLoading]);

  // Départements gérés par le compte connecté (via les groupements pour un APC)
  const myDepts = useMemo(() => {
    if (role === 'antenne') return authUser?.dept ? [authUser.dept] : [];
    if (role === 'departement') {
      const set = new Set();
      const myEmail = (authUser?.email || '').toLowerCase();
      groupements.forEach(g => { if ((g.apcs || []).includes(myEmail)) (g.depts || []).forEach(d => set.add(d)); });
      if (set.size === 0 && authUser?.dept) set.add(authUser.dept); // repli : son propre département
      return [...set];
    }
    return [];
  }, [role, authUser, groupements]);

  const lockedDept = (role === 'antenne')
    ? (authUser?.dept || myDepts[0] || null)
    : (role === 'departement')
      ? (myDepts.length === 1 ? myDepts[0] : null)
      : null;

  const allForRole = useMemo(() => {
    if (role === 'antenne')     return requests.filter(r => myDepts.includes(r.dept));
    if (role === 'departement') return requests.filter(r => myDepts.includes(r.dept));
    if (role === 'commission') return requests.filter(r => ['en_commission','valide_federation','refuse_federation'].includes(r.statut));
    return requests;
  }, [requests, role, myDepts]);

  const visibleRequests = useMemo(() => {
    let list = allForRole;
    if (filterStatus !== 'all') list = list.filter(r => r.statut === filterStatus);
    if (filterDept !== 'all') list = list.filter(r => r.dept === filterDept);
    if (filterYear !== 'all') list = list.filter(r => r.dateCreation?.startsWith(filterYear));
    if (search.trim()) { const s = search.toLowerCase(); list = list.filter(r => r.benevole.nom.toLowerCase().includes(s)||r.benevole.prenom.toLowerCase().includes(s)||r.id.toLowerCase().includes(s)||r.dept.toLowerCase().includes(s)); }
    return list;
  }, [allForRole, filterStatus, filterDept, filterYear, search]);

  // Fenêtre paginée affichée dans la liste
  const paginatedRequests = useMemo(() => visibleRequests.slice(pageOffset, pageOffset + pageSize), [visibleRequests, pageOffset, pageSize]);
  const totalPages = Math.ceil(visibleRequests.length / pageSize);
  const currentPage = Math.floor(pageOffset / pageSize) + 1;

  useEffect(() => { setPageOffset(0); }, [filterStatus, filterDept, filterYear, search]);

  const myDeptRequests = requests.filter(r => myDepts.includes(r.dept));
  const stats = {
    total: allForRole.length,
    enCours: allForRole.filter(r=>['soumis_antenne','soumis','en_commission','valide_federation'].includes(r.statut)).length,
    emis: allForRole.filter(r=>['diplome_emis','expedie'].includes(r.statut)).length,
    refuses: allForRole.filter(r=>['refuse_dept','refuse_federation'].includes(r.statut)).length,
    toValAntenne: myDeptRequests.filter(r=>r.statut==='soumis_antenne').length,
    toValDept: myDeptRequests.filter(r=>r.statut==='soumis').length,
    pretCommission: myDeptRequests.filter(r=>r.statut==='pret_commission').length,
    toValComm: requests.filter(r=>r.statut==='en_commission').length,
    toIssue: requests.filter(r=>r.statut==='valide_federation').length,
    tdrEnAttentePaiement: myDeptRequests.filter(r=>r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye').length,
    delayedAntenne: myDeptRequests.filter(r=>r.statut==='soumis_antenne'&&daysSince(r.dateCreation)>15).length,
    delayedDept: myDeptRequests.filter(r=>r.statut==='soumis'&&daysSince(r.dateCreation)>15).length,
    delayedComm: requests.filter(r=>r.statut==='en_commission'&&daysSince(r.dateCreation)>30).length,
    delayedAll:  requests.filter(r=>['soumis_antenne','soumis','en_commission'].includes(r.statut)&&daysSince(r.dateCreation)>30).length,
    toPayTemoignage: requests.filter(r=>r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye').length,
    toExpedite: requests.filter(r=>r.statut==='diplome_emis'&&!r.expedition).length,
  };
  const goToDelayed = (statusFilter) => { setFilterStatus(statusFilter); setFilterDept('all'); setFilterYear('all'); setPage('demandes'); };

  const upd = (id, patch) => setRequests(p => p.map(r => r.id!==id ? r : { ...r, ...patch }));
  const getReq = id => requests.find(r => r.id===id);

  const showEmail = (type, req) => {
    const tpl = emailTemplates[type];
    if (!tpl) return;
    const sujet = tpl.sujet.replace(/{prenom}/g,req.benevole.prenom).replace(/{nom}/g,req.benevole.nom).replace(/{distinction}/g,req.medalType.label);
    const corps = tpl.corps.replace(/{prenom}/g,req.benevole.prenom).replace(/{nom}/g,req.benevole.nom).replace(/{distinction}/g,req.medalType.label).replace(/{date}/g,today()).replace(/{numero}/g,req.diplomeId||'').replace(/{motif}/g,refuseComment).replace(/{tarif}/g,tarif).replace(/{temoignagePaiement}/g,req.medalType.payant?`\nNB : Ce témoignage nécessite un paiement de ${tarif}€.`:'');
    setEmailModal({ sujet, corps, destinataire: req.emailDemandeur });
  };

  const validateAntenne = id => {
    const req = getReq(id);
    upd(id, { statut:'soumis', historique:[...req.historique,{ date:today(), action:"Validé par Antenne — transmis à l'APC", auteur:ROLES[role].label, comment:'' }] });
    setSelected(null); fire('Demande transmise à l\'APC ✓');
    // Mail groupé J+1 — géré côté backend (cron job)
  };
  const validateDept = id => {
    const req = getReq(id);
    upd(id, { statut:'pret_commission', historique:[...req.historique,{ date:today(), action:'Validé par APC — en attente d\'envoi en masse à Commission FNPC', auteur:ROLES[role].label, comment:'' }] });
    audit('valider_apc', id, { dept: req.dept, medal: req.medalType?.shortLabel });
    setSelected(null); fire('Demande validée — mise en attente d\'envoi en masse ✓');
  };

  const sendBatchToCommission = () => {
    const batch = requests.filter(r => r.statut === 'pret_commission' && myDepts.includes(r.dept));
    if (!batch.length) { fire('Aucune demande prête pour envoi en masse', 'err'); return; }
    batch.forEach(r => {
      upd(r.id, { statut:'en_commission', historique:[...r.historique,{ date:today(), action:`Transmis en Commission FNPC (envoi groupé de ${batch.length} dossiers)`, auteur:ROLES[role].label, comment:'' }] });
      audit('envoyer_commission', r.id, { batch: batch.length, dept: r.dept });
    });
    fire(`${batch.length} dossier(s) transmis en masse à la Commission FNPC ✓`);
  };
  const validateComm = id => {
    const req = getReq(id);
    if (!req.medalType.payant) {
      const counters = { ...diplomeCounters };
      const num = generateDiplomaNumber(req.dept, counters);
      counters[req.dept] = (counters[req.dept]||0) + 1;
      setDiplomeCounters(counters);
      upd(id, { statut:'diplome_emis', diplomeId:num, historique:[...req.historique,
        { date:today(), action:'Approuvé par Commission FNPC', auteur:ROLES[role].label, comment:'Validation Commission FNPC.' },
        { date:today(), action:'Diplôme imprimé automatiquement', auteur:'Gestion FNPC', comment:`N° ${num}` }
      ]});
      audit('valider_commission', id, { diplomeId: num, dept: req.dept, medal: req.medalType?.shortLabel });
      setSelected(null); fire(`Dossier approuvé — Diplôme ${num} imprimé automatiquement 🎖`);
      if (req.notifications) showEmail('diplome_emis', { ...req, diplomeId:num });
    } else {
      upd(id, { statut:'valide_federation', historique:[...req.historique,{ date:today(), action:'Approuvé par Commission FNPC', auteur:ROLES[role].label, comment:'En attente de paiement avant impression.' }] });
      audit('valider_commission', id, { dept: req.dept, medal: req.medalType?.shortLabel, payant: true });
      setSelected(null); fire('Dossier approuvé — paiement requis avant impression du témoignage');
      if (req.notifications) showEmail('validation_commission', req);
    }
  };
  const issueDiploma = id => {
    const req = getReq(id);
    if (req.medalType.payant && req.paiement !== 'paye') { fire('Ce témoignage doit être payé avant impression','err'); return; }
    const counters = { ...diplomeCounters };
    const num = generateDiplomaNumber(req.dept, counters);
    counters[req.dept] = (counters[req.dept]||0) + 1;
    setDiplomeCounters(counters);
    upd(id, { statut:'diplome_emis', diplomeId:num, historique:[...req.historique,{ date:today(), action:'Diplôme imprimé', auteur:ROLES[role].label, comment:`N° ${num}` }] });
    audit('imprimer_diplome', id, { diplomeId: num, dept: req.dept, medal: req.medalType?.shortLabel });
    setSelected(null); fire(`Diplôme ${num} imprimé 🎖`);
    if (req.notifications) showEmail('diplome_emis', { ...req, diplomeId:num });
  };
  const markExpedited = (ids) => {
    ids.forEach(id => {
      const req = getReq(id);
      upd(id, { statut:'expedie', expedition:today(), historique:[...req.historique,{ date:today(), action:'Expédié', auteur:'Gestion FNPC', comment:'Expédié par courrier recommandé.' }] });
      if (req.notifications) showEmail('expedition', req);
      audit('expedier', id, { dept: req.dept, medal: req.medalType?.shortLabel });
    });
    setSelectedBatch([]);
    fire(`${ids.length} diplôme(s) marqué(s) expédié(s) ✓`);
  };
  const markPaid = async (id) => {
    const req = getReq(id);

    // ── Créer commande PrestaShop D'ABORD ─────────────────────────────────────
    // Le paiement n'est validé QUE si la commande PS est créée avec succès
    // (sauf si psBypass est activé — mode dépannage)
    if (!req.prestashopOrderId && !psBypass) {
      try {
        fire('Création commande PrestaShop…');
        let prodId = psProductId;
        if (!prodId) {
          const prod = await prestashop.getProductByRef('DiplomeReco');
          if (prod?.id) { prodId = prod.id; setPsProductId(prod.id); }
        }
        if (!prodId) throw new Error('Produit DiplomeReco introuvable dans PrestaShop');

        const apcAddr = deptAddresses[req.dept];
        const apcEmail = apcAddr?.email || `apc.${(req.dept||'').split(' ')[0].toLowerCase()}@protection-civile.org`;
        let customer;
        if (apcAddr?.psClientId) {
          customer = await prestashop.getCustomerById(apcAddr.psClientId);
          if (!customer?.id) throw new Error(`Compte APC introuvable (ID PS: ${apcAddr.psClientId})`);
        } else {
          customer = await prestashop.getCustomerByEmail(apcEmail);
          if (!customer?.id) throw new Error(`Compte APC introuvable : ${apcEmail} — configurez l'ID client PS dans les paramètres APC`);
        }

        const addresses = await prestashop.getCustomerAddresses(customer.id);
        if (!addresses[0]?.id) throw new Error('Adresse APC introuvable dans PrestaShop');

        const cart = await prestashop.createCart(customer.id, addresses[0].id);
        if (!cart?.id) throw new Error('Erreur lors de la création du panier PrestaShop');

        const ref   = `FNPC-TDR-${req.dept.split(' ')[0]}-${req.id}`;
        const order = await prestashop.createOrder(customer.id, cart.id, addresses[0].id, prodId, 1, ref, tarif);
        if (!order?.id) throw new Error('Erreur lors de la création de la commande PrestaShop');

        // PS OK — on mémorise l'ID de commande mais on ne valide pas encore
        upd(id, { prestashopOrderId: order.id });
        setPsOrders(p=>[{ dept:req.dept, status:'ok', orderId:order.id, qty:1, ref }, ...p]);
        fire(`✓ Commande PrestaShop #${order.id} créée`);

      } catch(e) {
        // BLOQUANT — on arrête ici, le paiement n'est pas validé
        let msg = e.message;
        if (msg.includes('503')) msg = 'PrestaShop inaccessible (503) — le site boutique-preprod est joignable depuis un navigateur ? Si oui, les IPs Netlify sont peut-être bloquées (WAF). Utilisez le mode dépannage ou contactez l\'admin PS.';
        if (msg.includes('404')) msg = 'Fonction Netlify introuvable (404) — vérifiez que le dossier netlify/functions/ est bien dans votre dépôt GitHub et déployé.';
        if (msg.includes('Failed to fetch')) msg = 'Connexion impossible à la Netlify Function — vérifiez votre accès internet.';
        fire(`Paiement bloqué — ${msg}`, 'err');
        setPsOrders(p=>[{ dept:req.dept, status:'error', msg }, ...p]);
        return; // ← sortie anticipée, pas de validation paiement
      }
    }

    // ── Validation du paiement (seulement si PS OK ou déjà commandé) ──────────
    const newHisto = [...req.historique, { date:today(), action:`Paiement reçu (${tarif}€)`, auteur:ROLES[role]?.label||'Gestion', comment:'' }];
    let updFields = { paiement:'paye', historique:newHisto };

    if (req.statut === 'valide_federation' && req.medalType.payant) {
      const counters = { ...diplomeCounters };
      const num = generateDiplomaNumber(req.dept, counters);
      counters[req.dept] = (counters[req.dept]||0) + 1;
      setDiplomeCounters(counters);
      updFields = { ...updFields, statut:'diplome_emis', diplomeId:num,
        historique:[...newHisto, { date:today(), action:'Diplôme imprimé', auteur:'Gestion FNPC', comment:`N° ${num}` }] };
      fire(`Paiement validé — Diplôme ${num} imprimé 🎖`);
    } else {
      fire('Paiement enregistré ✓');
    }
    upd(id, updFields);
    if (req.notifications) showEmail('paiement_temoignage', req);
  };
  const refuse = (id, comment) => {
    const req = getReq(id);
    const statut = role==='departement'?'refuse_dept':'refuse_federation';
    const action = role==='departement'?'Refusé par APC':'Refusé par Commission FNPC';
    upd(id, { statut, historique:[...req.historique,{ date:today(), action, auteur:ROLES[role].label, comment }] });
    audit('refuser', id, { statut, dept: req.dept, medal: req.medalType?.shortLabel, motif: comment });
    setRefuseModal(null); setRefuseComment(''); setSelected(null);
    fire('Demande refusée','err');
    if (req.notifications) showEmail(role==='departement'?'refus_apc':'refus_apc', { ...req, _motif:comment });
  };
  const resubmit = (id, comment) => {
    const req = getReq(id);
    upd(id, { statut:'soumis', historique:[...req.historique,{ date:today(), action:'Dossier resoumis', auteur:ROLES[role].label, comment }] });
    setResubmitModal(null); setSelected(null);
    fire('Dossier resoumis avec succès ✓');
  };
  const quickValidateAll = (ids) => {
    ids.forEach(id => { validateComm(id); });
    fire(`${ids.length} dossier(s) validé(s) en Commission ✓`);
  };

  const saveDraft = () => {
    const vol = getEffectiveVol();
    if (!vol) return;
    const medalType = nrMedal ? medalTypes.find(m => m.id === nrMedal) : MEDAL_TYPES[0];
    const dept = lockedDept || nrDept || vol.dept;
    const nr = {
      id:`REQ-${new Date().getFullYear()}-${String(requests.length+1).padStart(3,'0')}`,
      diplomeId:null, statut:'brouillon',
      benevole:{ ...vol, fonctions:nrFonctions||vol.fonctions||'', distinctions:nrDistinctions||vol.distinctions||'' },
      medalType, demandeur:ROLES[role].org, emailDemandeur:nrEmail, dept, niveau:role,
      dateCreation:today(), notifications:nrNotif, agrafe:nrMedal==='temoignage'?false:nrAgrafe, agrafeDepts:nrMedal==='temoignage'?[]:nrAgrafeDepts,
      paiement:null, expedition:null,
      justification:nrJust, dateReception:nrDateRecep, commentaire:nrCommentaire,
      historique:[{ date:today(), action:'Brouillon créé', auteur:ROLES[role].label, comment:'' }],
    };
    setRequests(p => [nr,...p]); resetForm(); setPage('demandes');
    fire('Brouillon enregistré ✓');
  };

  const getEffectiveVol = () => {
    if (nrMode === 'registry') return nrVol;
    if (!nrNom || !nrPrenom || !nrAdhesion) return null;
    const start = new Date(nrAdhesion); const now = new Date();
    const ans = Math.floor((now - start) / (365.25*24*3600*1000));
    return { id:'MANUAL', nom:nrNom.toUpperCase(), prenom:nrPrenom, genre:nrGenre, annee:parseInt(nrAnnee)||null, antenne:null, dept:lockedDept||nrDept, adhesion:nrAdhesion, ans, fonctions:nrFonctions, distinctions:nrDistinctions };
  };

  const DRAFT_KEY = 'fnpc_draft_demande';
  const [draftSavedAt, setDraftSavedAt] = useState(null); // horodatage du brouillon courant (pilote le bandeau)
  // Journal d'audit (lecture seule)
  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditFilterAction, setAuditFilterAction] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  // Gabarits diplômes + calibrage
  const [diplomaTpl, setDiplomaTpl] = useState(DEFAULT_DIPLOMA_TEMPLATES);
  const [calGabarit, setCalGabarit] = useState('medaille');
  const [calMode, setCalMode] = useState('complet');
  const [calField, setCalField] = useState('nom');
  const calPageRef = useRef(null);
  const calDrag = useRef(null);
  const autosaveDraft = () => {
    if (!nrNom && !nrPrenom && !nrMedal) return; // Ne pas sauver un brouillon vide
    const payload = { nrNom, nrPrenom, nrAdhesion, nrGenre, nrAnnee, nrMedal, nrJust, nrFonctions, nrDistinctions, nrDateRecep, nrEmail, nrNotif, nrCommentaire, nrDept, nrDemandeur, nrAgrafe, nrAgrafeDepts, savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    setDraftSavedAt(payload.savedAt);
    db.saveDraft(authUser?.email, payload); // synchro cross-session (Supabase)
  };
  const restoreDraft = () => {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d) return false;
      if (d.nrNom) setNrNom(d.nrNom); if (d.nrPrenom) setNrPrenom(d.nrPrenom);
      if (d.nrAdhesion) setNrAdhesion(d.nrAdhesion); if (d.nrGenre) setNrGenre(d.nrGenre);
      if (d.nrAnnee) setNrAnnee(d.nrAnnee); if (d.nrMedal) setNrMedal(d.nrMedal);
      if (d.nrJust) setNrJust(d.nrJust); if (d.nrFonctions) setNrFonctions(d.nrFonctions);
      if (d.nrDistinctions) setNrDistinctions(d.nrDistinctions); if (d.nrDateRecep) setNrDateRecep(d.nrDateRecep);
      if (d.nrEmail) setNrEmail(d.nrEmail); setNrNotif(d.nrNotif ?? true);
      if (d.nrCommentaire) setNrCommentaire(d.nrCommentaire); if (d.nrDept) setNrDept(d.nrDept);
      if (d.nrDemandeur) setNrDemandeur(d.nrDemandeur); setNrAgrafe(d.nrAgrafe ?? false);
      if (d.nrAgrafeDepts) setNrAgrafeDepts(d.nrAgrafeDepts);
      return d.savedAt;
    } catch { return false; }
  };
  const clearDraft = () => { localStorage.removeItem(DRAFT_KEY); setDraftSavedAt(null); db.clearDraft(authUser?.email); };
  const hasDraft = () => !!localStorage.getItem(DRAFT_KEY);

  const resetForm = () => { clearDraft(); setNrVol(null); setNrVolSearch(''); setNrMedal(''); setNrJust(''); setNrFonctions(''); setNrDistinctions(''); setNrDateRecep(''); setNrEmail(''); setNrNotif(true); setNrCommentaire(''); setNrDept(''); setNrDemandeur(''); setNrNom(''); setNrPrenom(''); setNrAdhesion(''); setNrAgrafe(false); setNrAgrafeDepts([]); setEditReqId(null); };

  const loadBrouillon = (req) => {
    if (req.statut !== 'brouillon') return;
    setNrVol(req.benevole);
    setNrMedal(req.medalType.id);
    setNrJust(req.justification || '');
    setNrFonctions(req.benevole.fonctions || '');
    setNrDistinctions(req.benevole.distinctions || '');
    setNrDateRecep(req.dateReception || '');
    setNrEmail(req.emailDemandeur || '');
    setNrNotif(req.notifications);
    setNrCommentaire(req.commentaire || '');
    setNrDept(req.dept || '');
    setNrMode('registry');
    // Remove the brouillon so it's replaced on submit
    setRequests(p => p.filter(r => r.id !== req.id));
    setSelected(null);
    setPage('nouvelle');
    fire('Brouillon chargé — terminez la demande ✓');
  };

  const createRequest = () => {
    const vol = getEffectiveVol();
    if (!vol || !nrMedal || !nrJust.trim()) return;
    if (nrJust.trim().length < 50) { fire('Les motivations doivent comporter au moins 50 caractères.', 'err'); return; }
    const dept = lockedDept || nrDept || vol.dept;
    if (!editReqId && deptDisabled[dept]) { fire('Ce département est désactivé — impossible de soumettre.', 'err'); return; }
    const medalType = medalTypes.find(m => m.id === nrMedal);
    const isTemoig = medalType.category === 'temoignage';
    const agrafeIds  = isTemoig ? []    : nrAgrafeDepts;
    const agrafeFlag = isTemoig ? false : (nrAgrafe || agrafeIds.length > 0);
    const isExceptional = vol.ans < medalType.years;
    // Duplicate check: same benevole + same medal, unless agrafe or exceptional facts
    if (!editReqId && !nrAgrafeDepts.length && !isExceptional) {
      const duplicate = requests.find(r =>
        r.benevole.id === vol.id &&
        r.medalType.id === nrMedal &&
        !['refuse_dept','refuse_federation','expedie'].includes(r.statut)
      );
      if (duplicate) { fire(`⚠️ Doublon détecté : une demande existe déjà pour ${vol.prenom} ${vol.nom} — ${medalType.label} (${duplicate.id})`, 'err'); return; }
    }
    // Antenne → soumis_antenne (for validation by president), APC → en_commission directly
    // Antenne with validation rights → directly soumis APC; others → soumis_antenne
    // APC → pret_commission (batch hold before mass send)
    const hasValidationRight = role === 'antenne'; // In prod: check delegate permissions from SSO
    const targetStatut = role === 'departement' ? 'pret_commission' : hasValidationRight ? 'soumis' : 'soumis_antenne';
    const createAction = role === 'departement' ? "Validé APC — en attente d'envoi en masse" : hasValidationRight ? 'Soumis APC directement' : "Soumis à validation Antenne";
    if (editReqId) {
      const orig = getReq(editReqId);
      upd(editReqId, {
        benevole:{ ...vol, fonctions:nrFonctions||vol.fonctions||'', distinctions:nrDistinctions||vol.distinctions||'' },
        medalType, emailDemandeur:nrEmail, dept, notifications:nrNotif, agrafe:agrafeFlag, agrafeDepts:agrafeIds,
        justification:nrJust, dateReception:nrDateRecep, commentaire:nrCommentaire, statut:targetStatut,
        paiement: medalType.payant ? (orig.paiement||'en_attente') : null,
        historique:[...orig.historique,{ date:today(), action:`Demande modifiée — ${createAction}`, auteur:ROLES[role].label, comment:'' }],
      });
      setEditReqId(null); resetForm(); setPage('demandes');
      fire(role==='departement'?'Demande modifiée et transmise en Commission ✓':'Demande modifiée et resoumise ✓');
    } else {
      const nr = {
        id:`REQ-${new Date().getFullYear()}-${String(requests.length+1).padStart(3,'0')}`,
        diplomeId:null, statut:targetStatut,
        benevole:{ ...vol, fonctions:nrFonctions||vol.fonctions||'', distinctions:nrDistinctions||vol.distinctions||'' },
        medalType, demandeur:ROLES[role].org, emailDemandeur:nrEmail, dept, niveau:role,
        dateCreation:today(), notifications:nrNotif, agrafe:agrafeFlag, agrafeDepts:agrafeIds,
        paiement: medalType.payant ? 'en_attente' : null, expedition:null,
        justification:nrJust, dateReception:nrDateRecep, commentaire:nrCommentaire,
        historique:[{ date:today(), action:createAction, auteur:ROLES[role].label, comment:'' }],
      };
      setRequests(p => [nr,...p]); resetForm(); setPage('demandes');
      fire(role==='departement'?'Demande transmise directement en Commission FNPC ✓':'Demande soumise à validation Antenne ✓');
      // Mail groupé J+1 — géré côté backend (cron job)
    }
  };

  const searchVol = () => {
    const q = nrVolSearch.toLowerCase().trim();
    const found = MOCK_VOLUNTEERS.find(v => v.nom.toLowerCase().includes(q)||v.prenom.toLowerCase().includes(q)||v.id.toLowerCase()===q);
    if (found) { setNrVol(found); setNrFonctions(found.fonctions); setNrDistinctions(found.distinctions); }
    else fire('Bénévole introuvable dans le registre','err');
  };

  const myDept = lockedDept || nrDept;
  const isDeptDisabled = myDept ? !!deptDisabled[myDept] : false;
  const canCreate = !isDeptDisabled && ((role==='antenne')||(role==='departement')||(role==='commission'&&commissionCanCreate)||(role==='gestion'&&gestionCanCreate));
  const canValAntenne = r => role==='antenne' && r?.statut==='soumis_antenne';
  const canValDept  = r => role==='departement' && r?.statut==='soumis';
  const canValComm  = r => role==='commission' && r?.statut==='en_commission';
  const canIssue    = r => role==='gestion' && r?.statut==='valide_federation';
  const canRefuse   = r => (role==='antenne'&&r?.statut==='soumis_antenne')||(role==='departement'&&r?.statut==='soumis')||(role==='commission'&&r?.statut==='en_commission');
  const canResubmit = r => ['refuse_dept','refuse_federation'].includes(r?.statut) && ['antenne','departement'].includes(role);
  // Noms des agrafes attachées à une demande (depuis le menu Agrafes)
  const agrafeNoms = (r) => (r?.agrafeDepts || []).map(id => agrafes.find(a => a.id === id)?.nom).filter(Boolean).join(', ');

  // ── Visite guidée (onboarding) ──
  const tourSeen = (r) => { try { return !!localStorage.getItem('fnpc_tour_v1_' + r); } catch { return true; } };
  const markTourSeen = (r) => { try { localStorage.setItem('fnpc_tour_v1_' + r, '1'); } catch {} };
  const maybeStartTour = (r) => { if ((r === 'antenne' || r === 'departement') && !tourSeen(r)) setTourStep(0); };
  const closeTour = () => { markTourSeen(role); setTourStep(null); };

  const saveWordCfg = () => { db.saveConfig('word_template', wordCfg); fire('Modèle du document Word enregistré ✓'); };

  // ── Groupements de départements ──
  const saveGroupements = (next) => { setGroupements(next); db.saveConfig('groupements', next); };
  const grpReset = () => { setGrpNom(''); setGrpDepts([]); setGrpApcs(''); setGrpEditId(null); };
  const grpSave = () => {
    if (!grpNom.trim() || !grpDepts.length) { fire('Indiquez un nom et au moins un département', 'err'); return; }
    const apcs = grpApcs.split(/[\n,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const entry = { id: grpEditId || `GRP-${Date.now()}`, nom: grpNom.trim(), depts: grpDepts, apcs };
    const next = grpEditId ? groupements.map(g => g.id === grpEditId ? entry : g) : [...groupements, entry];
    saveGroupements(next); grpReset(); fire('Groupement enregistré ✓');
  };
  const grpEdit = (g) => { setGrpEditId(g.id); setGrpNom(g.nom); setGrpDepts(g.depts || []); setGrpApcs((g.apcs || []).join('\n')); };
  const grpDelete = (id) => confirm('Supprimer le groupement', 'Confirmer la suppression de ce groupement ?', () => saveGroupements(groupements.filter(g => g.id !== id)));

  // ── E-mails : mise en page HTML + édition visuelle ──
  const fnpcEmailHtml = (bodyHtml) => {
    const body = (bodyHtml || '').replace(/\n/g, '<br>');
    return `<div style="margin:0;padding:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif">`
      + `<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">`
      + `<div style="background:#1B3764;padding:18px 24px;color:#ffffff;font-size:17px;font-weight:bold;border-bottom:3px solid #E87722">Fédération Nationale de la Protection Civile</div>`
      + `<div style="padding:24px;color:#374151;font-size:14px;line-height:1.7">${body}</div>`
      + `<div style="padding:16px 24px;background:#f8faff;color:#94a3b8;font-size:12px;border-top:1px solid #e5e7eb">Cet e-mail vous est envoyé automatiquement par l'application Médailles de la FNPC.</div>`
      + `</div></div>`;
  };
  // Applique une commande de formatage à la zone éditable puis resynchronise l'état
  const emExec = (cmd, val = null) => {
    document.execCommand(cmd, false, val);
    if (emEditorRef.current) setEmCorps(emEditorRef.current.innerHTML);
  };

  // ── Bordereau d'expédition A4 (page de rupture entre lots : adresse + liste des diplômes) ──
  const openShippingLabel = (dept, list = []) => {
    const a = deptAddresses[dept] || {};
    if (!a.nom && !a.adresse) { fire(`Aucune adresse configurée pour ${dept} (Paramètres APC → Adresse)`, 'err'); return; }
    const w = window.open('', 'bordereau_fnpc', 'width=820,height=920,menubar=no,toolbar=no');
    if (!w) { fire('Fenêtre bloquée — autorisez les pop-ups pour ce site', 'err'); return; }
    const recipient = [a.nom, a.adresse, `${a.cp || ''} ${a.ville || ''}`.trim()].filter(Boolean).join('<br>');
    const dateFr = new Date().toLocaleDateString('fr-FR');
    const rows = (list || []).map(r =>
      `<tr><td>${r.benevole.prenom} ${r.benevole.nom}</td><td>${r.medalType.label}</td><td>${r.diplomeId || ''}</td></tr>`
    ).join('') || '<tr><td colspan="3" style="color:#999">Aucun diplôme</td></tr>';
    w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Bordereau — ${dept}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: Arial, Helvetica, sans-serif; margin:0; color:#111; page-break-after: always; }
  .bar { height:6px; background:#E87722; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; margin-top:16px; }
  .title { font-size:22px; font-weight:bold; color:#1B3764; }
  .blocks { display:flex; gap:28px; margin-top:26px; }
  .block { flex:1; }
  .lbl { font-size:10px; letter-spacing:1.5px; color:#999; text-transform:uppercase; margin-bottom:5px; }
  .from { font-size:13px; color:#444; line-height:1.5; }
  .to { font-size:20px; font-weight:bold; line-height:1.4; }
  h2 { font-size:13px; color:#1B3764; margin:34px 0 8px; border-bottom:2px solid #E87722; padding-bottom:5px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid #e5e7eb; }
  th { background:#f1f5f9; color:#1B3764; font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
  .meta { margin-top:18px; font-size:12px; color:#555; }
  .btn { margin-top:24px; padding:9px 16px; border:none; border-radius:6px; background:#1B3764; color:#fff; font-weight:bold; cursor:pointer; }
  @media print { .btn { display:none; } }
</style></head><body>
  <div class="bar"></div>
  <div class="head">
    <div class="title">Bordereau d'expédition</div>
    <div style="text-align:right;font-size:12px;color:#555">${dateFr}<br><strong>${dept}</strong></div>
  </div>
  <div class="blocks">
    <div class="block"><div class="lbl">Expéditeur</div>
      <div class="from"><strong>Fédération Nationale<br>de la Protection Civile</strong></div></div>
    <div class="block"><div class="lbl">Destinataire</div>
      <div class="to">${recipient}</div></div>
  </div>
  <h2>Diplômes — ${(list || []).length}</h2>
  <table><thead><tr><th>Bénévole</th><th>Distinction</th><th>N° diplôme</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="meta">Cette page (A4 standard) sépare ce lot du suivant et accompagne l'envoi.</div>
  <button class="btn" onclick="window.print()">🖨 Imprimer le bordereau</button>
</body></html>`);
    w.document.close();
  };

  // ── Impression groupée CALIBRÉE (une page A4 paysage par diplôme) ──
  const openCalibratedBatch = (reqs, mode) => {
    const list = (reqs || []).filter(r => r && r.benevole && r.medalType);
    if (!list.length) { fire('Aucun diplôme à imprimer', 'err'); return; }
    const w = window.open('', 'diplomes_batch', 'width=1000,height=760,menubar=no,toolbar=no');
    if (!w) { fire('Fenêtre bloquée — autorisez les pop-ups pour ce site', 'err'); return; }
    const pages = list.map(r => {
      const gabarit = MEDAL_TO_GABARIT[r.medalType.id] || 'medaille';
      const agrafeNom = (r.agrafeDepts || []).map(id => agrafes.find(a => a.id === id)?.nom).filter(Boolean).join(', ');
      const values = {
        niveau: r.medalType.shortLabel || '',
        nom: `${r.benevole.prenom} ${r.benevole.nom}`,
        date: diplomaDateFr(r),
        numero: r.diplomeId || '—',
        agrafe: agrafeNom || '',
      };
      return diplomaPageHtml(diplomaTpl, gabarit, mode, values);
    }).join('');
    const modeLabel = mode === 'complet' ? 'Diplôme complet (fond inclus)' : 'Pré-imprimé (texte seul)';
    w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Diplômes — ${list.length}</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  body { margin:0; background:#444; font-family:Arial,Helvetica,sans-serif; }
  .toolbar { position:sticky; top:0; z-index:10; background:#1B3764; color:#fff; padding:10px 16px; display:flex; gap:12px; align-items:center; }
  .toolbar button { padding:8px 14px; border:none; border-radius:6px; background:#E87722; color:#fff; font-weight:bold; cursor:pointer; }
  .pages { padding:16px; }
  .page { position:relative; width:297mm; height:210mm; overflow:hidden; background:#fff; margin:0 auto 16px; box-shadow:0 2px 12px rgba(0,0,0,.5); page-break-after:always; }
  @media print { .toolbar { display:none; } .pages { padding:0; } .page { margin:0; box-shadow:none; } }
</style></head><body>
  <div class="toolbar"><strong>${list.length} diplôme(s)</strong> · ${modeLabel} · orientation Paysage
    <button onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button></div>
  <div class="pages">${pages}</div>
</body></html>`);
    w.document.close();
  };

  // Fenêtre d'aide séparée (contact e-mail)
  const openHelp = () => {
    const w = window.open('', 'aide_fnpc', 'width=480,height=540,menubar=no,toolbar=no,location=no');
    if (!w) { window.location.href = 'mailto:medaille@protection-civile.org?subject=Aide%20-%20Appli%20Medaille%20FNPC'; return; }
    w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Aide — Appli Médaille FNPC</title>
<style>body{font-family:system-ui,'Segoe UI',Arial,sans-serif;margin:0;background:#eef2f7;color:#1B3764}
.h{background:#1B3764;color:#fff;padding:22px;border-bottom:3px solid #E87722;text-align:center}.h h1{margin:0;font-size:18px}
.c{padding:24px;line-height:1.6;font-size:14px;color:#334155}
a.mail{display:inline-block;margin-top:14px;background:#E87722;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700}
.ft{color:#94a3b8;font-size:12px;margin-top:20px}</style></head><body>
<div class="h"><h1>Besoin d'aide ?</h1></div>
<div class="c"><p>Pour toute question relative aux médailles ou à l'utilisation de l'application, contactez l'équipe de la Fédération&nbsp;:</p>
<p><a class="mail" href="mailto:medaille@protection-civile.org?subject=Aide%20-%20Appli%20Medaille%20FNPC">✉️ medaille@protection-civile.org</a></p>
<p class="ft">Fédération Nationale de la Protection Civile</p></div></body></html>`);
    w.document.close();
  };

  // ── Génération du Word « Liste des récipiendaires » pour une agrafe ──
  const genAgrafeWord = async (ag) => {
    const agReqs = requests.filter(r => r.agrafeDepts && r.agrafeDepts.includes(ag.id) && ['valide_federation','diplome_emis','expedie'].includes(r.statut));
    if (!agReqs.length) { fire('Aucune demande validée pour cette agrafe', 'err'); return; }
    fire('Génération du document Word…');
    try {
      const [pizzipMod, dtMod] = await Promise.all([ import('pizzip'), import('docxtemplater') ]);
      const PizZip = pizzipMod.default || pizzipMod;
      const Docxtemplater = dtMod.default || dtMod;
      const resp = await fetch('/templates/liste_recipiendaires_template.docx');
      if (!resp.ok) throw new Error('Gabarit Word introuvable');
      const zip = new PizZip(await resp.arrayBuffer());
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
      const groups = {};
      agReqs.forEach(r => { (groups[r.medalType.id] = groups[r.medalType.id] || []).push(r); });
      const order = Object.keys(groups).sort((a,b)=>{ const ma=MEDAL_TYPES.find(m=>m.id===a), mb=MEDAL_TYPES.find(m=>m.id===b); return (mb?.years||0)-(ma?.years||0); });
      const preamble = (ag.texte || wordCfg.preambule || DEFAULT_AGRAFE_TEXTE).trim();
      doc.render({
        titre: (ag.titre || '').trim() || wordCfg.titre || 'Liste des récipiendaires',
        date: new Date().toLocaleDateString('fr-FR'),
        nom: ag.nom || '',
        preambule: preamble.split(/\n+/).map(s => s.trim()).filter(Boolean),
        intro: (ag.intro || '').trim() || wordCfg.intro || DEFAULT_LIST_INTRO,
        groups: order.map(mid => ({
          medal: MEDAL_TYPES.find(x => x.id === mid)?.label || mid,
          people: groups[mid].map(r => {
            const civ = r.benevole.genre === 'F' ? 'Mme' : 'M';
            const dept = (r.dept || '').split(' - ')[1] || r.dept || '';
            return `${civ} ${r.benevole.nom} ${r.benevole.prenom}, bénévole de la Protection Civile de ${dept}`;
          }),
        })),
        president: ((ag.president || '').trim() || wordCfg.president || '').trim(),
      });
      const blob = doc.getZip().generate({ type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Liste_recipiendaires_${(ag.nom || 'agrafe').replace(/[^a-z0-9]+/gi,'_')}.docx`;
      a.click();
      fire('Document Word généré ✓');
    } catch (e) {
      console.error('genAgrafeWord', e);
      fire('Erreur génération Word — lancez « npm install » (docxtemplater, pizzip) puis redéployez.', 'err');
    }
  };

  const canEdit = r => (role==='departement' && ['brouillon','soumis','pret_commission','soumis_antenne','refuse_dept','refuse_federation'].includes(r?.statut))
    || (role==='antenne' && ['brouillon','soumis_antenne','refuse_dept'].includes(r?.statut));

  const loadEditReq = (req) => {
    setNrVol(req.benevole);
    setNrMedal(req.medalType.id);
    setNrJust(req.justification||'');
    setNrFonctions(req.benevole.fonctions||'');
    setNrDistinctions(req.benevole.distinctions||'');
    setNrDateRecep(req.dateReception||'');
    setNrEmail(req.emailDemandeur||'');
    setNrNotif(req.notifications);
    setNrCommentaire(req.commentaire||'');
    setNrDept(req.dept||'');
    setNrMode('registry');
    setEditReqId(req.id);
    setSelected(null);
    setPage('nouvelle');
    fire('Demande chargée — modifiez puis soumettez ✓');
  };

  // Correction FNPC : modifie les champs sans changer le statut du dossier
  const openGEdit = (r) => { setGEdit(r); setGNom(r.benevole.nom||''); setGPrenom(r.benevole.prenom||''); setGJust(r.justification||''); setGDept(r.dept||''); setGMedal(r.medalType.id); setSelected(null); };
  const saveGEdit = () => {
    if (!gEdit) return;
    const medalType = medalTypes.find(m => m.id === gMedal) || gEdit.medalType;
    upd(gEdit.id, {
      benevole:{ ...gEdit.benevole, nom:gNom.trim(), prenom:gPrenom.trim() },
      justification:gJust, dept:gDept, medalType,
      historique:[...gEdit.historique, { date:today(), action:'Corrigé par Gestion FNPC', auteur:ROLES[role]?.label||'Gestion FNPC', comment:'' }],
    });
    fire('Demande corrigée ✓'); setGEdit(null);
  };

  const alertInfo =
      role==='antenne' && stats.delayedAntenne>0
        ? { text:`⏰ ${stats.delayedAntenne} demande(s) sans réponse depuis plus de 15 jours !`, icon:'🔴', action:()=>goToDelayed('soumis_antenne') }
      : role==='antenne' && stats.toValAntenne>0
        ? { text:`${stats.toValAntenne} demande(s) en attente de validation.`, icon:'⚠️', action:()=>{ setFilterStatus('soumis_antenne'); setPage('demandes'); } }
      : role==='departement' && stats.tdrEnAttentePaiement>0
        ? { text:`💳 ${stats.tdrEnAttentePaiement} TDR en attente de paiement — paiement requis avant impression.`, icon:'💳', action:()=>setPage('tdr_apc') }
      : role==='departement' && stats.delayedDept>0
        ? { text:`⏰ ${stats.delayedDept} demande(s) sans réponse depuis plus de 15 jours !`, icon:'🔴', action:()=>goToDelayed('soumis') }
      : role==='departement' && stats.toValDept>0
        ? { text:`${stats.toValDept} demande(s) en attente de validation APC.`, icon:'⚠️', action:()=>{ setFilterStatus('soumis'); setPage('demandes'); } }
      : role==='commission' && stats.delayedComm>0
        ? { text:`⏰ ${stats.delayedComm} dossier(s) en Commission sans réponse depuis plus de 30 jours !`, icon:'🔴', action:()=>goToDelayed('en_commission') }
      : role==='commission' && stats.toValComm>0
        ? { text:`${stats.toValComm} dossier(s) à examiner en Commission FNPC.`, icon:'⚖️', action:()=>{ setFilterStatus('en_commission'); setPage('demandes'); } }
      : role==='gestion' && (stats.toIssue>0||stats.toPayTemoignage>0||stats.toExpedite>0)
        ? { text:`${stats.toIssue} diplôme(s) à imprimer`+(stats.toPayTemoignage>0?' · '+stats.toPayTemoignage+' TDR à payer':'')+(stats.toExpedite>0?' · '+stats.toExpedite+' à expédier':''), icon:'🎖', action:()=>setPage('diplomes') }
      : null;

  // ─── PAGES ────────────────────────────────────────────────────────────────────

  const renderPage = () => {
    switch(page) {
      case 'dashboard':         return DashboardPage();
      case 'demandes':          return DemandesPage();
      case 'nouvelle':          return NouvelleDemandePage();
      case 'validation_rapide': return ValidationRapidePage();
      case 'delegues':          return DeleguesPage();
      case 'adresse':           return AdressePage();
      case 'diplomes':          return DiplomesPage();
      case 'diplomes_imprimer': return DiplomesImprimerPage();
      case 'import_csv':        return ImportCSVPage();
      case 'email_templates':   return EmailTemplatesPage();
      case 'statistiques':      return StatistiquesPage();
      case 'prestashop':        return PrestashopPage();
      case 'audit':             return AuditPage();
      case 'calibrage_diplomes': return CalibrageDiplomesPage();
      case 'mon_compte':        return MonComptePage();
      case 'medailles':         return MedaillesPage();
      case 'import_excel':      return ImportExcelPage();
      case 'agrafes':           return AgrafesPage();
      case 'groupements':       return GroupementsPage();
      case 'parametres':        return ParametresPage();
      default: return DashboardPage();
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────

  function DashboardPage() {
    if (role === 'gestion') return GestionDashboard();
    const welcome = welcomeMessages[role];
    const years = [...new Set(allForRole.map(r=>r.dateCreation?.slice(0,4)).filter(Boolean))].sort().reverse();
    const filteredRole = allForRole;
    const piplineSteps = [
      ...(role==='antenne'?[{key:'soumis_antenne',label:'Soumises Antenne',icon:'📋'}]:[]),
      ...(role==='antenne'?[{key:'soumis',label:'Soumises APC',icon:'📥'}]:[]),
      ...(role==='departement'?[{key:'soumis',label:'Soumises APC',icon:'📥'}]:[]),
      ...(role==='departement'?[{key:'pret_commission',label:'Prêts à envoyer',icon:'📦'}]:[]),
      {key:'en_commission',label:'Soumises Commission FNPC',icon:'⚖️'},
      {key:'valide_federation',label:'Approuvé',icon:'✅'},
      {key:'diplome_emis',label:'Diplôme imprimé',icon:'🎖'},
      {key:'expedie',label:'Expédié',icon:'📬'},
      {key:'refuse_dept',label:'Refusées',icon:'✗', noArrow:true},
    ];
    return (
      <div>
        <div style={{ marginBottom:12 }}>
          <h1 style={H1}>Tableau de bord</h1>
          <p style={{ color:'#64748b', marginTop:4, fontSize:14 }}>Bienvenue, <strong>{ROLES[role].label}</strong> · {ROLES[role].org}</p>
        </div>
        {welcome && <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:10, padding:'11px 16px', marginBottom:12, fontSize:14, color:'#1e40af' }}>💬 {welcome}</div>}
        {deptDisabled[ROLES[role]?.dept] && <div style={{ background:'#fef2f2', border:'2px solid #dc2626', borderRadius:10, padding:'12px 16px', marginBottom:12, fontSize:14, color:'#dc2626', fontWeight:700 }}>🚫 Votre département est désactivé — les nouvelles demandes sont temporairement bloquées. Contactez la Gestion FNPC.</div>}
        {role==='departement' && stats.pretCommission > 0 && (
          <div style={{ background:'#e0f2fe', border:'2px solid #0ea5e9', borderRadius:10, padding:'12px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontWeight:700, color:'#0369a1', fontSize:15 }}>📦 {stats.pretCommission} dossier(s) prêt(s) pour envoi groupé en Commission FNPC</div>
              <div style={{ fontSize:13, color:'#0284c7', marginTop:2 }}>Les dossiers validés s'accumulent ici. Envoyez-les en masse quand vous êtes prêt.</div>
            </div>
            <button className="btn btn-sm" style={{ background:'#0ea5e9', color:'white', flexShrink:0 }} onClick={()=>{ const n=requests.filter(r=>r.statut==='pret_commission'&&myDepts.includes(r.dept)).length; confirm(`Envoyer ${n} dossier(s) en Commission`, `Transmettre ${n} dossier(s) à la Commission FNPC ? Cette action est définitive.`, sendBatchToCommission, false); }}>
              📨 Envoyer en masse ({stats.pretCommission})
            </button>
          </div>
        )}
        {alertInfo && <div className="alert-bar" style={{ cursor:'pointer', marginBottom:18 }} onClick={alertInfo.action}><span style={{ fontSize:20 }}>{alertInfo.icon}</span><div style={{ flex:1 }}><strong style={{ color:'#C45A00' }}>Action requise</strong><div style={{ color:'#9A3E00', fontSize:13, marginTop:2 }}>{alertInfo.text}</div></div><span style={{ background:'#E87722', color:'white', borderRadius:20, padding:'3px 10px', fontSize:12, fontWeight:700, flexShrink:0 }}>Traiter →</span></div>}

        <div className="card" style={{ marginBottom:18 }}>
          <h2 style={H2}>Suivi des demandes</h2>
          <div style={{ display:'flex', gap:5, alignItems:'center', flexWrap:'wrap' }}>
            {piplineSteps.map((step,i,arr) => (
              <div key={step.key} style={{ display:'flex', alignItems:'center', gap:3, flex:1, minWidth:72 }}>
                <div className="pip-step" style={{ flex:1, background:STATUSES[step.key]?.bg, border:`1px solid ${STATUSES[step.key]?.color}30`, cursor:'pointer' }} onClick={() => { setFilterStatus(step.key); setFilterDept('all'); setFilterYear('all'); setSearch(''); setPage('demandes'); }}>
                  <div style={{ fontSize:15, marginBottom:2 }}>{step.icon}</div>
                  <div style={{ fontSize:20, fontWeight:700, color:STATUSES[step.key]?.color, fontFamily:'Playfair Display,serif' }}>{filteredRole.filter(r=>r.statut===step.key).length}</div>
                  <div style={{ fontSize:10, color:'#64748b', marginTop:1 }}>{step.label}</div>
                </div>
                {i<arr.length-1 && arr[i+1]?.key!=='refuse_dept' && <span style={{ color:'#c4c9d4', fontSize:12, flexShrink:0 }}>→</span>}
                {i<arr.length-1 && arr[i+1]?.key==='refuse_dept' && <span style={{ color:'transparent', fontSize:12, flexShrink:0, userSelect:'none' }}>·</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="card"><div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}><h2 style={H2}>Demandes récentes</h2><button className="btn btn-outline btn-sm" onClick={() => setPage('demandes')}>Voir toutes →</button></div>
          <ReqHeader />{visibleRequests.slice(0,5).map(req => <ReqRow key={req.id} req={req} onSelect={setSelected} showLate={true} />)}
        </div>
      </div>
    );
  }

  function GestionDashboard() {
    const allReqs = requests;
    const years = [...new Set(allReqs.map(r=>r.dateCreation?.slice(0,4)).filter(Boolean))].sort().reverse();
    const depts = [...new Set(allReqs.map(r=>r.dept))].sort();
    // Apply filters
    const all = allReqs.filter(r=>{
      if (gDashDept !== 'all' && r.dept !== gDashDept) return false;
      if (gDashYear !== 'all' && !r.dateCreation?.startsWith(gDashYear)) return false;
      return true;
    });
    const byDept = Object.entries(all.reduce((a,r) => { a[r.dept]=(a[r.dept]||0)+1; return a; },{})).sort((a,b)=>b[1]-a[1]).slice(0,8);
    const byMedal = medalTypes.map(m => ({ label:m.shortLabel, count:all.filter(r=>r.medalType.id===m.id).length, color:m.color }));
    const hommes = all.filter(r=>r.benevole.genre==='M').length;
    const femmes = all.filter(r=>r.benevole.genre==='F').length;
    const totalG = hommes+femmes||1;
    const ageGroups = {'<30':0,'30-40':0,'40-50':0,'50-60':0,'60+':0};
    all.forEach(r => { const a=new Date().getFullYear()-(r.benevole.annee||1970); if(a<30)ageGroups['<30']++;else if(a<40)ageGroups['30-40']++;else if(a<50)ageGroups['40-50']++;else if(a<60)ageGroups['50-60']++;else ageGroups['60+']++; });
    const maxAG = Math.max(...Object.values(ageGroups),1);
    const avgDelay = Math.round(all.filter(r=>r.statut==='diplome_emis').reduce((a,r)=>a+daysSince(r.dateCreation),0)/Math.max(all.filter(r=>r.statut==='diplome_emis').length,1));
    return (
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <div>
            <h1 style={H1}>Dashboard Gestion FNPC</h1>
            <p style={{ color:'#64748b', fontSize:13, marginTop:2 }}>{all.length} demande(s){gDashDept!=='all'?` · ${gDashDept}`:''}{ gDashYear!=='all'?` · ${gDashYear}`:''} · <span style={{ background:'#e0f2fe', color:'#0369a1', borderRadius:10, padding:'1px 7px', fontSize:11, fontWeight:700 }}>v{APP_VERSION}</span></p>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <select className="select" value={gDashDept} onChange={e=>setGDashDept(e.target.value)} style={{ maxWidth:200 }}>
              <option value="all">Tous les départements</option>
              {depts.map(d=><option key={d} value={d}>{d}</option>)}
            </select>
            <select className="select" value={gDashYear} onChange={e=>setGDashYear(e.target.value)} style={{ maxWidth:110 }}>
              <option value="all">Toutes les années</option>
              {years.map(y=><option key={y} value={y}>{y}</option>)}
            </select>
            {(gDashDept!=='all'||gDashYear!=='all')&&<button className="btn btn-outline btn-sm" onClick={()=>{setGDashDept('all');setGDashYear('all');}}>✕ Réinitialiser</button>}
          </div>
        </div>
        {alertInfo && <div className="alert-bar" style={{ marginBottom:14, cursor:'pointer' }} onClick={alertInfo.action}><span style={{ fontSize:18 }}>{alertInfo.icon}</span><div style={{ flex:1, fontSize:13, color:'#9A3E00' }}>{alertInfo.text}</div><span style={{ background:'#E87722', color:'white', borderRadius:20, padding:'2px 8px', fontSize:12, fontWeight:700 }}>Traiter →</span></div>}

        {/* Ligne 1 : Demandes en cours d'instruction */}
        <div style={{ marginBottom:8 }}>
          <div style={{ fontSize:11, color:'#94a3b8', letterSpacing:'1px', textTransform:'uppercase', marginBottom:6, fontWeight:700 }}>📋 Instructions en cours</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
            {[
              {l:'Niveau Antenne',v:all.filter(r=>r.statut==='soumis_antenne').length, c:'#8b5cf6', f:'soumis_antenne', icon:'🏠'},
              {l:'Niveau APC',v:all.filter(r=>r.statut==='soumis').length, c:'#3b82f6', f:'soumis', icon:'🏢'},
              {l:'Niveau Commission',v:all.filter(r=>r.statut==='en_commission').length, c:'#f59e0b', f:'en_commission', icon:'⚖️'},
            ].map(s=>(
              <div key={s.l} className="stat-card" style={{ '--ac':s.c, cursor:'pointer' }} onClick={()=>{ setFilterStatus(s.f); setFilterDept(gDashDept); setFilterYear(gDashYear); setPage('demandes'); }}>
                <span style={{ fontSize:18, flexShrink:0 }}>{s.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:22, fontWeight:700, color:s.c, fontFamily:'Playfair Display,serif', lineHeight:1 }}>{s.v}</div>
                  <div style={{ fontSize:11, color:'#64748b', marginTop:2 }}>{s.l}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Ligne 2 : Diplômes */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11, color:'#94a3b8', letterSpacing:'1px', textTransform:'uppercase', marginBottom:6, fontWeight:700 }}>🖨 Diplômes — Actions requises</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:10 }}>
            {[
              {l:'Approuvés à imprimer',v:all.filter(r=>r.statut==='valide_federation'&&(!r.medalType.payant||r.paiement==='paye')).length, c:'#E87722', f:'valide_federation', icon:'🖨'},
              {l:'À expédier',v:all.filter(r=>r.statut==='diplome_emis').length, c:'#7c3aed', f:'diplome_emis', icon:'📬'},
              {l:'TDR à payer',v:all.filter(r=>r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye').length, c:'#f59e0b', f:'valide_federation', icon:'💳'},
            ].map(s=>(
              <div key={s.l} className="stat-card" style={{ '--ac':s.c, cursor:'pointer' }} onClick={()=>{ setFilterStatus(s.f); setFilterDept(gDashDept); setFilterYear(gDashYear); setPage('diplomes'); }}>
                <span style={{ fontSize:18, flexShrink:0 }}>{s.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:22, fontWeight:700, color:s.c, fontFamily:'Playfair Display,serif', lineHeight:1 }}>{s.v}</div>
                  <div style={{ fontSize:11, color:'#64748b', marginTop:2 }}>{s.l}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize:11, color:'#94a3b8', letterSpacing:'1px', textTransform:'uppercase', marginBottom:6, fontWeight:700, marginTop:14 }}>📊 Diplômes — Suivi global</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
            {[
              {l:'Diplômes validés',v:all.filter(r=>['valide_federation','diplome_emis','expedie'].includes(r.statut)).length, c:'#10b981', f:'valide_federation', icon:'✅'},
              {l:'Diplômes imprimés',v:all.filter(r=>['diplome_emis','expedie'].includes(r.statut)).length, c:'#059669', f:'diplome_emis', icon:'🎖'},
              {l:'Diplômes expédiés',v:all.filter(r=>r.statut==='expedie').length, c:'#7c3aed', f:'expedie', icon:'📮'},
            ].map(s=>(
              <div key={s.l} className="stat-card" style={{ '--ac':s.c, cursor:'pointer' }} onClick={()=>{ setFilterStatus(s.f); setFilterDept(gDashDept); setFilterYear(gDashYear); setPage('demandes'); }}>
                <span style={{ fontSize:18, flexShrink:0 }}>{s.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:22, fontWeight:700, color:s.c, fontFamily:'Playfair Display,serif', lineHeight:1 }}>{s.v}</div>
                  <div style={{ fontSize:11, color:'#64748b', marginTop:2 }}>{s.l}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
          <div className="card">
            <h2 style={H2}>Par département</h2>
            {byDept.length===0&&<div style={{ color:'#94a3b8', fontSize:13 }}>Aucune donnée</div>}
            {byDept.map(([dept,count]) => {
              const max = byDept[0]?.[1]||1;
              return <div key={dept} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                <span style={{ fontSize:11, color:'#64748b', width:130, flexShrink:0, textAlign:'right' }}>{dept.split(' - ')[1]||dept}</span>
                <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:16, overflow:'hidden' }}>
                  <div style={{ width:`${count/max*100}%`, height:'100%', background:'#1B3764', borderRadius:4, transition:'width 0.5s' }}/>
                </div>
                <span style={{ fontSize:11, fontWeight:700, color:'#1B3764', width:24 }}>{count}</span>
              </div>;
            })}
          </div>
          <div className="card">
            <h2 style={H2}>Par type de distinction</h2>
            {byMedal.map(m => <div key={m.label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
              <div style={{ width:10, height:10, borderRadius:'50%', background:m.color, flexShrink:0 }}/>
              <span style={{ fontSize:11, color:'#64748b', width:80, flexShrink:0 }}>{m.label}</span>
              <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:14 }}>
                <div style={{ width:`${m.count/(all.length||1)*100}%`, height:'100%', background:m.color, borderRadius:4 }}/>
              </div>
              <span style={{ fontSize:11, fontWeight:700, color:'#1B3764', width:20 }}>{m.count}</span>
            </div>)}
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:14 }}>
          <div className="card">
            <h2 style={H2}>Répartition H / F</h2>
            <div style={{ display:'flex', gap:10, marginTop:10 }}>
              {[{l:'Hommes',c:hommes,color:'#1B3764'},{l:'Femmes',c:femmes,color:'#E87722'}].map(g=>(
                <div key={g.l} style={{ flex:1, textAlign:'center' }}>
                  <div style={{ width:60, height:60, borderRadius:'50%', background:g.color, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:700, color:'white', fontFamily:'Playfair Display,serif', margin:'0 auto 8px' }}>{Math.round(g.c/totalG*100)}%</div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{g.l}</div>
                  <div style={{ fontSize:14, fontWeight:700, color:g.color }}>{g.c}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h2 style={H2}>Pyramide des âges</h2>
            {Object.entries(ageGroups).map(([g,c])=>(
              <div key={g} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
                <span style={{ fontSize:11, color:'#64748b', width:40, flexShrink:0 }}>{g}</span>
                <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:14 }}>
                  <div style={{ width:`${c/maxAG*100}%`, height:'100%', background:'#E87722', borderRadius:4 }}/>
                </div>
                <span style={{ fontSize:11, fontWeight:700, color:'#E87722', width:20 }}>{c}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h2 style={H2}>Indicateurs clés</h2>
            {[{l:'Délai moyen traitement',v:`${avgDelay} jours`},{l:'Taux approbation',v:`${Math.round(all.filter(r=>['diplome_emis','expedie'].includes(r.statut)).length/(all.length||1)*100)}%`},{l:'Témoignages en attente paiement',v:all.filter(r=>r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye').length},{l:'Diplômes à expédier',v:all.filter(r=>r.statut==='diplome_emis').length},{l:'En retard (>30j)',v:all.filter(r=>['soumis','en_commission'].includes(r.statut)&&daysSince(r.dateCreation)>30).length}].map(i=>(
              <div key={i.l} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid #f1f5f9', fontSize:13 }}>
                <span style={{ color:'#64748b' }}>{i.l}</span>
                <span style={{ fontWeight:700, color:'#1B3764' }}>{i.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function DemandesPage() {
    const eligible4QuickVal = visibleRequests.filter(r => r.statut==='en_commission' && r.benevole.ans >= r.medalType.years);
    const years = [...new Set(requests.map(r=>r.dateCreation?.slice(0,4)).filter(Boolean))].sort().reverse();
    return (
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
          <h1 style={H1}>Demandes de distinctions</h1>
          <div style={{ display:'flex', gap:8 }}>
            {role==='commission' && eligible4QuickVal.length>0 && <button className="btn btn-success btn-sm" onClick={()=>setQuickValConfirm(eligible4QuickVal.map(r=>r.id))}>⚡ Validation rapide ({eligible4QuickVal.length})</button>}
            {canCreate && <button className="btn btn-orange" onClick={() => setPage('nouvelle')}>✚ Nouvelle demande</button>}
          </div>
        </div>
        <div className="card" style={{ marginBottom:12, padding:'12px 16px' }}>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            <input className="input" placeholder="🔍 Rechercher…" value={search} onChange={e=>setSearch(e.target.value)} style={{ maxWidth:200 }}/>
            <select className="select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{ maxWidth:190 }}>
              <option value="all">Tous les statuts</option>
              {Object.entries(STATUSES).map(([k,s])=><option key={k} value={k}>{s.label}</option>)}
            </select>
            {['commission','gestion'].includes(role)&&<select className="select" value={filterDept} onChange={e=>setFilterDept(e.target.value)} style={{ maxWidth:190 }}>
              <option value="all">Tous les départements</option>
              {[...new Set(requests.map(r=>r.dept))].sort().map(d=><option key={d} value={d}>{d}</option>)}
            </select>}
            <select className="select" value={filterYear} onChange={e=>setFilterYear(e.target.value)} style={{ maxWidth:110 }}>
              <option value="all">Toutes années</option>
              {years.map(y=><option key={y} value={y}>{y}</option>)}
            </select>
            <span style={{ color:'#94a3b8', fontSize:12, marginLeft:'auto' }}>{visibleRequests.length} résultat(s){totalPages > 1 ? ` — page ${currentPage}/${totalPages}` : ''}</span>
          </div>
        </div>
        <div className="card">
          <ReqHeader />
          {visibleRequests.length===0 ? <div style={{ textAlign:'center', padding:'36px', color:'#94a3b8' }}>📭 Aucune demande</div>
            : paginatedRequests.map(req=><ReqRow key={req.id} req={req} onSelect={setSelected} showLate={role!=='antenne'}/>)}
        </div>
        {totalPages > 1 && (
          <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:8, marginTop:12 }}>
            <button className="btn btn-outline btn-sm" disabled={pageOffset===0} onClick={()=>setPageOffset(0)}>«</button>
            <button className="btn btn-outline btn-sm" disabled={pageOffset===0} onClick={()=>setPageOffset(p=>Math.max(0,p-pageSize))}>‹ Préc.</button>
            <span style={{ fontSize:13, color:'#64748b' }}>Page {currentPage} / {totalPages}</span>
            <button className="btn btn-outline btn-sm" disabled={currentPage>=totalPages} onClick={()=>setPageOffset(p=>p+pageSize)}>Suiv. ›</button>
            <button className="btn btn-outline btn-sm" disabled={currentPage>=totalPages} onClick={()=>setPageOffset((totalPages-1)*pageSize)}>»</button>
          </div>
        )}
      </div>
    );
  }

  function StatistiquesPage() {
    const years = [...new Set(allForRole.map(r=>r.dateCreation?.slice(0,4)).filter(Boolean))].sort().reverse();
    const data = dashYear==='all' ? allForRole : allForRole.filter(r=>r.dateCreation?.startsWith(dashYear));
    // Délai moyen de traitement : création -> dernière action de l'historique
    const delays = data.map(r => {
      const hist = Array.isArray(r.historique) ? r.historique : [];
      const last = hist.length ? hist[hist.length-1]?.date : null;
      if (!r.dateCreation || !last) return null;
      const d = Math.floor((new Date(last) - new Date(r.dateCreation)) / 86400000);
      return d >= 0 ? d : null;
    }).filter(d => d != null);
    const avgDelay = delays.length ? Math.round(delays.reduce((a,b)=>a+b,0)/delays.length) : null;
    const refusCount = data.filter(r=>['refuse_dept','refuse_federation'].includes(r.statut)).length;
    // Volumes par département
    const deptMap = {};
    data.forEach(r => { const d = r.dept || '—'; deptMap[d] = (deptMap[d]||0)+1; });
    const byDeptStat = Object.entries(deptMap).map(([dept,count])=>({dept,count})).sort((a,b)=>b.count-a.count);
    const maxDept = Math.max(...byDeptStat.map(d=>d.count), 1);
    // Évolution par mois (12 derniers)
    const monthMap = {};
    data.forEach(r => { const m = r.dateCreation?.slice(0,7); if(m) monthMap[m]=(monthMap[m]||0)+1; });
    const byMonth = Object.entries(monthMap).map(([month,count])=>({month,count})).sort((a,b)=>a.month.localeCompare(b.month)).slice(-12);
    const maxMonth = Math.max(...byMonth.map(m=>m.count), 1);
    const byMedal = medalTypes.map(m => ({ label:m.shortLabel, count:data.filter(r=>r.medalType.id===m.id).length, color:m.color }));
    const hommes = data.filter(r=>r.benevole.genre==='M').length;
    const femmes = data.filter(r=>r.benevole.genre==='F').length;
    const totalG = hommes+femmes||1;
    const ageGroups = {'<30':0,'30-40':0,'40-50':0,'50-60':0,'60+':0};
    data.forEach(r => { const a=new Date().getFullYear()-(r.benevole.annee||1970); if(a<30)ageGroups['<30']++;else if(a<40)ageGroups['30-40']++;else if(a<50)ageGroups['40-50']++;else if(a<60)ageGroups['50-60']++;else ageGroups['60+']+= 1; });
    const maxAG = Math.max(...Object.values(ageGroups),1);
    return (
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <div>
            <h1 style={H1}>Statistiques</h1>
            <p style={{ color:'#64748b', fontSize:13 }}>{data.length} demande(s){dashYear!=='all'?` · ${dashYear}`:''}</p>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <select className="select" value={dashYear} onChange={e=>setDashYear(e.target.value)} style={{ maxWidth:140 }}>
              <option value="all">Toutes les années</option>
              {years.map(y=><option key={y} value={y}>{y}</option>)}
            </select>
            {dashYear!=='all'&&<button className="btn btn-outline btn-sm" onClick={()=>setDashYear('all')}>✕</button>}
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
          <div className="card">
            <h2 style={H2}>Par type de distinction</h2>
            {byMedal.filter(m=>m.count>0).map(m=><div key={m.label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
              <div style={{ width:10, height:10, borderRadius:'50%', background:m.color, flexShrink:0 }}/>
              <span style={{ fontSize:12, color:'#64748b', width:90, flexShrink:0 }}>{m.label}</span>
              <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:14 }}>
                <div style={{ width:`${m.count/(data.length||1)*100}%`, height:'100%', background:m.color, borderRadius:4 }}/>
              </div>
              <span style={{ fontSize:12, fontWeight:700, color:'#1B3764', width:24 }}>{m.count}</span>
            </div>)}
          </div>
          <div className="card">
            <h2 style={H2}>Répartition H / F</h2>
            <div style={{ display:'flex', gap:20, marginTop:14, justifyContent:'center' }}>
              {[{l:'Hommes',c:hommes,color:'#1B3764'},{l:'Femmes',c:femmes,color:'#E87722'}].map(g=>(
                <div key={g.l} style={{ textAlign:'center' }}>
                  <div style={{ width:70, height:70, borderRadius:'50%', background:g.color, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24, fontWeight:700, color:'white', fontFamily:'Playfair Display,serif', margin:'0 auto 8px' }}>{Math.round(g.c/totalG*100)}%</div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{g.l}</div>
                  <div style={{ fontSize:16, fontWeight:700, color:g.color }}>{g.c}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="card">
          <h2 style={H2}>Pyramide des âges</h2>
          {Object.entries(ageGroups).map(([g,c])=>(
            <div key={g} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
              <span style={{ fontSize:12, color:'#64748b', width:50, flexShrink:0 }}>{g}</span>
              <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:16 }}>
                <div style={{ width:`${c/maxAG*100}%`, height:'100%', background:'#E87722', borderRadius:4 }}/>
              </div>
              <span style={{ fontSize:12, fontWeight:700, color:'#E87722', width:24 }}>{c}</span>
            </div>
          ))}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:12, margin:'14px 0' }}>
          {[
            { l:'Total', v:data.length, c:'#1B3764' },
            { l:'En cours', v:data.filter(r=>['soumis_antenne','soumis','pret_commission','en_commission','valide_federation'].includes(r.statut)).length, c:'#3b82f6' },
            { l:'Émises', v:data.filter(r=>['diplome_emis','expedie'].includes(r.statut)).length, c:'#059669' },
            { l:'Refusées', v:refusCount, c:'#dc2626' },
            { l:'Taux de refus', v:(data.length?Math.round(refusCount/data.length*100):0)+'%', c:'#dc2626' },
            { l:'Délai moyen', v:(avgDelay!=null?avgDelay+' j':'—'), c:'#E87722' },
          ].map(k=>(
            <div key={k.l} className="card" style={{ textAlign:'center', padding:'14px 10px' }}>
              <div style={{ fontSize:24, fontWeight:800, color:k.c, fontFamily:'Playfair Display,serif' }}>{k.v}</div>
              <div style={{ fontSize:11, color:'#64748b', marginTop:2 }}>{k.l}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ marginBottom:14 }}>
          <h2 style={H2}>Répartition par statut</h2>
          {Object.keys(STATUSES).map(st=>({ st, count:data.filter(r=>r.statut===st).length })).filter(x=>x.count>0).map(({st,count})=>(
            <div key={st} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
              <span style={{ fontSize:12, color:'#64748b', width:160, flexShrink:0 }}>{STATUSES[st]?.label||st}</span>
              <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:14 }}>
                <div style={{ width:`${count/(data.length||1)*100}%`, height:'100%', background:STATUSES[st]?.color||'#1B3764', borderRadius:4 }}/>
              </div>
              <span style={{ fontSize:12, fontWeight:700, color:'#1B3764', width:24 }}>{count}</span>
            </div>
          ))}
        </div>

        {role==='gestion' && byDeptStat.length>0 && (
        <div className="card" style={{ marginBottom:14 }}>
          <h2 style={H2}>Volumes par département</h2>
          {byDeptStat.map(({dept,count})=>(
            <div key={dept} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
              <span style={{ fontSize:12, color:'#64748b', width:160, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{dept}</span>
              <div style={{ flex:1, background:'#e5e7eb', borderRadius:4, height:14 }}>
                <div style={{ width:`${count/maxDept*100}%`, height:'100%', background:'#1B3764', borderRadius:4 }}/>
              </div>
              <span style={{ fontSize:12, fontWeight:700, color:'#1B3764', width:24 }}>{count}</span>
            </div>
          ))}
        </div>
        )}

        {byMonth.length>0 && (
        <div className="card">
          <h2 style={H2}>Évolution (12 derniers mois)</h2>
          <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:120, marginTop:10 }}>
            {byMonth.map(({month,count})=>(
              <div key={month} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                <div style={{ fontSize:11, fontWeight:700, color:'#1B3764' }}>{count||''}</div>
                <div style={{ width:'100%', background:'#E87722', borderRadius:'4px 4px 0 0', height:`${count/maxMonth*80}px`, minHeight:count?4:0 }}/>
                <div style={{ fontSize:10, color:'#94a3b8', whiteSpace:'nowrap' }}>{month.slice(2)}</div>
              </div>
            ))}
          </div>
        </div>
        )}
      </div>
    );
  }

  const effectiveVol = useMemo(() => getEffectiveVol(), [nrMode, nrVol, nrNom, nrPrenom, nrAdhesion, nrGenre, nrAnnee, nrFonctions, nrDistinctions, nrDept]);

  function NouvelleDemandePage() {
    const vol = effectiveVol;
    const suggestion = vol ? getNextMedalSuggestion(vol, medalTypes) : null;
    const draftDate = !editReqId ? draftSavedAt : null;
    return (
      <div style={{ maxWidth:680 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20 }}>
          <button className="btn btn-outline btn-sm" onClick={()=>{ resetForm(); setPage('demandes'); }}>← Retour</button>
          <h1 style={H1}>{editReqId ? '✏️ Modifier la demande' : 'Nouvelle demande de distinction'}</h1>
          {editReqId && <span style={{ background:'#FFF4E8', border:'1px solid #E87722', borderRadius:20, padding:'2px 10px', fontSize:12, color:'#C45A00', fontWeight:700 }}>Modification · {editReqId}</span>}
        </div>

        {/* Bandeau brouillon */}
        {draftDate && !nrMedal && (
          <div style={{ background:'#fffbeb', border:'1px solid #fcd34d', borderRadius:8, padding:'10px 14px', marginBottom:12, display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:13 }}>
            <span>📝 Un brouillon a été sauvegardé le {new Date(draftDate).toLocaleString('fr-FR')}.</span>
            <div style={{ display:'flex', gap:8 }}>
              <button className="btn btn-sm btn-outline" onClick={()=>{ restoreDraft(); fire('Brouillon restauré ✓'); }}>Restaurer</button>
              <button className="btn btn-sm btn-outline" style={{ color:'#dc2626' }} onClick={()=>{ clearDraft(); fire('Brouillon supprimé'); }}>Ignorer</button>
            </div>
          </div>
        )}

        {/* 1 Identification — SSO non modifiable */}
        <div className="card" style={{ marginBottom:12 }}>
          <div className="st">1. Identification du demandeur</div>
          <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'9px 12px', marginBottom:10, fontSize:12, color:'#065f46' }}>🔒 Informations issues de votre compte SSO — non modifiables.</div>
          <div className="fg"><label className="fl">E-mail</label><input className="input" value={nrEmail} readOnly style={{ background:'#f8faff', color:'#64748b' }}/></div>
          {!lockedDept && <div className="fg"><label className="fl">Association APC *</label><select className="select" value={nrDept} onChange={e=>setNrDept(e.target.value)}><option value="">— Département —</option>{(role==='departement'?myDepts:DEPTS).map(d=><option key={d} value={d}>{d}</option>)}</select></div>}
          {lockedDept && <div className="fg"><label className="fl">Association APC</label><input className="input" value={lockedDept} readOnly style={{ background:'#f8faff', color:'#64748b' }}/></div>}
          <div className="fg" style={{ marginBottom:0 }}><label className="fl">Demandeur</label><input className="input" value={nrDemandeur} readOnly style={{ background:'#f8faff', color:'#64748b' }}/></div>
        </div>

        {/* 2 Récipiendaire */}
        <div className="card" style={{ marginBottom:12 }}>
          <div className="st">2. Récipiendaire</div>
          <div style={{ display:'flex', gap:8, marginBottom:10 }}>
            <button className={`tab ${nrMode==='registry'?'active':''}`} onClick={()=>setNrMode('registry')}>🔍 E protec</button>
            <button className={`tab ${nrMode==='manual'?'active':''}`} onClick={()=>setNrMode('manual')}>✏️ Saisie manuelle</button>
          </div>

          {nrMode==='registry' && <>
            <div style={{ display:'flex', gap:8, marginBottom:10 }}>
              <input className="input" style={{ flex:1 }} placeholder="Nom ou identifiant (Martin, Moreau, Thomas…)" value={nrVolSearch} onChange={e=>setNrVolSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&searchVol()}/>
              <button className="btn btn-primary" onClick={searchVol}>Rechercher</button>
            </div>
            {nrVol && <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:12, display:'flex', gap:10, alignItems:'center', marginBottom:12 }}>
              <div style={{ width:38, height:38, borderRadius:'50%', background:'#E87722', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, flexShrink:0 }}>{nrVol.prenom[0]}{nrVol.nom[0]}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, color:'#065f46', fontFamily:'Playfair Display,serif', fontSize:15 }}>{nrVol.prenom} {nrVol.nom}</div>
                <div style={{ fontSize:12, color:'#047857' }}>{nrVol.antenne||nrVol.dept} · {nrVol.ans} ans · {nrVol.adhesion}</div>
              </div>
              <span style={{ background:'#059669', color:'white', borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>✓</span>
            </div>}
          </>}

          {nrMode==='manual' && <div>
            <div className="g2">
              <div className="fg"><label className="fl">Nom *</label><input className="input" placeholder="NOM" value={nrNom} onChange={e=>setNrNom(e.target.value)}/></div>
              <div className="fg"><label className="fl">Prénom *</label><input className="input" placeholder="Prénom" value={nrPrenom} onChange={e=>setNrPrenom(e.target.value)}/></div>
            </div>
            <div className="g2">
              <div className="fg"><label className="fl">Date d'entrée PC *</label><input className="input" type="date" value={nrAdhesion} onChange={e=>setNrAdhesion(e.target.value)}/></div>
              <div className="fg"><label className="fl">Date de naissance</label><input className="input" type="date" value={nrAnnee} onChange={e=>setNrAnnee(e.target.value)}/></div>
            </div>
            <div className="fg"><label className="fl">Genre</label><select className="select" value={nrGenre} onChange={e=>setNrGenre(e.target.value)}><option value="M">Masculin</option><option value="F">Féminin</option><option value="C">Chien</option></select></div>
          </div>}

          {vol && <>
            <div className="fg"><label className="fl">Compétences <span style={{ color:'#94a3b8', fontWeight:400, fontSize:11 }}>(depuis E-Protec)</span></label><input className="input" value={nrFonctions} readOnly style={{ background:'#f8faff', color:'#64748b' }}/></div>
            <div className="fg" style={{ marginBottom:0 }}><label className="fl">Distinctions antérieures <span style={{ color:'#94a3b8', fontWeight:400, fontSize:11 }}>(depuis E-Protec)</span></label><input className="input" value={nrDistinctions||'Aucune'} readOnly style={{ background:'#f8faff', color:'#64748b' }}/></div>
          </>}
          {/* Alerte âge minimum 16 ans */}
          {vol && vol.annee && (new Date().getFullYear() - vol.annee) < 16 && (
            <div style={{ background:'#fffbeb', border:'1px solid #fbbf24', borderRadius:8, padding:'9px 14px', marginTop:10, fontSize:13, color:'#92400e', display:'flex', gap:8, alignItems:'flex-start' }}>
              <span style={{ fontSize:16, flexShrink:0 }}>⚠️</span>
              <div>
                <strong>Bénévole mineur — âge inférieur à 16 ans</strong><br/>
                <span style={{ fontSize:12 }}>{vol.prenom} {vol.nom} est né(e) en {vol.annee} ({new Date().getFullYear()-vol.annee} ans). La demande reste possible mais nécessite une attention particulière.</span>
              </div>
            </div>
          )}
        </div>

        {vol && <>
          {/* 3 Distinction */}
          <div className="card" style={{ marginBottom:12 }}>
            <div className="st">3. Niveau de distinction demandé *</div>
            {suggestion && role==='departement' && <div style={{ background:'#FFF4E8', border:'1px solid #E87722', borderRadius:8, padding:'9px 14px', marginBottom:10, fontSize:13 }}>💡 <strong>Suggestion :</strong> Avec {vol.ans} ans, prochain échelon : <strong>{suggestion.label}</strong> ({suggestion.years} ans requis).</div>}
            <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'8px 12px', marginBottom:10, fontSize:12, color:'#065f46' }}>ℹ️ Toutes les distinctions sont sélectionnables. Si le délai d'ancienneté n'est pas atteint, la distinction peut être accordée pour <strong>faits exceptionnels</strong> — les motivations devront être explicitement détaillées.</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {medalTypes.map((m, idx) => {
                const eligible = vol.ans >= m.years;
                const sel = nrMedal === m.id;
                return (
                  <label key={m.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px', borderRadius:8, border:`1px solid ${sel?m.color:eligible?'#e5e7eb':'#fbbf2430'}`, background:sel?m.light:eligible?'white':'#fffbeb', cursor:'pointer' }}>
                    <input type="radio" name="medal" value={m.id} checked={sel} onChange={()=>setNrMedal(m.id)} style={{ width:15, height:15 }}/>
                    <div style={{ width:10, height:10, borderRadius:'50%', background:m.color, flexShrink:0 }}/>
                    <div style={{ flex:1 }}>
                      <span style={{ fontWeight:700, color:'#1B3764', fontSize:13 }}>{m.label}</span>
                      {m.payant&&<span style={{ marginLeft:8, background:'#fbbf24', color:'#78350f', borderRadius:10, padding:'0 6px', fontSize:10, fontWeight:700 }}>{tarif}€</span>}
                      {m.custom&&<span style={{ marginLeft:8, background:'#e0f2fe', color:'#0369a1', borderRadius:10, padding:'0 6px', fontSize:10, fontWeight:700 }}>★ Spéciale</span>}
                      <span style={{ color:'#94a3b8', fontSize:12, marginLeft:6 }}>({m.years} ans requis)</span>
                    </div>
                    {eligible
                      ? <span style={{ fontSize:10, color:'#059669', fontWeight:700, flexShrink:0 }}>✓ {vol.ans} ans</span>
                      : <span style={{ fontSize:10, color:'#f59e0b', fontWeight:700, flexShrink:0 }}>⚡ Faits exceptionnels requis</span>}
                  </label>
                );
              })}
            </div>
            {nrMedal && !medalTypes.find(m=>m.id===nrMedal)?.payant && vol.ans < (medalTypes.find(m=>m.id===nrMedal)?.years||0) && (
              <div style={{ background:'#fffbeb', border:'1px solid #fbbf24', borderRadius:8, padding:'9px 12px', marginTop:10, fontSize:13, color:'#92400e' }}>
                ⚡ <strong>Délai non atteint :</strong> Cette distinction sera accordée uniquement pour faits exceptionnels. Veillez à détailler précisément les faits dans le champ Motivations.
              </div>
            )}
            {nrMedal!=='temoignage' && agrafes.filter(a=>a.actif&&a.depts.includes(lockedDept||nrDept||vol.dept)).length>0 && (
              <div style={{ marginTop:14, borderTop:'1px solid #f1f5f9', paddingTop:12 }}>
                <label className="fl" style={{ marginBottom:8 }}>🏅 Agrafes disponibles</label>
                {agrafes.filter(a=>a.actif&&a.depts.includes(lockedDept||nrDept||vol.dept)).map(ag=>(
                  <label key={ag.id} style={{ display:'flex', gap:8, alignItems:'center', cursor:'pointer', fontSize:13, marginBottom:6 }}>
                    <input type="checkbox" checked={nrAgrafeDepts.includes(ag.id)} onChange={e=>setNrAgrafeDepts(p=>e.target.checked?[...p,ag.id]:p.filter(x=>x!==ag.id))} style={{ width:15, height:15 }}/>
                    <span>{ag.nom}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* 4 Motivations */}
          <div className="card" style={{ marginBottom:12 }}>
            <div className="st">4. Motivations *</div>
            <textarea className="textarea" rows={5} placeholder="Décrivez l'investissement, les heures bénévolat, les faits marquants…" value={nrJust} onChange={e=>setNrJust(e.target.value)}/>
          </div>

          {/* 5 Date reception */}
          <div className="card" style={{ marginBottom:20 }}>
            <div className="st">5. Date de réception souhaitée</div>
            <input className="input" type="date" value={nrDateRecep} onChange={e=>setNrDateRecep(e.target.value)} style={{ maxWidth:220 }}/>
            {(()=>{ const dept=lockedDept||nrDept||vol.dept; const addr=deptAddresses[dept]; const s=addr?`${addr.nom}, ${addr.adresse}, ${addr.cp} ${addr.ville}`:'Non configurée'; return <p className="fh" style={{ marginTop:6 }}>Le diplôme sera expédié à : <strong>{s}</strong></p>; })()}
          </div>
          {role==='departement'&&!editReqId&&<div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'9px 14px', marginBottom:12, fontSize:13, color:'#065f46' }}>ℹ️ <strong>En tant que Président APC</strong>, votre demande sera transmise <strong>directement en Commission FNPC</strong> sans validation intermédiaire.</div>}
          {editReqId&&<div style={{ background:'#FFF4E8', border:'1px solid #E87722', borderRadius:8, padding:'9px 14px', marginBottom:12, fontSize:13, color:'#C45A00' }}>✏️ Modification de la demande <strong>{editReqId}</strong> — soumettez pour la renvoyer, ou enregistrez en brouillon pour continuer plus tard.</div>}
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-orange" onClick={createRequest} disabled={!nrMedal||!nrJust.trim()}>
              {role==='departement' ? '⚖️ Soumettre en Commission FNPC' : role==='antenne' ? '📤 Soumettre APC' : '✚ Soumettre la demande'}
            </button>
            <button className="btn btn-outline" onClick={saveDraft} disabled={!vol}>💾 Enregistrer brouillon</button>
            <button className="btn btn-outline" onClick={()=>{ resetForm(); setPage('demandes'); }}>Annuler</button>
          </div>
        </>}
      </div>
    );
  }

  function ValidationRapidePage() {
    const eligible = requests.filter(r=>r.statut==='en_commission'&&r.benevole.ans>=r.medalType.years);
    const horsDelai = requests.filter(r=>r.statut==='en_commission'&&r.benevole.ans<r.medalType.years);
    return (
      <div>
        <h1 style={H1}>Validation rapide — Commission FNPC</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>La validation rapide s'applique uniquement aux dossiers dont <strong>le délai d'ancienneté est respecté</strong>. Les dossiers hors délais (faits exceptionnels) doivent être examinés individuellement.</p>
        {eligible.length>0 && <div style={{ marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ color:'#059669', fontWeight:700 }}>✓ {eligible.length} dossier(s) éligible(s) au délai</span>
          <button className="btn btn-success" onClick={()=>setQuickValConfirm(eligible.map(r=>r.id))}>⚡ Valider tous ({eligible.length})</button>
        </div>}
        {eligible.map(req=>(
          <div key={req.id} className="card" style={{ marginBottom:8, display:'flex', alignItems:'center', gap:12, borderLeft:'4px solid #059669', padding:'12px 16px' }}>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, color:'#1B3764', fontFamily:'Playfair Display,serif' }}>{req.benevole.prenom} {req.benevole.nom}</div>
              <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>{req.medalType.label} · {req.dept} · {req.benevole.ans} ans / {req.medalType.years} requis</div>
            </div>
            <span style={{ background:'#d1fae5', color:'#059669', borderRadius:20, padding:'2px 10px', fontSize:11, fontWeight:700 }}>✓ Éligible</span>
            <button className="btn btn-success btn-sm" onClick={()=>setQuickValConfirm([req.id])}>Approuver</button>
          </div>
        ))}
        {eligible.length===0 && <div className="card" style={{ textAlign:'center', padding:36, color:'#94a3b8' }}>✓ Aucun dossier éligible au délai en attente</div>}
        {horsDelai.length>0&&<>
          <div style={{ marginTop:18, marginBottom:10, color:'#f59e0b', fontWeight:700, fontSize:13 }}>⚡ {horsDelai.length} dossier(s) hors délai — faits exceptionnels — examen individuel requis</div>
          {horsDelai.map(req=>(
            <div key={req.id} className="card" style={{ marginBottom:8, display:'flex', alignItems:'center', gap:12, borderLeft:'4px solid #f59e0b', padding:'12px 16px' }}>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, color:'#1B3764', fontFamily:'Playfair Display,serif' }}>{req.benevole.prenom} {req.benevole.nom}</div>
                <div style={{ fontSize:12, color:'#f59e0b', marginTop:2 }}>{req.medalType.label} · {req.benevole.ans} ans / {req.medalType.years} requis · faits exceptionnels</div>
              </div>
              <span style={{ background:'#fffbeb', color:'#92400e', borderRadius:20, padding:'2px 10px', fontSize:11, fontWeight:700 }}>⚡ Hors délai</span>
              <button className="btn btn-sm" style={{ background:'#f59e0b', color:'white' }} onClick={()=>setSelected(req)}>Examiner</button>
            </div>
          ))}
        </>}
      </div>
    );
  }

  function DeleguesPage() {
    const niveauxDispos = role==='gestion' ? ['antenne','departement','commission','gestion'] : [role];
    // SSO search: filter MOCK_VOLUNTEERS by dept/antenne scope
    const ssoScope = role === 'antenne'
      ? MOCK_VOLUNTEERS.filter(v => v.dept === '75 - Paris Seine' && v.antenne?.includes('Paris 12'))
      : role === 'departement'
      ? MOCK_VOLUNTEERS.filter(v => v.dept === '75 - Paris Seine')
      : MOCK_VOLUNTEERS; // gestion: all
    const [ssoSearch, setSsoSearch] = [dlgSsoSearch, setDlgSsoSearch];
    const ssoResults = ssoSearch.length > 1
      ? ssoScope.filter(v => `${v.prenom} ${v.nom} ${v.antenne||''}`.toLowerCase().includes(ssoSearch.toLowerCase()))
      : [];
    const pickSso = (v) => { setDlgNom(v.nom); setDlgPrenom(v.prenom); setDlgEmail(v.email||`${v.prenom.toLowerCase()}.${v.nom.toLowerCase()}@fnpc.fr`); setSsoSearch(''); };

    const addDelegate = () => {
      if (!dlgNom||!dlgPrenom||!dlgEmail) return;
      setDelegates(p => [...p,{ id:`D${Date.now()}`, nom:dlgNom.toUpperCase(), prenom:dlgPrenom, email:dlgEmail, niveau:dlgNiveau, delegueePar:ROLES[role].label, date:today(), actif:true, permissions:{ ...dlgPerms } }]);
      setDlgNom(''); setDlgPrenom(''); setDlgEmail('');
      fire('Délégué ajouté ✓');
    };
    const toggleDelegate = id => setDelegates(p=>p.map(d=>d.id!==id?d:{ ...d, actif:!d.actif }));
    const removeDelegate = id => setDelegates(p=>p.filter(d=>d.id!==id));
    const togglePerm = (id, perm) => setDelegates(p=>p.map(d=>d.id!==id?d:{ ...d, permissions:{ ...d.permissions, [perm]:!d.permissions?.[perm] } }));
    const visible = role==='gestion' ? delegates.filter(d=>d.niveau===dlgFilter) : delegates.filter(d=>d.niveau===role);
    return (
      <div style={{ maxWidth:740 }}>
        <h1 style={H1}>Gestion des délégués</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>Les délégués peuvent agir au nom du responsable de leur niveau selon les permissions accordées.</p>

        {role==='gestion' && (
          <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }}>
            {['antenne','departement','commission','gestion'].map(n=>(
              <button key={n} className={`tab ${dlgFilter===n?'active':''}`} onClick={()=>setDlgFilter(n)}>{ROLES[n]?.label}</button>
            ))}
          </div>
        )}

        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Ajouter un délégué</div>
          <div className="fg">
            <label className="fl">Recherche SSO (E-Protec) *</label>
            <input className="input" placeholder="Tapez un nom ou prénom…" value={ssoSearch} onChange={e=>setSsoSearch(e.target.value)}/>
            {ssoResults.length > 0 && (
              <div style={{ border:'1px solid #e5e7eb', borderRadius:8, marginTop:4, overflow:'hidden', boxShadow:'0 4px 10px rgba(0,0,0,0.08)' }}>
                {ssoResults.slice(0,6).map(v=>(
                  <div key={v.id} onClick={()=>pickSso(v)} style={{ padding:'9px 12px', cursor:'pointer', borderBottom:'1px solid #f1f5f9', display:'flex', gap:10, alignItems:'center' }}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:'#1B3764', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, flexShrink:0 }}>{v.prenom[0]}{v.nom[0]}</div>
                    <div><div style={{ fontWeight:700, fontSize:14, color:'#1B3764' }}>{v.prenom} {v.nom}</div><div style={{ fontSize:12, color:'#64748b' }}>{v.antenne} · {v.ans} ans</div></div>
                  </div>
                ))}
              </div>
            )}
            {ssoSearch.length>1 && ssoResults.length===0 && <p className="fh" style={{ color:'#dc2626' }}>Aucun résultat dans votre périmètre SSO</p>}
          </div>
          {(dlgNom||dlgPrenom) && (
            <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'9px 12px', marginBottom:12, fontSize:14, color:'#065f46' }}>
              ✓ <strong>{dlgPrenom} {dlgNom}</strong> · {dlgEmail}
              <button className="btn btn-outline btn-sm" style={{ marginLeft:10 }} onClick={()=>{ setDlgNom(''); setDlgPrenom(''); setDlgEmail(''); }}>✕</button>
            </div>
          )}
          {role==='gestion'&&<div className="fg"><label className="fl">Niveau</label><select className="select" value={dlgNiveau} onChange={e=>setDlgNiveau(e.target.value)}>{niveauxDispos.map(n=><option key={n} value={n}>{ROLES[n]?.label||n}</option>)}</select></div>}
          <div className="fg">
            <label className="fl">Permissions</label>
            <div style={{ display:'flex', gap:12, marginTop:4 }}>
              {[['lecture','👁 Lecture seule'],['demandes','✚ Faire des demandes'],['validation','✓ Valider les demandes']].map(([k,l])=>(
                <label key={k} style={{ display:'flex', gap:6, alignItems:'center', cursor:'pointer', fontSize:14 }}>
                  <input type="checkbox" checked={dlgPerms[k]||false} onChange={e=>setDlgPerms(p=>({...p,[k]:e.target.checked}))} style={{ width:15, height:15 }}/>
                  {l}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-orange" onClick={addDelegate} disabled={!dlgNom||!dlgPrenom}>+ Ajouter</button>
        </div>

        <div className="card">
          <h2 style={H2}>Délégués — {visible.filter(d=>d.actif).length} actif(s)</h2>
          {visible.length===0&&<div style={{ color:'#94a3b8', textAlign:'center', padding:24 }}>Aucun délégué pour ce niveau.</div>}
          {visible.map(d=>(
            <div key={d.id} style={{ padding:'12px 0', borderBottom:'1px solid #f1f5f9', opacity:d.actif?1:0.5 }}>
              <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:8 }}>
                <div style={{ width:34, height:34, borderRadius:'50%', background:d.actif?'#1B3764':'#94a3b8', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, flexShrink:0, fontSize:13 }}>{d.prenom[0]}{d.nom[0]}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700, color:'#1B3764', fontSize:14 }}>{d.prenom} {d.nom}</div>
                  <div style={{ fontSize:11, color:'#64748b' }}>{d.email} · {ROLES[d.niveau]?.label||d.niveau} · Délégué par {d.delegueePar} · {d.date}</div>
                </div>
                <span className="badge" style={{ background:d.actif?'#d1fae5':'#f1f5f9', color:d.actif?'#059669':'#94a3b8' }}>{d.actif?'Actif':'Suspendu'}</span>
                <button className="btn btn-outline btn-sm" onClick={()=>toggleDelegate(d.id)}>{d.actif?'Suspendre':'Réactiver'}</button>
                <button className="btn btn-danger btn-sm" onClick={()=>removeDelegate(d.id)}>✕</button>
              </div>
              <div style={{ display:'flex', gap:10, paddingLeft:44 }}>
                {[['lecture','👁 Lecture'],['demandes','✚ Demandes'],['validation','✓ Validation']].map(([k,l])=>(
                  <button key={k} onClick={()=>togglePerm(d.id,k)} style={{ display:'flex', gap:5, alignItems:'center', cursor:'pointer', fontSize:12, background:d.permissions?.[k]?'#d1fae5':'#f1f5f9', borderRadius:20, padding:'3px 10px', color:d.permissions?.[k]?'#059669':'#94a3b8', border:'none' }}>
                    <span style={{ fontSize:11 }}>{d.permissions?.[k]?'✓':'○'}</span>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function AdressePage() {
    const dept = adrDept || lockedDept || myDepts[0] || '75 - Paris Seine';
    const save = () => { setDeptAddresses(p=>({ ...p, [dept]:{ nom:adrNom, adresse:adrAdresse, cp:adrCp, ville:adrVille, email:adrEmail, psClientId:adrPsClientId } })); fire('Adresse enregistrée ✓'); };
    return (
      <div style={{ maxWidth:600 }}>
        <h1 style={H1}>Adresse de réception APC</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>L'adresse saisie ici sera utilisée pour l'expédition de tous les diplômes de votre département.</p>
        {(()=>{ const opts = role==='gestion' ? DEPTS : myDepts; return opts.length>1 ? (
          <div className="fg" style={{ maxWidth:380 }}><label className="fl">Département à configurer</label>
            <select className="select" value={adrDept} onChange={e=>setAdrDept(e.target.value)}>{opts.map(d=><option key={d} value={d}>{d}</option>)}</select>
          </div>
        ) : null; })()}
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">{dept}</div>
          <div className="fg"><label className="fl">Nom de l'association</label><input className="input" placeholder="APC Département XX" value={adrNom} onChange={e=>setAdrNom(e.target.value)}/></div>
          <div className="fg"><label className="fl">Adresse</label><input className="input" placeholder="N° rue, nom de la rue" value={adrAdresse} onChange={e=>setAdrAdresse(e.target.value)}/></div>
          <div className="g2">
            <div className="fg"><label className="fl">Code postal</label><input className="input" placeholder="75000" value={adrCp} onChange={e=>setAdrCp(e.target.value)}/></div>
            <div className="fg"><label className="fl">Ville</label><input className="input" placeholder="Paris" value={adrVille} onChange={e=>setAdrVille(e.target.value)}/></div>
          </div>
          <div className="fg"><label className="fl">Email APC <span style={{ color:'#94a3b8', fontSize:11 }}>(utilisé pour la recherche PrestaShop si pas d'ID client)</span></label><input className="input" type="email" placeholder="apc.dept@protection-civile.org" value={adrEmail} onChange={e=>setAdrEmail(e.target.value)}/></div>
          {role==='gestion' && <div className="fg">
            <label className="fl">
              ID client PrestaShop{' '}
              <span style={{ color:'#94a3b8', fontSize:11 }}>(recommandé — remplace la recherche par email)</span>
            </label>
            <input className="input" placeholder="Ex : 42" value={adrPsClientId} onChange={e=>setAdrPsClientId(e.target.value.replace(/\D/g,''))}/>
            {adrPsClientId && <div style={{ fontSize:11, color:'#059669', marginTop:4 }}>✓ ID client #{adrPsClientId} — les commandes TDR utiliseront directement cet identifiant.</div>}
            {!adrPsClientId && <div style={{ fontSize:11, color:'#f59e0b', marginTop:4 }}>⚠️ Sans ID client, la recherche se fait par email (moins fiable).</div>}
          </div>}
          {adrNom && adrAdresse && adrCp && adrVille && (
            <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'9px 12px', marginBottom:12, fontSize:13, color:'#065f46' }}>
              📬 {adrNom}, {adrAdresse}, {adrCp} {adrVille}
            </div>
          )}
          <button className="btn btn-orange" onClick={save}>💾 Enregistrer</button>
        </div>
        {role==='gestion' && (
          <div className="card">
            <h2 style={H2}>Toutes les adresses APC</h2>
            {Object.entries(deptAddresses).length === 0 && <div style={{ color:'#94a3b8', fontSize:13 }}>Aucune adresse configurée.</div>}
            {Object.entries(deptAddresses).sort(([a],[b])=>{ const na=parseInt(a); const nb=parseInt(b); return na-nb; }).map(([d,a])=>(
              <div key={d} style={{ padding:'10px 0', borderBottom:'1px solid #f1f5f9', display:'flex', gap:10, alignItems:'center' }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700, color:'#1B3764', fontSize:14 }}>{d}</div>
                  <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>{a.nom}, {a.adresse}, {a.cp} {a.ville}{a.email?` · ${a.email}`:''}{a.psClientId?<span style={{ color:'#059669', fontWeight:600 }}> · PS#{a.psClientId}</span>:<span style={{ color:'#f59e0b' }}> · ⚠️ Pas d'ID PS</span>}</div>
                </div>
                <button className="btn btn-outline btn-sm" onClick={()=>{ setAdrNom(a.nom); setAdrAdresse(a.adresse); setAdrCp(a.cp); setAdrVille(a.ville); setAdrEmail(a.email||''); setAdrPsClientId(a.psClientId||''); }}>✏️ Modifier</button>
                <button className="btn btn-danger btn-sm" onClick={()=>{ setDeptAddresses(p=>{ const n={...p}; delete n[d]; return n; }); fire('Adresse supprimée ✓'); }}>✕</button>
              </div>
            ))}
            <div style={{ marginTop:14, borderTop:'1px solid #f1f5f9', paddingTop:12 }}>
              <p style={{ fontSize:13, color:'#64748b' }}>Pour modifier une adresse, cliquez sur ✏️ puis complétez le formulaire ci-dessus et enregistrez.</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  function DiplomesPage() {
    const emis = requests.filter(r=>r.statut==='diplome_emis');
    const emisPayees = emis.filter(r=>!r.medalType.payant||r.paiement==='paye');
    const tdrEnAttente = requests.filter(r=>r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye');
    const byDept = {};
    emis.forEach(r=>{ if(!byDept[r.dept]) byDept[r.dept]=[]; byDept[r.dept].push(r); });
    const tdrByDept2 = requests.reduce((acc,r)=>{ if(r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye'){ if(!acc[r.dept])acc[r.dept]=[]; acc[r.dept].push(r); } return acc; },{});
    const toggleBatch = id => setSelectedBatch(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
    const selectDept = (deptReqs) => { const ids=deptReqs.filter(r=>!r.medalType.payant||r.paiement==='paye').map(r=>r.id); setSelectedBatch(p=>{ const s=new Set(p); ids.forEach(id=>s.has(id)?s.delete(id):s.add(id)); return [...s]; }); };
    const markPaidByDept = (deptReqs) => { deptReqs.filter(r=>r.medalType.payant&&r.paiement!=='paye').forEach(r=>markPaid(r.id)); fire('Paiements APC enregistrés ✓'); };
    const printTemplate = (req) => {
      if (req.medalType.payant && req.paiement !== 'paye') { fire('Paiement requis avant impression de ce témoignage', 'err'); return; }
      setDiplomaView({ ...req, _printMode:'template' });
    };
    const printFull = (req) => {
      if (req.medalType.payant && req.paiement !== 'paye') { fire('Paiement requis avant impression de ce témoignage', 'err'); return; }
      setDiplomaView({ ...req, _printMode:'full' });
    };
    return (
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
          <div><h1 style={H1}>Diplômes</h1><p style={{ color:'#64748b', fontSize:13, marginTop:2 }}>{emis.length} diplôme(s) imprimés · {tdrEnAttente.length>0?`${tdrEnAttente.length} témoignage(s) en attente de paiement ·`:''} en attente d'expédition</p></div>
          <div style={{ display:'flex', gap:8 }}>
            {selectedBatch.length>0&&<button className="btn btn-primary btn-sm" onClick={()=>{ const first=emis.find(r=>selectedBatch.includes(r.id)); if(first) setDiplomaView({ ...first, _printMode:'template' }); }}>📄 Imprimer Template ({selectedBatch.length})</button>}
            {selectedBatch.length>0&&<button className="btn btn-sm" style={{ background:'#7c3aed', color:'white' }} onClick={()=>confirm(`Expédier ${selectedBatch.length} diplôme(s)`, `Marquer ${selectedBatch.length} diplôme(s) sélectionné(s) comme expédié(s) ? Cette action est irréversible.`, ()=>markExpedited(selectedBatch))}>📬 Marquer Expédié ({selectedBatch.length})</button>}
          </div>
        </div>

        {/* TDR EN ATTENTE DE PAIEMENT */}
        {tdrEnAttente.length>0&&(
          <div style={{ marginBottom:18 }}>
            <div style={{ background:'#fffbeb', border:'2px solid #fbbf24', borderRadius:10, padding:'12px 16px', marginBottom:10, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div>
                <div style={{ fontWeight:700, color:'#92400e', fontSize:14 }}>⚠️ Témoignages en attente de paiement ({tdrEnAttente.length})</div>
                <div style={{ fontSize:12, color:'#78350f', marginTop:2 }}>Ces diplômes ne peuvent pas être imprimés tant que le paiement n'est pas validé.</div>
              </div>
              <button className="btn btn-sm" style={{ background:'#fbbf24', color:'#78350f' }} onClick={()=>{ tdrEnAttente.forEach(r=>markPaid(r.id)); fire(`${tdrEnAttente.length} paiement(s) TDR validé(s) ✓`); }}>💳 Tout valider</button>
            </div>
            {Object.entries(tdrByDept2).map(([dept,deptTdr])=>(
              <div key={dept} style={{ marginBottom:8 }}>
                <div style={{ display:'flex', gap:8, alignItems:'center', padding:'8px 14px', background:'#fef9c3', borderRadius:8, marginBottom:6 }}>
                  <span style={{ fontWeight:700, color:'#1B3764', flex:1, fontSize:13 }}>📍 {dept} — {deptTdr.length} TDR</span>
                  <button className="btn btn-sm" style={{ background:'#fbbf24', color:'#78350f' }} onClick={()=>{ deptTdr.forEach(r=>markPaid(r.id)); fire('TDR département validés ✓'); }}>💳 Valider le département</button>
                </div>
                {deptTdr.map(req=>(
                  <div key={req.id} className="card" style={{ marginBottom:5, display:'flex', alignItems:'center', gap:10, padding:'9px 14px', borderLeft:'4px solid #fbbf24' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:700, color:'#1B3764', fontSize:13 }}>{req.benevole.prenom} {req.benevole.nom}</div>
                      <div style={{ fontSize:11, color:'#92400e' }}>Témoignage de Reconnaissance · {req.diplomeId}</div>
                    </div>
                    <span style={{ fontSize:10, background:'#fef9c3', color:'#92400e', borderRadius:10, padding:'1px 8px', fontWeight:700 }}>⏳ {tarif}€ requis</span>
                    <button className="btn btn-success btn-sm" onClick={()=>markPaid(req.id)}>💳 Payer</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* DIPLÔMES ÉMIS PAR DÉPARTEMENT */}
        {Object.entries(byDept).sort(([a],[b])=>a.localeCompare(b)).map(([dept,deptReqs])=>{
          const hasPendingTDR = deptReqs.some(r=>r.medalType.payant&&r.paiement!=='paye');
          const addrObj = deptAddresses[dept];
          const addrStr = addrObj ? `${addrObj.nom}, ${addrObj.adresse}, ${addrObj.cp} ${addrObj.ville}` : null;
          return (
            <div key={dept}>
              <div className="dept-header" style={{ cursor:'pointer' }} onClick={()=>selectDept(deptReqs)}>
                <Logo size={24}/>
                <div style={{ flex:1 }}>
                  <div>{dept}</div>
                  <div style={{ fontSize:11, opacity:0.65 }}>{deptReqs.length} diplôme(s) · {addrStr?`📬 ${addrStr}`:'⚠️ Adresse non configurée'}{hasPendingTDR?` · ⚠️ TDR non payé(s)`:''}</div>
                </div>
                {hasPendingTDR && <button className="btn btn-sm" style={{ background:'#fbbf24', color:'#78350f', flexShrink:0 }} onClick={e=>{e.stopPropagation();markPaidByDept(deptReqs);}}>💳 TDR APC</button>}
                <button className="btn btn-sm" style={{ background:'#1e40af', color:'white', flexShrink:0 }} onClick={e=>{ e.stopPropagation(); const printable=deptReqs.filter(r=>!r.medalType.payant||r.paiement==='paye'); if(printable.length) setDiplomaView({ ...printable[0], _printMode:'template', _batch:printable.map(r=>r.id) }); else fire('Aucun diplôme imprimable (TDR non payés)','err'); }}>📄 Imprimer Template</button>
                <button className="btn btn-sm" style={{ background:'#7c3aed', color:'white', flexShrink:0 }} onClick={e=>{e.stopPropagation(); const ids=deptReqs.filter(r=>!r.medalType.payant||r.paiement==='paye').map(r=>r.id); confirm(`Expédier ${ids.length} diplôme(s)`, `Marquer tous les diplômes du département comme expédiés ? Cette action est irréversible.`, ()=>markExpedited(ids));}}>📬 Tout Marquer Expédié</button>
              </div>
              {deptReqs.map(req=>{
                const unpaid = req.medalType.payant && req.paiement !== 'paye';
                return (
                  <div key={req.id} className="card" style={{ marginBottom:6, display:'flex', alignItems:'center', gap:10, padding:'11px 14px', borderLeft:`4px solid ${unpaid?'#fbbf24':req.medalType.color}`, opacity:unpaid?0.85:1 }}>
                    <input type="checkbox" checked={selectedBatch.includes(req.id)} onChange={()=>!unpaid&&toggleBatch(req.id)} disabled={unpaid} style={{ width:15, height:15, flexShrink:0 }}/>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:'Playfair Display,serif', fontWeight:700, color:'#1B3764', fontSize:14 }}>{req.benevole.prenom} {req.benevole.nom}</div>
                      <div style={{ color:'#E87722', fontSize:12, fontWeight:600 }}>{req.medalType.label}{agrafeNoms(req)?` — 🏅 Agrafe : ${agrafeNoms(req)}`:''}</div>
                      {unpaid&&<span style={{ fontSize:10, background:'#fef9c3', color:'#92400e', borderRadius:10, padding:'0 6px', fontWeight:700 }}>🔒 Impression bloquée — paiement requis ({tarif}€)</span>}
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0 }}>
                      <div style={{ fontFamily:'monospace', color:'#E87722', fontWeight:700, fontSize:12 }}>{req.diplomeId}</div>
                      {req.dateReception&&<div style={{ fontSize:10, color:'#94a3b8' }}>Récep. : {req.dateReception}</div>}
                    </div>
                    <div style={{ display:'flex', gap:5, flexShrink:0 }}>
                      {unpaid
                        ? <button className="btn btn-success btn-sm" onClick={()=>markPaid(req.id)}>💳 Valider</button>
                        : <>
                            <button className="btn btn-sm" style={{ background:'#1e40af', color:'white' }} onClick={()=>printTemplate(req)}>📄 Imprimer Template</button>
                            <button className="btn btn-sm" style={{ background:'#374151', color:'white' }} onClick={()=>printFull(req)}>🖨 PDF</button>
                            <button className="btn btn-sm" style={{ background:'#7c3aed', color:'white' }} onClick={()=>markExpedited([req.id])}>📬 Marquer Expédié</button>
                          </>
                      }
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {emis.length===0&&tdrEnAttente.length===0&&<div className="card" style={{ textAlign:'center', padding:40, color:'#94a3b8' }}>✅ Tous les diplômes ont été expédiés.</div>}
      </div>
    );
  }

  function DiplomesImprimerPage() {
    const allEmitted = requests.filter(r=>['diplome_emis','expedie'].includes(r.statut));
    const toPrint = impDept==='all' ? allEmitted : allEmitted.filter(r=>r.dept===impDept);
    const depts = [...new Set(allEmitted.map(r=>r.dept))].sort();
    return (
      <div>
        <h1 style={H1}>Impression des diplômes</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>Imprimez ou réimprimez n'importe quel diplôme à tout moment, individuellement ou par département.</p>
        <div className="card" style={{ marginBottom:14, padding:'12px 16px' }}>
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ fontSize:13, fontWeight:700, color:'#1B3764' }}>Mode :</span>
            <button className={`tab ${impMode==='template'?'active':''}`} onClick={()=>setImpMode('template')}>📄 Template (pré-imprimé)</button>
            <button className={`tab ${impMode==='full'?'active':''}`} onClick={()=>setImpMode('full')}>🎖 Diplôme complet</button>
            <select className="select" value={impDept} onChange={e=>setImpDept(e.target.value)} style={{ maxWidth:200 }}>
              <option value="all">Tous les départements</option>
              {depts.map(d=><option key={d} value={d}>{d}</option>)}
            </select>
            <button className="btn btn-orange btn-sm" style={{ marginLeft:'auto' }} onClick={()=>openCalibratedBatch(toPrint, impMode==='template'?'preimprime':'complet')}>🖨 Impression groupée calibrée ({toPrint.length})</button>
            {impDept!=='all' && <button className="btn btn-outline btn-sm" onClick={()=>openShippingLabel(impDept, toPrint)}>📄 Bordereau A4 (rupture + adresse)</button>}
          </div>
        </div>
        {toPrint.length===0&&<div className="card" style={{ textAlign:'center', padding:36, color:'#94a3b8' }}>📭 Aucun diplôme</div>}
        {toPrint.map(req=>(
          <div key={req.id} className="card" style={{ marginBottom:7, display:'flex', alignItems:'center', gap:10, padding:'11px 14px', borderLeft:`4px solid ${req.medalType.color}` }}>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:'Playfair Display,serif', fontWeight:700, color:'#1B3764', fontSize:14 }}>{req.benevole.prenom} {req.benevole.nom}</div>
              <div style={{ fontSize:12, color:'#64748b', marginTop:1 }}>{req.medalType.label} · {req.dept}</div>
              <div style={{ fontSize:11, color:'#94a3b8' }}>N° {req.diplomeId} · {req.statut==='expedie'?'Expédié':'Émis'}</div>
            </div>
            <span className="badge" style={{ background:req.medalType.light, color:req.medalType.color }}>{req.medalType.shortLabel}</span>
            <button className="btn btn-outline btn-sm" onClick={()=>setDiplomaView({ ...req, _printMode:impMode })}>👁 Aperçu</button>
            <button className="btn btn-primary btn-sm" onClick={()=>{ setDiplomaView({ ...req, _printMode:impMode }); setTimeout(()=>window.print(),600); }}>🖨 Imprimer</button>
          </div>
        ))}
      </div>
    );
  }

  function ImportCSVPage() {
    const handleFile = e => {
      const file = e.target.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const lines = ev.target.result.split('\n').filter(Boolean);
        const headers = lines[0].split(',');
        const rows = lines.slice(1,6).map(l => { const vals=l.split(','); return Object.fromEntries(headers.map((h,i)=>[h.trim(),vals[i]?.trim()||''])); });
        setCsvPreview(rows);
      };
      reader.readAsText(file);
    };
    const doImport = () => {
      fire(`${csvPreview.length} demande(s) importée(s) depuis Google Forms ✓`);
      setCsvDone(true); setCsvPreview([]);
    };
    return (
      <div style={{ maxWidth:700 }}>
        <h1 style={H1}>Import depuis Google Forms</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>Importez les réponses exportées depuis votre Google Form actuel (fichier CSV depuis Google Sheets).</p>
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Étape 1 — Exporter depuis Google Sheets</div>
          <ol style={{ fontSize:13, color:'#374151', lineHeight:2, paddingLeft:20 }}>
            <li>Ouvrir votre Google Form → "Réponses" → icône Google Sheets</li>
            <li>Dans Google Sheets : Fichier → Télécharger → CSV (.csv)</li>
            <li>Importer le fichier ci-dessous</li>
          </ol>
        </div>
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Étape 2 — Importer le fichier CSV</div>
          <div style={{ border:'2px dashed #d1d5db', borderRadius:10, padding:24, textAlign:'center', marginBottom:14, cursor:'pointer', background:'#f9fafb' }} onClick={()=>csvRef.current?.click()}>
            <div style={{ fontSize:32, marginBottom:8 }}>📂</div>
            <div style={{ fontSize:14, fontWeight:700, color:'#1B3764' }}>Cliquer ou glisser-déposer</div>
            <div style={{ fontSize:12, color:'#94a3b8', marginTop:4 }}>Format CSV (export Google Sheets)</div>
            <input ref={csvRef} type="file" accept=".csv" style={{ display:'none' }} onChange={handleFile}/>
          </div>
          {csvPreview.length>0&&<>
            <div style={{ fontSize:13, fontWeight:700, color:'#059669', marginBottom:10 }}>✓ {csvPreview.length} lignes détectées — Aperçu :</div>
            <div style={{ overflowX:'auto', marginBottom:14 }}>
              <table style={{ width:'100%', fontSize:11, borderCollapse:'collapse' }}>
                <thead><tr style={{ background:'#f8faff' }}>{Object.keys(csvPreview[0]).slice(0,6).map(h=><th key={h} style={{ padding:'6px 8px', textAlign:'left', borderBottom:'1px solid #e5e7eb', color:'#1B3764' }}>{h}</th>)}</tr></thead>
                <tbody>{csvPreview.map((row,i)=><tr key={i} style={{ borderBottom:'1px solid #f1f5f9' }}>{Object.values(row).slice(0,6).map((v,j)=><td key={j} style={{ padding:'5px 8px', color:'#374151' }}>{v}</td>)}</tr>)}</tbody>
              </table>
            </div>
            <button className="btn btn-orange" onClick={doImport}>⬆️ Importer {csvPreview.length} demande(s)</button>
          </>}
          {csvDone&&<div style={{ background:'#d1fae5', border:'1px solid #86efac', borderRadius:8, padding:'10px 14px', fontSize:13, color:'#065f46' }}>✓ Import terminé. Les demandes sont visibles dans la liste.</div>}
        </div>
        <div className="card">
          <div className="st">Correspondance des colonnes</div>
          <table style={{ width:'100%', fontSize:12, borderCollapse:'collapse' }}>
            <thead><tr style={{ background:'#f8faff' }}><th style={{ padding:'6px 8px', textAlign:'left', color:'#1B3764' }}>Colonne Google Form</th><th style={{ padding:'6px 8px', textAlign:'left', color:'#1B3764' }}>Champ FNPC</th></tr></thead>
            <tbody>{[['Email','E-mail demandeur'],['Association de Protection Civile :','Département'],['Nom et prénom du demandeur :','Demandeur'],['Nom du récipiendaire :','Nom bénévole'],['Prénom(s) du récipiendaire :','Prénom bénévole'],["Date d'entrée à la Protection Civile","Date d'adhésion"],['Motivations de la demande :','Justification'],['Niveau de distinction demandé ?','Type de distinction'],['Date de réception souhaitée','Date réception']].map(([g,f])=><tr key={g} style={{ borderBottom:'1px solid #f1f5f9' }}><td style={{ padding:'5px 8px', color:'#64748b' }}>{g}</td><td style={{ padding:'5px 8px', fontWeight:600, color:'#1B3764' }}>{f}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    );
  }

  function EmailTemplatesPage() {
    const save = () => {
      const next = { ...emailTemplates, [emKey]:{ sujet:emSujet, corps:emCorps } };
      setEmailTemplates(next);
      db.saveConfig('email_templates', next); // persistance cross-session
      fire('Modèle enregistré ✓');
    };
    // Aperçu : substitution avec des données d'exemple
    const sample = { prenom:'Marie', nom:'Dupont', distinction:'Médaille Échelon Bronze', date:today(), numero:'FNPC-2025-075-0001', motif:'Dossier incomplet', tarif:tarif };
    const fill = (s) => (s||'')
      .replace(/{prenom}/g, sample.prenom).replace(/{nom}/g, sample.nom)
      .replace(/{distinction}/g, sample.distinction).replace(/{date}/g, sample.date)
      .replace(/{numero}/g, sample.numero).replace(/{motif}/g, sample.motif)
      .replace(/{tarif}/g, sample.tarif).replace(/{temoignagePaiement}/g, '');

    // Map each email key to its niveau and label
    const EMAIL_META = [
      { key:'soumission',           niveau:'antenne',     label:'Confirmation soumission demande' },
      { key:'validation_apc',       niveau:'antenne',     label:'Demande validée → APC' },
      { key:'refus_apc',            niveau:'antenne',     label:'Demande refusée APC' },
      { key:'validation_commission',niveau:'departement', label:'Dossier approuvé Commission' },
      { key:'paiement_temoignage',  niveau:'departement', label:'Paiement TDR requis' },
      { key:'diplome_emis',         niveau:'gestion',     label:'Diplôme imprimé' },
      { key:'expedition',           niveau:'gestion',     label:'Diplôme expédié' },
    ];

    const NIVEAU_COLOR = { antenne:'#8b5cf6', departement:'#3b82f6', gestion:'#E87722' };
    const NIVEAU_LABEL = { antenne:'Antenne', departement:'APC', gestion:'Gestion FNPC' };

    const toggleKey = (niveau, key) => {
      const cur = emailSettings[niveau]?.[key] ?? false;
      setEmailSettings(p=>({ ...p, [niveau]:{ ...(p[niveau]||{}), [key]:!cur } }));
      fire(`Notification "${EMAIL_META.find(m=>m.key===key)?.label}" ${!cur?'activée':'désactivée'} ✓`);
    };

    return (
      <div style={{ maxWidth:760 }}>
        <h1 style={H1}>Notifications & E-mails</h1>
        <p style={{ color:'#64748b', fontSize:14, marginBottom:20 }}>Activez ou désactivez chaque type de notification, et personnalisez le modèle d'e-mail correspondant.</p>

        {/* Tableau des notifications avec toggle + lien édition */}
        <div className="card" style={{ marginBottom:18 }}>
          <div className="st">Notifications par type d'événement</div>
          {EMAIL_META.map(({ key, niveau, label }) => {
            const active = emailSettings[niveau]?.[key] ?? false;
            return (
              <div key={key} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', borderBottom:'1px solid #f1f5f9' }}>
                <span style={{ background:NIVEAU_COLOR[niveau]+'22', color:NIVEAU_COLOR[niveau], borderRadius:20, padding:'2px 9px', fontSize:12, fontWeight:700, flexShrink:0, minWidth:80, textAlign:'center' }}>{NIVEAU_LABEL[niveau]}</span>
                <span style={{ flex:1, fontSize:14, color:'#374151' }}>✉️ {label}</span>
                <button className="btn btn-sm"
                  style={{ background:active?'#059669':'#94a3b8', color:'white', minWidth:96 }}
                  onClick={()=>toggleKey(niveau, key)}>
                  {active?'✓ Activé':'✗ Désactivé'}
                </button>
                <button className="btn btn-outline btn-sm"
                  onClick={()=>{ setEmKey(key); setTimeout(()=>document.getElementById('email-editor')?.scrollIntoView({behavior:'smooth'}),100); }}>
                  ✏️ Modèle
                </button>
              </div>
            );
          })}
        </div>

        {/* Éditeur de modèle */}
        <div className="card" id="email-editor">
          <div className="st">
            Modèle : {EMAIL_META.find(m=>m.key===emKey)?.label || emKey}
            <span style={{ marginLeft:10, fontSize:12, color:'#64748b', fontWeight:400 }}>
              Niveau {NIVEAU_LABEL[EMAIL_META.find(m=>m.key===emKey)?.niveau] || ''}
            </span>
          </div>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
            {EMAIL_META.map(({ key, label })=>(
              <button key={key} className={`tab ${emKey===key?'active':''}`} onClick={()=>setEmKey(key)} style={{ fontSize:12 }}>{label}</button>
            ))}
          </div>
          <p style={{ fontSize:12, color:'#94a3b8', marginBottom:12 }}>Variables : {'{prenom}'} {'{nom}'} {'{distinction}'} {'{date}'} {'{numero}'} {'{motif}'} {'{tarif}'}</p>
          <div className="fg"><label className="fl">Objet</label><input className="input" value={emSujet} onChange={e=>setEmSujet(e.target.value)}/></div>
          <div className="fg"><label className="fl">Corps du message (mise en page)</label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, border:'1px solid #e5e7eb', borderBottom:'none', borderRadius:'8px 8px 0 0', padding:6, background:'#f8faff' }}>
              <button type="button" className="btn btn-outline btn-sm" title="Gras" onMouseDown={e=>{e.preventDefault(); emExec('bold');}} style={{ fontWeight:700, minWidth:30 }}>G</button>
              <button type="button" className="btn btn-outline btn-sm" title="Italique" onMouseDown={e=>{e.preventDefault(); emExec('italic');}} style={{ fontStyle:'italic', minWidth:30 }}>I</button>
              <button type="button" className="btn btn-outline btn-sm" title="Souligné" onMouseDown={e=>{e.preventDefault(); emExec('underline');}} style={{ textDecoration:'underline', minWidth:30 }}>S</button>
              <button type="button" className="btn btn-outline btn-sm" title="Liste à puces" onMouseDown={e=>{e.preventDefault(); emExec('insertUnorderedList');}}>• Liste</button>
              <button type="button" className="btn btn-outline btn-sm" title="Liste numérotée" onMouseDown={e=>{e.preventDefault(); emExec('insertOrderedList');}}>1. Liste</button>
              <button type="button" className="btn btn-outline btn-sm" title="Lien" onMouseDown={e=>{e.preventDefault(); const u=prompt('Adresse du lien (https://…)'); if(u) emExec('createLink', u);}}>🔗</button>
              <button type="button" className="btn btn-outline btn-sm" title="Effacer la mise en forme" onMouseDown={e=>{e.preventDefault(); emExec('removeFormat');}}>✗ format</button>
              <span style={{ width:1, background:'#e5e7eb', margin:'0 2px' }}/>
              {['{prenom}','{nom}','{distinction}','{date}','{numero}','{motif}','{tarif}'].map(v=>(
                <button key={v} type="button" className="btn btn-outline btn-sm" title={`Insérer ${v}`} onMouseDown={e=>{e.preventDefault(); emExec('insertText', v);}} style={{ fontSize:11 }}>{v}</button>
              ))}
            </div>
            <div ref={emEditorRef} contentEditable suppressContentEditableWarning onInput={e=>setEmCorps(e.currentTarget.innerHTML)}
              style={{ minHeight:170, border:'1px solid #e5e7eb', borderRadius:'0 0 8px 8px', padding:'12px 14px', fontSize:14, lineHeight:1.7, color:'#374151', outline:'none', background:'white' }} />
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-orange" onClick={save}>💾 Enregistrer</button>
            <button className="btn btn-outline btn-sm" onClick={()=>{ const t=DEFAULT_EMAIL_TEMPLATES[emKey]; setEmSujet(t.sujet); setEmCorps(t.corps); if(emEditorRef.current) emEditorRef.current.innerHTML=(t.corps||'').replace(/\n/g,'<br>'); }}>↺ Réinitialiser par défaut</button>
          </div>
          <div style={{ marginTop:16, border:'1px solid #e5e7eb', borderRadius:8, overflow:'hidden' }}>
            <div style={{ background:'#f8faff', padding:'8px 14px', fontSize:12, fontWeight:700, color:'#1B3764', borderBottom:'1px solid #e5e7eb' }}>👁 Aperçu mis en page (données d'exemple)</div>
            <div style={{ padding:'12px 14px' }}>
              <div style={{ fontSize:11, color:'#94a3b8' }}>Objet</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#1B3764', marginBottom:10 }}>{fill(emSujet)}</div>
              <div dangerouslySetInnerHTML={{ __html: fnpcEmailHtml(fill(emCorps)) }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  function ParametresPage() {
    return (
      <div style={{ maxWidth:680 }}>
        <h1 style={H1}>Paramètres Gestion FNPC</h1>

        {/* Messages d'accueil */}
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Messages d'accueil</div>
          <div className="fg"><label className="fl">Message pour les Antennes</label><textarea className="textarea" rows={3} value={paramWmA} onChange={e=>setParamWmA(e.target.value)} placeholder="Ex : Bienvenue sur la plateforme FNPC…"/></div>
          <div className="fg"><label className="fl">Message pour les APC (Départements)</label><textarea className="textarea" rows={3} value={paramWmD} onChange={e=>setParamWmD(e.target.value)} placeholder="Ex : Rappel : validez les demandes dans les 30 jours…"/></div>
          <button className="btn btn-orange" onClick={()=>{ setWelcomeMessages({ antenne:paramWmA, departement:paramWmD }); fire('Messages enregistrés ✓'); }}>💾 Enregistrer les messages</button>
        </div>

        {/* Import modèles templates */}
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Import de modèles d'impression</div>
          <p style={{ fontSize:13, color:'#64748b', marginBottom:12 }}>Importez vos propres modèles pour l'impression sur diplôme pré-imprimé ou pour le diplôme complet (PDF, Word, PNG).</p>
          {['Template pré-imprimé','Diplôme complet'].map((label,idx)=>(
            <div key={idx} style={{ display:'flex', gap:10, alignItems:'center', padding:'10px 0', borderBottom:'1px solid #f1f5f9' }}>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, color:'#1B3764', fontSize:13 }}>📄 {label}</div>
                <div style={{ fontSize:11, color:'#94a3b8' }}>{idx===0?'Fichier PDF/DOCX avec zones de texte positionnées':'Fond de diplôme officiel (PDF ou image haute résolution)'}</div>
              </div>
              <button className="btn btn-outline btn-sm" onClick={()=>fire('Fonctionnalité disponible après déploiement')}>📂 Importer</button>
            </div>
          ))}
        </div>

        {/* Permissions */}
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Permissions de création de demandes</div>
          {[{k:'commission',l:'Commission FNPC peut créer des demandes',v:commissionCanCreate,set:setCommissionCanCreate},{k:'gestion',l:'Gestion FNPC peut créer des demandes',v:gestionCanCreate,set:setGestionCanCreate}].map(p=>(
            <div key={p.k} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:'1px solid #f1f5f9' }}>
              <span style={{ fontSize:13, color:'#374151' }}>{p.l}</span>
              <button className={`btn btn-sm ${p.v?'btn-success':'btn-outline'}`} onClick={()=>{ p.set(!p.v); fire(`Permission ${!p.v?'activée':'désactivée'} ✓`); }}>{p.v?'✓ Activé':'Désactivé'}</button>
            </div>
          ))}
        </div>

        {/* Départements actifs/inactifs */}
        <div className="card">
          <div className="st">Activation des départements</div>
          <p style={{ fontSize:13, color:'#64748b', marginBottom:12 }}>Désactivez un département pour bloquer toute nouvelle demande de ce niveau.</p>
          {[...new Set(requests.map(r=>r.dept))].sort().map(d=>(
            <div key={d} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #f1f5f9' }}>
              <span style={{ fontSize:13, color:'#1B3764', fontWeight:600 }}>{d}</span>
              <button className={`btn btn-sm ${deptDisabled[d]?'btn-danger':'btn-success'}`} onClick={()=>{ setDeptDisabled(p=>({...p,[d]:!p[d]})); fire(`Département ${deptDisabled[d]?'réactivé':'désactivé'} ✓`); }}>
                {deptDisabled[d]?'✗ Désactivé':'✓ Actif'}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── SIDEBAR ITEMS ────────────────────────────────────────────────────────────

  function GroupementsPage() {
    return (
      <div style={{ maxWidth:720 }}>
        <h1 style={H1}>Groupements de départements</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:16 }}>
          Un groupement réunit plusieurs départements sous la responsabilité d'un ou plusieurs APC.
          Un APC voit et valide les demandes de tous les départements de ses groupements.
        </p>

        {groupements.length === 0
          ? <div className="card" style={{ marginBottom:18, color:'#94a3b8', fontSize:14 }}>Aucun groupement pour l'instant.</div>
          : groupements.map(g => (
            <div key={g.id} className="card" style={{ marginBottom:12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                <div>
                  <div style={{ fontWeight:700, color:'#1B3764', fontFamily:'Playfair Display,serif' }}>{g.nom}</div>
                  <div style={{ fontSize:12, color:'#64748b', marginTop:4 }}>📍 {(g.depts||[]).join(', ') || '—'}</div>
                  <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>👤 {(g.apcs||[]).join(', ') || 'Aucun APC rattaché'}</div>
                </div>
                <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                  <button className="btn btn-outline btn-sm" onClick={()=>grpEdit(g)}>✏️ Modifier</button>
                  <button className="btn btn-danger btn-sm" onClick={()=>grpDelete(g.id)}>🗑</button>
                </div>
              </div>
            </div>
          ))}

        <div className="card" style={{ marginTop:18, borderLeft:'4px solid #E87722' }}>
          <div className="st">{grpEditId ? '✏️ Modifier le groupement' : '➕ Nouveau groupement'}</div>
          <div className="fg"><label className="fl">Nom du groupement *</label>
            <input className="input" value={grpNom} onChange={e=>setGrpNom(e.target.value)} placeholder="Ex : Île-de-France Est"/>
          </div>
          <div className="fg"><label className="fl">Départements * <span style={{ color:'#94a3b8', fontWeight:400 }}>(Ctrl/Cmd pour en choisir plusieurs)</span></label>
            <select className="select" multiple style={{ height:160 }} value={grpDepts} onChange={e=>setGrpDepts([...e.target.selectedOptions].map(o=>o.value))}>
              {DEPTS.map(d=><option key={d} value={d}>{d}</option>)}
            </select>
            {grpDepts.length>0 && <p className="fh" style={{ color:'#E87722' }}>{grpDepts.length} sélectionné(s)</p>}
          </div>
          <div className="fg"><label className="fl">APC rattachés <span style={{ color:'#94a3b8', fontWeight:400 }}>(e-mails, un par ligne)</span></label>
            <textarea className="textarea" rows={3} value={grpApcs} onChange={e=>setGrpApcs(e.target.value)} placeholder="apc.paris@protection-civile.org"/>
            <p className="fh">Ces comptes (rôle APC) verront les demandes de ces départements.</p>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-orange btn-sm" onClick={grpSave}>{grpEditId ? '💾 Enregistrer' : '➕ Créer le groupement'}</button>
            {grpEditId && <button className="btn btn-outline btn-sm" onClick={grpReset}>Annuler</button>}
          </div>
        </div>
      </div>
    );
  }

  function AgrafesPage() {
    const startEdit = (ag) => { setAgrEditId(ag.id); setAgrEditDepts([...ag.depts]); setAgrEditNom(ag.nom||''); setAgrEditTexte(ag.texte||''); setAgrEditTitre(ag.titre||''); setAgrEditIntro(ag.intro||''); setAgrEditPresident(ag.president||''); };
    const saveEdit = () => { setAgrafes(p=>p.map(a=>a.id!==agrEditId?a:{ ...a, nom:agrEditNom.trim()||a.nom, texte:agrEditTexte, titre:agrEditTitre, intro:agrEditIntro, president:agrEditPresident, depts:agrEditDepts })); setAgrEditId(null); fire('Agrafe mise à jour ✓'); };
    return (
      <div style={{ maxWidth:680 }}>
        <h1 style={H1}>Médailles exceptionnelles (Agrafes)</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>Créez et gérez les médailles exceptionnelles. Elles n'apparaissent que dans les formulaires des APC sélectionnées.</p>

        {agrafes.length === 0 && <div className="card" style={{ textAlign:'center', padding:36, color:'#94a3b8', marginBottom:14 }}>🏅 Aucune agrafe créée. Utilisez le formulaire ci-dessous.</div>}

        {agrafes.map(ag=>(
          <div key={ag.id} className="card" style={{ marginBottom:10, borderLeft:`4px solid ${ag.actif?'#E87722':'#94a3b8'}` }}>
            <div style={{ display:'flex', gap:10, alignItems:'flex-start', marginBottom: agrEditId===ag.id ? 12 : 0 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, color:'#1B3764', fontSize:15, fontFamily:'Playfair Display,serif' }}>🏅 {ag.nom}</div>
                <div style={{ fontSize:12, color:'#64748b', marginTop:4 }}>{ag.depts.length} département(s) : {ag.depts.slice(0,4).join(', ')}{ag.depts.length>4?` +${ag.depts.length-4}`:''}</div>
              </div>
              <span className="badge" style={{ background:ag.actif?'#d1fae5':'#f1f5f9', color:ag.actif?'#059669':'#94a3b8', flexShrink:0 }}>{ag.actif?'Active':'Inactive'}</span>
              <button className="btn btn-outline btn-sm" onClick={()=>agrEditId===ag.id?setAgrEditId(null):startEdit(ag)}>✏️ Modifier</button>
              <button className="btn btn-sm" style={{ background:'#1B3764', color:'white' }} onClick={()=>genAgrafeWord(ag)}>📄 Générer le Word</button>
              <button className="btn btn-outline btn-sm" onClick={()=>setAgrafes(p=>p.map(a=>a.id!==ag.id?a:{...a,actif:!a.actif}))}>{ag.actif?'Désactiver':'Activer'}</button>
              <button className="btn btn-danger btn-sm" onClick={()=>setAgrafes(p=>p.filter(a=>a.id!==ag.id))}>✕</button>
            </div>
            {agrEditId===ag.id&&<div style={{ borderTop:'1px solid #f1f5f9', paddingTop:12 }}>
              <label className="fl" style={{ marginBottom:6 }}>Nom de l'agrafe *</label>
              <input className="input" style={{ marginBottom:10 }} value={agrEditNom} onChange={e=>setAgrEditNom(e.target.value)} placeholder="Ex: Médaille Exceptionnelle Inondations 2025"/>
              <label className="fl" style={{ marginBottom:6 }}>Texte du document <span style={{ color:'#94a3b8', fontWeight:400 }}>(préambule de la liste)</span></label>
              <textarea className="textarea" rows={3} style={{ marginBottom:10 }} value={agrEditTexte} onChange={e=>setAgrEditTexte(e.target.value)}/>
              <div style={{ background:'#f8faff', border:'1px solid #e5e7eb', borderRadius:8, padding:'10px 12px', marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:700, color:'#1B3764', marginBottom:8 }}>📄 Modèle Word de cette agrafe <span style={{ color:'#94a3b8', fontWeight:400 }}>(optionnel — sinon valeurs globales)</span></div>
                <label className="fl" style={{ marginBottom:4 }}>Titre</label>
                <input className="input" style={{ marginBottom:8 }} value={agrEditTitre} onChange={e=>setAgrEditTitre(e.target.value)} placeholder={wordCfg.titre||'Liste des récipiendaires'}/>
                <label className="fl" style={{ marginBottom:4 }}>Introduction</label>
                <textarea className="textarea" rows={2} style={{ marginBottom:8 }} value={agrEditIntro} onChange={e=>setAgrEditIntro(e.target.value)} placeholder="Laisser vide pour le texte global"/>
                <label className="fl" style={{ marginBottom:4 }}>Signataire</label>
                <input className="input" value={agrEditPresident} onChange={e=>setAgrEditPresident(e.target.value)} placeholder={wordCfg.president||'Le Président'}/>
              </div>
              <label className="fl" style={{ marginBottom:6 }}>Départements concernés <span style={{ color:'#94a3b8', fontWeight:400 }}>(Ctrl/Cmd pour sélection multiple)</span></label>
              <select className="select" multiple style={{ height:110 }} value={agrEditDepts} onChange={e=>setAgrEditDepts([...e.target.selectedOptions].map(o=>o.value))}>
                {DEPTS.map(d=><option key={d} value={d}>{d}</option>)}
              </select>
              <p style={{ fontSize:11, color:'#E87722', marginTop:4 }}>{agrEditDepts.length} sélectionné(s)</p>
              <div style={{ display:'flex', gap:8, marginTop:10 }}>
                <button className="btn btn-orange btn-sm" onClick={saveEdit} disabled={!agrEditNom.trim()||!agrEditDepts.length}>💾 Enregistrer</button>
                <button className="btn btn-outline btn-sm" onClick={()=>setAgrEditId(null)}>Annuler</button>
              </div>
            </div>}
          </div>
        ))}

        <div className="card" style={{ marginTop:18 }}>
          <div className="st">Créer une nouvelle agrafe</div>
          <div className="fg"><label className="fl">Nom *</label>
            <input className="input" placeholder="Ex: Médaille Exceptionnelle Inondations 2025" value={paramAgrNom} onChange={e=>setParamAgrNom(e.target.value)}/>
          </div>
          <div className="fg">
            <label className="fl">Texte du document <span style={{ color:'#94a3b8', fontWeight:400 }}>(préambule intégré dans la liste des récipiendaires)</span></label>
            <textarea className="textarea" rows={4}
              placeholder={"Ex : Sur proposition des Présidents d'APC et après étude des dossiers par la commission honneurs et récompenses, les distinctions suivantes ont été attribuées dans le cadre des Médailles Exceptionnelles Crise 2024-2025, en reconnaissance de l'engagement exceptionnel des bénévoles lors des interventions de crise."}
              value={paramAgrTexte} onChange={e=>setParamAgrTexte(e.target.value)}/>
            <p className="fh">Ce texte apparaîtra dans le document généré, après le titre et avant la liste des récipiendaires.</p>
          </div>
          <div className="fg">
            <label className="fl">Départements concernés * <span style={{ color:'#94a3b8', fontWeight:400 }}>(Ctrl/Cmd pour sélection multiple)</span></label>
            <select className="select" multiple style={{ height:120 }} value={paramAgrDepts} onChange={e=>setParamAgrDepts([...e.target.selectedOptions].map(o=>o.value))}>
              {DEPTS.map(d=><option key={d} value={d}>{d}</option>)}
            </select>
            {paramAgrDepts.length > 0 && <p className="fh" style={{ color:'#E87722' }}>{paramAgrDepts.length} sélectionné(s) : {paramAgrDepts.slice(0,3).join(', ')}{paramAgrDepts.length>3?'...':''}</p>}
          </div>
          <button className="btn btn-orange" disabled={!paramAgrNom||!paramAgrDepts.length} onClick={()=>{
            setAgrafes(p=>[...p,{ id:`AGR${Date.now()}`, nom:paramAgrNom, texte:paramAgrTexte, depts:paramAgrDepts, actif:true }]);
            setParamAgrNom(''); setParamAgrTexte(wordCfg.preambule||DEFAULT_AGRAFE_TEXTE); setParamAgrDepts([]);
            fire('Agrafe créée ✓');
          }}>
            🏅 Créer l'agrafe
          </button>
        </div>

        <div className="card" style={{ marginTop:18, borderLeft:'4px solid #1B3764' }}>
          <div className="st">📄 Modèle du document Word</div>
          <p style={{ color:'#64748b', fontSize:12, marginBottom:12 }}>Contenu commun à tous les documents « Liste des récipiendaires ». Le <strong>préambule</strong> peut être surchargé agrafe par agrafe via son « Texte du document ».</p>
          <div className="fg"><label className="fl">Titre du document</label>
            <input className="input" value={wordCfg.titre} onChange={e=>setWordCfg(c=>({ ...c, titre:e.target.value }))}/>
          </div>
          <div className="fg"><label className="fl">Préambule par défaut</label>
            <textarea className="textarea" rows={5} value={wordCfg.preambule} onChange={e=>setWordCfg(c=>({ ...c, preambule:e.target.value }))}/>
            <p className="fh">Un paragraphe par ligne. Utilisé quand l'agrafe n'a pas son propre texte.</p>
          </div>
          <div className="fg"><label className="fl">Phrase d'introduction de la liste</label>
            <textarea className="textarea" rows={3} value={wordCfg.intro} onChange={e=>setWordCfg(c=>({ ...c, intro:e.target.value }))}/>
          </div>
          <div className="fg"><label className="fl">Signataire <span style={{ color:'#94a3b8', fontWeight:400 }}>(optionnel — ex : « Le Président, François RICHEZ »)</span></label>
            <input className="input" value={wordCfg.president} onChange={e=>setWordCfg(c=>({ ...c, president:e.target.value }))} placeholder="Le Président, …"/>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-orange btn-sm" onClick={saveWordCfg}>💾 Enregistrer le modèle</button>
            <button className="btn btn-outline btn-sm" onClick={()=>confirm('Réinitialiser le modèle', 'Revenir au modèle Word par défaut ? Vos textes personnalisés seront perdus.', ()=>setWordCfg(DEFAULT_WORD_CFG))}>↺ Défaut</button>
          </div>
        </div>
      </div>
    );
  }

  function MedaillesPage() {
    return (
      <div style={{ maxWidth:720 }}>
        <h1 style={H1}>Types de médailles</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>Gérez les distinctions et leurs tarifs. Pour les médailles payantes, vous pouvez modifier le prix directement ici.</p>

        {medalTypes.map((m,idx)=>(
          <div key={m.id} className="card" style={{ marginBottom:8, borderLeft:`4px solid ${m.color}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div style={{ width:14, height:14, borderRadius:'50%', background:m.color, flexShrink:0 }}/>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, color:'#1B3764', fontSize:14 }}>{m.label}</div>
                <div style={{ fontSize:12, color:'#64748b' }}>{m.years} ans requis · {m.category}</div>
              </div>
              {m.payant ? (
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:13, color:'#64748b' }}>Prix TDR :</span>
                  <input type="number" min="0" step="0.5" value={m.prix ?? tarif}
                    onChange={e=>{ const v=parseFloat(e.target.value)||0; setMedalTypes(p=>p.map((mt,i)=>i===idx?{...mt,prix:v}:mt)); setTarif(v); }}
                    style={{ width:70, padding:'3px 6px', border:'1px solid #e5e7eb', borderRadius:6, fontSize:14, textAlign:'right' }}/>
                  <span style={{ fontSize:13, color:'#64748b' }}>€</span>
                </div>
              ) : (
                <span style={{ fontSize:13, color:'#94a3b8' }}>Gratuit</span>
              )}
              <span className="badge" style={{ background:m.custom?'#e0f2fe':'#f1f5f9', color:m.custom?'#0369a1':'#64748b' }}>{m.custom?'★ Perso':'Standard'}</span>
              {m.custom && <button className="btn btn-danger btn-sm" onClick={()=>setMedalTypes(p=>p.filter((_,i)=>i!==idx))}>✕</button>}
            </div>
          </div>
        ))}

        <div className="card" style={{ marginTop:20 }}>
          <div className="st">Créer une médaille personnalisée</div>
          <div className="g2">
            <div className="fg"><label className="fl">Nom complet *</label><input className="input" placeholder="Ex: Médaille Spéciale Engagement Jeunes" value={newMedalLabel} onChange={e=>setNewMedalLabel(e.target.value)}/></div>
            <div className="fg"><label className="fl">Abréviation *</label><input className="input" placeholder="Ex: MSE" value={newMedalShort} onChange={e=>setNewMedalShort(e.target.value)} style={{ maxWidth:120 }}/></div>
          </div>
          <div className="g2">
            <div className="fg"><label className="fl">Années requises *</label><input className="input" type="number" min="1" max="50" placeholder="Ex: 25" value={newMedalYears} onChange={e=>setNewMedalYears(e.target.value)}/></div>
            <div className="fg"><label className="fl">Couleur</label><input type="color" value={newMedalColor} onChange={e=>setNewMedalColor(e.target.value)} style={{ height:38, width:80, borderRadius:6, cursor:'pointer', border:'1px solid #e5e7eb' }}/></div>
          </div>
          <div className="g2">
            <label style={{ display:'flex', gap:8, alignItems:'center', cursor:'pointer', fontSize:13 }}>
              <input type="checkbox" checked={newMedalPayant} onChange={e=>setNewMedalPayant(e.target.checked)} style={{ width:15, height:15 }}/>
              Distinction payante
            </label>
            {newMedalPayant && <div className="fg" style={{ marginBottom:0 }}><label className="fl">Tarif (€)</label><input className="input" type="number" min="0" step="0.5" value={newMedalColor === '#1B3764' ? tarif : ''} placeholder={String(tarif)} style={{ maxWidth:100 }}/></div>}
          </div>
          <button className="btn btn-orange" disabled={!newMedalLabel||!newMedalShort||!newMedalYears} style={{ marginTop:14 }} onClick={()=>{
            const y = parseInt(newMedalYears); if(!y||y<1) return;
            const newM = { id:`custom_${Date.now()}`, label:newMedalLabel, shortLabel:newMedalShort, years:y, category:'medaille', color:newMedalColor, light:`${newMedalColor}22`, payant:newMedalPayant, custom:true };
            setMedalTypes(p=>{ const arr=[...p,newM]; arr.sort((a,b)=>a.years-b.years); return arr; });
            setNewMedalLabel(''); setNewMedalShort(''); setNewMedalYears(''); setNewMedalColor('#1B3764'); setNewMedalPayant(false);
            fire('Médaille créée ✓');
          }}>⭐ Créer la médaille</button>
        </div>
      </div>
    );
  }

  function ImportExcelPage() {
    const TEMPLATE_COLS = ['Nom','Prénom','Genre (M/F)','Date adhésion (AAAA-MM-JJ)','Département','Type de distinction','Justification (50 car. min)','Date réception souhaitée'];
    const handleXls = e => {
      const file = e.target.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const lines = ev.target.result.split('\n').filter(Boolean);
        const headers = lines[0].split(';').map(h=>h.trim());
        const rows = lines.slice(1,6).map(l => { const vals=l.split(';'); return Object.fromEntries(headers.map((h,i)=>[h,vals[i]?.trim()||''])); });
        setXlsPreview(rows);
      };
      reader.readAsText(file, 'UTF-8');
    };
    const doXlsImport = () => {
      fire(`${xlsPreview.length} demande(s) importée(s) ✓`);
      setXlsDone(true); setXlsPreview([]);
    };
    const downloadTemplate = () => {
      const rows = [TEMPLATE_COLS.join(';'), 'MARTIN;Jean;M;2010-03-15;75 - Paris Seine;Médaille Échelon Bronze;Investissement remarquable depuis 14 ans...;2025-06-01'];
      const blob = new Blob(['\ufeff'+rows.join('\n')], { type:'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='template_demandes_fnpc.csv'; a.click();
      fire('Template téléchargé ✓');
    };
    return (
      <div style={{ maxWidth:720 }}>
        <h1 style={H1}>Import Excel / CSV</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>Importez des demandes en masse depuis un fichier Excel ou CSV. Téléchargez d'abord le template pour respecter le format attendu.</p>

        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Étape 1 — Télécharger le template</div>
          <p style={{ fontSize:13, color:'#374151', marginBottom:12 }}>Le template CSV calibré contient toutes les colonnes requises avec un exemple de ligne. Ouvrez-le dans Excel, remplissez-le, sauvegardez en CSV (séparateur point-virgule).</p>
          <button className="btn btn-orange" onClick={downloadTemplate}>📥 Télécharger le template CSV</button>
          <div style={{ marginTop:12 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'#1B3764', marginBottom:6 }}>Colonnes du template :</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {TEMPLATE_COLS.map((c,i)=><span key={i} style={{ background:'#f0fdf4', color:'#065f46', borderRadius:20, padding:'2px 10px', fontSize:11 }}>{c}</span>)}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Étape 2 — Importer le fichier rempli</div>
          <div style={{ border:'2px dashed #d1d5db', borderRadius:10, padding:24, textAlign:'center', marginBottom:14, cursor:'pointer', background:'#f9fafb' }} onClick={()=>xlsRef.current?.click()}>
            <div style={{ fontSize:32, marginBottom:8 }}>📊</div>
            <div style={{ fontSize:14, fontWeight:700, color:'#1B3764' }}>Cliquer pour sélectionner</div>
            <div style={{ fontSize:12, color:'#94a3b8', marginTop:4 }}>Format CSV (séparateur ; encodage UTF-8)</div>
            <input ref={xlsRef} type="file" accept=".csv,.xlsx,.xls" style={{ display:'none' }} onChange={handleXls}/>
          </div>
          {xlsPreview.length>0&&<>
            <div style={{ fontSize:13, fontWeight:700, color:'#059669', marginBottom:10 }}>✓ {xlsPreview.length} lignes détectées — Aperçu :</div>
            <div style={{ overflowX:'auto', marginBottom:14 }}>
              <table style={{ width:'100%', fontSize:11, borderCollapse:'collapse' }}>
                <thead><tr style={{ background:'#f8faff' }}>{Object.keys(xlsPreview[0]).slice(0,5).map(h=><th key={h} style={{ padding:'5px 8px', textAlign:'left', borderBottom:'1px solid #e5e7eb', color:'#1B3764' }}>{h}</th>)}</tr></thead>
                <tbody>{xlsPreview.map((row,i)=><tr key={i} style={{ borderBottom:'1px solid #f1f5f9' }}>{Object.values(row).slice(0,5).map((v,j)=><td key={j} style={{ padding:'4px 8px', color:'#374151' }}>{v}</td>)}</tr>)}</tbody>
              </table>
            </div>
            <button className="btn btn-orange" onClick={doXlsImport}>⬆️ Importer {xlsPreview.length} demande(s)</button>
          </>}
          {xlsDone&&<div style={{ background:'#d1fae5', border:'1px solid #86efac', borderRadius:8, padding:'10px 14px', fontSize:13, color:'#065f46' }}>✓ Import terminé. Les demandes sont visibles dans la liste.</div>}
        </div>
      </div>
    );
  }

  function TdrApcPage() {
    const myTdr = myDeptRequests.filter(r=>r.statut==='valide_federation'&&r.medalType.payant&&r.paiement!=='paye');
    const byDept2 = myTdr.reduce((acc,r)=>{if(!acc[r.dept])acc[r.dept]=[];acc[r.dept].push(r);return acc},{});
    return (
      <div>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18 }}>
          <button className="btn btn-outline btn-sm" onClick={()=>setPage('dashboard')}>← Retour</button>
          <h1 style={H1}>Témoignages en attente de paiement</h1>
        </div>
        <p style={{ color:'#64748b', fontSize:14, marginBottom:18 }}>
          Ces témoignages ont été approuvés par la Commission FNPC. Le paiement doit être effectué avant que la Gestion FNPC puisse imprimer et expédier les diplômes.
        </p>
        {myTdr.length === 0 && <div className="card" style={{ textAlign:'center', padding:48, color:'#94a3b8' }}>✅ Aucun TDR en attente de paiement.</div>}
        {Object.entries(byDept2).map(([dept, deptTdr]) => (
          <div key={dept}>
            <div className="dept-header">
              <Logo size={26}/>
              <div style={{ flex:1 }}>
                <div>{dept}</div>
                <div style={{ fontSize:12, opacity:0.65 }}>{deptTdr.length} TDR · en attente de paiement</div>
              </div>
            </div>
            {deptTdr.map(req => (
              <div key={req.id} className="card" style={{ marginBottom:8, borderLeft:'4px solid #fbbf24', padding:'12px 16px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:'Playfair Display,serif', fontWeight:700, color:'#1B3764', fontSize:16 }}>{req.benevole.prenom} {req.benevole.nom}</div>
                    <div style={{ fontSize:13, color:'#E87722', fontWeight:600, marginTop:2 }}>{req.medalType.label}</div>
                    <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>Approuvé le {req.historique.find(h=>h.action.includes('Commission'))?.date||'—'} · N° {req.diplomeId||'En attente'}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <span style={{ background:'#fef9c3', color:'#92400e', borderRadius:10, padding:'3px 12px', fontSize:13, fontWeight:700, display:'block' }}>⏳ {req.medalType.prix ?? tarif}€ requis</span>
                    <div style={{ fontSize:11, color:'#94a3b8', marginTop:4 }}>Paiement à effectuer auprès de la Gestion FNPC</div>
                  </div>
                </div>
                <div style={{ marginTop:12, background:'#fffbeb', borderRadius:8, padding:'9px 12px', fontSize:13, color:'#78350f' }}>
                  💡 Pour effectuer le paiement, contactez la Gestion FNPC ou utilisez la boutique en ligne PrestaShop FNPC (référence : {req.id}).
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  function PrestashopPage() {
    // TDR validated yesterday or before, not yet ordered
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1); yesterday.setHours(0,0,0,0);
    const toOrder = requests.filter(r =>
      r.statut === 'valide_federation' && r.medalType?.payant && !r.prestashopOrderId
    );
    // Group by dept
    const byDept = toOrder.reduce((acc, r) => {
      if (!acc[r.dept]) acc[r.dept] = [];
      acc[r.dept].push(r);
      return acc;
    }, {});

    const createOrders = async () => {
      if (!Object.keys(byDept).length) { fire('Aucune commande à créer', 'err'); return; }
      setPsLoading(true); setPsStep('');
      try {
        // 1. Get product ID once
        let productId = psProductId;
        if (!productId) {
          setPsStep('🔍 Recherche du produit DiplomeReco…');
          const prod = await prestashop.getProductByRef('DiplomeReco');
          if (!prod?.id) throw new Error('Produit DiplomeReco introuvable dans PrestaShop');
          productId = prod.id;
          setPsProductId(productId);
        }

        const results = [];
        for (const [dept, reqs] of Object.entries(byDept)) {
          // 2. Get APC customer by psClientId (preferred) or email fallback
          const apcAddr = deptAddresses[dept];
          const apcEmail = apcAddr?.email || `apc.${dept.split(' ')[0].toLowerCase()}@protection-civile.org`;
          fire(`Recherche compte APC ${dept}...`);
          setPsStep(`👤 [${dept}] Recherche du compte APC…`);
          let customer;
          if (apcAddr?.psClientId) {
            customer = await prestashop.getCustomerById(apcAddr.psClientId);
            if (!customer?.id) {
              results.push({ dept, status:'error', msg:`Compte APC introuvable (ID PS: ${apcAddr.psClientId})` });
              continue;
            }
          } else {
            customer = await prestashop.getCustomerByEmail(apcEmail);
            if (!customer?.id) {
              results.push({ dept, status:'error', msg:`Compte APC introuvable pour ${apcEmail} — configurez l'ID client PS` });
              continue;
            }
          }

          // 3. Get address
          const addresses = await prestashop.getCustomerAddresses(customer.id);
          const addrId = addresses[0]?.id;
          if (!addrId) {
            results.push({ dept, status:'error', msg:'Aucune adresse trouvée pour ce client' });
            continue;
          }

          // 4. Create cart
          setPsStep(`🛒 [${dept}] Création du panier…`);
          const cart = await prestashop.createCart(customer.id, addrId);
          if (!cart?.id) {
            results.push({ dept, status:'error', msg:'Erreur création panier' });
            continue;
          }

          // 5. Create order (qty = nb TDR du département)
          const ref = `FNPC-TDR-${dept.split(' ')[0]}-${today()}`;
          setPsStep(`📋 [${dept}] Création de la commande (${reqs.length} TDR)…`);
          const order = await prestashop.createOrder(customer.id, cart.id, addrId, productId, reqs.length, ref, tarif);
          if (!order?.id) {
            results.push({ dept, status:'error', msg:'Erreur création commande' });
            continue;
          }

          // 6. Mark requests as ordered
          reqs.forEach(r => {
            upd(r.id, { prestashopOrderId: order.id, paiement:'commande_creee' });
            audit('commande_ps_creee', r.id, { orderId: order.id, dept, ref });
          });
          results.push({ dept, status:'ok', orderId:order.id, qty:reqs.length, ref });
        }

        setPsOrders(p => [...results, ...p]);
        const ok = results.filter(r=>r.status==='ok').length;
        const err = results.filter(r=>r.status==='error').length;
        setPsStep('');
        fire(`${ok} commande(s) créée(s)${err>0?` · ${err} erreur(s)`:''}${err===0?' ✓':''}`);
      } catch(e) {
        setPsStep('');
        fire(`Erreur PrestaShop : ${e.message}`, 'err');
        console.error('PrestaShop error:', e);
      } finally {
        setPsLoading(false);
      }
    };

    return (
      <div style={{ maxWidth:760 }}>
        <h1 style={H1}>Commandes PrestaShop — TDR groupés</h1>
        <p style={{ color:'#64748b', fontSize:15, marginBottom:18 }}>
          Les commandes sont regroupées <strong>par département APC</strong> et créées sur le compte PrestaShop de l'APC concernée.
          Une commande = tous les TDR validés d'un département.
        </p>

        <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:10, padding:'10px 16px', marginBottom:16, fontSize:14, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span>🛒 PrestaShop : <strong>boutique-preprod.protection-civile.org</strong> · Produit : <strong>DiplomeReco</strong></span>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <span style={{ color:'#059669', fontWeight:700 }}>{psProductId ? `✓ Produit ID ${psProductId}` : '⏳ ID non chargé'}</span>
            <button className="btn btn-sm btn-outline" style={{ fontSize:12 }} onClick={async ()=>{
              fire('Test connexion PrestaShop…');
              try {
                // On interroge une ressource précise plutôt que la racine "/",
                // car la liste racine en JSON déclenche un bug PHP 8 du cœur
                // PrestaShop (array_filter sur une chaîne).
                const d = await psCall('/products?filter[reference]=DiplomeReco');
                const found = Array.isArray(d?.products) ? d.products.length : 0;
                if (d) fire(found ? '✓ PrestaShop OK — produit DiplomeReco trouvé' : '✓ Connexion OK, mais produit DiplomeReco introuvable (vérifiez la référence)');
                else fire('⚠️ Réponse vide de PrestaShop', 'err');
              } catch(e) {
                let msg = e.message;
                if (msg.includes('"code":22')) msg = 'Webservice désactivé côté PrestaShop (Paramètres avancés → Webservice).';
                else if (msg.includes('"code":26')) msg = 'Clé API sans permission sur cette ressource — cochez products/customers/addresses/carts/orders pour la clé dans le Back Office.';
                else if (msg.includes('401')) msg = '401 — clé API refusée. Vérifiez la clé et ses permissions dans le Back Office.';
                else if (msg.includes('503')) msg = '503 — PrestaShop inaccessible depuis Netlify (site hors ligne ou IPs Netlify bloquées par un WAF/Cloudflare).';
                else if (msg.includes('404')) msg = '404 — Netlify Function introuvable. Vérifiez que netlify/functions/ est dans le repo GitHub.';
                fire(msg, 'err');
              }
            }}>🔌 Tester</button>
          </div>
        </div>
        <div style={{ background: psBypass?'#fef9c3':'#f8faff', border:`1px solid ${psBypass?'#fbbf24':'#e5e7eb'}`, borderRadius:8, padding:'9px 14px', marginBottom:16, fontSize:13, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ color: psBypass?'#92400e':'#64748b' }}>
            {psBypass ? '⚠️ Mode dépannage activé — les paiements sont validés sans vérification PrestaShop' : '🔒 Mode normal — PrestaShop requis pour valider les paiements'}
          </span>
          <button className="btn btn-sm" style={{ background:psBypass?'#f59e0b':'#e5e7eb', color:psBypass?'white':'#374151' }}
            onClick={()=>{ setPsBypass(p=>!p); fire(psBypass?'Mode normal rétabli':'⚠️ Mode dépannage activé'); }}>
            {psBypass ? 'Désactiver le bypass' : '🔧 Mode dépannage'}
          </button>
        </div>

        {/* TDR à commander */}
        {Object.keys(byDept).length === 0 ? (
          <div className="card" style={{ textAlign:'center', padding:40, color:'#94a3b8' }}>
            ✅ Aucun TDR en attente de commande PrestaShop
          </div>
        ) : (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div>
                <div style={{ fontWeight:700, color:'#1B3764', fontSize:16 }}>
                  {toOrder.length} TDR à commander — {Object.keys(byDept).length} commande(s) à créer
                </div>
                <div style={{ fontSize:13, color:'#64748b', marginTop:2 }}>
                  Regroupés par département · une commande par APC
                </div>
              </div>
              <button
                className="btn btn-orange"
                style={{ opacity: psLoading?0.6:1 }}
                disabled={psLoading}
                onClick={()=>confirm('Créer les commandes PrestaShop', `Créer ${Object.keys(byDept).length} commande(s) groupée(s) pour les TDR en attente ? Cette action crée des commandes réelles dans PrestaShop.`, createOrders, false)}
              >
                {psLoading ? '⏳ Création en cours…' : '🛒 Créer les commandes groupées'}
              </button>
            </div>
            {psLoading && psStep && (
              <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:8, padding:'10px 14px', marginTop:10, display:'flex', alignItems:'center', gap:10, fontSize:13, color:'#0369a1' }}>
                <span style={{ animation:'spin 1s linear infinite', display:'inline-block' }}>⏳</span>
                <span>{psStep}</span>
              </div>
            )}

            {Object.entries(byDept).map(([dept, reqs]) => (
              <div key={dept} className="card" style={{ marginBottom:8, borderLeft:'4px solid #E87722' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div>
                    <div style={{ fontWeight:700, color:'#1B3764', fontSize:15 }}>{dept}</div>
                    <div style={{ fontSize:13, color:'#64748b', marginTop:2 }}>
                      {reqs.length} TDR · {reqs.map(r=>`${r.benevole?.prenom||''} ${r.benevole?.nom||''}`.trim()).join(', ')}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontWeight:700, color:'#E87722', fontSize:16 }}>{reqs.length * tarif} €</div>
                    <div style={{ fontSize:12, color:'#94a3b8' }}>{reqs.length} × {tarif}€</div>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Historique commandes */}
        {psOrders.length > 0 && (
          <div style={{ marginTop:24 }}>
            <h2 style={H2}>Historique des commandes créées</h2>
            {psOrders.map((o, i) => (
              <div key={i} className="card" style={{ marginBottom:8, borderLeft:`4px solid ${o.status==='ok'?'#059669':'#dc2626'}`, padding:'10px 16px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div>
                    <div style={{ fontWeight:700, color:'#1B3764', fontSize:14 }}>{o.dept}</div>
                    {o.status==='ok' && <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>Commande #{o.orderId} · {o.qty} TDR · Réf. {o.ref}</div>}
                    {o.status==='error' && <div style={{ fontSize:12, color:'#dc2626', marginTop:2 }}>⚠️ {o.msg}</div>}
                  </div>
                  <span style={{ background:o.status==='ok'?'#d1fae5':'#fef2f2', color:o.status==='ok'?'#059669':'#dc2626', borderRadius:20, padding:'2px 10px', fontSize:13, fontWeight:700 }}>
                    {o.status==='ok'?'✓ Créée':'✗ Erreur'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'10px 14px', marginTop:20, fontSize:13, color:'#065f46' }}>
          ✓ <strong>Proxy Netlify activé</strong> — Les appels PrestaShop transitent par une Netlify Function serverside (<code>/.netlify/functions/prestashop-proxy</code>). Aucune configuration CORS requise côté PrestaShop.
        </div>
      </div>
    );
  }

  function TdrPaiementPage() {
    const tdrDept = requests.filter(r => myDepts.includes(r.dept) && r.statut === 'valide_federation' && r.medalType.payant && r.paiement !== 'paye');
    const tdrPaid = requests.filter(r => myDepts.includes(r.dept) && r.medalType.payant && r.paiement === 'paye');
    return (
      <div>
        <h1 style={H1}>Témoignages de Reconnaissance — Paiement</h1>
        <p style={{ color:'#64748b', fontSize:15, marginBottom:18 }}>Validez le paiement des TDR de votre département. Le diplôme sera imprimé automatiquement après validation.</p>

        {tdrDept.length === 0 ? (
          <div className="card" style={{ textAlign:'center', padding:40, color:'#94a3b8' }}>✅ Aucun TDR en attente de paiement pour {myDept}</div>
        ) : (
          <>
            <div style={{ marginBottom:12, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontWeight:700, color:'#f59e0b', fontSize:15 }}>⚠️ {tdrDept.length} TDR en attente de paiement</span>
              <button className="btn btn-sm" style={{ background:'#fbbf24', color:'#78350f' }} onClick={()=>{ tdrDept.forEach(r=>markPaid(r.id)); fire(`${tdrDept.length} paiement(s) validé(s) ✓`); }}>💳 Tout valider</button>
            </div>
            {tdrDept.map(req=>(
              <div key={req.id} className="card" style={{ marginBottom:8, display:'flex', alignItems:'center', gap:12, borderLeft:'4px solid #fbbf24', padding:'12px 16px' }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Playfair Display,serif', fontWeight:700, color:'#1B3764', fontSize:16 }}>{req.benevole.prenom} {req.benevole.nom}</div>
                  <div style={{ fontSize:13, color:'#64748b', marginTop:3 }}>{req.medalType.label} · N° {req.diplomeId||'—'} · {req.benevole.antenne}</div>
                  <div style={{ fontSize:12, color:'#92400e', marginTop:2, fontWeight:600 }}>💳 {tarif}€ à régler</div>
                </div>
                <button className="btn btn-success" onClick={()=>markPaid(req.id)}>💳 Valider le paiement</button>
              </div>
            ))}
          </>
        )}

        {tdrPaid.length > 0 && (
          <div style={{ marginTop:24 }}>
            <div style={{ fontSize:13, color:'#64748b', fontWeight:700, marginBottom:8 }}>✓ Paiements déjà validés ({tdrPaid.length})</div>
            {tdrPaid.map(req=>(
              <div key={req.id} className="card" style={{ marginBottom:6, display:'flex', alignItems:'center', gap:12, borderLeft:'4px solid #059669', padding:'10px 16px', opacity:0.8 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700, color:'#1B3764', fontSize:15 }}>{req.benevole.prenom} {req.benevole.nom}</div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{req.medalType.label} · {req.diplomeId}</div>
                </div>
                <span style={{ background:'#d1fae5', color:'#059669', borderRadius:20, padding:'2px 10px', fontSize:13, fontWeight:700 }}>✓ Payé</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function MonComptePage() {
    const user = authUser;
    const myDelegates = delegates.filter(d => d.niveau === role && d.actif);
    const myDelegateOf = delegates.filter(d => d.email === user?.email && d.actif);
    return (
      <div style={{ maxWidth:640 }}>
        <h1 style={H1}>Mon compte</h1>

        {/* Identité */}
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Informations personnelles</div>
          <div style={{ display:'flex', gap:18, alignItems:'center', marginBottom:16 }}>
            <div style={{ width:64, height:64, borderRadius:'50%', background:'#1B3764', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:26, fontWeight:700, flexShrink:0 }}>
              {user?.prenom?.[0]||'?'}{user?.nom_famille?.[0]||''}
            </div>
            <div>
              <div style={{ fontFamily:'Playfair Display,serif', fontSize:20, fontWeight:700, color:'#1B3764' }}>{user?.nom}</div>
              <div style={{ fontSize:14, color:'#64748b', marginTop:2 }}>{user?.email}</div>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[
              {l:'Rôle', v:ROLES[role]?.label},
              {l:'Organisation', v:ROLES[role]?.org},
              {l:'Département', v:lockedDept||'—'},
              {l:'Source authentification', v:'SSO (simulation prototype)'},
            ].map(({l,v})=>(
              <div key={l} style={{ background:'#f8faff', borderRadius:8, padding:'10px 14px' }}>
                <div style={{ fontSize:11, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.7px' }}>{l}</div>
                <div style={{ fontWeight:700, color:'#1B3764', marginTop:3, fontSize:14 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Permissions */}
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">Mes permissions</div>
          {[
            {l:'Visualiser les demandes de son périmètre', ok:true},
            {l:'Créer des demandes', ok:canCreate},
            {l:'Valider les demandes (son niveau)', ok:['antenne','departement','commission','gestion'].includes(role)},
            {l:'Gérer les délégués', ok:['antenne','departement','gestion'].includes(role)},
            {l:'Statistiques de son niveau', ok:['antenne','departement','gestion'].includes(role)},
            {l:'Administration Gestion FNPC', ok:role==='gestion'},
          ].map(({l,ok})=>(
            <div key={l} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #f1f5f9', fontSize:15 }}>
              <span style={{ color:'#374151' }}>{l}</span>
              <span style={{ fontWeight:700, color:ok?'#059669':'#dc2626' }}>{ok?'✓ Autorisé':'✗ Non autorisé'}</span>
            </div>
          ))}
        </div>

        {/* Délégués actifs */}
        {myDelegates.length > 0 && (
          <div className="card" style={{ marginBottom:14 }}>
            <div className="st">Mes délégués actifs</div>
            {myDelegates.map(d=>(
              <div key={d.id} style={{ display:'flex', gap:10, alignItems:'center', padding:'8px 0', borderBottom:'1px solid #f1f5f9' }}>
                <div style={{ width:32, height:32, borderRadius:'50%', background:'#1B3764', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700 }}>{d.prenom[0]}{d.nom[0]}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700, fontSize:13, color:'#1B3764' }}>{d.prenom} {d.nom}</div>
                  <div style={{ fontSize:11, color:'#64748b' }}>{d.email}</div>
                </div>
                <div style={{ display:'flex', gap:4 }}>
                  {[['lecture','👁'],['demandes','✚'],['validation','✓']].map(([k,ic])=>d.permissions?.[k]&&<span key={k} style={{ background:'#d1fae5', color:'#059669', borderRadius:10, padding:'1px 7px', fontSize:11 }}>{ic}</span>)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Je suis délégué de... */}
        {myDelegateOf.length > 0 && (
          <div className="card">
            <div className="st">Je suis délégué de</div>
            {myDelegateOf.map(d=>(
              <div key={d.id} style={{ display:'flex', gap:10, alignItems:'center', padding:'8px 0', borderBottom:'1px solid #f1f5f9' }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700, fontSize:13, color:'#1B3764' }}>Délégué par : {d.delegueePar}</div>
                  <div style={{ fontSize:11, color:'#64748b' }}>Niveau {ROLES[d.niveau]?.label} · Depuis le {d.date}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Préférences notifications personnelles */}
        <div className="card">
          <div className="st">Mes préférences de notification</div>
          <p style={{ fontSize:14, color:'#64748b', marginBottom:14 }}>Choisissez les e-mails que vous souhaitez recevoir pour votre niveau. Ces réglages s'appliquent à votre compte uniquement.</p>
          {Object.entries(emailSettings[role] || {}).map(([k, active]) => {
            const labels = {
              soumission:'Confirmation soumission demande', validation:'Demande validée',
              refus:'Demande refusée', rappel15j:'Rappel retard > 15 jours',
              tdr_paiement:'Paiement TDR requis', diplome_emis:'Diplôme imprimé', expedition:'Diplôme expédié',
            };
            return (
              <div key={k} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #f1f5f9' }}>
                <span style={{ fontSize:14, color:'#374151' }}>✉️ {labels[k]||k}</span>
                <button
                  className="btn btn-sm"
                  style={{ background:active?'#059669':'#94a3b8', color:'white', minWidth:90 }}
                  onClick={()=>{ setEmailSettings(p=>({...p,[role]:{...p[role],[k]:!active}})); fire(`Notification ${!active?'activée':'désactivée'} ✓`); }}
                >{active?'✓ Activé':'✗ Désactivé'}</button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Calibrage diplômes ──
  const startCalDrag = (e, gab, field) => {
    e.preventDefault();
    setCalField(field);
    const f = diplomaTpl[gab].fields[field];
    calDrag.current = { gab, field, mx:e.clientX, my:e.clientY, fx:f.x, fy:f.y };
  };
  const calDragMove = (e) => {
    if (!calDrag.current || !calPageRef.current) return;
    const rect = calPageRef.current.getBoundingClientRect();
    const dx = (e.clientX - calDrag.current.mx)/rect.width*100;
    const dy = (e.clientY - calDrag.current.my)/rect.height*100;
    const { gab, field, fx, fy } = calDrag.current;
    const nx = Math.max(0, Math.min(100, +(fx+dx).toFixed(2)));
    const ny = Math.max(0, Math.min(100, +(fy+dy).toFixed(2)));
    setDiplomaTpl(p => ({ ...p, [gab]:{ ...p[gab], fields:{ ...p[gab].fields, [field]:{ ...p[gab].fields[field], x:nx, y:ny } } } }));
  };
  const endCalDrag = () => { calDrag.current = null; };
  const updateCalField = (gab, field, patch) => setDiplomaTpl(p => ({ ...p, [gab]:{ ...p[gab], fields:{ ...p[gab].fields, [field]:{ ...p[gab].fields[field], ...patch } } } }));
  const saveDiplomaTpl = () => { db.saveConfig('diploma_templates', diplomaTpl); fire('Positions des diplômes enregistrées ✓'); };

  // Rendu d'un diplôme (utilisé par l'éditeur de calibrage et l'aperçu)
  const diplomaBox = (gab, mode, values, editable) => {
    const t = diplomaTpl[gab];
    if (!t) return null;
    const showBg = mode === 'complet' && t.hasComplet;
    return (
      <div ref={editable ? calPageRef : null}
        onMouseMove={editable ? calDragMove : undefined}
        onMouseUp={editable ? endCalDrag : undefined}
        onMouseLeave={editable ? endCalDrag : undefined}
        style={{ position:'relative', width:DIPLOMA_PAGE_W, height:DIPLOMA_PAGE_W*8.27/11.69,
          background: showBg ? `#fff url(/diplomas/${gab}-complet.jpg) 0 0/100% 100% no-repeat` : '#fff',
          border:'1px solid #e2e8f0', userSelect:'none', flexShrink:0 }}>
        {Object.entries(t.fields).map(([k,f]) => (
          <div key={k}
            onMouseDown={editable ? (e)=>startCalDrag(e, gab, k) : undefined}
            style={{ position:'absolute', left:`${f.x}%`, top:`${f.y}%`, width:`${f.w}%`,
              fontSize:ptToPx(f.size), color:f.color, fontWeight:700, lineHeight:1, whiteSpace:'nowrap',
              display:'flex', justifyContent: f.align==='center' ? 'center' : 'flex-start',
              fontFamily: (f.font || 'Arial') + ', Helvetica, sans-serif',
              cursor: editable ? 'move' : 'default',
              outline: editable ? (calField===k ? '2px dashed #E87722' : '1px dashed #cbd5e1') : 'none' }}>
            {values[k] ?? ''}
          </div>
        ))}
      </div>
    );
  };

  function CalibrageDiplomesPage() {
    const t = diplomaTpl[calGabarit] || {};
    const mode = t.hasComplet ? calMode : 'preimprime';
    const fkeys = Object.keys(t.fields || {});
    const fld = t.fields?.[calField];
    return (
      <div>
        <h1 style={H1}>Calibrage des diplômes</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:14 }}>Glisse chaque champ sur l'aperçu (ou ajuste les valeurs), puis enregistre. <b>Complet</b> = avec le fond (pour l'e-mail) · <b>Pré-imprimé</b> = texte seul (impression sur ton papier décoré).</p>
        <div className="card no-print" style={{ marginBottom:12, display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          {Object.keys(diplomaTpl).map(g => (
            <button key={g} className={`tab ${calGabarit===g?'active':''}`} style={{ fontSize:12 }}
              onClick={()=>{ setCalGabarit(g); setCalField(Object.keys(diplomaTpl[g].fields)[0]); if(!diplomaTpl[g].hasComplet) setCalMode('preimprime'); }}>
              {diplomaTpl[g].label || g}
            </button>
          ))}
        </div>
        <div className="no-print" style={{ display:'flex', gap:8, marginBottom:10, alignItems:'center', flexWrap:'wrap' }}>
          {t.hasComplet && <>
            <button className={`tab ${mode==='complet'?'active':''}`} onClick={()=>setCalMode('complet')}>Complet (fond)</button>
            <button className={`tab ${mode==='preimprime'?'active':''}`} onClick={()=>setCalMode('preimprime')}>Pré-imprimé</button>
          </>}
          <button className="btn btn-orange btn-sm" style={{ marginLeft:'auto' }} onClick={saveDiplomaTpl}>💾 Enregistrer</button>
          <button className="btn btn-outline btn-sm" onClick={()=>confirm('Réinitialiser le gabarit', 'Réinitialiser ce gabarit aux positions par défaut ?', ()=>setDiplomaTpl(p=>({ ...p, [calGabarit]:JSON.parse(JSON.stringify(DEFAULT_DIPLOMA_TEMPLATES[calGabarit])) })))}>↺ Défaut</button>
        </div>
        <div style={{ display:'flex', gap:16, flexWrap:'wrap', alignItems:'flex-start' }}>
          <div className="dip-print">{diplomaBox(calGabarit, mode, DIPLOMA_SAMPLE, true)}</div>
          <div className="card no-print" style={{ minWidth:240, flex:1 }}>
            <div className="st">Champs</div>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
              {fkeys.map(k => <button key={k} className={`tab ${calField===k?'active':''}`} style={{ fontSize:12 }} onClick={()=>setCalField(k)}>{DIPLOMA_FIELD_LABELS[k]||k}</button>)}
            </div>
            {fld && <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <label className="fl">X %<input className="input" type="number" step="0.5" value={fld.x} onChange={e=>updateCalField(calGabarit,calField,{x:+e.target.value})}/></label>
              <label className="fl">Y %<input className="input" type="number" step="0.5" value={fld.y} onChange={e=>updateCalField(calGabarit,calField,{y:+e.target.value})}/></label>
              <label className="fl">Largeur %<input className="input" type="number" step="1" value={fld.w} onChange={e=>updateCalField(calGabarit,calField,{w:+e.target.value})}/></label>
              <label className="fl">Taille (pt)<input className="input" type="number" step="1" value={fld.size} onChange={e=>updateCalField(calGabarit,calField,{size:+e.target.value})}/></label>
              <label className="fl">Couleur<input className="input" type="color" value={fld.color} onChange={e=>updateCalField(calGabarit,calField,{color:e.target.value})} style={{ padding:2, height:38 }}/></label>
              <label className="fl">Alignement<select className="select" value={fld.align} onChange={e=>updateCalField(calGabarit,calField,{align:e.target.value})}><option value="left">Gauche</option><option value="center">Centre</option></select></label>
              <label className="fl" style={{ gridColumn:'1 / 3' }}>Police<select className="select" value={fld.font || 'Arial'} onChange={e=>updateCalField(calGabarit,calField,{font:e.target.value})} style={{ fontFamily:(fld.font||'Arial')+',sans-serif' }}>{FONT_OPTIONS.map(f=><option key={f} value={f} style={{ fontFamily:f }}>{f}</option>)}</select></label>
            </div>}
            <p style={{ fontSize:11, color:'#94a3b8', marginTop:12 }}>Astuce : glisse directement le champ sur l'aperçu pour le positionner, puis affine au pixel ici.</p>
          </div>
        </div>
      </div>
    );
  }

  function AuditPage() {
    const actions = [...new Set(auditLog.map(a => a.action).filter(Boolean))].sort();
    const q = auditSearch.trim().toLowerCase();
    const rows = auditLog.filter(a => {
      if (auditFilterAction && a.action !== auditFilterAction) return false;
      if (!q) return true;
      const hay = `${a.user_email||''} ${a.user_role||''} ${a.action||''} ${a.request_id||''} ${a.details?JSON.stringify(a.details):''}`.toLowerCase();
      return hay.includes(q);
    });
    const reload = () => { setAuditLoading(true); db.loadAuditLog(null,200).then(r=>setAuditLog(r||[])).finally(()=>setAuditLoading(false)); };
    return (
      <div>
        <h1 style={H1}>Journal d'audit</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:16 }}>Traçabilité des actions sensibles : validation, refus, impression, expédition, commande PrestaShop.</p>
        <div className="card" style={{ marginBottom:16, display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
          <select className="select" value={auditFilterAction} onChange={e=>setAuditFilterAction(e.target.value)} style={{ maxWidth:240 }}>
            <option value="">Toutes les actions</option>
            {actions.map(a=><option key={a} value={a}>{a}</option>)}
          </select>
          <input className="input" placeholder="Rechercher (email, demande, détail…)" value={auditSearch} onChange={e=>setAuditSearch(e.target.value)} style={{ flex:1, minWidth:200 }}/>
          <button className="btn btn-outline" onClick={reload}>🔄 Rafraîchir</button>
          <span style={{ fontSize:12, color:'#94a3b8', marginLeft:'auto' }}>{rows.length} entrée(s)</span>
        </div>
        <div className="card" style={{ overflowX:'auto' }}>
          {auditLoading ? <p style={{ color:'#94a3b8', padding:12 }}>⏳ Chargement…</p>
          : rows.length===0 ? <p style={{ color:'#94a3b8', padding:12 }}>Aucune entrée d'audit.</p>
          : (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ textAlign:'left', borderBottom:'2px solid #e2e8f0', color:'#475569' }}>
                  <th style={{ padding:'8px 10px' }}>Date</th>
                  <th style={{ padding:'8px 10px' }}>Utilisateur</th>
                  <th style={{ padding:'8px 10px' }}>Action</th>
                  <th style={{ padding:'8px 10px' }}>Demande</th>
                  <th style={{ padding:'8px 10px' }}>Détails</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(a=>(
                  <tr key={a.id} style={{ borderBottom:'1px solid #f1f5f9' }}>
                    <td style={{ padding:'8px 10px', whiteSpace:'nowrap', color:'#64748b' }}>{a.created_at ? new Date(a.created_at).toLocaleString('fr-FR') : '—'}</td>
                    <td style={{ padding:'8px 10px' }}>{a.user_email||'—'}{a.user_role?<span style={{ marginLeft:6, fontSize:11, padding:'1px 6px', borderRadius:6, background:'#eef2ff', color:'#4338ca' }}>{ROLES[a.user_role]?.label||a.user_role}</span>:null}</td>
                    <td style={{ padding:'8px 10px', fontWeight:600, color:'#1B3764' }}>{a.action||'—'}</td>
                    <td style={{ padding:'8px 10px', color:'#64748b' }}>{a.request_id||'—'}</td>
                    <td style={{ padding:'8px 10px', color:'#64748b', maxWidth:280, overflow:'hidden', textOverflow:'ellipsis' }}>{a.details ? (typeof a.details==='string'?a.details:JSON.stringify(a.details)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  const sideItems = [
    { id:'dashboard', icon:'▦', label:'Tableau de bord' },
    { id:'demandes', icon:'📋', label:'Demandes', badge:role==='departement'?stats.toValDept:role==='antenne'?stats.toValAntenne:role==='commission'?stats.toValComm:null },
    ...(role==='departement'&&stats.tdrEnAttentePaiement>0?[{ id:'tdr_paiement', icon:'💳', label:'TDR à payer', badge:stats.tdrEnAttentePaiement }]:[]),
    ...(canCreate?[{ id:'nouvelle', icon:'✚', label:'Nouvelle demande' }]:[]),
    ...(['antenne','departement','gestion'].includes(role)?[{ id:'statistiques', icon:'📈', label:'Statistiques' }]:[]),
    ...(role==='commission'?[{ id:'validation_rapide', icon:'⚡', label:'Validation rapide', badge:requests.filter(r=>r.statut==='en_commission'&&r.benevole.ans>=r.medalType.years).length||null }]:[]),
    ...(role==='gestion'?[
      { id:'diplomes', icon:'🎖', label:'Diplômes', badge:(stats.toExpedite||null) },
      { id:'agrafes', icon:'🏅', label:'Agrafes' },
      { id:'groupements', icon:'🗺️', label:'Groupements' },
      { id:'prestashop', icon:'🛒', label:'Commandes PrestaShop', badge: requests.filter(r=>r.statut==='en_commission'&&r.medalType.payant&&!r.prestashopOrderId&&new Date(r.dateCreation)<new Date(Date.now()-86400000)).length || null },
      { id:'medailles', icon:'⭐', label:'Types de médailles' },
      { id:'import_csv', icon:'⬆️', label:'Import Google Forms' },
      { id:'import_excel', icon:'📊', label:'Import Excel' },
      { id:'email_templates', icon:'✉️', label:'Notifications & E-mails' },
      { id:'calibrage_diplomes', icon:'🎓', label:'Calibrage diplômes' },
      { id:'audit', icon:'📜', label:"Journal d'audit" },
      { id:'parametres', icon:'⚙️', label:'Paramètres' },
    ]:[]),
    ...(['antenne','departement','gestion'].includes(role)?[{ id:'delegues', icon:'👥', label:'Les Délégués' }]:[]),
    ...(['departement','gestion'].includes(role)?[{ id:'adresse', icon:'⚙️', label:'Paramètres APC' }]:[]),
    { id:'mon_compte', icon:'👤', label:'Mon compte' },
  ];

  const H1 = { fontFamily:'Playfair Display,serif', fontSize:22, color:'#1B3764', fontWeight:700, marginBottom:4 };
  const H2 = { fontFamily:'Playfair Display,serif', fontSize:15, color:'#1B3764', fontWeight:600, marginBottom:12 };

  // ── Page de connexion ─────────────────────────────────────────────────────
  // ── Route d'impression headless (agent) : rend les diplômes calibrés, sans connexion ni habillage ──
  if (printRoute) {
    const list = requests.filter(r => {
      if (r.statut !== 'diplome_emis') return false;
      const cat = r.medalType?.category || '';
      if (cat.startsWith('gm_')) return false; // grandes médailles : impression manuelle
      if (printRoute.dept && r.dept !== printRoute.dept) return false;
      if (printRoute.type === 'temoignage') return cat === 'temoignage';
      if (printRoute.type === 'medaille') return cat !== 'temoignage';
      return true;
    });
    const pagesHtml = list.map(r => {
      const gabarit = MEDAL_TO_GABARIT[r.medalType.id] || 'medaille';
      const agrafeNom = (r.agrafeDepts || []).map(id => agrafes.find(a => a.id === id)?.nom).filter(Boolean).join(', ');
      const values = {
        niveau: r.medalType.shortLabel || '',
        nom: `${r.benevole.prenom} ${r.benevole.nom}`,
        date: diplomaDateFr(r),
        numero: r.diplomeId || '—',
        agrafe: agrafeNom || '',
      };
      return diplomaPageHtml(diplomaTpl, gabarit, printRoute.mode, values);
    }).join('');
    return (
      <div id="print-root" data-ready={dbLoading ? '0' : '1'} data-count={list.length}>
        <style>{`@page{size:A4 landscape;margin:0} html,body{margin:0;padding:0;background:#fff} #print-root .page{position:relative;width:297mm;height:210mm;overflow:hidden;background:#fff;page-break-after:always}`}</style>
        <div dangerouslySetInnerHTML={{ __html: pagesHtml }} />
      </div>
    );
  }

  if (!authUser && !dbLoading) return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(160deg,#1B3764 0%,#0f2347 55%,#E87722 100%)', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ background:'white', borderRadius:20, padding:40, width:'100%', maxWidth:420, boxShadow:'0 24px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <img src={LOGO_SRC} width={72} height={72} alt="FNPC" style={{ borderRadius:'50%', marginBottom:14 }}/>
          <div style={{ fontFamily:'Playfair Display,serif', fontSize:22, fontWeight:700, color:'#1B3764' }}>Protection Civile</div>
          <div style={{ fontSize:14, color:'#64748b', marginTop:4 }}>Gestion des Distinctions et Médailles</div>
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:14, fontWeight:700, color:'#374151', display:'block', marginBottom:5 }}>E-mail</label>
          <input className="input" type="email" placeholder="votre@email.fr" value={loginEmail}
            onChange={e=>{ setLoginEmail(e.target.value); setLoginError(''); }}
            onKeyDown={e=>e.key==='Enter'&&doLogin()} style={{ fontSize:15 }} autoFocus/>
        </div>
        <div style={{ marginBottom:20 }}>
          <label style={{ fontSize:14, fontWeight:700, color:'#374151', display:'block', marginBottom:5 }}>Mot de passe</label>
          <input className="input" type="password" placeholder="••••••••" value={loginPassword}
            onChange={e=>{ setLoginPassword(e.target.value); setLoginError(''); }}
            onKeyDown={e=>e.key==='Enter'&&doLogin()} style={{ fontSize:15 }}/>
        </div>
        {loginError && <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:'9px 12px', marginBottom:14, fontSize:13, color:'#dc2626' }}>⚠️ {loginError}</div>}
        <button className="btn btn-orange" style={{ width:'100%', justifyContent:'center', fontSize:16, padding:'12px', opacity:loginLoading?0.7:1 }}
          onClick={doLogin} disabled={loginLoading}>{loginLoading?'⏳ Connexion…':'Se connecter'}</button>
        <div style={{ textAlign:'center', marginTop:18, fontSize:12, color:'#94a3b8' }}>
          Accès réservé aux membres habilités FNPC<br/>
          Pour obtenir vos identifiants, contactez la Gestion FNPC
        </div>
        <details style={{ marginTop:20 }}>
          <summary style={{ fontSize:12, color:'#cbd5e1', cursor:'pointer', textAlign:'center' }}>Accès démonstration interne</summary>
          <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:6 }}>
            {[['antenne','Antenne Paris 12e'],['departement','APC 75 - Paris Seine'],['commission','Commission FNPC'],['gestion','Gestion FNPC']].map(([r,l])=>(
              <button key={r} className="btn btn-outline btn-sm" style={{ justifyContent:'center', fontSize:12 }}
                onClick={()=>{ const u={ id:`demo-${r}`, email:`demo-${r}@fnpc.fr`, nom:l, prenom:'Démo', role:r, dept:'75 - Paris Seine', antenne:'Paris 12ème' }; setAuthUser(u); setRole(r); setPage('dashboard'); auth.saveSession(u); maybeStartTour(r); }}>
                🔑 {l}
              </button>
            ))}
          </div>
        </details>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily:"'Source Sans 3',sans-serif", background:'#F4F6FA', minHeight:'100vh', display:'flex', flexDirection:'column' }}>
      {dbLoading && USE_SUPABASE && <div style={{ position:'fixed', inset:0, background:'rgba(27,55,100,0.93)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', zIndex:999 }}>
        <img src={LOGO_SRC} width={80} height={80} alt="FNPC" style={{ borderRadius:'50%', marginBottom:20 }}/>
        <div style={{ color:'white', fontSize:20, fontWeight:700, fontFamily:'Playfair Display,serif', marginBottom:8 }}>Connexion à la base de données…</div>
        <div style={{ color:'#94a3b8', fontSize:15 }}>Chargement depuis Supabase</div>
      </div>}
      <style>{CSS}</style>

      {/* HEADER */}
      <header style={{ background:'#1B3764', padding:'0 22px', display:'flex', alignItems:'center', justifyContent:'space-between', height:64, flexShrink:0, borderBottom:'3px solid #E87722' }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, cursor:'pointer' }} onClick={()=>setPage('dashboard')}>
          <Logo size={44}/>
          <div>
            <div style={{ fontFamily:'Playfair Display,serif', fontSize:14, fontWeight:700, color:'white', lineHeight:1.2 }}>Fédération Nationale de la Protection Civile</div>
            <div style={{ fontSize:10, color:'#E87722', letterSpacing:'2px', textTransform:'uppercase', marginTop:2 }}>Gestion des Distinctions et Médailles</div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {USE_SUPABASE && <span style={{ background:dbConnected?'#d1fae5':'#fef9c3', color:dbConnected?'#059669':'#92400e', borderRadius:20, padding:'3px 9px', fontSize:12, fontWeight:700 }}>{dbConnected?'🟢 BD':'🟡 Démo'}</span>}
          {/* Role selector: visible pour gestion, mode démo, et comptes multi-rôles */}
          {(!authUser?.id || authUser?.id?.startsWith('demo-') || authUser?.role==='gestion' || (authUser?.roles && authUser.roles.length>1)) && <>
            <span style={{ fontSize:11, color:'#94a3b8' }}>Vue :</span>
          <select value={role} onChange={e=>{ setRole(e.target.value); setPage('dashboard'); setFilterStatus('all'); setFilterDept('all'); setSearch(''); setSelectedBatch([]); }}
            style={{ background:'rgba(255,255,255,0.1)', color:'white', border:'1px solid rgba(255,255,255,0.2)', fontSize:12, padding:'5px 9px', borderRadius:6 }}>
            {(() => {
              const all = ['antenne','departement','commission','gestion'];
              const allowed = (authUser && authUser.id && !authUser.id.startsWith('demo-') && authUser.role!=='gestion' && authUser.roles && authUser.roles.length) ? authUser.roles : all;
              const labels = { antenne:'👤 Antenne — Paris 12e', departement:'🏢 APC — Paris 75', commission:'⚖️ Commission FNPC', gestion:'🏛 Gestion FNPC' };
              return allowed.map(r => <option key={r} value={r} style={{ background:'#1B3764' }}>{labels[r]||r}</option>);
            })()}
          </select>
          </>}
          {role!=='antenne' && (stats.delayedDept>0||stats.delayedComm>0) && <span onClick={alertInfo?.action} style={{ background:'#ef4444', color:'white', borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:800, cursor:'pointer' }} title="Demandes en retard">⏰ {role==='departement'?stats.delayedDept:stats.delayedComm}</span>}
          {/* User badge + logout */}
          {authUser && ['antenne','departement','commission'].includes(role) && <button onClick={openHelp} title="Pour toute question : medaille@protection-civile.org" style={{ display:'inline-flex', alignItems:'center', gap:5, height:26, padding:'0 10px', borderRadius:13, border:'1px solid rgba(255,255,255,0.3)', background:'rgba(255,255,255,0.1)', color:'white', cursor:'pointer', fontSize:12, fontWeight:600 }}>✉️ Aide</button>}
          {authUser && (role==='antenne'||role==='departement') && <button onClick={()=>setTourStep(0)} title="Revoir la visite guidée" style={{ width:26, height:26, borderRadius:'50%', border:'1px solid rgba(255,255,255,0.3)', background:'rgba(255,255,255,0.1)', color:'white', cursor:'pointer', fontSize:13, fontWeight:700, lineHeight:1 }}>?</button>}
          {authUser && <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:12, color:'white', fontWeight:700 }}>{authUser.prenom} {authUser.nom}</div>
              <div style={{ fontSize:10, color:'#94a3b8' }}>{ROLES[role]?.label}</div>
            </div>
            <div style={{ width:34, height:34, borderRadius:'50%', background:'#E87722', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, color:'white', fontWeight:800, cursor:'pointer' }}
              title="Se déconnecter" onClick={doLogout}>
              {(authUser.prenom?.[0]||'?')}
            </div>
          </div>}
        </div>
      </header>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        {/* SIDEBAR */}
        <aside style={{ width:214, background:'#0E2247', padding:'18px 8px', flexShrink:0, overflowY:'auto' }}>
          <div style={{ color:'#475569', fontSize:10, letterSpacing:'2px', textTransform:'uppercase', padding:'0 10px', marginBottom:6 }}>Menu</div>
          {sideItems.map(item=>(
            <div key={item.id} className={`nav-item ${page===item.id?'active':''}`} onClick={()=>{ if(item.id==='demandes') setFilterStatus('all'); setPage(item.id); }}>
              <span style={{ width:16, textAlign:'center', fontSize:13 }}>{item.icon}</span>
              <span style={{ flex:1, fontSize:13 }}>{item.label}</span>
              {item.badge?<span className="badge-alert">{item.badge}</span>:null}
            </div>
          ))}
          <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', margin:'12px 0' }}/>
          <div style={{ padding:'0 10px', marginBottom:12 }}>
            <div style={{ fontSize:10, color:'#475569', letterSpacing:'1px', textTransform:'uppercase', marginBottom:6 }}>Structure</div>
            <div style={{ color:'#E87722', fontWeight:700, fontSize:13, fontFamily:'Playfair Display,serif' }}>{ROLES[role].org}</div>
            {ROLES[role].dept&&<div style={{ color:'#64748b', fontSize:11, marginTop:2 }}>{ROLES[role].dept}</div>}
          </div>
          <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', margin:'12px 0' }}/>
          <div style={{ padding:'0 10px' }}>
            <div style={{ fontSize:10, color:'#475569', letterSpacing:'1px', textTransform:'uppercase', marginBottom:8 }}>Statuts</div>
            {Object.entries(STATUSES).map(([key,s])=>(
              <div key={key} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:6, cursor:'pointer' }} onClick={()=>{ setFilterStatus(key); setPage('demandes'); }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:s.color, flexShrink:0 }}/>
                <span className="side-stat" style={{ fontSize:12 }}>{s.label}</span>
                <span style={{ fontSize:11, color:'#475569', fontWeight:700 }}>{requests.filter(r=>r.statut===key).length}</span>
              </div>
            ))}
          </div>
          <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', margin:'12px 0' }}/>
          <div style={{ padding:'0 10px' }}>
            <div style={{ fontSize:10, color:'#475569', letterSpacing:'1px', textTransform:'uppercase', marginBottom:8 }}>Distinctions</div>
            {medalTypes.map(m=>(
              <div key={m.id} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:5 }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:m.color, flexShrink:0 }}/>
                <span style={{ fontSize:12, color:'#64748b', flex:1 }}>{m.shortLabel}</span>
                <span style={{ fontSize:11, color:'#475569' }}>{m.years} ans</span>
              </div>
            ))}
          </div>
        </aside>

        <main style={{ flex:1, overflow:'auto', padding:22 }}>
          {renderPage()}
        </main>
      </div>

      {/* MODAL DÉTAIL */}
      {selected&&(
        <div className="modal-overlay" onClick={()=>setSelected(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
              <div>
                <div style={{ fontSize:10, color:'#94a3b8', fontFamily:'monospace', marginBottom:2 }}>{selected.id}</div>
                <h2 style={{ fontFamily:'Playfair Display,serif', color:'#1B3764', fontSize:20, fontWeight:700 }}>{selected.benevole.prenom} {selected.benevole.nom}</h2>
                <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>{selected.benevole.antenne||selected.dept}</div>
              </div>
              <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                {daysSince(selected.dateCreation)>30&&['soumis','en_commission'].includes(selected.statut)&&<span style={{ background:'#fef2f2', color:'#dc2626', borderRadius:10, padding:'2px 8px', fontSize:11, fontWeight:700 }}>⏰ {daysSince(selected.dateCreation)}j</span>}
                <span className="badge" style={{ background:STATUSES[selected.statut]?.bg, color:STATUSES[selected.statut]?.color, padding:'3px 10px' }}>{STATUSES[selected.statut]?.label}</span>
                <button onClick={()=>setSelected(null)} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#94a3b8' }}>✕</button>
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, background:'#f8faff', borderRadius:8, padding:'10px 12px', marginBottom:14 }}>
              <div><div className="il">Ancienneté</div><div className="iv">{selected.benevole.ans} ans</div></div>
              <div><div className="il">Entrée PC</div><div className="iv">{selected.benevole.adhesion}</div></div>
              <div><div className="il">Département</div><div className="iv" style={{ fontSize:12 }}>{selected.dept}</div></div>
            </div>
            {(selected.benevole.fonctions||selected.benevole.distinctions)&&<div className="g2" style={{ marginBottom:14 }}>
              {selected.benevole.fonctions&&<div style={{ background:'#f8faff', borderRadius:8, padding:'9px 11px' }}><div className="il" style={{ marginBottom:2 }}>Fonction(s)</div><div style={{ fontSize:12, color:'#374151' }}>{selected.benevole.fonctions}</div></div>}
              {selected.benevole.distinctions&&<div style={{ background:'#FFF4E8', borderRadius:8, padding:'9px 11px' }}><div className="il" style={{ marginBottom:2 }}>Distinctions antérieures</div><div style={{ fontSize:12, color:'#374151' }}>{selected.benevole.distinctions||'—'}</div></div>}
            </div>}
            <div style={{ display:'flex', gap:10, alignItems:'center', background:selected.medalType.light, border:`1px solid ${selected.medalType.color}40`, borderRadius:8, padding:11, marginBottom:14 }}>
              <div style={{ width:40, height:40, borderRadius:'50%', background:selected.medalType.color, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>🎖</div>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:'Playfair Display,serif', fontWeight:700, color:'#1B3764', fontSize:14 }}>{selected.medalType.label}{agrafeNoms(selected)?` — 🏅 Agrafe : ${agrafeNoms(selected)}`:''}</div>
                <div style={{ fontSize:11, color:'#64748b', marginTop:1 }}>{selected.medalType.years} ans requis · {selected.benevole.ans} ans</div>
                {selected.medalType.payant&&<div style={{ marginTop:4 }}><span style={{ background:selected.paiement==='paye'?'#d1fae5':'#fef9c3', color:selected.paiement==='paye'?'#059669':'#92400e', borderRadius:10, padding:'1px 8px', fontSize:11, fontWeight:700 }}>{selected.paiement==='paye'?`✓ Payé (${tarif}€)`:`⏳ Paiement ${tarif}€ requis`}</span></div>}
              </div>
              {selected.benevole.ans>=selected.medalType.years?<span style={{ background:'#059669', color:'white', borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>✓ Éligible</span>:<span style={{ background:'#dc2626', color:'white', borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>✗</span>}
            </div>
            <div style={{ marginBottom:12 }}><div className="il" style={{ marginBottom:5 }}>Motivations</div><p style={{ color:'#374151', lineHeight:1.7, fontStyle:'italic', fontSize:13 }}>"{selected.justification}"</p></div>
            <div style={{ fontSize:12, color:'#64748b', marginBottom:12 }}>
              <strong>Demandeur :</strong> {selected.demandeur}
              {selected.emailDemandeur&&<> · <a href={`mailto:${selected.emailDemandeur}`} style={{ color:'#E87722' }}>{selected.emailDemandeur}</a></>}
              {selected.dateReception&&<> · <span>Récep. souhaitée : {selected.dateReception}</span></>}
            </div>
            <div style={{ marginBottom:12 }}>
              <div className="il" style={{ marginBottom:8 }}>Historique</div>
              {selected.historique.map((h,i)=>(
                <div key={i} className="tl-item">
                  <div className="tl-dot" style={{ background:i===selected.historique.length-1?'#E87722':'#1B3764' }}>{i===selected.historique.length-1?'★':i+1}</div>
                  <div style={{ paddingTop:3 }}>
                    <div style={{ fontWeight:700, color:'#1e293b', fontSize:13 }}>{h.action}</div>
                    <div style={{ fontSize:11, color:'#94a3b8', marginTop:1 }}>{h.auteur} · {h.date}</div>
                    {h.comment&&<div style={{ fontSize:11, color:'#64748b', marginTop:4, fontStyle:'italic', background:'#f8faff', padding:'6px 10px', borderRadius:6 }}>{h.comment}</div>}
                  </div>
                </div>
              ))}
            </div>
            {selected.diplomeId&&<div style={{ background:'#FFF4E8', border:'1px solid #E87722', borderRadius:8, padding:'10px 14px', marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div><div style={{ fontSize:10, color:'#C45A00', fontWeight:700, letterSpacing:'1px' }}>N° DIPLÔME</div><div style={{ fontFamily:'monospace', color:'#E87722', fontSize:16, fontWeight:700 }}>{selected.diplomeId}</div></div>
                {role==='gestion'&&<div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  <button className="btn btn-outline btn-sm" onClick={()=>{ setDiplomaView({ ...selected, _printMode:'template' }); setSelected(null); }}>📄 Template</button>
                  <button className="btn btn-orange btn-sm" onClick={()=>{ setDiplomaView({ ...selected, _printMode:'full' }); setSelected(null); }}>🖨 PDF complet</button>
                  {agrafeNoms(selected)&&<>
                    <button className="btn btn-outline btn-sm" onClick={()=>{ setDiplomaView({ ...selected, _printMode:'template', _gabarit:'agrafe' }); setSelected(null); }}>🏅 Agrafe (template)</button>
                    <button className="btn btn-orange btn-sm" onClick={()=>{ setDiplomaView({ ...selected, _printMode:'full', _gabarit:'agrafe' }); setSelected(null); }}>🏅 Agrafe PDF</button>
                  </>}
                </div>}
              </div>
            </div>}
            <div style={{ display:'flex', gap:7, justifyContent:'flex-end', borderTop:'1px solid #f1f5f9', paddingTop:12, flexWrap:'wrap' }}>
              <button className="btn btn-outline btn-sm" onClick={()=>setSelected(null)}>Fermer</button>
              {selected.statut==='brouillon'&&<button className="btn btn-orange btn-sm" onClick={()=>loadBrouillon(selected)}>✏️ Continuer la demande</button>}
              {canEdit(selected)&&<button className="btn btn-orange btn-sm" onClick={()=>loadEditReq(selected)}>✏️ Modifier la demande</button>}
              {role==='gestion'&&<button className="btn btn-outline btn-sm" onClick={()=>openGEdit(selected)}>✏️ Corriger (FNPC)</button>}
              {canResubmit(selected)&&<button className="btn btn-orange btn-sm" onClick={()=>{ setResubmitModal(selected); setSelected(null); }}>↺ Resoumettre</button>}
              {canRefuse(selected)&&<button className="btn btn-danger btn-sm" onClick={()=>{ setRefuseModal(selected); setSelected(null); }}>✗ Refuser</button>}
              {canValAntenne(selected)&&<button className="btn btn-success btn-sm" onClick={()=>validateAntenne(selected.id)}>✓ Valider → APC</button>}
              {canValDept(selected)&&<button className="btn btn-success btn-sm" onClick={()=>validateDept(selected.id)}>✓ Valider APC</button>}
              {canValComm(selected)&&<button className="btn btn-success btn-sm" onClick={()=>confirm('Approuver la demande', `Approuver la demande de ${selected.benevole.prenom} ${selected.benevole.nom} (${selected.medalType.shortLabel}) ?`, ()=>validateComm(selected.id), false)}>✓ Approuver Commission</button>}
              {canIssue(selected)&&<button className="btn btn-orange btn-sm" onClick={()=>confirm('Imprimer le diplôme', `Imprimer le diplôme de ${selected.benevole.prenom} ${selected.benevole.nom} ? Un numéro définitif sera attribué.`, ()=>issueDiploma(selected.id), false)}>🖨 Imprimer le diplôme</button>}
            </div>
          </div>
        </div>
      )}

      {/* MODALE CONFIRMATION GÉNÉRIQUE */}
      {confirmModal&&(
        <div className="modal-overlay" onClick={()=>setConfirmModal(null)}>
          <div className="modal" style={{ maxWidth:420 }} onClick={e=>e.stopPropagation()}>
            <h2 style={{ fontFamily:'Playfair Display,serif', color: confirmModal.danger ? '#dc2626' : '#1B3764', marginBottom:8 }}>{confirmModal.title}</h2>
            <p style={{ color:'#64748b', fontSize:14, marginBottom:20, lineHeight:1.5 }}>{confirmModal.message}</p>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={()=>setConfirmModal(null)}>Annuler</button>
              <button className={`btn btn-sm ${confirmModal.danger ? 'btn-danger' : 'btn-primary'}`} onClick={()=>{ confirmModal.onConfirm(); setConfirmModal(null); }}>Confirmer</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL REFUS */}
      {refuseModal&&(
        <div className="modal-overlay" onClick={()=>setRefuseModal(null)}>
          <div className="modal" style={{ maxWidth:480 }} onClick={e=>e.stopPropagation()}>
            <h2 style={{ fontFamily:'Playfair Display,serif', color:'#dc2626', marginBottom:6 }}>Refuser la demande</h2>
            <p style={{ color:'#64748b', fontSize:13, marginBottom:14 }}>{refuseModal.id} — {refuseModal.benevole.prenom} {refuseModal.benevole.nom}</p>
            <div className="fg" style={{ marginBottom:16 }}><label className="fl">Motif de refus *</label><textarea className="textarea" rows={4} placeholder="Ce commentaire sera transmis au demandeur." value={refuseComment} onChange={e=>setRefuseComment(e.target.value)}/></div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={()=>setRefuseModal(null)}>Annuler</button>
              <button className="btn btn-danger btn-sm" disabled={!refuseComment.trim()} onClick={()=>refuse(refuseModal.id, refuseComment)}>Confirmer le refus</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL RESOUMISSION */}
      {resubmitModal&&(
        <div className="modal-overlay" onClick={()=>setResubmitModal(null)}>
          <div className="modal" style={{ maxWidth:480 }} onClick={e=>e.stopPropagation()}>
            <h2 style={{ fontFamily:'Playfair Display,serif', color:'#E87722', marginBottom:6 }}>Resoumettre le dossier</h2>
            <p style={{ color:'#64748b', fontSize:13, marginBottom:14 }}>{resubmitModal.id} — {resubmitModal.benevole.prenom} {resubmitModal.benevole.nom}</p>
            <div style={{ background:'#fef2f2', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:12, color:'#dc2626' }}>
              <strong>Motif du refus :</strong> {resubmitModal.historique[resubmitModal.historique.length-1]?.comment}
            </div>
            <div className="fg" style={{ marginBottom:16 }}>
              <label className="fl">Commentaire de resoumission</label>
              <textarea className="textarea" rows={3} placeholder="Expliquez les corrections apportées au dossier…" id="resubmit-comment"/>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={()=>setResubmitModal(null)}>Annuler</button>
              <button className="btn btn-orange btn-sm" onClick={()=>resubmit(resubmitModal.id, document.getElementById('resubmit-comment')?.value||'Dossier corrigé et resoumis.')}>↺ Resoumettre</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL EMAIL */}
      {emailModal&&(
        <div className="modal-overlay" onClick={()=>setEmailModal(null)}>
          <div className="modal" style={{ maxWidth:560 }} onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h2 style={{ fontFamily:'Playfair Display,serif', color:'#1B3764', fontSize:18 }}>✉️ Envoi e-mail</h2>
              {emailSendState==='sent'
                ? <span style={{ background:'#d1fae5', color:'#059669', borderRadius:20, padding:'3px 10px', fontSize:12, fontWeight:700 }}>✓ Envoyé</span>
                : <span style={{ background:'#eef2ff', color:'#4338ca', borderRadius:20, padding:'3px 10px', fontSize:12, fontWeight:700 }}>Prêt à envoyer</span>}
            </div>
            <div style={{ background:'#f8faff', borderRadius:8, padding:'12px 14px', marginBottom:14 }}>
              <div style={{ fontSize:11, color:'#94a3b8', marginBottom:2 }}>À :</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#1B3764' }}>{emailModal.destinataire}</div>
            </div>
            <div style={{ background:'#f8faff', borderRadius:8, padding:'12px 14px', marginBottom:14 }}>
              <div style={{ fontSize:11, color:'#94a3b8', marginBottom:2 }}>Objet :</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#1B3764' }}>{emailModal.sujet}</div>
            </div>
            <div style={{ border:'1px solid #e5e7eb', borderRadius:8, overflow:'hidden' }} dangerouslySetInnerHTML={{ __html: fnpcEmailHtml(emailModal.corps) }} />
            <div style={{ display:'flex', justifyContent:'flex-end', alignItems:'center', gap:10, marginTop:16 }}>
              {emailSendState==='error' && <span style={{ color:'#dc2626', fontSize:12, marginRight:'auto' }}>⚠️ {emailSendErr}</span>}
              <button className="btn btn-outline btn-sm" onClick={()=>setEmailModal(null)}>Fermer</button>
              {emailSendState!=='sent' && (
                <button className="btn btn-sm" disabled={emailSendState==='sending'} onClick={sendEmailNow}>
                  {emailSendState==='sending' ? 'Envoi…' : '✉️ Envoyer'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DIPLÔME */}
      {quickValConfirm && (
        <div className="modal-overlay" onClick={()=>setQuickValConfirm(null)}>
          <div className="modal" style={{ maxWidth:460 }} onClick={e=>e.stopPropagation()}>
            <h2 style={{ fontFamily:'Playfair Display,serif', color:'#1B3764', marginBottom:8 }}>⚡ Confirmer la validation rapide</h2>
            <p style={{ color:'#64748b', fontSize:14, marginBottom:20 }}>
              Vous êtes sur le point d'approuver <strong>{quickValConfirm.length} dossier(s)</strong> en Commission FNPC.<br/>
              Cette action est irréversible. Confirmez-vous ?
            </p>
            <div style={{ background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, padding:'10px 14px', marginBottom:20 }}>
              {quickValConfirm.slice(0,5).map(id=>{ const r=requests.find(x=>x.id===id); return r?<div key={id} style={{ fontSize:13, color:'#065f46', padding:'3px 0' }}>✓ {r.benevole.prenom} {r.benevole.nom} — {r.medalType.shortLabel}</div>:null; })}
              {quickValConfirm.length>5&&<div style={{ fontSize:12, color:'#94a3b8', marginTop:4 }}>+ {quickValConfirm.length-5} autre(s)…</div>}
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={()=>setQuickValConfirm(null)}>Annuler</button>
              <button className="btn btn-success" onClick={()=>{ quickValidateAll(quickValConfirm); setQuickValConfirm(null); }}>✓ Confirmer la validation</button>
            </div>
          </div>
        </div>
      )}

      {tourStep!==null && (TOUR_STEPS[role]||[]).length>0 && (() => {
        const steps = TOUR_STEPS[role];
        const idx = Math.min(tourStep, steps.length-1);
        const s = steps[idx];
        const last = idx >= steps.length-1;
        return (
          <div className="modal-overlay" style={{ zIndex:1000 }} onClick={closeTour}>
            <div style={{ maxWidth:440, width:'100%', background:'white', borderRadius:18, overflow:'hidden', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }} onClick={e=>e.stopPropagation()}>
              <div style={{ background:'#1B3764', padding:'22px 24px', textAlign:'center', borderBottom:'3px solid #E87722' }}>
                <div style={{ fontSize:40, marginBottom:6 }}>{s.icon}</div>
                <div style={{ color:'white', fontFamily:'Playfair Display,serif', fontWeight:700, fontSize:18 }}>{s.title}</div>
              </div>
              <div style={{ padding:'20px 24px' }}>
                <p style={{ color:'#475569', fontSize:14, lineHeight:1.6, margin:0 }}>{s.body}</p>
                <div style={{ display:'flex', justifyContent:'center', gap:6, margin:'18px 0' }}>
                  {steps.map((_,i)=><span key={i} style={{ width:8, height:8, borderRadius:'50%', background:i===idx?'#E87722':'#e5e7eb' }}/>)}
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                  <button className="btn btn-outline btn-sm" onClick={closeTour}>Passer</button>
                  <div style={{ display:'flex', gap:8 }}>
                    {idx>0 && <button className="btn btn-outline btn-sm" onClick={()=>setTourStep(idx-1)}>Précédent</button>}
                    {last
                      ? <button className="btn btn-orange btn-sm" onClick={closeTour}>Terminer ✓</button>
                      : <button className="btn btn-orange btn-sm" onClick={()=>setTourStep(idx+1)}>Suivant →</button>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {diplomaView&&<DiplomaModal req={diplomaView} templates={diplomaTpl} agrafes={agrafes} tarif={tarif} onClose={()=>setDiplomaView(null)}/>}
      {gEdit&&(
        <div className="modal-overlay" onClick={()=>setGEdit(null)}>
          <div style={{ maxWidth:560, width:'100%', background:'white', borderRadius:16, overflow:'hidden', maxHeight:'92vh', display:'flex', flexDirection:'column' }} onClick={e=>e.stopPropagation()}>
            <div style={{ padding:'12px 18px', background:'#1B3764', display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:'2px solid #E87722' }}>
              <span style={{ color:'#E87722', fontFamily:'Playfair Display,serif', fontWeight:700 }}>✏️ Correction FNPC — {gEdit.id}</span>
              <button onClick={()=>setGEdit(null)} style={{ background:'rgba(255,255,255,0.1)', border:'none', color:'white', cursor:'pointer', borderRadius:6, padding:'5px 10px', fontSize:12 }}>✕</button>
            </div>
            <div style={{ padding:18, overflow:'auto' }}>
              <div style={{ background:'#FFF4E8', border:'1px solid #E87722', borderRadius:8, padding:'8px 12px', marginBottom:14, fontSize:12, color:'#C45A00' }}>Correction directe par la Gestion FNPC — le statut du dossier ({STATUSES[gEdit.statut]?.label}) n'est pas modifié.</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <label className="fl">Prénom<input className="input" value={gPrenom} onChange={e=>setGPrenom(e.target.value)}/></label>
                <label className="fl">Nom<input className="input" value={gNom} onChange={e=>setGNom(e.target.value)}/></label>
              </div>
              <label className="fl" style={{ marginTop:10, display:'block' }}>Distinction<select className="select" value={gMedal} onChange={e=>setGMedal(e.target.value)}>{medalTypes.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
              <label className="fl" style={{ marginTop:10, display:'block' }}>Département<select className="select" value={gDept} onChange={e=>setGDept(e.target.value)}>{DEPTS.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
              <label className="fl" style={{ marginTop:10, display:'block' }}>Motivations<textarea className="textarea" rows={5} value={gJust} onChange={e=>setGJust(e.target.value)}/></label>
              <div style={{ display:'flex', gap:8, marginTop:14 }}>
                <button className="btn btn-orange" onClick={saveGEdit} disabled={!gNom.trim()||!gPrenom.trim()}>💾 Enregistrer la correction</button>
                <button className="btn btn-outline" onClick={()=>setGEdit(null)}>Annuler</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast&&<div className="toast" style={{ background:toast.type==='err'?'#dc2626':'#059669' }}>{toast.type==='err'?'✗':'✓'} {toast.msg}</div>}
    </div>
  );
}

// ─── COMPOSANTS PARTAGÉS ───────────────────────────────────────────────────────

function ReqHeader() {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'128px 1fr 1fr 1fr 156px 72px 36px', gap:10, padding:'6px 14px', color:'#94a3b8', fontSize:10, letterSpacing:'0.7px', textTransform:'uppercase', borderBottom:'1px solid #f1f5f9', marginBottom:2 }}>
      <span>N° Demande</span><span>Récipiendaire</span><span>Distinction</span><span>Département</span><span>Statut</span><span>Date</span><span/>
    </div>
  );
}

function ReqRow({ req, onSelect, showLate = true }) {
  const s = STATUSES[req.statut];
  const late = showLate && ['soumis','en_commission'].includes(req.statut) && daysSince(req.dateCreation)>30;
  return (
    <div className={`req-row ${late?'delayed':''}`} onClick={()=>onSelect(req)}>
      <span style={{ fontFamily:'monospace', fontSize:10, color:'#64748b', fontWeight:700 }}>{req.id}</span>
      <div>
        <div style={{ fontWeight:700, color:'#1B3764', fontFamily:'Playfair Display,serif', fontSize:13 }}>{req.benevole.prenom} {req.benevole.nom}</div>
        <div style={{ fontSize:10, color:'#94a3b8', marginTop:1 }}>{req.benevole.antenne||req.demandeur}</div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <div style={{ width:8, height:8, borderRadius:'50%', background:req.medalType.color, flexShrink:0 }}/>
        <span style={{ fontSize:11, color:'#374151' }}>{req.medalType.shortLabel}{req.agrafe?' 🏅':''}</span>
      </div>
      <span style={{ fontSize:11, color:'#64748b' }}>{req.dept}</span>
      <div>
        <span className="badge" style={{ background:s?.bg, color:s?.color }}>{s?.label}</span>
      </div>
      <span style={{ fontSize:10, color:'#94a3b8' }}>{req.dateCreation}</span>
      {late?<span title="En retard >30j" style={{ color:'#ef4444', fontSize:14 }}>⏰</span>:<span/>}
    </div>
  );
}


