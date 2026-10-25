import type { ReactNode } from 'react';

export function ComputerAutomationSection({title,helpKey,activeCount,pausedCount=0,historyCount,error,empty,children,history,information}: {
  title:string;helpKey:string;activeCount:number;pausedCount?:number;historyCount:number;
  error?:string|null;empty:string;children:ReactNode;history:ReactNode;information?:ReactNode;
}) {
  return <section data-help={helpKey} aria-label={title} style={{padding:'8px 18px',fontSize:12,borderBottom:'1px solid var(--color-border-hairline)'}}>
    <div style={{display:'flex',alignItems:'baseline',gap:12,flexWrap:'wrap'}}>
      <strong>{title}</strong>
      <span>{activeCount} active{pausedCount>0?` · ${pausedCount} paused`:''}</span>
    </div>
    {error&&<p role="alert">{error}</p>}
    {activeCount===0&&pausedCount===0&&<div style={{color:'var(--color-fg-muted)',marginTop:4}}>{empty}</div>}
    {children}
    {historyCount>0&&<details style={{marginTop:6}}>
      <summary style={{cursor:'pointer'}}>History ({historyCount})</summary>
      <p style={{margin:'6px 0',color:'var(--color-fg-muted)'}}>These items have stopped and cannot run.</p>
      {history}
    </details>}
    {information}
  </section>;
}
