// 合成评价集（activation-01 §七）。只使用合成数据，不导入真实私人记忆。
//
// 结构：
//   corpus()            —— 合成正式记录全集（含 retracted / superseded，用于不可达验证）
//   baseScenarios()     —— 12 类基础记忆情景 × 3 种查询 = 36 个 explicit 用例
//   holdoutScenarios()  —— 15 个动态激活对照场景（保留测试集，调参不得接触）
//   tuningScenarios()   —— 调参场景（与 holdout 不同故事变体）
//
// 诚实性规则：expectedRelevant / forbidden / expect 在本文件中先于任何策略输出
// 固定；评估脚本不得修改。情景语义与 WhiteMoon Memory Plan 的跨端、纠正、撤回、
// 权限、来源、约定主题对齐。

export const EVAL_NOW = Date.parse('2026-10-31T12:00:00.000Z');
const DAY = 86_400_000;

export function daysAgoIso(days, offsetMinutes = 1) {
  return new Date(EVAL_NOW - days * DAY + offsetMinutes * 60_000).toISOString();
}

// —— 事件历史构造器 ——————————————————————————————————————————————
// rev / del: daysAgo 数组；internals: 内部查询事件条数；tools: 同源转发工具数。
// eventId 使用模块级单调计数：同一进程内跨场景全局唯一（合成事件日志允许
// 多场景拍平合并重放），且生成顺序确定 → 可重放。
let eventUid = 0;
export function eventHistory({
  spaceId, recordId, rev = [], del = [], internals = 0,
  confirms = 0, corrections = 0, tools = 1, sourceEventId = null, prefix = 'ev'
}) {
  const events = [];
  const next = () => `${prefix}-${spaceId}-${recordId}-${eventUid += 1}`;
  for (const d of rev) {
    const sid = sourceEventId ?? next();
    for (let t = 0; t < tools; t += 1) {
      events.push({
        eventId: t === 0 ? sid : `${sid}#tool${t}`,
        spaceId, recordId,
        recordRevision: 3,
        eventType: 'user_revisited',
        occurredAt: daysAgoIso(d),
        observedAt: daysAgoIso(d, 2),
        // 原始观测与每次转发都携带同一来源事件 id：跨工具重复投递只算一次强化。
        sourceEventId: sid,
        provenance: { channel: 'chat', tool: t === 0 ? 'primary' : `forward-${t}` },
        signalVersion: 1
      });
    }
  }
  for (const d of del) {
    events.push({
      eventId: next(), spaceId, recordId, recordRevision: 3,
      eventType: 'delivered_reference',
      occurredAt: daysAgoIso(d), observedAt: daysAgoIso(d, 2),
      sourceEventId: null,
      provenance: { channel: 'chat', tool: 'primary' }, signalVersion: 1
    });
  }
  for (let i = 0; i < internals; i += 1) {
    events.push({
      eventId: next(), spaceId, recordId, recordRevision: 3,
      eventType: i % 3 === 0 ? 'candidate_retrieved' : i % 3 === 1 ? 'selected_for_context' : 'generated_reference',
      occurredAt: daysAgoIso(1 + i * 0.2), observedAt: daysAgoIso(1 + i * 0.2, 2),
      sourceEventId: null,
      provenance: { channel: 'pipeline', tool: 'context-builder' }, signalVersion: 1
    });
  }
  for (let i = 0; i < confirms; i += 1) {
    events.push({
      eventId: next(), spaceId, recordId, recordRevision: 3,
      eventType: 'user_confirmed',
      occurredAt: daysAgoIso(2 + i), observedAt: daysAgoIso(2 + i, 2),
      sourceEventId: null,
      provenance: { channel: 'chat' },
      formalAuthorization: i === 0,   // 仅第一条走了正式授权路径
      signalVersion: 1
    });
  }
  for (let i = 0; i < corrections; i += 1) {
    events.push({
      eventId: next(), spaceId, recordId, recordRevision: 3,
      eventType: 'user_corrected',
      occurredAt: daysAgoIso(3 + i), observedAt: daysAgoIso(3 + i, 2),
      sourceEventId: null,
      provenance: { channel: 'chat' }, signalVersion: 1
    });
  }
  return events;
}

