// Memory Atlas 子图查询适配层（GPT 修复轮 GLM 第 4 项）。
//
// 供 Atlas 服务 / DeepSeek Frontend 消费的稳定只读门面：把 GraphProjection 的
// 有界子图查询包装成 Atlas 侧调用形状，并锁定语义边界：
//   - 只读：本层没有任何写路径。
//   - 推测关联永远带 confidence:'speculative' 与解释性 basis，绝不升级为
//     已确认事实；门面不提供任何"确认"操作。
//   - 节点不带正文（label 只是 id/名称/时间），正文由调用方凭 recordId 向
//     正式权威（Backend A）另行取回。
//   - 索引未就绪（REBUILDING/损坏）时如实报告 unavailable，不返回伪造子图。

export function createAtlasGraphFacade(adapter) {
  const assertReady = () => {
    const stats = adapter.getIndexStats();
    if (stats.indexState !== 'READY') {
      throw Object.assign(new Error(`图查询不可用：索引状态 ${stats.indexState}（重建中不返回伪造子图）`), {
        code: 'GRAPH_NOT_READY'
      });
    }
  };
  return {
    // GET 形态的元信息：Atlas 服务启动自检用。
    describe() {
      const stats = adapter.getIndexStats();
      return {
        kind: 'whitemoon-atlas-graph-facade',
        dto: 'SEARCH-DTO-v1',
        indexState: stats.indexState,
        indexGeneration: stats.indexGeneration,
        readWrite: 'read-only',
        semantics: {
          confidence: ['confirmed', 'speculative'],
          speculativeRule: '推测关联永远显式标注，不构成因果或既证事实',
          nodeCarriesText: false,
          crossInstanceEdges: false
        }
      };
    },

    // 有界邻居子图：depth ≤2、limit ≤50（越界被点名拒绝，见 graph.mjs）。
    neighbors({ recordId, instanceId, depth = 1, limit = 20, includeSpeculative = false }) {
      assertReady();
      const view = adapter.graph.neighbors(recordId, { instanceId, depth, limit, includeSpeculative });
      return {
        found: view.found,
        graphGeneration: view.graphGeneration,
        center: view.center,
        nodes: view.nodes,
        edges: view.edges,
        speculativeIncluded: view.speculativeIncluded === true,
        note: view.note ?? (view.speculativeIncluded
          ? '包含 speculative 边：共现推断，不构成因果或既证关联'
          : '仅含来源明确的 confirmed 边')
      };
    },

    // 记忆空间总览（只统计 confirmed 边）。
    overview({ instanceId } = {}) {
      assertReady();
      return adapter.graph.overview({ instanceId });
    },

    // 时间线（memory/correction 节点按时间排序，有界）。
    timeline({ instanceId, since, until, limit = 50 } = {}) {
      assertReady();
      return adapter.graph.timeline({ instanceId, since, until, limit });
    },

    stats({ instanceId } = {}) {
      assertReady();
      return adapter.graph.stats({ instanceId });
    },

    // 一致性自检（Atlas 健康面板用）。
    verify() {
      const verdict = adapter.verifyIndex();
      return {
        ok: verdict.ok,
        indexState: verdict.indexState,
        indexGeneration: verdict.indexGeneration,
        indexAnomalies: verdict.index.anomalies,
        graphAnomalies: verdict.graph.anomalies,
        recoverable: 'adapter.recoverGraph() 可从索引自身重建图（documents 持久化了关系字段）'
      };
    }
  };
}
