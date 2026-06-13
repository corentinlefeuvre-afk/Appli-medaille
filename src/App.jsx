import { useState, useMemo, useEffect, useRef } from "react";
import React from "react";
import { db } from './supabase.js';
import { auth } from './auth.js';

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
const APP_VERSION = "1.3.1";
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
const CONNECTED_USERS = {
  antenne:     { email:'pres.paris12@protection-civile.fr', nom:'Dupont Jean', prenom:'Jean', nom_famille:'Dupont' },
  departement: { email:'president@apc-paris75.fr', nom:'Martin Sophie', prenom:'Sophie', nom_famille:'Martin' },
  commission:  { email:'commission@fnpc.fr', nom:'Commission FNPC', prenom:'', nom_famille:'' },
  gestion:     { email:'gestion@fnpc.fr', nom:'Secrétariat Fédéral', prenom:'', nom_famille:'' },
};

const DEPTS = [
  '01 - Ain','02 - Aisne','03 - Allier','04 - Alpes-de-Haute-Provence','05 - Hautes-Alpes',
  '06 - Alpes-Maritimes','07 - Ardèche','08 - Ardennes','09 - Ariège','10 - Aube',
  '11 - Aude','12 - Aveyron','13 - Bouches-du-Rhône','14 - Calvados','15 - Cantal',
  '16 - Charente','17 - Charente-Maritime','18 - Cher','19 - Corrèze','20 - Corse',
  "21 - Côte-d'Or","22 - Côtes-d'Armor",'23 - Creuse','24 - Dordogne','25 - Doubs',
  '26 - Drôme','28 - Eure-et-Loir','29 - Finistère','30 - Gard','31 - Haute-Garonne',
  '32 - Gers','33 - Gironde','34 - Hérault','35 - Ille-et-Vilaine','36 - Indre',
  '37 - Indre-et-Loire','38 - Isère','39 - Jura','40 - Landes','41 - Loir-et-Cher',
  '42 - Loire','44 - Loire-Atlantique','45 - Loiret','46 - Lot','47 - Lot-et-Garonne',
  '49 - Maine-et-Loire','50 - Manche','51 - Marne','52 - Haute-Marne','53 - Mayenne',
  '54 - Meurthe-et-Moselle','55 - Meuse','56 - Morbihan','57 - Moselle','58 - Nièvre',
  '59 - Nord','60 - Oise','61 - Orne','62 - Pas-de-Calais','63 - Puy-de-Dôme',
  '64 - Pyrénées-Atlantiques','65 - Hautes-Pyrénées','66 - Pyrénées-Orientales',
  '67 - Bas-Rhin','68 - Haut-Rhin','69 - Rhône','70 - Haute-Saône','71 - Saône-et-Loire',
  '72 - Sarthe','73 - Savoie','74 - Haute-Savoie','75 - Paris Seine','76 - Normandie Seine',
  '77 - Seine-et-Marne','78 - Yvelines','79 - Deux-Sèvres','80 - Somme','81 - Tarn',
  '82 - Tarn-et-Garonne','83 - Var','84 - Vaucluse','85 - Vendée','86 - Vienne',
  '87 - Haute-Vienne','88 - Vosges','89 - Yonne','90 - Territoire de Belfort',
  "91 - Essonne","95 - Val-d'Oise",'971 - Guadeloupe','97150 - Saint-Martin',
  '972 - Martinique','973 - Guyane','974 - La Réunion','976 - Mayotte',
  '986 - Wallis et Futuna','987 - Polynésie Française','998 - Nouvelle-Calédonie','FNPC',
];

const MEDAL_TYPES = [
  { id:'temoignage', label:'Témoignage de Reconnaissance',   shortLabel:'TDR',        years:2,  category:'temoignage',      color:'#8B7355', light:'#f5f0e8', payant:true  },
  { id:'bronze',     label:'Médaille Échelon Bronze',         shortLabel:'Bronze',     years:5,  category:'medaille',        color:'#CD7F32', light:'#fdf3e3', payant:false },
  { id:'argent',     label:'Médaille Échelon Argent',         shortLabel:'Argent',     years:10, category:'medaille',        color:'#9BA7B0', light:'#f0f4f8', payant:false },
  { id:'vermeil',    label:'Médaille Échelon Vermeil',        shortLabel:'Vermeil',    years:15, category:'medaille',        color:'#CC5500', light:'#fff0e6', payant:false },
  { id:'grand_or',   label:'Médaille Échelon Grand Or',       shortLabel:'Grand Or',   years:20, category:'medaille',        color:'#CFB53B', light:'#fffbea', payant:false },
  { id:'gm_argent',  label:'Grande Médaille Échelon Argent',  shortLabel:'Gr. Argent', years:30, category:'grande_medaille', color:'#8C8C8C', light:'#f5f5f5', payant:false },
  { id:'gm_or',      label:'Grande Médaille Échelon Or',      shortLabel:'Gr. Or',     years:40, category:'grande_medaille', color:'#D4AF37', light:'#fefbe6', payant:false },
];

const STATUSES = {
  brouillon:         { label:'Brouillon',                   color:'#94a3b8', bg:'#f1f5f9' },
  soumis_antenne:    { label:'Soumis Antenne',              color:'#8b5cf6', bg:'#f5f3ff' },
  soumis:            { label:'Soumis APC',                  color:'#3b82f6', bg:'#eff6ff' },
  pret_commission:   { label:'Prêt pour Commission',        color:'#0ea5e9', bg:'#e0f2fe' },
  en_commission:     { label:'Soumis Commission FNPC',      color:'#f59e0b', bg:'#fffbeb' },
  valide_federation: { label:'Approuvé',                    color:'#10b981', bg:'#ecfdf5' },
  refuse_dept:       { label:'Refusé APC',                  color:'#ef4444', bg:'#fef2f2' },
  refuse_federation: { label:'Refusé Commission',           color:'#dc2626', bg:'#fef2f2' },
  diplome_emis:      { label:'Diplôme imprimé',             color:'#059669', bg:'#d1fae5' },
  expedie:           { label:'Expédié',                     color:'#7c3aed', bg:'#f5f3ff' },
};

const ROLES = {
  antenne:     { label:'Antenne',  org:'Antenne Paris 12ème', dept:'75 - Paris Seine' },
  departement: { label:'APC',     org:'APC 75 - Paris Seine',dept:'75 - Paris Seine' },
  commission:  { label:'Commission FNPC',      org:'Fédération Nationale',dept:null },
  gestion:     { label:'Gestion FNPC',         org:'Fédération Nationale',dept:null },
};

