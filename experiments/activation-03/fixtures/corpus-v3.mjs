// 合成语料 v3 —— activation-03 专用（不复用、不修改 activation-01/02 语料）。
//
// 全部确定性：固定 occurredAt、固定 content、固定 control operationId。
// 空间：
//   mira    —— 路径 A / C 的主空间
//   other   —— 跨空间隔离对照（含同名 recordId）
//   mira-b / other-b —— 路径 B（association 探测）空间，记录带 subject/sourceSession
//            （whitemoon-sync.mjs 的字段形状；Atlas 生产投影不传这些字段，
//             见 PATH-ANALYSIS）
//
// 评估时钟 NOW = 2026-11-01T12:00:00.000Z（冻结于 fixtures/holdout-v3.mjs）。

export const NOW_ISO = '2026-11-01T12:00:00.000Z';
export const NOW_MS = Date.parse(NOW_ISO);

const d = (iso) => `${iso}T10:00:00.000Z`;

// —— mira 主空间 ——
export const MIRA_RECORDS = [
  { recordId: 'rec-hotpot', content: '周末在家吃火锅，用新买的鸳鸯锅', occurredAt: d('2026-10-20'), key: 'rec-hotpot' },
  { recordId: 'rec-gym', content: '健身房年卡12月到期', occurredAt: d('2026-10-30'), key: 'rec-gym' },
  { recordId: 'rec-bike', content: '周末骑车去江边', occurredAt: d('2026-09-15'), key: 'rec-bike' },
  { recordId: 'rec-weekend-plan', content: '周末安排：上午整理相册', occurredAt: d('2026-10-25'), key: 'rec-weekend-plan' },
  { recordId: 'rec-latte', content: '用户喜欢拿铁，每天一杯咖啡', occurredAt: d('2026-08-01'), key: 'rec-latte' },
  { recordId: 'rec-umbrella-commitment', content: '答应小周周六送伞还她', occurredAt: d('2026-06-10'), key: 'rec-umbrella-commitment' },
  { recordId: 'rec-umbrella-uncommitted', content: '小周说下雨要记得带伞', occurredAt: d('2026-10-26'), key: 'rec-umbrella-uncommitted' },
  { recordId: 'rec-xiaolin-book', content: '小林借走了我的三体还没还', occurredAt: d('2026-09-20'), key: 'rec-xiaolin-book' },
  { recordId: 'rec-xiaolin-cafe', content: '和小林在单位楼下咖啡馆聊过项目', occurredAt: d('2026-10-12'), key: 'rec-xiaolin-cafe' },
  { recordId: 'rec-xiaolin-birthday', content: '小林的生日是3月2日', occurredAt: d('2026-03-02'), key: 'rec-xiaolin-birthday' },
  { recordId: 'rec-medicine-drawer', content: '药盒放在书桌第二个抽屉', occurredAt: d('2026-10-18'), key: 'rec-medicine-drawer' },
  { recordId: 'rec-herb-tea', content: '中药茶包要冷藏保存', occurredAt: d('2026-09-01'), key: 'rec-herb-tea' },
  { recordId: 'rec-pharmacy-run', content: '路过药店买了创可贴', occurredAt: d('2026-10-22'), key: 'rec-pharmacy-run' },
  { recordId: 'rec-trip-tokyo', content: '计划明年三月去东京旅行', occurredAt: d('2026-10-05'), key: 'rec-trip-tokyo' },
  { recordId: 'rec-wifi-password', content: '家里WiFi密码是home2026', occurredAt: d('2026-07-15'), key: 'rec-wifi-password' },
  { recordId: 'rec-wifi-note', content: 'WiFi密码贴在路由器底部', occurredAt: d('2026-10-20'), key: 'rec-wifi-note' },
  { recordId: 'rec-project-deadline', content: '12月15日前交季度复盘报告', occurredAt: d('2026-10-15'), key: 'rec-project-deadline' },
  { recordId: 'rec-x-t30-camera', content: '相机机身是X-T30，镜头18-55', occurredAt: d('2026-05-10'), key: 'rec-x-t30-camera' },
  { recordId: 'rec-camera-backup', content: 'X-T30 相机备用电池在抽屉', occurredAt: d('2026-10-18'), key: 'rec-camera-backup' },
  { recordId: 'rec-camera-bag', content: '相机包在玄关柜第二层', occurredAt: d('2026-10-09'), key: 'rec-camera-bag' },
  { recordId: 'rec-gym-run', content: '周末去健身房跑步一小时', occurredAt: d('2026-10-21'), key: 'rec-gym-run' },
  { recordId: 'rec-gym-treadmill', content: '跑步前先去健身房拉伸', occurredAt: d('2026-10-28'), key: 'rec-gym-treadmill' },
  { recordId: 'rec-run-weekend', content: '周末晨跑五公里，跑步路线沿江', occurredAt: d('2026-10-27'), key: 'rec-run-weekend' },
  { recordId: 'rec-run-gear', content: '新跑鞋到货，跑步app会员续费了', occurredAt: d('2026-10-31'), key: 'rec-run-gear' },
  { recordId: 'rec-swim-class', content: '周二晚游泳课改为周四', occurredAt: d('2026-09-10'), key: 'rec-swim-class' },
  { recordId: 'rec-swim-pool', content: '小区泳池周一人最多', occurredAt: d('2026-10-30'), key: 'rec-swim-pool' },
  { recordId: 'rec-buy-umbrella', content: '帮同事送伞到地铁站', occurredAt: d('2026-10-27'), key: 'rec-buy-umbrella' },
  { recordId: 'rec-friday-meal', content: '周五和老周吃牛肉火锅', occurredAt: d('2026-10-28'), key: 'rec-friday-meal' },
  { recordId: 'rec-friday-cancel', content: '老周说周五可能要加班', occurredAt: d('2026-10-30'), key: 'rec-friday-cancel' },
  { recordId: 'rec-coffee-machine', content: '咖啡机除垢完成', occurredAt: d('2026-10-26'), key: 'rec-coffee-machine' },
  { recordId: 'rec-lottery-warning', content: '提醒：中奖短信都是诈骗', occurredAt: d('2026-10-12'), key: 'rec-lottery-warning' },
  { recordId: 'rec-retracted-phish', content: '抽奖中奖链接已提交身份信息', occurredAt: d('2026-07-01'), key: 'rec-retracted-phish' },
  // control 记录（顺序敏感：必须在目标之后；operationId → 确定性 recordId）
  { controlAction: 'correct', aboutRecordId: 'rec-latte', content: '用户现在只喝美式咖啡，不再喝拿铁', operationId: 'corr-latte-001', key: 'corr-latte' },
  { controlAction: 'retract', aboutRecordId: 'rec-retracted-phish', operationId: 'retr-phish-001', key: 'retr-phish' }
];

