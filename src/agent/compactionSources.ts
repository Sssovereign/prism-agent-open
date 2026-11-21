export interface CompactEntry {id:string;type:string;message?:{role:string;content:unknown};summary?:string;firstKeptEntryId?:string|null;}
/** Cut only at complete user turns; assistant tool calls and tool results stay together. */
export function selectCompactionSources(branch:CompactEntry[], keepRecentTurns:number) {
    const lastCp=branch.map(e=>e.type).lastIndexOf('compaction');
    const prior=lastCp>=0?branch[lastCp]:undefined;
    const priorKept=prior?.firstKeptEntryId?branch.findIndex(e=>e.id===prior.firstKeptEntryId):-1;
    const visible=branch.filter((e,i)=>e.type==='message'&&e.message&&(lastCp<0||i>=lastCp||(priorKept>=0&&i>=priorKept)));
    const turns=visible.map((e,i)=>e.message?.role==='user'?i:-1).filter(i=>i>=0);
    if(turns.length<=keepRecentTurns) return null;
    let cut=turns[turns.length-keepRecentTurns]!;
    // Defensive closure for malformed transcripts: never retain a result without its call.
    const calls=new Map<string,number>();
    for(let i=0;i<visible.length;i++) {
        const m=visible[i]!.message as {role:string;content:unknown;toolCallId?:string};
        if(m.role==='assistant'&&Array.isArray(m.content)) for(const c of m.content) if(c?.type==='toolCall'&&typeof c.id==='string') calls.set(c.id,i);
        if(i>=cut&&m.role==='toolResult'&&m.toolCallId&&calls.has(m.toolCallId)) cut=Math.min(cut,calls.get(m.toolCallId)!);
    }
    const summarized=visible.slice(0,cut),kept=visible.slice(cut);
    if(!summarized.length||!kept.length)return null;
    const manifest={firstKeptEntryId:kept[0]!.id,summarizedIds:summarized.map(e=>e.id),keptIds:kept.map(e=>e.id),previousCheckpointEntryId:prior?.id??null};
    return {summarized,kept,previousSummary:prior?.summary,manifest};
}
