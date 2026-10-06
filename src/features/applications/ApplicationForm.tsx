import { useState } from 'react';
import type { Application, Channel, Stage } from '../../domain/types';

type Props = { mode: 'create'|'edit'; initial?: Application; channels: Channel[]; onSubmit: (input: Record<string, unknown>) => Promise<void>; onCancel: ()=>void; submitting?: boolean };
const stages: {value: Stage; label:string}[] = [{value:'draft',label:'待投递'},{value:'submitted',label:'已投递'},{value:'assessment',label:'测评'},{value:'interview_1',label:'一面'},{value:'interview_2',label:'二面'},{value:'interview_3_plus',label:'后续面试'}];
export function ApplicationForm({mode,initial,channels,onSubmit,onCancel,submitting}: Props) {
 const [v,setV]=useState({company:initial?.company||'',role:initial?.role||'',city:initial?.city||'',channelId:initial?.channelId||'',jobUrl:initial?.jobUrl||'',appliedOn:initial?.appliedOn||'',currentStage:initial?.currentStage||'draft' as Stage,notes:initial?.notes||'',isStarred:initial?.isStarred||false}); const [error,setError]=useState('');
 const set=(k:string,x:string|boolean|undefined)=>setV(p=>({...p,[k]:x||''}));
 async function submit(e:React.FormEvent){e.preventDefault(); setError(''); if(!v.company.trim()||!v.role.trim()){setError('请填写公司和岗位');return} if(v.currentStage!=='draft'&&!v.appliedOn){setError('非待投递状态必须填写投递日期');return} if(v.jobUrl && !/^https?:\/\//i.test(v.jobUrl)){setError('招聘链接必须是 HTTP 或 HTTPS 地址');return} try{await onSubmit(mode==='create'?{...v,company:v.company.trim(),role:v.role.trim(),appliedOn:v.appliedOn||null}:{...v,id:initial?.id,expectedUpdatedAt:initial?.updatedAt});}catch(err){setError(err instanceof Error?err.message:'保存失败')}}
 return <form className="application-form" onSubmit={submit} aria-label={mode==='create'?'新增投递':'编辑投递'}>
 <div className="form-grid">{[['company','公司 *'],['role','岗位 *'],['city','城市'],['jobUrl','招聘链接']].map(([k,l])=><label key={k}>{l}<input value={(v[k as keyof typeof v] as string|undefined)||''} onChange={e=>set(k as string,e.target.value)} type={k==='jobUrl'?'url':'text'} /></label>)}
  <label>渠道<select value={v.channelId} onChange={e=>set('channelId',e.target.value)}><option value="">未填写</option>{channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
  <label>投递日期<input type="date" value={v.appliedOn} onChange={e=>set('appliedOn',e.target.value)} /></label>
  <label>当前阶段<select value={v.currentStage} onChange={e=>set('currentStage',e.target.value)}>{stages.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label></div>
  <label>备注<textarea value={v.notes} onChange={e=>set('notes',e.target.value)} rows={4}/></label><label className="checkbox-row"><input type="checkbox" checked={v.isStarred} onChange={e=>set('isStarred',e.target.checked)}/> 关注此投递</label>{error&&<p role="alert" className="form-error">{error}</p>}<div className="page-actions"><button type="button" className="button button--secondary" onClick={onCancel}>取消</button><button className="button button--primary" disabled={submitting}>{submitting?'保存中…':mode==='create'?'创建投递':'保存修改'}</button></div>
 </form>;
}
