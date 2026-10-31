# activation-01 评估报告（机器生成）

- 评估时钟：2026-10-31T12:00:00.000Z（固定，无随机源）
- 基线出处：glm-retrieval adapter.mjs @ Atlas HEAD 4f112f2（A0 公式逐字复刻）
- 策略：A0 / A1 / A2-H7 / A2-H30 / A3；参数：wCount=0.5, wStrength=0.75, wActr=0.35, floor=0.4, ceil=2.25

## 1. 基础情景（36 个 explicit 用例）——正确性回归

| 策略 | pass | Recall@5 | MRR(可判定) | MRR(全部) | nDCG@5 | forbidden 命中 |
|---|---|---|---|---|---|---|
| A0 | 36/36 | 1 | 1 | 0.8611 | 1 | 0 |
| A1 | 36/36 | 1 | 1 | 0.8611 | 1 | 0 |
| A2-H7 | 36/36 | 1 | 1 | 0.8611 | 1 | 0 |
| A2-H30 | 36/36 | 1 | 1 | 0.8611 | 1 | 0 |
| A3 | 36/36 | 1 | 1 | 0.8611 | 1 | 0 |

## 2. 动态保留场景（16 个）——逐场景判定（— = 该策略在此场景无可判定预期）

| 场景 | A0 | A1 | A2-H7 | A2-H30 | A3 |
|---|---|---|---|---|---|
| D01-revisit-1 | — | ✅ | ✅ | ✅ | ❌ |
| D02-revisit-3 | — | ✅ | ✅ | ✅ | ❌ |
| D03-revisit8-vs-recent-trivial | — | ❌ | ❌ | ❌ | ✅ |
| D04-high-freq-irrelevant-explicit | — | ❌ | ✅ | ❌ | ✅ |
| D05-old-commitment-reachable | — | ✅ | ✅ | ✅ | ✅ |
| D05b-old-commitment-explicit | — | ✅ | ✅ | ✅ | ✅ |
| D06-retracted-high-freq | — | ✅ | ✅ | ✅ | ✅ |
| D07-explicit-followup-after-delivery | — | ✅ | ✅ | ✅ | ✅ |
| D08-internal-queries-no-reinforce | — | ✅ | ✅ | ✅ | ✅ |
| D09-recent-delivery-suppression | ✅ | ✅ | ✅ | ✅ | ✅ |
| D10-same-source-duplicate | — | ✅ | ✅ | ✅ | ✅ |
| D11-clock-anomalies | — | ✅ | ✅ | ✅ | ✅ |
| D12-cross-space-isolation | — | ✅ | ✅ | ✅ | ✅ |
| D13-corrected-memory | — | ✅ | ✅ | ✅ | ✅ |
| D14-model-self-reinforcement | — | ✅ | ✅ | ✅ | ✅ |
| D15-revisit-distribution | ✅ | ✅ | ✅ | ✅ | ✅ |

### 逐场景策略差异明细（失败检查项）

**D01-revisit-1** — 回忆 1 次：方向正确且不越界
- A3: top1(got=rec-recipe-hotpot)

**D02-revisit-3** — 回忆 3 次：仍受上限约束
- A3: top1(got=rec-recipe-hotpot)

**D03-revisit8-vs-recent-trivial** — 高频无关（健身房，coverage 低）不得挤掉真正相关（火锅，coverage 高）；任务书失败模式 3
- A1: top1(got=rec-gym-runs)
- A2-H7: top1(got=rec-gym-runs)
- A2-H30: top1(got=rec-gym-runs)

**D04-high-freq-irrelevant-explicit** — explicit 内三条同含"周末"的候选（火锅计划 2 次重提 / 健身房 8 次重提但更旧 / 骑车零重提）：8 次重提的更旧记录不得挤掉真正被问的当前计划；任务书失败模式 3
- A1: top1(got=rec-gym-runs)
- A2-H30: top1(got=rec-gym-runs)

## 3. 相对 A0 的回归（GO 条件 2）
- A1: MRR 降幅 0，Recall@5 降幅 0，forbidden 0，A0 通过而它失败：无
- A2-H7: MRR 降幅 0，Recall@5 降幅 0，forbidden 0，A0 通过而它失败：无
- A2-H30: MRR 降幅 0，Recall@5 降幅 0，forbidden 0，A0 通过而它失败：无
- A3: MRR 降幅 0，Recall@5 降幅 0，forbidden 0，A0 通过而它失败：无

## 4. 调参场景
- T1-revisited-relevant-no-harm: A0→rec-recipe-hotpot, A1→rec-scifi-books, A2-H7→rec-scifi-books, A2-H30→rec-scifi-books, A3→rec-recipe-hotpot

## 5. 权重敏感性（报告用，未参与判定）
- {"strategy":"A1","wCount":0.1,"D03_top1":"rec-recipe-hotpot","D04_top1":"rec-recipe-hotpot"}
- {"strategy":"A1","wCount":0.15,"D03_top1":"rec-recipe-hotpot","D04_top1":"rec-recipe-hotpot"}
- {"strategy":"A1","wCount":0.25,"D03_top1":"rec-gym-runs","D04_top1":"rec-recipe-hotpot"}
- {"strategy":"A1","wCount":0.35,"D03_top1":"rec-gym-runs","D04_top1":"rec-recipe-hotpot"}
- {"strategy":"A1","wCount":0.5,"D03_top1":"rec-gym-runs","D04_top1":"rec-recipe-hotpot"}
- {"strategy":"A2-H7","wStrength":0.25,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H30","wStrength":0.25,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H7","wStrength":0.35,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H30","wStrength":0.35,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H7","wStrength":0.5,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H30","wStrength":0.5,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H7","wStrength":0.75,"D03_top1":"rec-gym-runs"}
- {"strategy":"A2-H30","wStrength":0.75,"D03_top1":"rec-gym-runs"}
- {"strategy":"A3","wActr":0.1,"D03_top1":"rec-recipe-hotpot"}
- {"strategy":"A3","wActr":0.2,"D03_top1":"rec-recipe-hotpot"}
- {"strategy":"A3","wActr":0.35,"D03_top1":"rec-recipe-hotpot"}