const MOCK_VOLUNTEERS = [
  { id:'V001', nom:'Martin',   prenom:'Jean',   genre:'M', annee:1980, antenne:'Antenne Paris 12e',       dept:'75 - Paris Seine',      adhesion:'2014-03-15', ans:10, fonctions:"Chef d'équipe, Formateur PSC1",            distinctions:'Témoignage de Reconnaissance (2022)' },
  { id:'V002', nom:'Dubois',   prenom:'Marie',  genre:'F', annee:1990, antenne:'Antenne Lyon Nord',        dept:'69 - Rhône',            adhesion:'2019-06-01', ans:5,  fonctions:'Secouriste, Responsable logistique',       distinctions:'' },
  { id:'V003', nom:'Lefebvre', prenom:'Pierre', genre:'M', annee:1975, antenne:null,                       dept:'33 - Gironde',          adhesion:'2009-09-10', ans:15, fonctions:'Président antenne, Formateur PSE1/PSC1',   distinctions:'Bronze (2014), Argent (2019)' },
  { id:'V004', nom:'Bernard',  prenom:'Sophie', genre:'F', annee:1970, antenne:'Antenne Marseille Centre', dept:'13 - Bouches-du-Rhône', adhesion:'2004-01-20', ans:20, fonctions:'Directrice opérationnelle',                distinctions:'Témoignage (2006), Bronze (2009), Argent (2014), Vermeil (2019)' },
  { id:'V005', nom:'Thomas',   prenom:'Luc',    genre:'M', annee:1965, antenne:'Antenne Bordeaux Est',     dept:'33 - Gironde',          adhesion:'1994-05-12', ans:30, fonctions:'Vice-président, Coordinateur, Formateur',  distinctions:'Bronze (1999), Argent (2004), Vermeil (2009), Grand Or (2014)' },
  { id:'V006', nom:'Petit',    prenom:'André',  genre:'M', annee:1998, antenne:'Antenne Toulouse Sud',     dept:'31 - Haute-Garonne',    adhesion:'2022-01-10', ans:2,  fonctions:'Secouriste bénévole',                      distinctions:'' },
  { id:'V007', nom:'Moreau',   prenom:'Claire', genre:'F', annee:1960, antenne:'Antenne Nice Centre',      dept:'06 - Alpes-Maritimes',  adhesion:'1984-08-22', ans:40, fonctions:'Fondatrice, Présidente honoraire',          distinctions:'Bronze, Argent, Vermeil, Grand Or, Grande Médaille Argent' },
  { id:'V008', nom:'Durand',   prenom:'Paul',   genre:'M', annee:1998, antenne:'Antenne Paris 12e',        dept:'75 - Paris Seine',      adhesion:'2022-06-01', ans:2,  fonctions:'Secouriste',                               distinctions:'' },
  { id:'V009', nom:'Laurent',  prenom:'Emma',   genre:'F', annee:1985, antenne:'Antenne Paris 12e',        dept:'75 - Paris Seine',      adhesion:'2004-05-10', ans:20, fonctions:'Formatrice, Coordinatrice',                distinctions:'Bronze (2009), Argent (2014), Vermeil (2019)' },
  { id:'V010', nom:'Garcia',   prenom:'Carlos', genre:'M', annee:1972, antenne:'Antenne Lyon Nord',        dept:'69 - Rhône',            adhesion:'2009-03-01', ans:15, fonctions:'Chef de section',                          distinctions:'Bronze (2014), Argent (2019)' },
];

const today = () => new Date().toISOString().split('T')[0];
const daysSince = (d) => Math.floor((new Date() - new Date(d)) / 86400000);

const getDeptCode = (dept) => {
  const code = dept.split(' - ')[0].trim();
  return isNaN(code) ? '00' : code.padStart(3, '0');
};

const generateDiplomaNumber = (dept, counters) => {
  const code = getDeptCode(dept);
  const year = new Date().getFullYear();
  const seq = (counters[dept] || 0) + 1;
  return `FNPC-${year}-${code}-${String(seq).padStart(4, '0')}`;
};

const getNextMedalSuggestion = (volunteer, medals) => {
  if (!medals) return null;
  const eligible = medals.filter(m => volunteer.ans >= m.years);
  if (eligible.length === 0) return null;
  const current = eligible[eligible.length - 1];
  const nextIdx = medals.indexOf(current) + 1;
  return nextIdx < medals.length ? medals[nextIdx] : null;
};

