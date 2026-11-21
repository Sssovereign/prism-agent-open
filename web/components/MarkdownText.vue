<script setup lang="ts">
import { defineComponent, h, type VNodeChild } from 'vue';
import { parseMarkdown, type MarkdownNode } from '../conversation/markdown';
import 'katex/dist/katex.min.css';
import CodeBlock from './CodeBlock.vue';
import MathSpan from './MathSpan.vue';
const props=defineProps<{text:string}>();
// 块E1：fence→CodeBlock（Mermaid/Shiki 分支内部判定），math→KaTeX 桥；其余走白名单原子标签。
function renderNode(node:MarkdownNode):VNodeChild {
 if(node.tag==='pre'){
  const codeNode=node.children?.find(child=>child.tag==='code');
  return h(CodeBlock,{code:(codeNode?.text??'').replace(/\n+$/,''),language:codeNode?.attrs?.['data-language']??''});
 }
 if(node.tag==='math')return h(MathSpan,{tex:node.text??'',display:false});
 if(node.tag==='math-block')return h(MathSpan,{tex:node.text??'',display:true});
 return node.tag?h(node.tag,node.attrs??{},node.text??node.children?.map(renderNode)):node.text??'';
}
const Body=defineComponent({setup:()=>()=>h('div',{class:'markdown-body'},parseMarkdown(props.text).map(renderNode))});
</script>
<template><div class="markdown-text"><Body /></div></template>
<style scoped>
/* ZCode message.tsx: ui-base/1.75, headings xl/lg/base, code ui-sm. */
.markdown-text{min-width:0;font-size:var(--conversation-font-size,14px);line-height:1.75;overflow-wrap:anywhere}
.markdown-text :deep(.markdown-body)>:first-child{margin-top:0}
.markdown-text :deep(.markdown-body)>:last-child{margin-bottom:0}
.markdown-text :deep(p){white-space:normal;margin:12px 0}
.markdown-text :deep(pre:not(.code-pre)){overflow:auto;max-width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:8px;background:var(--color-surface);white-space:pre;font:12px/1.5 var(--font-mono)}
.markdown-text :deep(code){font-family:var(--font-mono)}
.markdown-text :deep(:not(pre)>code){font-size:12px;margin:0 2px;padding:2px 6px;background:var(--color-surface);border-radius:6px}
.markdown-text :deep(table){display:block;overflow:auto;border-collapse:collapse;max-width:100%;margin:12px 0;font-size:inherit}
.markdown-text :deep(th),.markdown-text :deep(td){border:1px solid var(--border);padding:6px 12px;min-width:70px}
.markdown-text :deep(th){background:var(--color-surface);text-align:left;font-weight:500}
.markdown-text :deep(ul),.markdown-text :deep(ol){padding-left:24px;margin:12px 0}
.markdown-text :deep(li)>p{margin:4px 0}
.markdown-text :deep(ul){list-style:disc}.markdown-text :deep(ol){list-style:decimal}
.markdown-text :deep(blockquote){border-left:2px solid var(--border-hover);margin:12px 0;padding-left:16px;color:var(--fg-subtle)}
.markdown-text :deep(a){color:var(--color-icon-blue,var(--fg));text-decoration:underline;text-underline-offset:3px}
.markdown-text :deep(h1),.markdown-text :deep(h2),.markdown-text :deep(h3),.markdown-text :deep(h4),.markdown-text :deep(h5),.markdown-text :deep(h6){line-height:1.5;margin:24px 0 16px;font-weight:600}
.markdown-text :deep(h1){font-size:calc(var(--conversation-font-size,14px) + 4px)}
.markdown-text :deep(h2){font-size:calc(var(--conversation-font-size,14px) + 2px)}
.markdown-text :deep(h3),.markdown-text :deep(h4),.markdown-text :deep(h5),.markdown-text :deep(h6){font-size:var(--conversation-font-size,14px)}
.markdown-text :deep(h5){font-weight:500}.markdown-text :deep(h6){font-weight:400}
</style>