// —— other 空间（跨空间隔离对照）——
export const OTHER_RECORDS = [
  { recordId: 'rec-xiaolin-book', spaceId: 'other', content: '小林借走了我的三体还没还', occurredAt: d('2026-09-20'), key: 'other-xiaolin-book' },
  { recordId: 'rec-other-trip', spaceId: 'other', content: '另一个空间的海边旅行记录', occurredAt: d('2026-10-31'), key: 'rec-other-trip' }
];

// —— mira-b / other-b（路径 B）：whitemoon-sync 形状（subject/sourceSession）——
export const MIRA_B_RECORDS = [
  { recordId: 'rec-b-linran-hike', content: '和林然约了周六徒步', occurredAt: d('2026-10-24'), subject: '林然', sourceSession: 'sess-1024', key: 'rec-b-linran-hike' },
  { recordId: 'rec-b-linran-movie', content: '林然推荐了一部纪录片', occurredAt: d('2026-10-27'), subject: '林然', sourceSession: 'sess-1027', key: 'rec-b-linran-movie' },
  // 无词面锚词的 subject 记录：只能经结构关联进入候选（type 11 的关键设计）
  { recordId: 'rec-b-linran-tea', content: '这位朋友不爱喝浓茶', occurredAt: d('2026-10-29'), subject: '林然', sourceSession: 'sess-1027', key: 'rec-b-linran-tea' },
  { recordId: 'rec-b-session-mate', content: '同一场会聊到电影票根', occurredAt: d('2026-10-27'), subject: '林然', sourceSession: 'sess-1027', key: 'rec-b-session-mate' },
  { recordId: 'rec-b-zhou-umbrella', content: '小周周日下午来取伞', occurredAt: d('2026-10-25'), subject: '小周', sourceSession: 'sess-1025', key: 'rec-b-zhou-umbrella' },
  { recordId: 'rec-b-noise', content: '办公室打印机换过墨盒', occurredAt: d('2026-10-23'), subject: '办公室', sourceSession: 'sess-1023', key: 'rec-b-noise' },
  { recordId: 'rec-b-retracted', content: '林然借过五百元', occurredAt: d('2026-09-30'), subject: '林然', sourceSession: 'sess-0930', status: 'retracted', key: 'rec-b-retracted' }
];

