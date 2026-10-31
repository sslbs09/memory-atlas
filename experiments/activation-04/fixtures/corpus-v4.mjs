// 合成语料 v4 —— activation-04 归因实验专用（独立于 activation-01/02/03 语料）。
//
// 全部确定性：固定 occurredAt、固定 content、固定 control operationId。
// 空间：
//   nova      —— 路径 A（explicit 关键词检索）主空间
//   nova-b    —— 路径 B（ambient association 直连探测）空间
//   nova-other —— 跨空间对照（本轮无跨空间场景，保留结构以备行为断言）
//
// 评估时钟与 v3 一致：NOW = 2026-11-01T12:00:00.000Z（冻结）。
// 真实 AND 检索约束（glm-retrieval adapter.mjs：collectCandidates 按词元求交）：
// 每个场景的全部预期候选都必须包含查询的全部词元（含 CJK 二元）——语料内容
// 按此设计；冻结前的管道探针只验证「候选集成员可到达」，不消费任何策略输出。

export const NOW_ISO_V4 = '2026-11-01T12:00:00.000Z';
export const NOW_MS_V4 = Date.parse(NOW_ISO_V4);

const d = (iso) => `${iso}T10:00:00.000Z`;

// —— nova 主空间（路径 A）——
export const NOVA_RECORDS = [
  // V01 语义相关但时间较旧 + 完整短语 vs 零散字词：query "身份证 挂失"
  { recordId: 'rec-idloss-report', content: '身份证挂失回执收好在文件柜第二层', occurredAt: d('2026-06-15'), key: 'rec-idloss-report' },
  { recordId: 'rec-idloss-copy', content: '挂失的旧身份证复印件在抽屉里找到了', occurredAt: d('2026-10-31'), key: 'rec-idloss-copy' },
  { recordId: 'rec-idloss-noise', content: '身份证照片打印店在商场三层', occurredAt: d('2026-10-20'), key: 'rec-idloss-noise' },

  // V02 用户明确再次追问（刚投递过）：query "报销 流程"
  { recordId: 'rec-expense-flow', content: '报销流程贴在部门群里了', occurredAt: d('2026-10-05'), key: 'rec-expense-flow' },
  { recordId: 'rec-expense-note', content: '报销流程图存在桌面文件夹', occurredAt: d('2026-10-31'), key: 'rec-expense-note' },

  // V03 高频无关记忆（已知失效模式）：query "年会"
  { recordId: 'rec-annual-plan', content: '年会节目单初稿已经定稿', occurredAt: d('2026-10-25'), key: 'rec-annual-plan' },
  { recordId: 'rec-annual-lottery', content: '年会抽奖奖品讨论了好几轮', occurredAt: d('2026-10-31'), key: 'rec-annual-lottery' },

  // V04 长期有效约定 + 多次真实重提：query "还书"
  { recordId: 'rec-book-return', content: '答应老陈月底前还书给他', occurredAt: d('2026-09-20'), key: 'rec-book-return' },
  { recordId: 'rec-book-remind', content: '图书馆发来还书提醒短信', occurredAt: d('2026-10-31'), key: 'rec-book-remind' },

  // V05 同一条记忆多次真实重提：query "体检"
  { recordId: 'rec-health-report', content: '年度体检报告已存到邮箱收藏', occurredAt: d('2026-10-01'), key: 'rec-health-report' },
  { recordId: 'rec-health-center', content: '体检中心搬到三楼了', occurredAt: d('2026-10-30'), key: 'rec-health-center' },

  // V06 已撤回的高频旧记录：query "密码"（retracted 记录带历史重提，必须结构性缺席）
  { recordId: 'rec-safe-password', content: '家门密码改成六位数字了', occurredAt: d('2026-10-28'), key: 'rec-safe-password' },
  { recordId: 'rec-safe-box', content: '密码箱的初始密码是出厂设置', occurredAt: d('2026-10-20'), key: 'rec-safe-box' },
  { recordId: 'rec-bank-password', content: '银行U盾密码贴在日历背面', occurredAt: d('2026-08-01'), key: 'rec-bank-password' },

  // V07 新近但只弱相关 + 旧正确带多次真实重提：query "发票 报销"
  { recordId: 'rec-invoice-deadline', content: '发票报销截止月底别拖到十一月', occurredAt: d('2026-09-28'), key: 'rec-invoice-deadline' },
  { recordId: 'rec-invoice-done', content: '上月的报销发票都贴好了', occurredAt: d('2026-10-31'), key: 'rec-invoice-done' },

  // 公共噪声（让 AND 候选集不只有目标对，排序空间更真实）
  { recordId: 'rec-v4-noise-a', content: '周末去旧货市场淘了两本书', occurredAt: d('2026-10-18'), key: 'rec-v4-noise-a' },
  { recordId: 'rec-v4-noise-b', content: '公司门禁卡需要重新办理照片', occurredAt: d('2026-10-26'), key: 'rec-v4-noise-b' },

  // V06 的 control 记录（必须在目标之后声明；operationId → 确定性 recordId）
  { controlAction: 'retract', aboutRecordId: 'rec-bank-password', operationId: 'retr-v4-bank-001', key: 'retr-v4-bank' }
];

