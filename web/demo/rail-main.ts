// 会话消息轨复刻校准页：1:1 复刻 ZCode 桌面端截图（814×402 @2x = 407×201 CSS）。
// 仅用于开发验证（vite dev /demo/rail.html），不参与生产构建入口。
import { createApp, h } from 'vue';
import ConversationRail from '../components/ConversationRail.vue';
import type { RailItem } from '../components/ConversationRail.vue';

const q1 = '系统的上下文设置在哪里？参考zcode是怎么设置的?';
const items: RailItem[] = [
  {
    id: 't1',
    runId: 't1',
    queryText: q1,
    assistantTexts: [
      'ZCode 的「系统上下文」(指令文件) 分两层，\n我先看看你机器上实际的文件长什么样：\n\n两个标准位置都没有 AGENTS.md。让我搜一下系统上下文的标准位置和加载规则，再对照你项目的目录结构给出具体放法。',
    ],
    running: false,
  },
  { id: 't2', runId: 't2', queryText: '把系统上下文放到项目根目录的 AGENTS.md 里', assistantTexts: ['已写入 AGENTS.md，包含仓库结构与构建命令两节。'], running: false },
  { id: 't3', runId: 't3', queryText: '继续，把测试命令也补进去', assistantTexts: [], running: false },
  { id: 't4', runId: 't4', queryText: '继续', assistantTexts: ['测试命令已补充到 AGENTS.md 第三节。'], running: false },
  { id: 't5', runId: 't5', queryText: '运行一遍完整测试确认没有回归', assistantTexts: ['253 个用例全部通过。'], running: false },
  { id: 't6', runId: 't6', queryText: '继续', assistantTexts: [], running: false },
  { id: 't7', runId: 't7', queryText: '继续', assistantTexts: ['已汇总本轮改动，等待下一步指示。'], running: false },
  { id: 't8', runId: 't8', queryText: '先到这里，稍后继续', assistantTexts: [], running: false },
];

const terminalIcon = () => h('svg', { viewBox: '0 0 13 13', fill: 'none', 'aria-hidden': 'true' }, [
  h('rect', { x: '0.7', y: '0.7', width: '11.6', height: '11.6', rx: '2.9', stroke: 'currentColor', 'stroke-width': '1.4' }),
  h('path', { d: 'M3.6 4.4 5.6 6.5 3.6 8.6', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  h('path', { d: 'M6.9 8.9h2.7', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }),
]);

const app = createApp({
  render() {
    return h('div', { class: 'stage' }, [
      h('div', { class: 'win-edge' }),
      h('div', { class: 'pill' }, [h(terminalIcon), h('span', '已执行 7 命令')]),
      h(ConversationRail, { items, activeId: '', class: 'rail-demo' }),
      h('div', { class: 'status-clip' }, [
        h('div', { class: 'status-frag' }, [h(terminalIcon), h('span', '已执行 0 commands 添加 ModeBind')]),
      ]),
    ]);
  },
});
app.mount('#app');