const INITIAL_REQUESTS = [
  { id:'REQ-2024-001', diplomeId:null, statut:'soumis', benevole:MOCK_VOLUNTEERS[0], medalType:MEDAL_TYPES[2],
    demandeur:'Antenne Paris 12e', emailDemandeur:'pres.paris12@pc.fr', dept:'75 - Paris Seine', niveau:'antenne',
    dateCreation:'2024-10-10', notifications:true, agrafe:false, paiement:null, expedition:null,
    justification:'Engagement exceptionnel lors des inondations de 2023. Coordination de 45 bénévoles sur le terrain pendant 72h.',
    dateReception:'2025-03-15',
    historique:[{ date:'2024-10-10', action:'Demande créée', auteur:"Président Antenne Paris 12e", comment:'' }] },
  { id:'REQ-2024-002', diplomeId:null, statut:'en_commission', benevole:MOCK_VOLUNTEERS[1], medalType:MEDAL_TYPES[1],
    demandeur:'Antenne Lyon Nord', emailDemandeur:'pres.lyon@pc.fr', dept:'69 - Rhône', niveau:'antenne',
    dateCreation:'2024-11-10', notifications:false, agrafe:false, paiement:null, expedition:null,
    justification:'Participation à plus de 80 postes de secours. Dévouement exemplaire.',
    dateReception:'2025-02-01',
    historique:[
      { date:'2024-11-10', action:'Demande créée', auteur:'Président Antenne Lyon Nord', comment:'' },
      { date:'2024-11-18', action:'Validé par APC', auteur:'Président APC Rhône', comment:'Dossier complet. Transmis en commission.' }] },
  { id:'REQ-2024-003', diplomeId:null, statut:'en_commission', benevole:MOCK_VOLUNTEERS[2], medalType:MEDAL_TYPES[3],
    demandeur:'APC 33 - Gironde', emailDemandeur:'president@pc-gironde.fr', dept:'33 - Gironde', niveau:'departement',
    dateCreation:'2024-09-15', notifications:true, agrafe:false, paiement:null, expedition:null,
    justification:'200 missions coordonnées. Formateur PSC1 ayant formé 800 personnes.',
    dateReception:'2025-01-20',
    historique:[
      { date:'2024-09-15', action:'Demande créée', auteur:'Président APC Gironde', comment:'' },
      { date:'2024-09-30', action:'Transmis en commission', auteur:'APC Gironde', comment:'Demande directe APC.' }] },
  { id:'REQ-2024-004', diplomeId:'FNPC-2024-013-0001', statut:'expedie', benevole:MOCK_VOLUNTEERS[3], medalType:MEDAL_TYPES[4],
    demandeur:'Antenne Marseille Centre', emailDemandeur:'pres.marseille@pc.fr', dept:'13 - Bouches-du-Rhône', niveau:'antenne',
    dateCreation:'2024-09-01', notifications:false, agrafe:false, paiement:null, expedition:'2024-11-05',
    justification:'Formation de 150 secouristes. Direction de la cellule psychologique lors de la catastrophe de Martigues.',
    dateReception:'2024-11-15',
    historique:[
      { date:'2024-09-01', action:'Demande créée', auteur:'Président Antenne Marseille Centre', comment:'' },
      { date:'2024-09-20', action:'Validé par APC', auteur:'Président APC 13', comment:'Excellent dossier.' },
      { date:'2024-10-15', action:'Approuvé par Commission FNPC', auteur:'Commission FNPC', comment:'Validation unanime.' },
      { date:'2024-10-30', action:'Diplôme imprimé', auteur:'Gestion FNPC', comment:'' },
      { date:'2024-11-05', action:'Expédié', auteur:'Gestion FNPC', comment:'Expédié par courrier recommandé.' }] },
  { id:'REQ-2024-005', diplomeId:null, statut:'refuse_dept', benevole:MOCK_VOLUNTEERS[5], medalType:MEDAL_TYPES[1],
    demandeur:'Antenne Toulouse Sud', emailDemandeur:'pres.toulouse@pc.fr', dept:'31 - Haute-Garonne', niveau:'antenne',
    dateCreation:'2024-11-01', notifications:true, agrafe:false, paiement:null, expedition:null,
    justification:"Investissement local depuis son arrivée.",
    dateReception:'',
    historique:[
      { date:'2024-11-01', action:'Demande créée', auteur:'Secrétaire Antenne Toulouse Sud', comment:'' },
      { date:'2024-11-12', action:'Refusé par APC', auteur:'Président APC Haute-Garonne', comment:"Ancienneté insuffisante (2 ans / 5 requis). Dossier à renouveler en 2027." }] },
  { id:'REQ-2024-006', diplomeId:null, statut:'soumis', benevole:MOCK_VOLUNTEERS[4], medalType:MEDAL_TYPES[5],
    demandeur:'Antenne Bordeaux Est', emailDemandeur:'pres.bordeaux@pc.fr', dept:'33 - Gironde', niveau:'antenne',
    dateCreation:'2024-11-20', notifications:true, agrafe:false, paiement:null, expedition:null,
    justification:'30 ans de service. Engagement déterminant lors des inondations de la Garonne en 2009 et 2021.',
    dateReception:'2025-04-10',
    historique:[{ date:'2024-11-20', action:'Demande créée', auteur:'Président Antenne Bordeaux Est', comment:'' }] },
  { id:'REQ-2024-007', diplomeId:'FNPC-2024-006-0001', statut:'diplome_emis', benevole:MOCK_VOLUNTEERS[6], medalType:MEDAL_TYPES[6],
    demandeur:'Antenne Nice Centre', emailDemandeur:'pres.nice@pc.fr', dept:'06 - Alpes-Maritimes', niveau:'antenne',
    dateCreation:'2024-08-15', notifications:false, agrafe:false, paiement:null, expedition:null,
    justification:'40 ans de service. Fondatrice de 3 antennes. Formation de centaines de bénévoles.',
    dateReception:'2024-10-20',
    historique:[
      { date:'2024-08-15', action:'Demande créée', auteur:'Président Antenne Nice Centre', comment:'' },
      { date:'2024-09-01', action:'Validé par APC', auteur:'Président APC 06', comment:'Dossier exceptionnel.' },
      { date:'2024-09-25', action:'Approuvé par Commission FNPC', auteur:'Commission FNPC', comment:'La plus haute distinction méritée.' },
      { date:'2024-10-05', action:'Diplôme imprimé', auteur:'Gestion FNPC', comment:'' }] },
  { id:'REQ-2024-008', diplomeId:null, statut:'valide_federation', benevole:MOCK_VOLUNTEERS[0], medalType:MEDAL_TYPES[0],
    demandeur:'Antenne Paris 12e', emailDemandeur:'pres.paris12@pc.fr', dept:'75 - Paris Seine', niveau:'antenne',
    dateCreation:'2024-11-01', notifications:true, agrafe:false, paiement:'en_attente', expedition:null,
    justification:'2 ans d\'engagement exemplaire.',
    dateReception:'2025-01-30',
    historique:[
      { date:'2024-11-01', action:'Demande créée', auteur:"Président Antenne Paris 12e", comment:'' },
      { date:'2024-11-10', action:'Validé par APC', auteur:'Président APC Paris', comment:'' },
      { date:'2024-11-20', action:'Approuvé par Commission FNPC', auteur:'Commission FNPC', comment:'' }] },
  { id:'REQ-2024-009', diplomeId:'FNPC-2024-075-0001', statut:'diplome_emis', benevole:MOCK_VOLUNTEERS[8], medalType:MEDAL_TYPES[4],
    demandeur:'Antenne Paris 12e', emailDemandeur:'pres.paris12@pc.fr', dept:'75 - Paris Seine', niveau:'antenne',
    dateCreation:'2024-07-01', notifications:true, agrafe:false, paiement:null, expedition:null,
    justification:'20 ans de service, formatrice et coordinatrice hors pair.',
    dateReception:'2024-09-10',
    historique:[
      { date:'2024-07-01', action:'Demande créée', auteur:"Président Antenne Paris 12e", comment:'' },
      { date:'2024-07-20', action:'Validé par APC', auteur:'Président APC Paris', comment:'' },
      { date:'2024-08-10', action:'Approuvé par Commission FNPC', auteur:'Commission FNPC', comment:'' },
      { date:'2024-08-25', action:'Diplôme imprimé', auteur:'Gestion FNPC', comment:'' }] },
];

