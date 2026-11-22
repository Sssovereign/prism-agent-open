// 研究页导航增强演示页（vite dev /demo/research-rail.html，不参与生产构建入口）：
// 挂真实 ResearchPanel（含吸顶胶囊条、颜色深浅停留标识与 ResearchRail 导轨）+ 真实全局样式，
// 仅 window.fetch 打桩喂假数据；用于无后端环境预览与截图验收。
import { createApp, h } from 'vue';
import '../style.css';
import { applyLanguage } from '../ui/i18n/index';
import ResearchPanel from '../components/ResearchPanel.vue';

applyLanguage('zh');

const body = (lines: string[]) => lines.join('\n\n');
const claim = (key: string, text: string, sourceId: string, quote: string, respondsTo?: string[]) =>
  ({ key, text, evidence: [{ sourceId, quote }], ...(respondsTo ? { respondsTo } : {}) });

const view = (id: string, phaseTaskId: string, recordIds: string[]) => ({
  id, phaseTaskId, participantId: 'demo', role: 'pro', recordIds,
  hashes: Object.fromEntries(recordIds.map(r => [r, 'h'])), tools: ['research_read', 'research_search', 'web_search'],
  supplementThrough: 1, policyVersion: 'research-v1',
});

// speech：text 为多段字符串数组（body 负责拼接），第二参直接传数组。
const speech = (summary: string, lines: string[], claims: ReturnType<typeof claim>[]) => ({
  text: body(lines), summary, claims, limitations: [],
});