// —— nova-b 空间（路径 B 直连探测）——
export const NOVA_B_RECORDS = [
  { recordId: 'rec-v4b-zhao-hike', content: '和小赵约了周日徒步', occurredAt: d('2026-10-24'), subject: '小赵', sourceSession: 'sess-1024', key: 'rec-v4b-zhao-hike' },
  { recordId: 'rec-v4b-zhao-dinner', content: '小赵推荐了一家川菜馆', occurredAt: d('2026-10-27'), subject: '小赵', sourceSession: 'sess-1027', key: 'rec-v4b-zhao-dinner' },
  { recordId: 'rec-v4b-zhao-tea', content: '这位朋友不爱喝浓茶', occurredAt: d('2026-10-29'), subject: '小赵', sourceSession: 'sess-1027', key: 'rec-v4b-zhao-tea' },
  { recordId: 'rec-v4b-noise', content: '办公室打印机换过墨盒', occurredAt: d('2026-10-23'), subject: '办公室', sourceSession: 'sess-1023', key: 'rec-v4b-noise' }
];

// —— 场景级事件剧本（synthetic history；runner 用 activation-01 replayEvents
//    重放为派生态；delivered_reference 仅代表剧本声明的历史真实投递）——
export const SCENARIO_EVENTS_V4 = {
  'V02-explicit-reask-expense': [
    { recordId: 'rec-expense-flow', eventType: 'delivered_reference', at: '2026-11-01T10:00:00.000Z' },
    { recordId: 'rec-expense-flow', eventType: 'user_revisited', at: '2026-11-01T09:00:00.000Z' }
  ],
  'V03-freq-irrelevant-annual': [
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T09:10:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T09:20:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T09:30:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T09:40:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T09:50:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T10:00:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T10:10:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T10:20:00.000Z' },
    { recordId: 'rec-annual-lottery', eventType: 'user_revisited', at: '2026-10-31T10:30:00.000Z' }
  ],
  'V04-commitment-book-return': [
    { recordId: 'rec-book-return', eventType: 'user_revisited', at: '2026-10-28T09:00:00.000Z' },
    { recordId: 'rec-book-return', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' }
  ],
  'V05-multi-revisit-health': [
    { recordId: 'rec-health-report', eventType: 'user_revisited', at: '2026-09-28T09:00:00.000Z' },
    { recordId: 'rec-health-report', eventType: 'user_revisited', at: '2026-10-08T09:00:00.000Z' },
    { recordId: 'rec-health-report', eventType: 'user_revisited', at: '2026-10-15T09:00:00.000Z' },
    { recordId: 'rec-health-report', eventType: 'user_revisited', at: '2026-10-22T09:00:00.000Z' },
    { recordId: 'rec-health-report', eventType: 'user_revisited', at: '2026-10-29T09:00:00.000Z' }
  ],
  // V06：撤回记录的历史重提（撤回前真实发生）——激活状态存在 ≠ 候选复活
  'V06-retracted-highfreq-password': [
    { recordId: 'rec-bank-password', eventType: 'user_revisited', at: '2026-08-15T09:00:00.000Z' },
    { recordId: 'rec-bank-password', eventType: 'user_revisited', at: '2026-09-01T09:00:00.000Z' },
    { recordId: 'rec-bank-password', eventType: 'user_revisited', at: '2026-09-15T09:00:00.000Z' },
    { recordId: 'rec-bank-password', eventType: 'user_revisited', at: '2026-10-01T09:00:00.000Z' },
    { recordId: 'rec-bank-password', eventType: 'user_revisited', at: '2026-10-15T09:00:00.000Z' }
  ],
  'V07-recent-weak-invoice': [
    { recordId: 'rec-invoice-deadline', eventType: 'user_revisited', at: '2026-10-20T09:00:00.000Z' },
    { recordId: 'rec-invoice-deadline', eventType: 'user_revisited', at: '2026-10-24T09:00:00.000Z' },
    { recordId: 'rec-invoice-deadline', eventType: 'user_revisited', at: '2026-10-30T09:00:00.000Z' }
  ],
  'V08-ambient-delivery-zhao': [
    { recordId: 'rec-v4b-zhao-dinner', eventType: 'delivered_reference', at: '2026-11-01T11:00:00.000Z' }
  ]
};