const DEFAULT_EMAIL_TEMPLATES = {
  soumission:          { sujet:'[FNPC] Demande de distinction soumise — {prenom} {nom}',              corps:'Bonjour,\n\nVotre demande de {distinction} pour {prenom} {nom} a bien été soumise le {date}.\n\nVous serez notifié(e) à chaque étape de validation.\n\nCordialement,\nFédération Nationale de la Protection Civile' },
  validation_apc:      { sujet:'[FNPC] Demande validée par votre APC — {prenom} {nom}',               corps:'Bonjour,\n\nLa demande de {distinction} pour {prenom} {nom} a été validée par votre APC le {date}. Elle est transmise à la Commission FNPC.\n\nCordialement,\nFédération Nationale de la Protection Civile' },
  validation_commission:{ sujet:'[FNPC] Demande approuvée par la Commission FNPC — {prenom} {nom}',   corps:'Bonjour,\n\nLa demande de {distinction} pour {prenom} {nom} a été approuvée par la Commission FNPC le {date}. Le diplôme sera prochainement imprimé.\n\nCordialement,\nFédération Nationale de la Protection Civile' },
  refus_apc:           { sujet:'[FNPC] Demande refusée par votre APC — {prenom} {nom}',               corps:'Bonjour,\n\nLa demande de {distinction} pour {prenom} {nom} a été refusée par votre APC le {date}.\n\nMotif : {motif}\n\nVous pouvez resoumettre le dossier corrigé.\n\nCordialement,\nFédération Nationale de la Protection Civile' },
  diplome_emis:        { sujet:'[FNPC] Diplôme émis — {prenom} {nom}',                                corps:'Bonjour,\n\nLe diplôme N° {numero} pour {prenom} {nom} ({distinction}) a été émis le {date}.\n{temoignagePaiement}\n\nCordialement,\nFédération Nationale de la Protection Civile' },
  expedition:          { sujet:'[FNPC] Diplôme expédié — {prenom} {nom}',                             corps:'Bonjour,\n\nLe diplôme de {prenom} {nom} ({distinction}) a été expédié le {date} à l\'adresse de votre APC.\n\nCordialement,\nFédération Nationale de la Protection Civile' },
  paiement_temoignage: { sujet:'[FNPC] Paiement témoignage reçu — {prenom} {nom}',                    corps:'Bonjour,\n\nLe paiement de {tarif}€ pour le témoignage de {prenom} {nom} a bien été reçu le {date}.\n\nCordialement,\nFédération Nationale de la Protection Civile' },
};

// ─── GABARITS DIPLÔMES (positions calibrables) ──────────────────────────────────
// Positions en % de la page A4 paysage. Fonds dans public/diplomas/<gabarit>-complet.jpg
const DEFAULT_DIPLOMA_TEMPLATES = {
  medaille:  { label:'Médaille (Bronze/Argent/Vermeil/Grand Or)', hasComplet:true, fields:{
    niveau:{x:52.7,y:53.2,w:25.4,size:24,color:'#E8771F',align:'left'},
    nom:{x:0,y:60.4,w:100,size:24,color:'#111111',align:'center'},
    date:{x:26.4,y:82.6,w:18,size:14,color:'#111111',align:'left'},
    numero:{x:34.6,y:94.3,w:24,size:12,color:'#111111',align:'left'} } },
  gm_argent: { label:'Grande Médaille — Échelon Argent', hasComplet:true, fields:{
    nom:{x:0,y:57.86,w:100,size:24,color:'#111111',align:'center'},
    date:{x:22.36,y:80.14,w:16,size:16,color:'#111111',align:'left'},
    numero:{x:29.23,y:90.24,w:24,size:12,color:'#111111',align:'left'} } },
  gm_or:     { label:'Grande Médaille — Échelon Or', hasComplet:true, fields:{
    nom:{x:0,y:57.86,w:100,size:24,color:'#111111',align:'center'},
    date:{x:22.35,y:80.12,w:16,size:16,color:'#111111',align:'left'},
    numero:{x:29.21,y:90.25,w:24,size:12,color:'#111111',align:'left'} } },
  temoignage:{ label:'Témoignage de Reconnaissance', hasComplet:true, fields:{
    nom:{x:0,y:50.5,w:100,size:24,color:'#111111',align:'center'},
    date:{x:22.46,y:80.13,w:16,size:16,color:'#111111',align:'left'},
    numero:{x:28.98,y:90.24,w:24,size:12,color:'#111111',align:'left'} } },
  agrafe:    { label:'Agrafe', hasComplet:true, fields:{
    niveau:{x:50.91,y:50,w:24.65,size:24,color:'#E8771F',align:'left'},
    nom:{x:0,y:57.86,w:100,size:24,color:'#111111',align:'center'},
    date:{x:21.32,y:81.43,w:16,size:16,color:'#111111',align:'left'},
    numero:{x:28.98,y:92.19,w:24,size:12,color:'#111111',align:'left'},
    agrafe:{x:30.45,y:65.86,w:39,size:24,color:'#E8771F',align:'left'} } },
};
const DIPLOMA_FIELD_LABELS = { niveau:'Échelon', nom:'Prénom + Nom', date:'Date', numero:'Numéro', agrafe:'Agrafe' };
const MEDAL_TO_GABARIT = { temoignage:'temoignage', bronze:'medaille', argent:'medaille', vermeil:'medaille', grand_or:'medaille', gm_argent:'gm_argent', gm_or:'gm_or' };
const DIPLOMA_SAMPLE = { niveau:'Bronze', nom:'Marie DUPONT', date:'12 juin 2026', numero:'FNPC-2026-075-0001', agrafe:'Agrafe Or' };