const phases = [
  {
    id: 'p1', label: 'pro', role: 'pro', ordinal: 0, phaseKey: 'opening_pro', roundNo: 0,
    status: 'succeeded', sealed: false, view: view('v1', 'p1', ['src1', 'src2']), model: { displayName: 'GLM-5.3' },
    activity: { tools: { research_read: 6, research_search: 2, web_search: 1 }, modelRequests: 14 }, rejections: { count: 0, last: null },
    output: speech(
      '内置浏览器面板方案以 guest 子窗口为底座，能复用同一进程的会话与权限体系；相比外挂 CLI 路线，交互闭环更短，且已有 R90 冒烟 11/11 的实证基础。',
      [
        '我方认为，网页交互能力应当以「内置浏览器面板」为核心路线推进。判断依据有三：其一，桌面壳已经完成同一 guest 子窗口面板化改造（frameless + setParentWindow + 贴矩形跟随），8/8 单测与冒烟全绿，说明技术底座是稳的；其二，面板与主进程共享会话与权限体系，登录态、下载、剪贴板都能走既有通道，不需要再造一套凭据同步；其三，从竞品调研看，DSH 的 sidebar-browser 面板证明了这一形态的产品可行性，而我们是少数有开源参照可以直接对齐的实现者。',
      ],
      [claim('c1', '面板化改造已通过 8/8 单测与 R90 冒烟 11/11 实证，技术底座稳定。', 'src1', '导航挂起 executeJavaScript→runActionScript、settled 撞 commit→独立定时器，两处修复后冒烟 11/11 全过。')],
    ),
  },
  {
    id: 'p2', label: 'con', role: 'con', ordinal: 1, phaseKey: 'opening_con', roundNo: 0,
    status: 'succeeded', sealed: false, view: view('v2', 'p2', ['src1', 'src2']), model: { displayName: 'GLM-5.3' },
    activity: { tools: { research_read: 5, research_search: 3 }, modelRequests: 12 }, rejections: { count: 0, last: null },
    output: speech(
      '面板方案的美观不该掩盖其工程成本：Windows 子窗口行为、Fake-IP 网络环境下的导航边界都尚未验证；外挂 CLI 路线虽然交互割裂，但能把不确定性隔离在主程序之外。',
      [
        '反方需要先拆掉对方论证中最脆弱的一环——「技术底座是稳的」。冒烟全绿是在 macOS 单平台、单窗口场景下取得的，Windows 的子窗口贴附与 Session0 诊断历史表明跨平台行为差异真实存在。其次，Fake-IP DNS 环境下联网抓取已经被守卫拒绝过，浏览器面板在真实用户网络环境里的表现仍是未知数。相比之下，外挂 CLI（browser-use sidecar 模式）把不确定性隔离在主程序之外，即使出问题也不拖累主流程。',
      ],
      [claim('c1', 'Windows 子窗口行为与 Fake-IP 网络边界未经真实环境验证，面板路线风险前置。', 'src1', '待验=真实应用内面板交互/Windows子窗口/Fake-IP场景。')],
    ),
  },
  {
    id: 'p3', label: 'pro', role: 'pro', ordinal: 2, phaseKey: 'round_1_pro', roundNo: 1,
    status: 'succeeded', sealed: false, view: view('v3', 'p3', ['src1', 'src2']), model: { displayName: 'GLM-5.3' },
    activity: { tools: { research_read: 4, web_fetch: 1 }, modelRequests: 11 }, rejections: { count: 1, last: { at: '2026-11-22T21:40:00Z', message: '引文定位失败，重试后通过' } },
    output: speech(
      '跨平台差异恰恰是面板路线先行的理由：问题集中在Electron既有能力域内，可复用目录选择竞态的三重加固经验；CLI 路线则会把同样的问题换成进程间协议重新发明一遍。',
      [
        '对方指出的两个风险都真实，但结论反了。Windows 子窗口与 Fake-IP 的问题不是面板路线独有的——任何承载网页交互的方案都要面对它们，CLI 方案只是把同一批问题换成了进程间协议的形态重新面对。而面板路线的问题全部落在 Electron 既有能力域内，目录选择竞态的三重加固已经给出了可复用的打法（一次性握手竞态→三重加固→含空票据表判定法）。当问题的解法有先例可循时，风险就不是理由。',
      ],
      [
        claim('c1', '面板路线的风险全部落在 Electron 既有能力域内，有目录选择竞态三重加固等先例打法可复用。', 'src1', 'Win「无法选文件夹」=一次性1s握手竞态永久禁用；a101f9b三重加固。'),
        claim('c2', 'CLI 路线把同一批跨平台问题换成进程间协议形态重新面对，并未消除风险。', 'src2', 'WorkBuddy=Python browser-use外挂sidecar，其进程桥接层承担了同等的平台差异成本。', ['p2:c1']),
      ],
    ),
  },
  {
    id: 'p4', label: 'con', role: 'con', ordinal: 3, phaseKey: 'round_1_con', roundNo: 1,
    status: 'succeeded', sealed: false, view: view('v4', 'p4', ['src1', 'src2']), model: { displayName: 'GLM-5.3' },
    activity: { tools: { research_read: 3, research_search: 2 }, modelRequests: 9 }, rejections: { count: 0, last: null },
    output: speech(
      '「有先例可循」不等于「成本可控」：面板化的每次回归都要走完整桌面验收，而 CLI 的失败半径只有一次会话；把高风险改动挡在主程序外，是弱网与旧机器用户的现实需要。',
      [
        '先例证明的是「问题可解」，没有证明「回归成本可接受」。面板改动位于桌面壳内核路径，每次回归都要走 asar 完整性 + mac 冒烟的发行验收——0.1.1-beta 的启动即死事故就是在这个路径上发生的。CLI sidecar 的失败半径只有一次会话重建，监督器自动重建就能自愈。对弱网与旧机器用户来说，主程序的稳定性比交互的美观优先级更高。',
      ],
      [claim('c1', '面板改动位于桌面壳内核路径，回归须走完整发行验收，事故半径大于 CLI 的会话级失败。', 'src1', '0.1.1-beta启动即死事故已收口：发行验收必须实际启动应用本体。')],
    ),
  },
  {
    id: 'p5', label: 'pro', role: 'pro', ordinal: 4, phaseKey: 'round_2_pro', roundNo: 2,
    status: 'succeeded', sealed: false, view: view('v5', 'p5', ['src1', 'src2']), model: { displayName: 'GLM-5.3' },
    activity: { tools: { research_read: 2 }, modelRequests: 7 }, rejections: { count: 0, last: null },
    output: speech(
      '事故半径的差异被夸大了：启动即死的根因是构建门禁而非面板代码本身，且发行门禁已固化；面板路线的长期收益是会话、权限、剪贴板三套体系的零重复，这是 CLI 无法给出的。',
      [
        '对方用一次构建事故给整条路线定罪，但 0.1.1-beta 的根因是「发行验收没有实际启动应用本体」，与面板代码无关——事后固化的构建门禁（asar 完整性 + mac 冒烟）针对的是流程而非组件。真正该比的是长期账：面板路线下，会话、权限、剪贴板三套体系全部复用，零重复维护；CLI 路线则要在 sidecar 里长期维护一份凭据同步与权限映射。一次性的验收成本换长期的体系零重复，这笔账是划算的。',
      ],
      [claim('c1', '启动即死根因是发行验收流程缺失而非面板代码，门禁固化后同类事故不可重复。', 'src1', '0.1.2从未公开不必重建；教训：发行验收必须实际启动应用本体。')],
    ),
  },
  {
    id: 'p6', label: 'con', role: 'con', ordinal: 5, phaseKey: 'round_2_con', roundNo: 2,
    status: 'running', sealed: false, view: null, model: { displayName: 'GLM-5.3' },
    activity: { tools: { research_read: 1 }, modelRequests: 3 }, rejections: { count: 0, last: null },
    output: null,
  },
  {
    id: 'p7', label: 'host', role: 'host', ordinal: 6, phaseKey: 'host', roundNo: 0,
    status: 'pending', sealed: false, view: null, model: undefined,
    activity: undefined, rejections: { count: 0, last: null },
    output: null,
  },
];

