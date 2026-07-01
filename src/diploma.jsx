// ─── DIPLÔMES — RENDU & MODALE ───────────────────────────────────────────────
// Rendu calibré d'un diplôme (React + HTML autonome) et modale d'aperçu/impression.
// Extrait de App.jsx. Dépendances : ptToPx, MEDAL_TO_GABARIT (constantes).

import React, { useEffect } from "react";
import { ptToPx, MEDAL_TO_GABARIT, recipientName } from './constants.js';

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

// Génère le HTML autonome d'UNE page de diplôme calibrée (mêmes positions que renderDiplomaCanvas).
// Réutilisable pour l'impression groupée (fenêtre) et, plus tard, l'agent headless.
function diplomaPageHtml(templates, gabarit, mode, values) {
  const W = 1122;
  const esc = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  const t = templates?.[gabarit];
  if (!t) return `<div class="page"><div style="padding:40px;color:#999">Gabarit « ${esc(gabarit)} » non défini</div></div>`;
  const showBg = mode === 'complet' && t.hasComplet;
  const fields = Object.entries(t.fields).map(([k, f]) => {
    const justify = f.align === 'center' ? 'center' : 'flex-start';
    return `<div style="position:absolute;left:${f.x}%;top:${f.y}%;width:${f.w}%;font-size:${ptToPx(f.size, W)}px;color:${f.color};font-weight:700;line-height:1;white-space:nowrap;display:flex;justify-content:${justify};font-family:'${(f.font||'Arial')}',Helvetica,sans-serif">${esc(values[k])}</div>`;
  }).join('');
  const bg = showBg ? `background:#fff url(/diplomas/${gabarit}-complet.jpg) 0 0/100% 100% no-repeat;` : 'background:#fff;';
  return `<div class="page" style="${bg}">${fields}</div>`;
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
    nom: recipientName(req.benevole),
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

export { renderDiplomaCanvas, diplomaPageHtml, diplomaDateFr, DiplomaModal };
