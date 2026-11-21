export interface ScrollMetrics {scrollTop:number;scrollHeight:number;clientHeight:number}
export function atBottom(m:ScrollMetrics):boolean{const maxTop=Math.max(0,m.scrollHeight-m.clientHeight);return maxTop-Math.max(0,m.scrollTop)<=48;}
export function followingAfterScroll(following:boolean,m:ScrollMetrics,source:'user'|'layout'):boolean{return source==='user'?atBottom(m):following;}
export function prependTop(old:ScrollMetrics,newHeight:number):number{return Math.max(0,old.scrollTop+newHeight-old.scrollHeight);}
