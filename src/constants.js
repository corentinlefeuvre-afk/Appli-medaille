// ─── CONSTANTES ─────────────────────────────────────────────────────────────────
// Données de référence (rôles, médailles, départements, gabarits, modèles…) et
// petits helpers purs, extraits de App.jsx. Aucune dépendance externe.


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

export {
  DEPTS, MEDAL_TYPES, STATUSES, ROLES, MOCK_VOLUNTEERS, today, daysSince, getDeptCode, generateDiplomaNumber, getNextMedalSuggestion, DEFAULT_EMAIL_TEMPLATES, DEFAULT_DIPLOMA_TEMPLATES, DIPLOMA_FIELD_LABELS, MEDAL_TO_GABARIT, DIPLOMA_SAMPLE, TOUR_STEPS, DEFAULT_AGRAFE_TEXTE, DEFAULT_LIST_INTRO, DEFAULT_WORD_CFG, DIPLOMA_PAGE_W, ptToPx, FONT_OPTIONS
};
