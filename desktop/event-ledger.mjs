/**
 * event-ledger.mjs — Alpha 激活事件账本（复用 activation-01/02/03 的正式实现）。
 *
 * 持久化：<dataDir>/activation/events.jsonl（append-only，一行一条）。
 * 派生激活状态从不落盘：每次都由 activation-01 的 replayEvents 从账本重放得出，
 * 与 dogfood CLI 的跨进程重放校验是同一套幂等规则（eventId / sourceEventId 折叠）。
 *
 * 事件准入只走 activation-03 的 Event Bridge——本文件不自己发明事件形状：
 *   user_revisited      仅当 UI 里用户明确确认"我这次确实重新提到了它"
 *                       （provenance.surface='user', utteranceObserved=true）；
 *   generated_reference 模型回复引用了某条记录（只读，不强化）；
 *   delivered_reference 回复已真实展示给用户后（deliveryConfirmed=true），
 *                       只更新最近投递，永不强化；
 *   selected_for_context 记录被选入本轮模型上下文（只读观测）；
 *   user_corrected      仅当 Atlas 纠正 API 成功返回 operationId 回执
 *                       （formalAuthorization=true）。撤回不写激活事件：
 *                       有效性由权威治理，激活状态不能让被撤回记录复活。
 *
 * 损坏账本：重命名保留为 events.jsonl.corrupt-<ts>，重新从空账本开始，并把
 * 事实如实报告给界面——不假装历史还在。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importExperimentModule(repoRoot, ...segments) {
  const file = path.join(repoRoot, "experiments", ...segments);
  if (!fs.existsSync(file)) {
    throw new Error(`activation 实验模块缺失：${file}（Alpha 工作树应包含 experiments/activation-01..04）`);
  }
  return import(pathToFileURL(file).href);
}

export async function createEventLedger({ repoRoot, dataDir }) {
  const eventsDir = path.join(dataDir, "activation");
  fs.mkdirSync(eventsDir, { recursive: true });
  const eventsPath = path.join(eventsDir, "events.jsonl");

  const [{ EventLog, replayEvents }, { createEventBridge }, { createEventIdFactory }] = await Promise.all([
    importExperimentModule(repoRoot, "activation-01", "src", "events.mjs"),
    importExperimentModule(repoRoot, "activation-03", "src", "event-bridge.mjs"),
    importExperimentModule(repoRoot, "activation-02", "src", "event-ids.mjs")
  ]);

  const log = new EventLog();
  let quarantined = null;
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim());
    let broken = null;
    const candidate = new EventLog();
    for (const line of lines) {
      let event = null;
      try { event = JSON.parse(line); } catch { broken = { line, reason: "JSON 解析失败" }; break; }
      const outcome = candidate.recordEvent(event);
      if (outcome.status === "rejected") { broken = { line, reason: outcome.reason }; break; }
    }
    if (broken) {
      // 账本必须可重放才可信：损坏的账本整体隔离，绝不带着断账继续算激活。
      quarantined = { path: eventsPath, reason: broken.reason, line: String(broken.line).slice(0, 200) };
      fs.renameSync(eventsPath, `${eventsPath}.corrupt-${Date.now()}`);
    } else {
      for (const event of candidate.events()) log.recordEvent(event);
    }
  }

  const bridge = createEventBridge({
    log,
    ids: createEventIdFactory({ prefix: "alpha-01" }),
    now: () => Date.now()
  });

  function persistTail() {
    const events = log.events();
    const last = events[events.length - 1];
    if (last) fs.appendFileSync(eventsPath, JSON.stringify(last) + "\n", "utf8");
  }

  return {
    /** 准入 + 持久化。返回桥的结果（eventRecorded / reason）。 */
    observe(lifecycle) {
      const result = bridge.observe(lifecycle);
      if (result.eventRecorded) persistTail();
      return result;
    },
    events: () => log.events(),
    get size() { return log.size; },
    replayState: () => replayEvents(log.events()),
    stateHash() {
      const { createHash } = require("node:crypto");
      const state = replayEvents(log.events());
      const canonical = [...state.entries()]
        .map(([key, v]) => ({ key, revisits: v.reinforceTimesMs, lastDeliveryMs: v.lastDeliveryMs }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
      return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    },
    diagnostics: () => ({ eventsPath, size: log.size, quarantined })
  };
}
