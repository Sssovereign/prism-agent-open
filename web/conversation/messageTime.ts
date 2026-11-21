/** Message times come from stored messages or public event timestamps; never invent missing dates. */
export function messageTime(value?:string,now=new Date()):{dateTime:string;label:string;full:string}|undefined{
 if(!value)return;const date=new Date(value);if(!Number.isFinite(date.getTime()))return;
 const sameDay=date.getFullYear()===now.getFullYear()&&date.getMonth()===now.getMonth()&&date.getDate()===now.getDate();
 const clock=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
 const day=new Intl.DateTimeFormat('zh-CN',{...(date.getFullYear()===now.getFullYear()?{}:{year:'numeric' as const}),month:'2-digit',day:'2-digit'}).format(date);
 const yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);const isYesterday=date.getFullYear()===yesterday.getFullYear()&&date.getMonth()===yesterday.getMonth()&&date.getDate()===yesterday.getDate();
 return {dateTime:date.toISOString(),label:sameDay?clock:isYesterday?`昨天 ${clock}`:`${day} ${clock}`,full:new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date)};
}
