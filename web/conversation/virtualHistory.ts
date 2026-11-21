export const MAX_MOUNTED_HISTORY=10;
export const ESTIMATED_TURN_HEIGHT=360;
export interface TurnMetric {id:string;height:number}
export interface TurnAnchor {id:string;offset:number;following:boolean}
/** Bounded history DOM, plus a separately pinned live tail. */
export function virtualTurnWindow(metrics:TurnMetric[],top:number,viewport:number,tailId?:string):Set<string>{
 let y=0,first=0;for(let i=0;i<metrics.length;i++){if(y+metrics[i]!.height>top){first=i;break;}y+=metrics[i]!.height;first=i;}
 const start=Math.max(0,first-2);let end=start,total=0;
 while(end<metrics.length&&end-start<MAX_MOUNTED_HISTORY&&(end<=first+2||total<viewport*2)){total+=metrics[end]!.height;end++;}
 const ids=new Set(metrics.slice(start,end).map(m=>m.id));if(tailId)ids.add(tailId);return ids;
}
export function anchorFor(metrics:TurnMetric[],top:number,following:boolean):TurnAnchor|undefined{
 let y=0;for(const metric of metrics){if(y+metric.height>top)return {id:metric.id,offset:top-y,following};y+=metric.height;}const last=metrics.at(-1);return last?{id:last.id,offset:Math.max(0,top-y+last.height),following}:undefined;
}
export function anchorTop(metrics:TurnMetric[],anchor:TurnAnchor):number|undefined{
 let y=0;for(const metric of metrics){if(metric.id===anchor.id)return y+Math.min(Math.max(0,anchor.offset),Math.max(0,metric.height-1));y+=metric.height;}return;
}
const heights=new Map<string,number>(),memories=new Map<string,TurnAnchor>();
export function measuredHeight(scope:string,id:string,width:number):number{return heights.get(`${scope}:${id}:${Math.round(width)}`)??ESTIMATED_TURN_HEIGHT;}
export function cacheHeight(scope:string,id:string,width:number,height:number):void{if(!Number.isFinite(height)||height<1)return;heights.set(`${scope}:${id}:${Math.round(width)}`,height);while(heights.size>5000)heights.delete(heights.keys().next().value!);}
export function saveReadingAnchor(scope:string,anchor:TurnAnchor):void{memories.delete(scope);memories.set(scope,anchor);while(memories.size>100)memories.delete(memories.keys().next().value!);}
export function readReadingAnchor(scope:string):TurnAnchor|undefined{return memories.get(scope);}
