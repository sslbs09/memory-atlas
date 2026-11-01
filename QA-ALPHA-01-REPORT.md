# Memory Atlas Alpha-01 · 独立体验验收报告（QA Dogfood）

- 执行：GLM（独立 QA 会话），日期 2026-11-01
- 被测：`<Memory Atlas checkout>`，分支 `alpha/desktop-dogfood-01` @ `d6101c0`
- 修复分支：`alpha/qa-dogfood-fixes`（`116e37a` 回归测试 → RED → `aeca6fb` 修复 → GREEN）
- QA 工作区：`<QA workspace>\alpha01\`（截图证据 `evidence\`、逐项日志 `reports\*.jsonl`）
- 数据隔离：全部测试使用 `run1/run2/run3/flow-*/sc-*/run-fault-data` 独立目录与独立
  `--user-data-dir`；用户真实数据 `%APPDATA%\Memory Atlas Alpha\atlas-data` 与
  `config.json`/`state.json` 经字节级比对确认零改动。用户内存写入冒烟（此前 PASS）未重复。

## 判定：PARTIAL

核心记忆工作台（写/搜/读/纠正链/撤回/多空间/持久化/故障诚实显示）全部真实 GUI 验证通过，
两个 P1 缺陷已修复并有 RED→GREEN 回归测试；但真实模型仍未测试（用户仅有本地协议桩配置），
且发现一个影响自然语言提问召回质量的检索层限制（P1，未修，属于算法扩展，超出本次权限）。

## 一、测试方法与诚实分级

- **真实 GUI 验证**：CDP（`--remote-debugging-port`）驱动真实 Electron 窗口，
  `Input.dispatchMouseEvent`/`Input.insertText` 真实点击与输入，`Page.captureScreenshot` 截图。
  非单元测试、非 HTTP 直呼冒充。
- **HTTP/API 级验证**：Atlas 数据模型能力探测（对 QA 数据副本起独立 Atlas 实例）。
- **仓库自带 selfcheck**（main/flow/chat/universe）：修复分支上全部 EXIT 0。
- **单元测试**：`npm test` 51 pass / 0 fail / 6 skipped（既有跳过）。

## 二、真实 GUI 结果（全部在隔离数据上）

| 项 | 结果 | 证据 |
|---|---|---|
| 空目录首启（自动建 alpha、GLM 索引 REBUILT、Atlas 连接） | PASS | s01-firstboot.png / reports/s01.json |
| 写入 A/B/C（＋记住这段内容 面板） | PASS | r2-write-*.png |
| 中文短词搜索 + 打开记录看来源/纠正链 | PASS | r2-reader-A-original.png |
| 多级纠正（UI：原文→小陈→《流浪地球》，3 级链） | PASS（修复后） | r3-correct-lv1/lv2.png, f5-full-chain.png |
| 撤回 C（有效列表消失、历史保留、状态一致） | PASS | r2-retract-C.png |
| 有效/已被更新/已撤回 视图 | PASS | r2-movie-history.png |
| 演示种子建空间 + 下拉框正确显示（QA-01 修复后） | PASS | r3-dropdown-after-fix.png |
| 跨空间隔离（alpha vs alpha-demo 双向、对话空间隔离） | PASS | r2-demo-space-isolated.png, r2-chat-q-demo.png |
| Universe 打开/渲染/统计/图例 | PASS | r3-universe.png |
| Universe 节点点击选中 | 未自动化成功（25+ 网格点击未命中节点；canvas 交互真实性未验证） | r3-universe.png |
| 重启持久化（记录/纠正链/撤回/事件账本重放） | PASS | r3-restart-chain.png, f5-full-chain.png |
| 优雅退出 + 子进程清理（electron 5→0，Atlas PID 消失） | PASS ×3 次 | s02b/s02c2/s04 日志 |
| 同一应用双开（第二实例自动退出 code 0） | PASS | s02-log.jsonl (run1) |
| 注入文本记忆（`<img onerror>` + 指令文本）不执行、按纯文本展示 | PASS | r2-inject.png |
| 4000 字长中文记忆写入与检索 | PASS | r2-write-longtext.png |

## 三、对话实验（协议桩；REAL MODEL NOT TESTED 维持）

用户 config.json 仅指向本地协议桩 `stub-echo-1`（127.0.0.1:8798），未发现任何已配置
授权的真实模型服务（未扫描其他软件密钥，未连接付费服务）。

链路级验证（协议桩会引用上下文前两条 recordId）：
- 三集合分离可见：候选 / 上下文 / 实际引用，含 searchPath、indexState（WIRED）、
  影子 A0/L/R/LR/D 排序、queryAttempts 关键词降级阶梯。
- 纠正后提问"我之前和谁看过电影？"→ 上下文与引用都是**最新纠正记录**（小陈/《流浪地球》），
  旧版"小林"不再出现在有效候选。✔（检索正确性，与模型无关）
- "我要归还的东西是什么来着？"→ 正确召回 B（约定记录），未被电影记忆挤掉。✔
- "我们之前约定了什么？"→ **检索失败**：问题用词"约定"与记忆原文"答应"词法失配，
  关键词降级把高频单字"了"排在前面，只召回电影记录。**责任：检索层（词法匹配无同义扩展），
  不是模型幻觉。** 未修（语义检索=新算法，超出最小修复权限）。缓解：用记忆原词提问可召回。
- 模型不可达：`[MODEL_TRANSPORT_FAILED] 模型请求失败：fetch failed`，如实报错不假装回答。✔
- 用户中断：流式中点击停止 → "（已中断，本轮没有生成内容）"，未把半截输出当回答。✔

**REAL MODEL NOT TESTED 状态保留。** 协议桩只验证接线，不验证模型理解与引用质量。

## 四、Activation Shadow

- UI"我重新提到了它"→ `user_revisited` 事件落账（eventId 回执）。✔
- 两次合法重提后影子 g2 乘数 ×1.52 → ×1.82（随次数增长）；正式排序保持 A0，
  LR 仅影子展示（调试表明示"正式上下文与 Atlas 返回都按 A0"）。✔
- `candidate_retrieved`/`generated_reference`/`delivered_reference` 只记录不强化；
  查询/展示从未产生重提事件（账本 31 条逐条核对）。✔
- 事件账本重放：重启后乘数一致、事件齐全。✔
- 已撤回记录不能靠激活复活（撤回后有效检索为空，全部历史里状态已撤回）。✔

## 五、故障行为（重点原则：失败 ≠ 没有记忆）

| 故障 | 表现 | 判定 |
|---|---|---|
| Atlas 子进程被杀 | 列表读取失败提示（非"没有记录"），服务面板如实显示 stopped | PASS（P2：状态芯片短时仍显示"已连接"，面板准确） |
| GLM 索引文件损坏 | Atlas 拒绝启动：`索引数据库无法打开（不是空索引）: file is not a database`，窗口仍打开并显示真实原因 | PASS |
| 模型 API 不可达 | 对话如实报错 | PASS |
| 写入超时语义 | 传输无回答 → "未确认"状态 + 核对按钮（不假装成功） | PASS（代码路径 + UI 呈现核对） |
| 首启空目录 | 自动建空间，正常可用 | PASS |

## 六、缺陷与修复（分支 alpha/qa-dogfood-fixes）

- **QA-01 (P1)**：载入演示记忆/创建空间后，工作台空间下拉用启动时陈旧列表重绘，
  新空间选项被抹掉——界面显示 alpha、实际空间已是 alpha-demo，用户会在错误认知下写入。
  RED（selfcheck flow `demoSpaceDropdown.options == ["alpha"]`）→ 修复（switchSpace 重拉列表、
  loadSpaces 以主进程 currentSpace 为权威、seed/create 后广播 spaces-changed）→ GREEN。
- **QA-02 (P1)**：当前有效的纠正记录（memory-control/correct）无任何操作按钮，
  同一件事从 UI 只能纠正一次（后端数据模型本身支持多级纠正，已用 QA 数据副本探测证实）。
  RED（`hasCorrectOpen: false`）→ 修复（active 纠正记录提供纠正/撤回，目标即控制记录）→ GREEN。
- 回归测试进 flow selfcheck（`116e37a`），修复 `aeca6fb`；全 selfcheck + 单测通过。

## 七、未解决问题（不阻塞判断，按优先级）

1. **P1 检索词法失配**（见三）：自然语言提问若用词与记忆原文不同则可能漏召回；
   无同义扩展。真实模型接入后仍会被此限制影响（检索先于模型）。
2. **P2** 打开链尾记录时纠正链面板只显示链尾节点；从原始记录/全部历史进入可见全链。
3. **P2** Atlas 子进程死亡后状态芯片短暂显示"已连接"（面板准确，下次状态轮询恢复）。
4. **P2** Universe 节点点选未能自动化验证（渲染/统计已验证）。
5. **未完成状态保留**：REAL MODEL NOT TESTED；PORTABLE EXE NOT PACKAGED（未在本次范围）。

## 八、结论

**Memory Atlas 现在适合用户在本机开始长期日常试用**（工作台主循环可靠、数据可纠正可撤回、
多空间隔离、重启一致、故障诚实），前提是接受两点：
1. 对话实验要配真实模型后才有意义（当前仅有协议桩联调证据）；
2. 向对话提问时尽量使用记忆里的原词（如"归还""老陈"），否则可能漏召回。

阻止"完全通过"的仅剩：真实模型联调未做 + 检索词法失配（P1，待后续专门处理）。
本轮到此为止，未开启 Alpha-02。
