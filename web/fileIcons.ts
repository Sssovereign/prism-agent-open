import iconNames from './fileIconNames.json';
import associations from './fileIconAssociations.json';
import { resolveIconName } from './vendor/zcode/fileDisplayHelpers';
const available=new Set(iconNames);
const extensions:Record<string,string>=associations.extensions,names:Record<string,string>=associations.names;
const languages:Record<string,string>={js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',mts:'typescript',cts:'typescript',tsx:'react_ts',jsx:'react',md:'markdown',markdown:'markdown',py:'python',rb:'ruby',rs:'rust',sh:'console',shell:'console',shellscript:'console',bash:'console',zsh:'console',shellsession:'console',bat:'console',batch:'console','c++':'cpp','c#':'csharp',cs:'csharp',jsonc:'json',json5:'json',yml:'yaml',text:'document',txt:'document',plain:'document',plaintext:'document',log:'document',output:'document',mermaid:'mermaid',mmd:'mermaid',dockerfile:'docker',vue:'vue',ps1:'powershell',kt:'kotlin'};
export function fileIconName(path:string):string{
 const leaf=path.replace(/\\/g,'/').split('/').at(-1)?.toLowerCase()??'';
 const upstream=resolveIconName(leaf);
 if(names[leaf])return names[leaf]!;
 // Prefer upstream config/stem aliases, then the full Material extension catalog.
 if(upstream!=='document'&&available.has(upstream)&&!leaf.endsWith(`.${upstream}`))return upstream;
 const parts=leaf.split('.');for(let i=1;i<parts.length;i++){const icon=extensions[parts.slice(i).join('.')];if(icon&&available.has(icon))return icon;}
 return available.has(upstream)?upstream:'document';
}
export function languageIconName(language:string):string{const lang=language.trim().toLowerCase();const candidate=languages[lang]??lang;return available.has(candidate)?candidate:fileIconName(`code.${lang||'txt'}`);}
export function fileIconUrl(name:string,light=false):string{const safe=available.has(name)?name:'document';const themed=light&&available.has(`${safe}_light`)?`${safe}_light`:safe;return `${import.meta.env.BASE_URL}material-icons/${themed}.svg`;}