export const OTHER_B_RECORDS = [
  { recordId: 'rec-b2-linran-note', spaceId: 'other-b', content: '另一空间的林然备注', occurredAt: d('2026-10-30'), subject: '林然', sourceSession: 'sess-b2', key: 'rec-b2-linran-note' }
];

// —— 场景级事件剧本（synthetic history；runner 用 activation-01 replayEvents
//    重放为派生态。事件只在这里声明；桥的准入规则由 tests/event-bridge 验证）——
export const SCENARIO_EVENTS = {
  'E01-xiaolin-person-events': [
    { recordId: 'rec-xiaolin-book', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' }
  ],
  'E02-token-quality-gate': [
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:05:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:10:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:15:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:20:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:25:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:30:00.000Z' },
    { recordId: 'rec-gym-treadmill', eventType: 'user_revisited', at: '2026-10-31T09:35:00.000Z' },
    { recordId: 'rec-gym-run', eventType: 'user_revisited', at: '2026-10-31T11:00:00.000Z' }
  ],
  'E03-same-coverage-uplift': [
    { recordId: 'rec-swim-class', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' }
  ],
  'E05-freq-irrelevant-explicit': [
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T09:10:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T09:20:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T09:30:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T09:40:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T09:50:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T10:00:00.000Z' },
    { recordId: 'rec-run-gear', eventType: 'user_revisited', at: '2026-10-31T10:10:00.000Z' }
  ],
  'E06-explicit-reask': [
    { recordId: 'rec-friday-meal', eventType: 'delivered_reference', at: '2026-11-01T10:00:00.000Z' },
    { recordId: 'rec-friday-meal', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' }
  ],
  'E09-corrected-highfreq': [
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-09-15T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-09-20T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-09-25T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-10-01T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-10-08T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-10-15T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-10-22T09:00:00.000Z' },
    { recordId: 'rec-latte', eventType: 'user_revisited', at: '2026-10-27T09:00:00.000Z' }
  ],
  'E13-idhit-gate': [
    { recordId: 'rec-camera-backup', eventType: 'user_revisited', at: '2026-10-31T09:00:00.000Z' }
  ],
  'B02-recent-delivery': [
    { recordId: 'rec-b-linran-movie', eventType: 'delivered_reference', at: '2026-11-01T10:00:00.000Z' }
  ],
  'B03-suppression-decay-zone': [
    { recordId: 'rec-b-linran-movie', eventType: 'delivered_reference', at: '2026-11-01T02:00:00.000Z' }
  ],
  'C05-browse-suppression': [
    { recordId: 'rec-friday-cancel', eventType: 'delivered_reference', at: '2026-11-01T11:00:00.000Z' }
  ]
};