// —— 合成语料 ————————————————————————————————————————————————
// importance 是静态属性（high = 约定/关键事实），激活引擎只读。
export function corpus() {
  const personal = [
    { recordId: 'rec-movie-wandering', text: '2025年12月和用户一起看了电影《流浪地球3》，用户很喜欢特效场面', occurredAt: '2025-12-20T19:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-001' },
    { recordId: 'rec-allergy-peanut', text: '用户对花生严重过敏，外出就餐必须避免含花生的菜品', occurredAt: '2024-06-10T10:00:00.000Z', importance: 'high', sourceKind: 'chat', sourceId: 's-002' },
    { recordId: 'rec-commitment-erhai', text: '2023年4月和用户的约定：春天一起去洱海旅行，看一次日出', occurredAt: '2023-04-15T09:00:00.000Z', importance: 'high', sourceKind: 'chat', sourceId: 's-003' },
    { recordId: 'rec-umbrella', text: '用户在我这里借了一把黑色长柄伞，还没有还', occurredAt: '2026-10-30T15:00:00.000Z', importance: 'low', sourceKind: 'chat', sourceId: 's-004' },
    { recordId: 'rec-scifi-books', text: '用户喜欢科幻小说，尤其偏爱刘慈欣的《三体》系列', occurredAt: '2025-03-01T11:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-005' },
    { recordId: 'rec-mother-birthday', text: '用户的母亲生日是3月14日', occurredAt: '2024-02-20T12:00:00.000Z', importance: 'high', sourceKind: 'chat', sourceId: 's-006' },
    { recordId: 'rec-no-cilantro', text: '用户不吃香菜，点餐时需要主动提醒商家', occurredAt: '2024-08-11T12:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-007' },
    { recordId: 'rec-badminton', text: '用户每周三晚上打羽毛球，固定球友约在城南体育馆', occurredAt: '2025-09-03T13:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-008' },
    { recordId: 'rec-fishing-retracted', text: '用户喜欢周末去河边钓鱼', occurredAt: '2025-05-10T09:00:00.000Z', status: 'retracted', importance: 'normal', sourceKind: 'chat', sourceId: 's-009' },
    { recordId: 'rec-address-old', text: '用户的收货地址是上海市徐汇区中山南二路24号', occurredAt: '2024-01-05T10:00:00.000Z', status: 'superseded', importance: 'normal', sourceKind: 'chat', sourceId: 's-010' },
    { recordId: 'rec-address-new', text: '2026年2月起用户的收货地址变更为杭州市西湖区文三路100号', occurredAt: '2026-02-10T10:00:00.000Z', importance: 'normal', sourceKind: 'correction', sourceId: 's-011' },
    { recordId: 'rec-travel-yunnan', text: '计划明年春天去云南旅行，初步目的地是大理和丽江', occurredAt: '2026-09-15T14:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-012' },
    { recordId: 'rec-weather-smalltalk', text: '上周聊天时提到天气转凉，用户说早晚要加外套', occurredAt: '2026-10-24T18:00:00.000Z', importance: 'low', sourceKind: 'chat', sourceId: 's-013' },
    { recordId: 'rec-plant-watering', text: '用户托我每周帮绿萝浇水一次，从10月开始', occurredAt: '2026-10-05T09:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-014' },
    { recordId: 'rec-recipe-hotpot', text: '用户说周末想在家做火锅，还缺一个锅', occurredAt: '2026-10-28T11:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-015' },
    { recordId: 'rec-gym-runs', text: '用户周末经常去健身房跑步，雷打不动', occurredAt: '2026-09-14T08:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-016' },
    { recordId: 'rec-climb-a', text: '用户去年常去城南的攀岩馆攀岩', occurredAt: '2025-10-01T10:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-017' },
    { recordId: 'rec-climb-b', text: '用户今年常去城北的攀岩馆攀岩', occurredAt: '2025-10-01T10:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-018' },
    { recordId: 'rec-bike-riding', text: '用户周末喜欢骑车沿河兜风', occurredAt: '2026-05-15T09:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-019' },
    { recordId: 'rec-coffee-cafe', text: '用户去咖啡馆写东西放松', occurredAt: '2026-08-01T15:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-020' },
    { recordId: 'rec-shared-001', text: '用户的项目代号是白鹭，相关文档放在共享盘', occurredAt: '2026-07-01T10:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 's-021' }
  ].map((r) => ({ ...r, spaceId: 'personal', revision: 3 }));

  const work = [
    { recordId: 'rec-mk2-sensor', text: 'MK-II 原型的温度传感器型号是 HS-7，量程 -40 到 125 摄氏度', occurredAt: '2026-08-20T10:00:00.000Z', importance: 'normal', sourceKind: 'doc', sourceId: 'w-001' },
    { recordId: 'rec-friday-demo', text: '本周五前要把 MK-II 演示文稿初稿发给用户审阅', occurredAt: '2026-10-26T09:00:00.000Z', importance: 'high', sourceKind: 'chat', sourceId: 'w-002' },
    { recordId: 'rec-sprint-retro', text: '上次迭代复盘决定：发布节奏调整为双周一版', occurredAt: '2026-10-13T16:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 'w-003' },
    { recordId: 'rec-standup', text: '站会时间从每天上午九点调整为十点', occurredAt: '2026-10-20T09:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 'w-004' },
    { recordId: 'rec-shared-001', text: '用户的项目代号是白鹭，相关文档放在共享盘', occurredAt: '2026-07-01T10:00:00.000Z', importance: 'normal', sourceKind: 'chat', sourceId: 'w-005' }
  ].map((r) => ({ ...r, spaceId: 'work', revision: 3 }));

  return [...personal, ...work];
}

// —— 12 类基础情景（explicit，正确性路径） ————————————————
// 每个情景 3 种查询。expected/forbidden 是冻结答案。
export function baseScenarios() {
  return [
    {
      id: 'S01-critical-fact-allergy', spaceIds: ['personal'],
      queries: ['花生', '花生 过敏', '过敏'],
      expectedRelevant: ['rec-allergy-peanut'],
      forbidden: ['rec-fishing-retracted', 'rec-mk2-sensor', 'rec-friday-demo'],
      theme: '关键事实'
    },
    {
      id: 'S02-preference-scifi', spaceIds: ['personal'],
      queries: ['科幻小说', '刘慈欣 三体', '科幻'],
      expectedRelevant: ['rec-scifi-books'],
      forbidden: ['rec-fishing-retracted'],
      theme: '偏好'
    },
    {
      id: 'S03-commitment-active-work', spaceIds: ['work'],
      queries: ['演示文稿', 'MK-II 演示文稿', '初稿 审阅'],
      expectedRelevant: ['rec-friday-demo'],
      forbidden: ['rec-allergy-peanut', 'rec-commitment-erhai'],
      theme: '进行中约定（跨空间权限）'
    },
    {
      id: 'S04-correction-address', spaceIds: ['personal'],
      queries: ['收货地址', '杭州 地址', '文三路'],
      expectedRelevant: ['rec-address-new'],
      forbidden: ['rec-address-old'],
      theme: '纠正后新值'
    },
    {
      id: 'S05-retraction-unreachable', spaceIds: ['personal'],
      queries: ['钓鱼', '钓鱼 周末', '河边 钓鱼'],
      expectedRelevant: [],
      forbidden: ['rec-fishing-retracted'],
      expectNoMatch: true,
      theme: '撤回不可达'
    },
    {
      id: 'S06-id-lookup-sensor', spaceIds: ['work'],
      queries: ['HS-7', 'HS-7 传感器', '量程'],
      expectedRelevant: ['rec-mk2-sensor'],
      forbidden: ['rec-allergy-peanut'],
      theme: '稳定 id / 型号'
    },
    {
      id: 'S07-recent-object', spaceIds: ['personal'],
      queries: ['长柄伞', '借 伞', '伞'],
      expectedRelevant: ['rec-umbrella'],
      forbidden: ['rec-fishing-retracted'],
      theme: '新近事务'
    },
    {
      id: 'S08-birthday', spaceIds: ['personal'],
      queries: ['生日', '3月14日', '母亲 生日'],
      expectedRelevant: ['rec-mother-birthday'],
      forbidden: ['rec-fishing-retracted'],
      theme: '日期事实'
    },
    {
      id: 'S09-space-isolation', spaceIds: null, // 逐查询指定
      querySpecs: [
        { q: '羽毛球', spaceIds: ['personal'], expectedRelevant: ['rec-badminton'], forbidden: [] },
        { q: '羽毛球', spaceIds: ['work'], expectedRelevant: [], forbidden: ['rec-badminton'], expectNoMatch: true },
        { q: '过敏', spaceIds: ['work'], expectedRelevant: [], forbidden: ['rec-allergy-peanut'], expectNoMatch: true }
      ],
      theme: '空间隔离（权限）'
    },
    {
      id: 'S10-travel-disambiguation', spaceIds: ['personal'],
      querySpecs: [
        { q: '旅行', spaceIds: ['personal'], expectedRelevant: ['rec-commitment-erhai', 'rec-travel-yunnan'], forbidden: ['rec-fishing-retracted', 'rec-address-old'] },
        { q: '旅行 计划', spaceIds: ['personal'], expectedRelevant: ['rec-travel-yunnan'], forbidden: ['rec-fishing-retracted', 'rec-address-old'] },
        { q: '春天 旅行', spaceIds: ['personal'], expectedRelevant: ['rec-commitment-erhai', 'rec-travel-yunnan'], forbidden: ['rec-fishing-retracted', 'rec-address-old'] }
      ],
      theme: '多候选消歧'
    },
    {
      id: 'S11-work-retro', spaceIds: ['work'],
      queries: ['发布节奏', '复盘 发布', '双周'],
      expectedRelevant: ['rec-sprint-retro'],
      forbidden: ['rec-allergy-peanut'],
      theme: '团队决定'
    },
    {
      id: 'S12-plant-commitment', spaceIds: ['personal'],
      queries: ['绿萝', '浇水 绿萝', '浇水'],
      expectedRelevant: ['rec-plant-watering'],
      forbidden: ['rec-fishing-retracted'],
      theme: '周期性受托事项'
    }
  ];
}

// —— 动态保留测试集（holdout，15 个） ——————————————————————
// 每个场景：query/situation、eventHistory、evaluationTime、冻结 expect。
// expect 字段：
//   top1            该 record 必须排第一
//   order           期望的完整 recordId 顺序（前缀匹配）
//   inTop           { k, recordIds } —— 这些 record 必须在 top-k 内
//   absent          这些 record 不得出现在任何候选位
//   noMatch         候选必须为空
//   strategyExpect  { A0/A1/A2-H7/A2-H30/A3: 同上形状的覆盖断言 }
export function holdoutScenarios() {
  const at = EVAL_NOW;
  return [
    {
      id: 'D01-revisit-1', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '用户想再看一次流浪地球那样的电影',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-movie-wandering', rev: [3] }),
      expect: { top1: 'rec-movie-wandering' },
      note: '回忆 1 次：方向正确且不越界'
    },
    {
      id: 'D02-revisit-3', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '用户想再看一次流浪地球那样的电影',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-movie-wandering', rev: [3, 20, 40] }),
      expect: { top1: 'rec-movie-wandering', monotonic: 'D01' },
      note: '回忆 3 次：仍受上限约束'
    },
    {
      id: 'D03-revisit8-vs-recent-trivial', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '周末在家做什么吃的',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [2, 9, 16, 23, 30, 37, 44, 51] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-recipe-hotpot' })
      ],
      expect: { top1: 'rec-recipe-hotpot', absent: [] },
      note: '高频无关（健身房，coverage 低）不得挤掉真正相关（火锅，coverage 高）；任务书失败模式 3'
    },
    {
      id: 'D04-high-freq-irrelevant-explicit', mode: 'explicit', spaceIds: ['personal'], at,
      query: '周末',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-recipe-hotpot', rev: [1, 6] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [10, 20, 30, 40, 50, 60, 70, 80] })
      ],
      expect: { top1: 'rec-recipe-hotpot' },
      note: 'explicit 内三条同含"周末"的候选（火锅计划 2 次重提 / 健身房 8 次重提但更旧 / 骑车零重提）：8 次重提的更旧记录不得挤掉真正被问的当前计划；任务书失败模式 3'
    },
    {
      id: 'D05-old-commitment-reachable', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '有没有还没完成的旅行约定',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }),
      expect: {
        top1: 'rec-commitment-erhai',
        strategyExpect: {
          'A2-H7': { inCandidates: ['rec-commitment-erhai'] },
          'A2-H30': { inCandidates: ['rec-commitment-erhai'] },
          A3: { inCandidates: ['rec-commitment-erhai'] }
        }
      },
      note: '三年前的约定（重提 3 次）：A1 应升到第一；衰减策略下 ambient 排名可能下沉（诚实记录），但候选可达性必须保留；任务书失败模式 4 与示例 C'
    },
    {
      id: 'D05b-old-commitment-explicit', mode: 'explicit', spaceIds: ['personal'], at,
      query: '洱海 约定',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }),
      expect: { top1: 'rec-commitment-erhai' },
      note: '用户明确追问旧约定 → 词元 AND 匹配保证候选可达，任何策略下必须是第一；任务书失败模式 4 的"明确查询可达性"'
    },
    {
      id: 'D06-retracted-high-freq', mode: 'explicit', spaceIds: ['personal'], at,
      query: '钓鱼',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-fishing-retracted', rev: [10, 20, 30, 40, 50, 60, 70, 80] }),
      expect: { noMatch: true, absent: ['rec-fishing-retracted'] },
      strategyExpect: {
        ambient: {
          mode: 'ambient', situation: '周末去水边放松钓鱼怎么样',
          expect: { absent: ['rec-fishing-retracted'] }
        }
      },
      note: '已撤回的高频旧记忆不得复活；任务书失败模式 2'
    },
    {
      id: 'D07-explicit-followup-after-delivery', mode: 'explicit', spaceIds: ['personal'], at,
      query: '花生 过敏',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', rev: [30, 90], del: [0.1] }),
      expect: { top1: 'rec-allergy-peanut' },
      note: '刚投递过（2.4h 前）但用户明确追问：必须正常召回，不得被抑制；任务书失败模式 9 后半'
    },
    {
      id: 'D08-internal-queries-no-reinforce', mode: 'explicit', spaceIds: ['personal'], at,
      query: '科幻',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', internals: 50 }),
      expect: { identityToZeroEvents: true, top1: 'rec-scifi-books' },
      note: '50 次内部查询、用户零参与 → 排名必须与零事件完全一致；任务书失败模式 1/8'
    },
    {
      id: 'D09-recent-delivery-suppression', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '外出和朋友吃饭要注意什么',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', del: [0.1] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-no-cilantro', del: [80] })
      ],
      expect: {
        strategyExpect: {
          A0: { orderAfter: { recordId: 'rec-no-cilantro', after: 'rec-allergy-peanut' } },
          A1: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'A2-H7': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'A2-H30': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          A3: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } }
        }
      },
      note: '过敏提醒 2.4h 前刚投递过 → 无关情境下应被抑制、排到久未提及的同类提醒之后；A0 无事件机制只能按基线排；任务书失败模式 9 前半'
    },
    {
      id: 'D10-same-source-duplicate', mode: 'explicit', spaceIds: ['personal'], at,
      query: '科幻',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', rev: [5], tools: 3, sourceEventId: 'src-evt-shared' }),
      expect: { reinforceCount: 1, identityToZeroEvents: false, sameAsSingleRevisit: true },
      note: '同一事件跨 3 个工具转发 → 只算 1 次强化；任务书失败模式 6'
    },
    {
      id: 'D11-clock-anomalies', mode: 'explicit', spaceIds: ['personal'], at,
      query: '科幻',
      events: [
        { eventId: 'clk-1', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: daysAgoIso(5), observedAt: daysAgoIso(1), sourceEventId: null, provenance: {}, signalVersion: 1 },
        { eventId: 'clk-2', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: daysAgoIso(5), observedAt: daysAgoIso(2), sourceEventId: null, provenance: {}, signalVersion: 1 },
        { eventId: 'clk-3', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: daysAgoIso(-2), observedAt: daysAgoIso(1), sourceEventId: null, provenance: {}, signalVersion: 1 },
        { eventId: 'clk-4', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'delivered_reference', occurredAt: daysAgoIso(3), observedAt: daysAgoIso(3), sourceEventId: null, provenance: {}, signalVersion: 1 }
      ],
      expect: { top1: 'rec-scifi-books', finiteScores: true, replayOrderInsensitive: true },
      note: '重复时间戳 + 乱序到达 + 未来 occurredAt：必须可解释、无 NaN、重放顺序无关；任务书失败模式 7'
    },
    {
      id: 'D12-cross-space-isolation', mode: 'ambient', spaceIds: ['work'], at,
      situation: '项目代号和文档在哪个共享盘',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-shared-001', rev: [1, 2, 3, 4, 5, 6, 7, 8] }),
      expect: { inCandidates: ['rec-shared-001'], workActivationZero: 'rec-shared-001' },
      note: '同一 recordId 在两个空间：事件只发生在 personal，work 空间激活必须为零（硬断言）；A2 变体可能因对旧记录的年龄衰减让位给新记录（衰减行为在 D01/D03 单独测量）；任务书失败模式 5'
    },
    {
      id: 'D13-corrected-memory', mode: 'explicit', spaceIds: ['personal'], at,
      query: '收货地址',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-address-old', rev: [10, 20, 30, 40, 50, 60, 70, 80] }),
      expect: { top1: 'rec-address-new', absent: ['rec-address-old'] },
      note: '被纠正的旧地址即使 8 次重提也不得覆盖新值；任务书失败模式 2'
    },
    {
      id: 'D14-model-self-reinforcement', mode: 'explicit', spaceIds: ['personal'], at,
      query: '科幻',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', del: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] }),
      expect: { identityToZeroEvents: true, reinforceCount: 0 },
      note: '模型连续 20 次自行提及、用户零重提 → 激活必须与零事件一致；任务书失败模式 1'
    },
    {
      id: 'D15-revisit-distribution', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '攀岩馆',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-climb-b', rev: [2, 3, 4, 5, 6, 7, 8, 9] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-climb-a', rev: [45, 90, 135, 180, 225, 270, 315, 360] })
      ],
      expect: { strategyExpect: { A0: { top1: 'rec-climb-a' }, A1: { top1: 'rec-climb-a' }, 'A2-H7': { top1: 'rec-climb-b' }, 'A2-H30': { top1: 'rec-climb-b' }, A3: { top1: 'rec-climb-b' } } },
      note: '同为 8 次：最近密集 vs 一年分散（情境"攀岩馆"使两条记录 coverage 相同、排除新近闲聊干扰）。A0/A1 无法区分（平局→recordId），A2/A3 应把最近密集的排前。A1 的这个局限是已知的、被测量的'
    }
  ];
}

// —— 调参场景 ————————————————————————————————————————————
// 诚实性说明：所有策略权重（wCount/wStrength/wActr）都是在看到任何评估输出之前
// 按任务书原则（有界、边际递减、保守）先验选定的，不做权重拟合。因此这里没有
// 会污染保留集的调参自由度。T1 只验证"强化不伤害"这一硬性质；
// 权重敏感性在 results/weights-sensitivity.json 中单独报告，不参与 GO 判定。
export function tuningScenarios() {
  const at = EVAL_NOW;
  return [
    {
      id: 'T1-revisited-relevant-no-harm', mode: 'ambient', spaceIds: ['personal'], at,
      situation: '用户想找科幻小说来看',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', rev: [2, 6, 12] }),
      expect: {
        top1: 'rec-scifi-books',
        noHarm: true,
        strategyExpect: { A0: { inTop: { k: 3, recordIds: ['rec-scifi-books'] } } }
      },
      note: '强化不伤害：重提过的相关记录（较旧）应被恢复到第一；A0 无事件机制下至少保持在 top3'
    }
  ];
}

export function allScenarios() {
  return { base: baseScenarios(), holdout: holdoutScenarios(), tuning: tuningScenarios() };
}