// ─── ONBOARDING (visite guidée première connexion) ─────────────────────────────
const TOUR_STEPS = {
  antenne: [
    { icon:'👋', title:"Bienvenue sur l'Appli Médaille FNPC", body:"En tant qu'Antenne, vous proposez vos bénévoles aux distinctions et suivez chaque dossier. Voici l'essentiel en quelques étapes." },
    { icon:'✚', title:'Créer une demande', body:"Cliquez sur « Nouvelle demande » (icône ✚) dans le menu de gauche : choisissez le bénévole, la distinction, et saisissez les motivations (50 caractères minimum)." },
    { icon:'📋', title:'Suivre vos demandes', body:"Le menu « Demandes » liste tous vos dossiers. Chaque demande avance par statuts : Brouillon → Soumis Antenne → Soumis APC → Commission → Diplôme." },
    { icon:'📥', title:'Le circuit de validation', body:"Vos demandes sont validées d'abord par votre APC, puis par la Commission FNPC. Une notification vous informe à chaque étape." },
    { icon:'✅', title:"C'est parti !", body:"Vous pourrez rouvrir cette visite à tout moment grâce au bouton « ? » en haut à droite." },
  ],
  departement: [
    { icon:'👋', title:"Bienvenue sur l'Appli Médaille FNPC", body:"En tant que Président d'APC, vous validez les demandes de vos antennes, créez vos propres demandes et les transmettez à la Commission FNPC." },
    { icon:'📥', title:'Valider les demandes des antennes', body:"Dans le Tableau de bord, l'onglet « Soumises APC » regroupe les demandes de vos antennes : vous pouvez les valider ou les refuser." },
    { icon:'✚', title:'Créer une demande', body:"Le menu « Nouvelle demande » (✚) vous permet de créer un dossier ; en tant qu'APC il part directement en Commission FNPC." },
    { icon:'📦', title:'Envoyer en Commission', body:"L'onglet « Prêts à envoyer » rassemble vos dossiers validés pour un envoi groupé vers la Commission FNPC." },
    { icon:'✅', title:"C'est parti !", body:"Vous pourrez rouvrir cette visite à tout moment grâce au bouton « ? » en haut à droite." },
  ],
};

// Préambule pré-rempli par défaut pour une nouvelle agrafe (modifiable)
const DEFAULT_AGRAFE_TEXTE = `Les dernières années ont été marquées par un engagement inédit et exemplaire des bénévoles dans la crise sanitaire, dans la crise ukrainienne, puis dans le déploiement de détachements à Mayotte et à la Réunion.
Pour mettre à l'honneur et en valeur cet engagement sans faille, la FNPC a décidé de réaliser une remise de distinctions honorifiques sous la forme d'une promotion spéciale de la médaille fédérale.
Celle-ci met à l'honneur les femmes et hommes qui ont pleinement œuvré dans les crises que la Protection Civile a su relever en confirmant sa place de première association agréée de sécurité civile de France.`;

const DEFAULT_LIST_INTRO = "Sur proposition des Présidents d'APC et Administrateurs fédéraux, et après étude des dossiers par la commission honneurs et récompenses de la Fédération Nationale de Protection Civile, le Président a l'honneur de promouvoir les personnes suivantes :";

// Modèle du document Word « Liste des récipiendaires » — éditable et persisté (app_config: word_template)
const DEFAULT_WORD_CFG = {
  titre: 'Liste des récipiendaires',
  intro: DEFAULT_LIST_INTRO,
  preambule: DEFAULT_AGRAFE_TEXTE,
  president: '',
};
const DIPLOMA_PAGE_W = 900; // largeur px de l'aperçu éditeur (A4 paysage)
const ptToPx = (pt, w=DIPLOMA_PAGE_W) => pt * w / 841.68;
const FONT_OPTIONS = ['Arial','Helvetica','Times New Roman','Georgia','Garamond','Verdana','Trebuchet MS','Calibri','Courier New','Playfair Display'];

