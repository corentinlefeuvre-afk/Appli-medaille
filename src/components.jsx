// ─── COMPOSANTS PARTAGÉS ──────────────────────────────────────────────────────
// Composants autonomes extraits d'App.jsx : garde-fou d'erreur, logo,
// en-tête et ligne d'une liste de demandes.

import React from "react";
import { LOGO_SRC } from './assets.js';
import { STATUSES, daysSince, recipientName } from './constants.js';

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

const Logo = ({ size = 40 }) => <img src={LOGO_SRC} width={size} height={size} alt="FNPC" style={{borderRadius:'50%'}} />;

function ReqHeader({ showAntenne = false }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns: showAntenne ? '128px 1fr 1fr 1fr 1fr 156px 72px 36px' : '128px 1fr 1fr 1fr 156px 72px 36px', gap:10, padding:'6px 14px', color:'#94a3b8', fontSize:10, letterSpacing:'0.7px', textTransform:'uppercase', borderBottom:'1px solid #f1f5f9', marginBottom:2 }}>
      <span>N° Demande</span><span>Récipiendaire</span>{showAntenne && <span>Antenne</span>}<span>Distinction</span><span>Département</span><span>Statut</span><span>Date</span><span/>
    </div>
  );
}

function ReqRow({ req, onSelect, showLate = true, showAntenne = false }) {
  const s = STATUSES[req.statut];
  const late = showLate && ['soumis','en_commission'].includes(req.statut) && daysSince(req.dateCreation)>30;
  return (
    <div className={`req-row ${late?'delayed':''}`} onClick={()=>onSelect(req)} style={showAntenne ? { gridTemplateColumns:'128px 1fr 1fr 1fr 1fr 156px 72px 36px' } : undefined}>
      <span style={{ fontFamily:'monospace', fontSize:10, color:'#64748b', fontWeight:700 }}>{req.id}</span>
      <div>
        <div style={{ fontWeight:700, color:'#1B3764', fontFamily:'Playfair Display,serif', fontSize:13 }}>{recipientName(req.benevole)}</div>
        <div style={{ fontSize:10, color:'#94a3b8', marginTop:1 }}>{req.benevole.antenne||req.demandeur}</div>
      </div>
      {showAntenne && <span style={{ fontSize:11, color:'#374151' }}>{req.benevole.antenne||'—'}</span>}
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

export { ErrorBoundary, Logo, ReqHeader, ReqRow };
