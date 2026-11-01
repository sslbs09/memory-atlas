# Memory Atlas · Alpha-01 — 使用说明

一个独立于 WhiteMoon 的本地记忆桌面应用：独立 Memory Atlas 服务 + GLM 检索索引
+ 记忆工作台（查 / 管 / 维 / 宇）+ 记忆对话实验 + Activation 影子解释。

分支：`alpha/desktop-dogfood-01`（源码树任意 checkout 位置，
自 `experiment/activation-04` 的 `17398b7` 创建，包含 master `4f112f2` 的全部
Memory Atlas 能力）。资产来源见 `desktop/PROVENANCE.md`。

## 首次安装（只做一次）

前置：Windows 10/11、Node.js ≥ 24（GLM 检索索引用 `node:sqlite`）、npm。

```bat
cd /d <checkout>\desktop
npm install
node_modules\.bin\install-electron
```

## 启动（任选其一）

1. **双击** `<checkout>\MemoryAtlas-Alpha.cmd`
2. 仓库根目录执行 `npm run alpha`
3. `cd desktop && npm run alpha`

关窗即退出：应用结束自己启动的 Atlas 子进程（stdin 约定优雅停机），
不会碰你机器上已有的任何 Node / Atlas / 其他服务。

## 数据在哪里

- 记忆数据（默认）：`%APPDATA%\memory-atlas-alpha-desktop\atlas-data\`
  可用环境变量 `MEMORY_ATLAS_ALPHA_DATA=<目录>` 或启动参数 `--data-dir <目录>` 指定。
  这是全新的独立 Alpha 数据空间，不读、不写你已有的任何正式记忆数据。
- 激活事件账本：`<数据目录>\activation\events.jsonl`（重放即状态，可审计）。
- 模型 API 配置：`%APPDATA%\memory-atlas-alpha-desktop\config.json`
  （apiKey 只存这里，不进日志、不回传渲染层）。

## 十二步体验流程（对应任务书 §九）

1. 双击 `MemoryAtlas-Alpha.cmd` → 记忆工作台打开，右上角显示 **Atlas 已连接 :端口**。
2. 首次启动已自动创建独立空间 `alpha`（左上"记忆空间"下拉可切换/见下方创建新空间）。
3. 点右上 **「载入演示记忆」** → 写入 4 条合成演示记忆并切到 `alpha-demo` 空间
   （合成数据与真实使用数据按空间隔离，来源标记 `synthetic-seed`）。
4. **查**：搜索框输入 `电影` → 应看到演示记忆；点开一条，右栏显示原始内容、
   来源、纠正链。
5. **宇**：左侧栏点"宇" → 记忆宇宙（WebGL 3D）：节点是记录、线是关系；
   图例严格区分 确认关系/推测关联；标注"图：本地派生（后端未提供图查询接口）"。
6. 点右上 **「记忆对话实验」** → 对话窗口。第一次会自动弹出设置：
   填任意 OpenAI-compatible 服务的 BaseURL（本地 Ollama 填
   `http://127.0.0.1:11434/v1`）、模型名、（如需）API Key → 保存。
7. 问：`我以前看过什么电影？` → 回复里带【记忆:…】引用芯片，点芯片看档案详情。
8. 展开消息下的 **检索与上下文**：检索关键词、查询路径、候选与 A0/L/R/LR/D
   影子排序、真正进入上下文的记录、回复实际引用——三个集合分开。
9. 在调试视图"真正传入模型上下文的记录"里，点某条旁边的
   **「确认这次真的重提了它」** → 记录 `user_revisited`（唯一强化类事件）。
   再问一次同样的问题 → 影子表里该记录 g2 乘数 >1，R/LR 排名上移（标 \*），
   而正式顺序仍是 A0。
10. 回工作台：点开一条记录 → 动作行里有 **纠正 / 撤回 / 我重新提到了它**。
    纠正或撤回后，记录状态与纠正链立即反映（已被更新 / 已撤回）。
11. 再去问模型同一个问题：被纠正/撤回的旧事实不会再被检索到（有效性由权威治理）。
12. 关闭应用再打开：记忆、纠正链、事件账本都还在。

「＋记住这段内容」：把你亲手写的一段经历作为正式记录写入当前空间
（来源 manual/alpha-capture）。模型生成的文字永远不会自动变成记忆。

## 模型配置

任何实现 `POST /v1/chat/completions` 的服务都可以（OpenAI、本地 Ollama、
one-api 网关等）。没有配置模型时，档案工作台的全部功能照常可用；
对话窗口会如实显示"还没有配置模型 API"。

`desktop/docs/test-stub-model.mjs` 是一个本地协议桩（仅联调用，不是模型）：
`node desktop/docs/test-stub-model.mjs 8798`，BaseURL 填 `http://127.0.0.1:8798/v1`。

## 故障时

- Atlas 离线：工作台显示"读取失败/Atlas 离线"，绝不是"没有记忆"。
  点右上状态芯片可看服务真实状态（端口、Node 版本、数据目录、错误输出）。
- 端口被占：默认自动挑空闲端口；`config.json` 里可改 `atlas.portMode: "fixed"`。
- 数据目录被其他 Atlas 进程持有：会显示单写者锁的真实原因。
- GLM 索引异常：Atlas 拒绝带坏索引启动并报告原因；索引信任丢失的空间自动
  回到权威全量扫描（界面显示 searchPath）。

## 自动验证

```bat
cd desktop
node_modules\electron\dist\electron.exe . --selfcheck main     :: 主窗 + 服务 + 空间
node_modules\electron\dist\electron.exe . --selfcheck flow     :: 种子/写入/纠正/撤回/重提/影子
node_modules\electron\dist\electron.exe . --selfcheck chat     :: 对话全链路（需协议桩在 8798）
node_modules\electron\dist\electron.exe . --selfcheck universe :: 宇宙渲染
```