// ─── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Source+Sans+3:wght@400;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Source Sans 3',sans-serif;font-size:17px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;cursor:pointer;transition:all 0.15s;color:#94a3b8;font-size:16px;margin-bottom:3px;border-left:3px solid transparent}
.nav-item:hover{background:rgba(255,255,255,0.08);color:#e2e8f0}
.nav-item.active{background:rgba(232,119,34,0.18);color:#E87722;border-left-color:#E87722}
.badge{display:inline-flex;align-items:center;justify-content:center;padding:2px 9px;border-radius:20px;font-size:15px;font-weight:700}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:7px;border:none;cursor:pointer;font-size:16px;font-family:'Source Sans 3',sans-serif;transition:all 0.18s;font-weight:600;white-space:nowrap}
.btn:hover{opacity:0.88;transform:translateY(-1px)}
.btn:disabled{opacity:0.45;cursor:not-allowed;transform:none}
.btn-primary{background:#1B3764;color:white}
.btn-orange{background:#E87722;color:white}
.btn-success{background:#059669;color:white}
.btn-danger{background:#dc2626;color:white}
.btn-purple{background:#7c3aed;color:white}
.btn-outline{background:transparent;border:1px solid #d1d5db;color:#374151}
.btn-outline:hover{background:#f9fafb}
.btn-sm{padding:5px 11px;font-size:15px}
.card{background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.07);padding:20px}
.req-row{display:grid;grid-template-columns:128px 1fr 1fr 1fr 156px 72px 36px;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;cursor:pointer;transition:all 0.13s;border:1px solid transparent}
.req-row:hover{background:#fff8f3;border-color:#fbd5b0}
.req-row.delayed{border-left:3px solid #ef4444}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px}
.modal{background:white;border-radius:16px;padding:26px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto}
.tl-item{display:flex;gap:12px;padding-bottom:18px;position:relative}
.tl-item::before{content:'';position:absolute;left:13px;top:28px;bottom:0;width:2px;background:#e5e7eb}
.tl-item:last-child::before{display:none}
.tl-dot{width:28px;height:28px;border-radius:50%;background:#1B3764;color:white;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;z-index:1}
.pip-step{flex:1;text-align:center;padding:12px 6px;border-radius:10px;cursor:pointer;transition:all 0.15s}
.pip-step:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.08)}
.select{padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-family:'Source Sans 3',sans-serif;font-size:16px;background:white;width:100%}
.input{padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-family:'Source Sans 3',sans-serif;font-size:16px;width:100%}
.textarea{padding:9px 10px;border:1px solid #d1d5db;border-radius:7px;font-family:'Source Sans 3',sans-serif;font-size:16px;width:100%;resize:vertical}
.input:focus,.select:focus,.textarea:focus{outline:none;border-color:#E87722;box-shadow:0 0 0 2px rgba(232,119,34,0.15)}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:9px;color:white;font-weight:700;z-index:300;animation:su 0.3s ease;font-family:'Source Sans 3',sans-serif;font-size:17px;box-shadow:0 4px 20px rgba(0,0,0,0.2);display:flex;align-items:center;gap:8px}
@keyframes su{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
.stat-card{background:white;border-radius:10px;padding:10px 14px;border-left:4px solid var(--ac);box-shadow:0 1px 3px rgba(0,0,0,0.07);display:flex;align-items:center;gap:10px}
.fl{font-size:16px;color:#374151;font-weight:700;display:block;margin-bottom:5px}
.fh{font-size:14px;color:#94a3b8;margin-top:3px}
.fg{margin-bottom:12px}
.st{font-family:'Playfair Display',serif;color:#1B3764;font-size:18px;font-weight:600;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #FEE8D6}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.il{font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:2px}
.iv{font-weight:600;color:#1B3764;font-size:17px}
.dept-header{display:flex;align-items:center;gap:12px;padding:11px 16px;background:linear-gradient(135deg,#1B3764,#2a4f8a);color:white;border-radius:10px;margin:18px 0 10px;font-family:'Playfair Display',serif;font-size:17px;font-weight:600}
.side-label{font-size:14px;color:#64748b;padding:2px 0}
.side-stat{font-size:15px;color:#94a3b8;flex:1}
.badge-alert{background:#ef4444;color:white;border-radius:10px;padding:1px 6px;font-size:12px;font-weight:800}
.alert-bar{background:#FFF4E8;border:2px solid #E87722;border-radius:10px;padding:12px 16px;margin-bottom:18px;display:flex;gap:10px;align-items:center}
.tab{padding:7px 16px;border-radius:20px;cursor:pointer;font-size:15px;font-weight:600;transition:all 0.15s;border:1px solid #e5e7eb;background:white;color:#64748b}
.tab.active{background:#1B3764;color:white;border-color:#1B3764}
.checkbox-row{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;cursor:pointer;transition:background 0.1s}
.checkbox-row:hover{background:#f8faff}
input[type=checkbox]{width:16px;height:16px;accent-color:#E87722;cursor:pointer}
/* Diplôme : aperçu réduit + impression A4 paysage */
.diploma-print{width:696px;height:492px;position:relative;overflow:hidden;max-width:100%}
.diploma-scale{position:absolute;top:0;left:0;transform:scale(0.6203);transform-origin:top left}
.diploma-canvas{box-shadow:0 6px 24px rgba(0,0,0,.18)}
@page diploma{size:A4 landscape;margin:0}
@media print{
  body.diploma-printing *{visibility:hidden !important}
  body.diploma-printing .diploma-print, body.diploma-printing .diploma-print *{visibility:visible !important}
  body.diploma-printing .diploma-print{position:fixed;left:0;top:0;width:auto;height:auto;overflow:visible;page:diploma}
  body.diploma-printing .diploma-scale{position:static;transform:none}
  body.diploma-printing .diploma-canvas{box-shadow:none}
  body.diploma-printing .no-print{display:none !important}
}
`;

// ─── LOGO FNPC ────────────────────────────────────────────────────────────────

const LOGO_SRC = "data:image/png;base64,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KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+KdsP63bl+zU/mfinbD+t25fs1P5rHh80xf5+XsfL8N+CuH4p2w/rduX7NT+Z+KdsP63bl+zU/mseHzTF/n5ex8vw34K4finbD+t25fs1P5n4p2w/rduX7NT+ax4fNMX+fl7Hy/Dfgrh+K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";
const FAV_SRC = "data:image/x-icon;base64,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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADyP5wY9kOhKPY/nmD2Q59w9kOf8PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf8PZDn3j2Q55w8j+dMPI/nCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9kOgWPZDngj2P5+Y9kOf/PZDn/z2Q5/89kOf/PZDo/z2Q5/89kOf/PZDn/z2Q5/89j+f/PZDn/z2Q5/89kOf/PZDn/z2Q6P89j+j/PZDn6D2P54Y9kOcaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPZDnDD2Q6II9kOjyPZDn/z2Q5/89j+f/PZDo/z2Q5/89j+f/PZDn/z2Q5/89j+f/PZDn/z2Q5/89j+f/PZDn/z2Q5/89kOf/PZDn/z2Q5/89j+f/PZDn/z2Q5/89j+f0PZDniD2Q6A4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9kOdCPZDn3D2Q5/89j+f/PY/n/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDn/z2Q5/89j+f/PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDn/z2P5/89kOf/PZDn/z2Q5+I9kOdIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPJDoAj2Q54A9kOf8PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDn/z2Q5/89kOf/PZDo/z2Q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";
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
        if (dipTpl_cfg) setDiplomaTpl({ ...DEFAULT_DIPLOMA_TEMPLATES, ...dipTpl_cfg });
        const wordCfg_cfg = await db.loadConfig('word_template');
        if (wordCfg_cfg) setWordCfg({ ...DEFAULT_WORD_CFG, ...wordCfg_cfg });
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
  const [requests, setRequests]   = useState(INITIAL_REQUESTS);
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
  const [impMode, setImpMode] = useState('template');
  const [impDept, setImpDept] = useState('all');
  const [csvPreview, setCsvPreview] = useState([]);
  const [csvDone, setCsvDone] = useState(false);
  const csvRef = useRef();
  const [emKey, setEmKey] = useState('soumission');
  const [emSujet, setEmSujet] = useState(DEFAULT_EMAIL_TEMPLATES.soumission.sujet);
  const [emCorps, setEmCorps] = useState(DEFAULT_EMAIL_TEMPLATES.soumission.corps);
  const [paramT, setParamT] = useState(2);
  const [paramWmA, setParamWmA] = useState('');
  const [paramWmD, setParamWmD] = useState('');
  const [paramAgrNom, setParamAgrNom] = useState('');
  const [paramAgrTexte, setParamAgrTexte] = useState(DEFAULT_AGRAFE_TEXTE);
  const [tourStep, setTourStep] = useState(null); // null = visite fermée ; sinon index d'étape
  const [wordCfg, setWordCfg] = useState(DEFAULT_WORD_CFG);
  const [paramAgrDepts, setParamAgrDepts] = useState([]);
  const [agrEditId, setAgrEditId] = useState(null);
  const [agrEditDepts, setAgrEditDepts] = useState([]);
  const [agrEditNom, setAgrEditNom] = useState('');
  const [agrEditTexte, setAgrEditTexte] = useState('');
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
  useEffect(() => { const t = emailTemplates[emKey]; if(t){ setEmSujet(t.sujet); setEmCorps(t.corps); } }, [emKey]);
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
        body: JSON.stringify({ to: emailModal.destinataire, subject: emailModal.sujet, body: emailModal.corps }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setEmailSendState('sent');
    } catch (e) {
      setEmailSendState('error'); setEmailSendErr(e.message);
    }
  };
  useEffect(() => {
    if (page === 'adresse') {
      const dept = ROLES[role]?.dept || '75 - Paris Seine';
      const d = deptAddresses[dept] || {};
      setAdrNom(d.nom||''); setAdrAdresse(d.adresse||''); setAdrCp(d.cp||''); setAdrVille(d.ville||''); setAdrEmail(d.email||''); setAdrPsClientId(d.psClientId||'');
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
      const user = CONNECTED_USERS[role];
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

  const lockedDept = (role === 'antenne') ? '75 - Paris Seine' : (role === 'departement') ? '75 - Paris Seine' : null;

  const allForRole = useMemo(() => {
    if (role === 'antenne') return requests.filter(r => r.dept === '75 - Paris Seine' && (r.demandeur.includes('Paris 12') || r.niveau === 'antenne'));
    if (role === 'departement') return requests.filter(r => r.dept === '75 - Paris Seine');
    if (role === 'commission') return requests.filter(r => ['en_commission','valide_federation','refuse_federation'].includes(r.statut));
    return requests;
  }, [requests, role]);

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

  const myDeptRequests = requests.filter(r => r.dept === (lockedDept || '75 - Paris Seine'));
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
    const batch = requests.filter(r => r.statut === 'pret_commission' && r.dept === (lockedDept || '75 - Paris Seine'));
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
        const apcEmail = apcAddr?.email || CONNECTED_USERS['departement']?.email;
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
        titre: wordCfg.titre || 'Liste des récipiendaires',
        nom: ag.nom || '',
        preambule: preamble.split(/\n+/).map(s => s.trim()).filter(Boolean),
        intro: wordCfg.intro || DEFAULT_LIST_INTRO,
        groups: order.map(mid => ({
          medal: MEDAL_TYPES.find(x => x.id === mid)?.label || mid,
          people: groups[mid].map(r => {
            const civ = r.benevole.genre === 'F' ? 'Mme' : 'M';
            const dept = (r.dept || '').split(' - ')[1] || r.dept || '';
            return `${civ} ${r.benevole.nom} ${r.benevole.prenom}, bénévole de la Protection Civile de ${dept}`;
          }),
        })),
        president: (wordCfg.president || '').trim(),
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
            <button className="btn btn-sm" style={{ background:'#0ea5e9', color:'white', flexShrink:0 }} onClick={()=>{ const n=requests.filter(r=>r.statut==='pret_commission'&&r.dept===(lockedDept||'75 - Paris Seine')).length; confirm(`Envoyer ${n} dossier(s) en Commission`, `Transmettre ${n} dossier(s) à la Commission FNPC ? Cette action est définitive.`, sendBatchToCommission, false); }}>
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
          {!lockedDept && <div className="fg"><label className="fl">Association APC *</label><select className="select" value={nrDept} onChange={e=>setNrDept(e.target.value)}><option value="">— Département —</option>{DEPTS.map(d=><option key={d} value={d}>{d}</option>)}</select></div>}
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
    const dept = ROLES[role]?.dept || '75 - Paris Seine';
    const save = () => { setDeptAddresses(p=>({ ...p, [dept]:{ nom:adrNom, adresse:adrAdresse, cp:adrCp, ville:adrVille, email:adrEmail, psClientId:adrPsClientId } })); fire('Adresse enregistrée ✓'); };
    return (
      <div style={{ maxWidth:600 }}>
        <h1 style={H1}>Adresse de réception APC</h1>
        <p style={{ color:'#64748b', fontSize:13, marginBottom:18 }}>L'adresse saisie ici sera utilisée pour l'expédition de tous les diplômes de votre département.</p>
        <div className="card" style={{ marginBottom:14 }}>
          <div className="st">{dept}</div>
          <div className="fg"><label className="fl">Nom de l'association</label><input className="input" placeholder="APC Département XX" value={adrNom} onChange={e=>setAdrNom(e.target.value)}/></div>
          <div className="fg"><label className="fl">Adresse</label><input className="input" placeholder="N° rue, nom de la rue" value={adrAdresse} onChange={e=>setAdrAdresse(e.target.value)}/></div>
          <div className="g2">
            <div className="fg"><label className="fl">Code postal</label><input className="input" placeholder="75000" value={adrCp} onChange={e=>setAdrCp(e.target.value)}/></div>
            <div className="fg"><label className="fl">Ville</label><input className="input" placeholder="Paris" value={adrVille} onChange={e=>setAdrVille(e.target.value)}/></div>
          </div>
          <div className="fg"><label className="fl">Email APC <span style={{ color:'#94a3b8', fontSize:11 }}>(utilisé pour la recherche PrestaShop si pas d'ID client)</span></label><input className="input" type="email" placeholder="apc.dept@protection-civile.org" value={adrEmail} onChange={e=>setAdrEmail(e.target.value)}/></div>
          <div className="fg">
            <label className="fl">
              ID client PrestaShop{' '}
              <span style={{ color:'#94a3b8', fontSize:11 }}>(recommandé — remplace la recherche par email)</span>
            </label>
            <input className="input" placeholder="Ex : 42" value={adrPsClientId} onChange={e=>setAdrPsClientId(e.target.value.replace(/\D/g,''))}/>
            {adrPsClientId && <div style={{ fontSize:11, color:'#059669', marginTop:4 }}>✓ ID client #{adrPsClientId} — les commandes TDR utiliseront directement cet identifiant.</div>}
            {!adrPsClientId && <div style={{ fontSize:11, color:'#f59e0b', marginTop:4 }}>⚠️ Sans ID client, la recherche se fait par email (moins fiable).</div>}
          </div>
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
            <button className="btn btn-orange btn-sm" style={{ marginLeft:'auto' }} onClick={()=>window.print()}>🖨 Tout imprimer ({toPrint.length})</button>
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
          <div className="fg"><label className="fl">Corps du message</label><textarea className="textarea" rows={9} value={emCorps} onChange={e=>setEmCorps(e.target.value)}/></div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-orange" onClick={save}>💾 Enregistrer</button>
            <button className="btn btn-outline btn-sm" onClick={()=>{ const t=DEFAULT_EMAIL_TEMPLATES[emKey]; setEmSujet(t.sujet); setEmCorps(t.corps); }}>↺ Réinitialiser par défaut</button>
          </div>
          <div style={{ marginTop:16, border:'1px solid #e5e7eb', borderRadius:8, overflow:'hidden' }}>
            <div style={{ background:'#f8faff', padding:'8px 14px', fontSize:12, fontWeight:700, color:'#1B3764', borderBottom:'1px solid #e5e7eb' }}>👁 Aperçu (données d'exemple)</div>
            <div style={{ padding:'12px 14px' }}>
              <div style={{ fontSize:11, color:'#94a3b8' }}>Objet</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#1B3764', marginBottom:10 }}>{fill(emSujet)}</div>
              <div style={{ fontSize:11, color:'#94a3b8' }}>Message</div>
              <div style={{ whiteSpace:'pre-wrap', fontSize:13, color:'#374151', lineHeight:1.6 }}>{fill(emCorps)}</div>
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

  function AgrafesPage() {
    const startEdit = (ag) => { setAgrEditId(ag.id); setAgrEditDepts([...ag.depts]); setAgrEditNom(ag.nom||''); setAgrEditTexte(ag.texte||''); };
    const saveEdit = () => { setAgrafes(p=>p.map(a=>a.id!==agrEditId?a:{ ...a, nom:agrEditNom.trim()||a.nom, texte:agrEditTexte, depts:agrEditDepts })); setAgrEditId(null); fire('Agrafe mise à jour ✓'); };
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
            <button className="btn btn-outline btn-sm" onClick={()=>{ if(confirm('Réinitialiser le modèle Word par défaut ?')) setWordCfg(DEFAULT_WORD_CFG); }}>↺ Défaut</button>
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
    const myDept = lockedDept || '75 - Paris Seine';
    const tdrDept = requests.filter(r => r.dept === myDept && r.statut === 'valide_federation' && r.medalType.payant && r.paiement !== 'paye');
    const tdrPaid = requests.filter(r => r.dept === myDept && r.medalType.payant && r.paiement === 'paye');
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
    const user = CONNECTED_USERS[role];
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
          <button className="btn btn-outline btn-sm" onClick={()=>{ if(confirm('Réinitialiser ce gabarit aux positions par défaut ?')) setDiplomaTpl(p=>({ ...p, [calGabarit]:JSON.parse(JSON.stringify(DEFAULT_DIPLOMA_TEMPLATES[calGabarit])) })); }}>↺ Défaut</button>
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
            <div style={{ border:'1px solid #e5e7eb', borderRadius:8, padding:'14px 16px', whiteSpace:'pre-wrap', fontSize:13, color:'#374151', lineHeight:1.7 }}>{emailModal.corps}</div>
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


// Rendu d'un diplôme calibré (lecture seule) — A4 paysage à 96dpi (1122px)
function renderDiplomaCanvas(templates, gabarit, mode, values) {
  const W = 1122;
  const t = templates?.[gabarit];
  if (!t) return <div className="diploma-canvas" style={{ width:W, height:W*8.27/11.69, background:'#fff', display:'flex', alignItems:'center', justifyContent:'center', color:'#94a3b8' }}>Gabarit « {gabarit} » non défini</div>;
  const showBg = mode === 'complet' && t.hasComplet;
  return (
    <div className="diploma-canvas" style={{ position:'relative', width:W, height:W*8.27/11.69,
      background: showBg ? `#fff url(/diplomas/${gabarit}-complet.jpg) 0 0/100% 100% no-repeat` : '#fff' }}>
      {Object.entries(t.fields).map(([k,f]) => (
        <div key={k} style={{ position:'absolute', left:`${f.x}%`, top:`${f.y}%`, width:`${f.w}%`,
          fontSize:ptToPx(f.size, W), color:f.color, fontWeight:700, lineHeight:1, whiteSpace:'nowrap',
          display:'flex', justifyContent: f.align==='center' ? 'center' : 'flex-start',
          fontFamily:(f.font||'Arial')+', Helvetica, sans-serif' }}>
          {values[k] ?? ''}
        </div>
      ))}
    </div>
  );
}

function diplomaDateFr(req) {
  const h = req.historique?.find(x => /imprim|émis|emis/i.test(x.action || ''));
  const d = h?.date ? new Date(h.date) : new Date();
  try { return d.toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' }); }
  catch { return new Date().toLocaleDateString('fr-FR'); }
}

function DiplomaModal({ req, templates, agrafes, tarif, onClose }) {
  useEffect(() => { document.body.classList.add('diploma-printing'); return () => document.body.classList.remove('diploma-printing'); }, []);
  const printMode = req._printMode || 'full';
  const mode = printMode === 'template' ? 'preimprime' : 'complet';
  const gabarit = req._gabarit || MEDAL_TO_GABARIT[req.medalType.id] || 'medaille';
  const t = templates?.[gabarit];
  const agrafeNom = (req.agrafeDepts || []).map(id => (agrafes||[]).find(a => a.id === id)?.nom).filter(Boolean).join(', ');
  const values = {
    niveau: req.medalType.shortLabel || '',
    nom: `${req.benevole.prenom} ${req.benevole.nom}`,
    date: diplomaDateFr(req),
    numero: req.diplomeId || '—',
    agrafe: agrafeNom || '',
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div style={{ maxWidth:760, width:'100%', background:'white', borderRadius:16, overflow:'hidden', maxHeight:'92vh', display:'flex', flexDirection:'column' }} onClick={e=>e.stopPropagation()}>
        <div className="no-print" style={{ padding:'12px 18px', background:'#1B3764', display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:'2px solid #E87722' }}>
          <span style={{ color:'#E87722', fontFamily:'Playfair Display,serif', fontWeight:700, fontSize:14 }}>{mode==='complet'?'🎖 Diplôme complet':'📄 Pré-imprimé'} — {req.medalType.label}</span>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-orange btn-sm" onClick={()=>window.print()}>{mode==='complet'?'🖨 Imprimer / PDF':'🖨 Imprimer'}</button>
            <button onClick={onClose} style={{ background:'rgba(255,255,255,0.1)', border:'none', color:'white', cursor:'pointer', borderRadius:6, padding:'5px 10px', fontSize:12 }}>✕</button>
          </div>
        </div>
        <div style={{ padding:18, background:'#eef2f7', overflow:'auto' }}>
          <div className="diploma-print">
            <div className="diploma-scale">
              {renderDiplomaCanvas(templates, gabarit, mode, values)}
            </div>
          </div>
          {mode==='complet' && !t?.hasComplet && <p className="no-print" style={{ fontSize:12, color:'#b45309', marginTop:10 }}>⚠️ Ce gabarit n'a pas de fond « complet » — bascule en pré-imprimé.</p>}
          <p className="no-print" style={{ fontSize:11, color:'#94a3b8', marginTop:10 }}>Positions issues du Calibrage diplômes. {mode==='complet'?'« Imprimer / PDF » → choisis « Enregistrer en PDF » et orientation Paysage dans le dialogue.':'À imprimer sur le diplôme pré-imprimé (orientation Paysage).'}</p>
        </div>
      </div>
    </div>
  );
}