const record = (over: Record<string, unknown>) => ({
  id: 'r', kind: 'source', participantId: null, phaseTaskId: null, title: '资料', content: '', hash: 'h', url: null, truncated: false, published: true, ...over,
});

const records = [
  record({ id: 'src1', kind: 'source', title: '内置浏览器面板技术评估（R90/R91 冒烟与修复记录）', content: body([
    'R91 面板版：同一 guest 子窗口面板化（frameless + setParentWindow + 贴矩形跟随），8/8 单测 + 70 桌面测试 + 冒烟全绿。',
    '修复两处：导航挂起 executeJavaScript→runActionScript；settled 撞 commit→独立定时器。',
    '待验项：真实应用内面板交互 / Windows 子窗口 / Fake-IP 场景。',
  ]) }),
  record({ id: 'src2', kind: 'source', title: '各家 harness 浏览器路线调研（2026-11-20 本机 asar 实证）', content: body([
    'DSH：sidebar-browser 面板但纯用户侧不注册工具（开源可抄作业）、lease 票据闸门模式。',
    'Codex：插件 + node_repl，与 ZCode 同构，无本地面板。',
    'WorkBuddy：Python browser-use 外挂 sidecar。',
  ]) }),
  record({ id: 'sup1', kind: 'supplement', title: '用户补充：弱网与旧机器场景优先', content: '旧设备上主程序稳定性优先，任何会拖累主流程的方案都要求有会话级自愈兜底。' }),
  // 已发布的反方发言记录：让 output 主张的 respondsTo 定位（p2:c1）可解析、可点击跳转。
  record({ id: 'rec-p2', kind: 'statement', participantId: 'con-1', phaseTaskId: 'p2', title: '【反方】开题发言', content: JSON.stringify({ claims: [{ id: 'p2:c1', text: 'Windows 子窗口行为与 Fake-IP 网络边界未经真实环境验证，面板路线风险前置。', evidence: [] }] }) }),
];

const payload = { phases, records, report: null };

// 打桩：面板轮询 /api/v1/runs/:id/research，这里统一回同一份假数据（信封格式对齐 v1()）。
const envelope = JSON.stringify({ data: payload, requestId: 'demo' });
window.fetch = (async () => new Response(envelope, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

createApp({
  render() {
    return h('div', { class: 'demo-stage' }, [
      h('span', { class: 'demo-banner' }, '演示数据 · 真实组件'),
      h('section', { class: 'conversation-region' }, [
        h('div', { class: 'timeline-scroll' }, [
          h(ResearchPanel, {
            runId: 'demo', status: 'succeeded', mode: 'debate' as const, busy: false,
            objective: '棱镜的网页交互能力应当以内置浏览器面板还是外挂 CLI 方式承载？',
          }),
        ]),
      ]),
    ]);
  },
}).mount('#app');