## 6. 性能与存储
- 单次排序：median 0.0687ms / p95 0.16ms / max 0.3208ms（26 记录合成库）
- 事件重放：0.138ms/次（150 事件）
- 事件日志：49896 bytes，332.6 B/事件，round-trip 一致
- CPU（本进程累计采样段）：user 0ms, sys 0ms

## 7. 解释样例
```json
{
  "D05-A1-erhai-vs-umbrella": {
    "query": "有没有还没完成的旅行约定",
    "strategy": "A1",
    "mode": "ambient",
    "a": {
      "recordId": "rec-commitment-erhai",
      "spaceId": "personal",
      "rank": 1,
      "breakdown": {
        "recordId": "rec-commitment-erhai",
        "spaceId": "personal",
        "strategy": "A1",
        "mode": "ambient",
        "validity": {
          "status": "active",
          "eligibility": "active",
          "eligible": true
        },
        "evidence": {
          "sourceKind": "chat",
          "sourceId": "s-003",
          "confirmationsAuthorized": 0,
          "confirmationsUnauthorized": 0,
          "note": "证据只来自来源与正式授权路径；激活事件永不增长它"
        },
        "importance": {
          "level": "high",
          "note": "静态属性；激活引擎只读，不由回忆频率增长"
        },
        "relevance": {
          "mode": "ambient",
          "coverage": 0.3333,
          "matchedTerms": [
            "的(cjk-1)",
            "旅(cjk-1)",
            "旅行(cjk-2)",
            "行(cjk-1)",
            "约(cjk-1)",
            "约定(cjk-2)",
            "定(cjk-1)"
          ],
          "note": "当前查询/情境词元覆盖，当前问题优先"
        },
        "activation": {
          "raw": 1.693147,
          "multiplier": 1.693147,
          "clamped": null,
          "reinforcementCount": 3,
          "hasEvents": true
        },
        "recentDelivery": {
          "lastDeliveryMs": null,
          "multiplier": 1,
          "note": "仅 ambient 模式抑制；explicit 追问恒为 1"
        },
        "recency": {
          "factor": 0.600008,
          "windowDays": 120,
          "recordTime": "2023-04-15T09:00:00.000Z"
        },
        "components": {
          "relevanceTerm": 0.800011,
          "activationTerm": 1.693147,
          "deliveryTerm": 1
        },
        "finalScore": 1.354536,
        "reasons": [
          "user_revisited×3：1 + 0.5·log1p(3) = 1.6931"
        ],
        "eligibility": {
          "eligible": true,
          "reason": "active"
        }
      }
    },
    "b": {
      "recordId": "rec-umbrella",
      "spaceId": "personal",
      "rank": 2,
      "breakdown": {
        "recordId": "rec-umbrella",
        "spaceId": "personal",
        "strategy": "A1",
        "mode": "ambient",
        "validity": {
          "status": "active",
          "eligibility": "active",
          "eligible": true
        },
        "evidence": {
          "sourceKind": "chat",
          "sourceId": "s-004",
          "confirmationsAuthorized": 0,
          "confirmationsUnauthorized": 0,
          "note": "证据只来自来源与正式授权路径；激活事件永不增长它"
        },
        "importance": {
          "level": "low",
          "note": "静态属性；激活引擎只读，不由回忆频率增长"
        },
        "relevance": {
          "mode": "ambient",
          "coverage": 0.2857,
          "matchedTerms": [
            "有(cjk-1)",
            "没(cjk-1)",
            "没有(cjk-2)",
            "有还(cjk-2)",
            "还(cjk-1)",
            "还没(cjk-2)"
          ],
          "note": "当前查询/情境词元覆盖，当前问题优先"
        },
        "activation": {
          "raw": 1,
          "multiplier": 1,
          "clamped": null,
          "reinforcementCount": 0,
          "hasEvents": false
        },
        "recentDelivery": {
          "lastDeliveryMs": null,
          "multiplier": 1,
          "note": "仅 ambient 模式抑制；explicit 追问恒为 1"
        },
        "recency": {
          "factor": 0.997094,
          "windowDays": 120,
          "recordTime": "2026-10-30T15:00:00.000Z"
        },
        "components": {
          "relevanceTerm": 1.281978,
          "activationTerm": 1,
          "deliveryTerm": 1
        },
        "finalScore": 1.281978,
        "reasons": [
          "零事件：中性激活 1.0"
        ],
        "eligibility": {
          "eligible": true,
          "reason": "active"
        }
      }
    },
    "aBeforeB": true,
    "verdict": "rec-commitment-erhai(#1) 排在 rec-umbrella(#2) 之前：finalScore 1.354536 > 1.281978",
    "componentDiff": {
      "relevanceTerm": -0.481967,
      "activationTerm": 0.693147,
    
```