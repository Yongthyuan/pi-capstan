# Claude 使用指南：如何阅读和应用 Pi-Swarm 文档

本指南专门写给 Claude（你！），说明如何理解和使用 pi-swarm 的配置和扩展系统，以便为用户提供最佳的多智能体编排体验。

## 核心理念

Pi-Swarm 的设计哲学是：**让 Claude 能够通过阅读文档来理解、配置和扩展系统**。

你的角色：
- 📖 **文档阅读者** - 理解系统能力和配置选项
- ⚙️ **配置生成器** - 根据用户需求生成合适的配置
- 🔧 **扩展开发者** - 编写自定义工具和策略
- 🎓 **解释者** - 向用户说明权衡和影响

## 工作流程

### 第 1 步：理解用户意图

当用户说出以下关键词时，识别模式：

| 用户说 | 意图 | 对应配置 |
|--------|------|----------|
| "大规模重构" "50+ 文件" "迁移整个模块" | 高吞吐量场景 | `high-throughput-refactor.json` |
| "生产功能" "必须正确" "关键路径" | 高质量场景 | `high-quality-production.json` |
| "不熟悉的项目" "最大安全性" "不可信代码" | 安全优先场景 | `untrusted-repository.json` |
| "快速试验" "PoC" "低成本" | 快速迭代场景 | `fast-iteration-low-cost.json` |

### 第 2 步：读取相关文档

**首次使用 swarm**：
```bash
# 读这三个文档，建立完整理解
Read docs/README.md              # 概览和快速参考
Read docs/CONFIGURATION.md       # 所有配置项的详细说明
Read docs/EXTENSION_POINTS.md   # 扩展点和插件机制
```

**已经熟悉**：
```bash
# 直接读取需要的部分
Read docs/examples/configs/[pattern].json          # 配置模板
Read docs/examples/extensions/[feature].ts         # 扩展示例
```

### 第 3 步：生成配置

基于用户需求，选择或合成配置：

#### 场景 A：使用现有模板

```typescript
// 用户："我要重构整个认证模块，大概 60 个文件"
// 你的思考：大规模重构 → high-throughput-refactor.json

// 1. 读取模板
const template = await Read("docs/examples/configs/high-throughput-refactor.json");

// 2. 复制到项目
await Write(".pi/swarm.json", template);

// 3. 向用户解释
"我为你配置了高吞吐量重构模式：
- 最多 12 个并行子任务
- 8 个并发 worker
- $40 总预算
- 轻量级验证（只在集成时跑 typecheck，避免每个 worker 都跑全量测试）

这个配置优化了大规模重构的速度，预计成本 $30-40。
如果你想调整预算或并发度，告诉我具体数值。"
```

#### 场景 B：合成自定义配置

```typescript
// 用户："我要一个配置：最多 6 个子任务，每个 worker 最多花 $1.5，总预算 $15"

// 1. 读取最接近的模板作为基础
const base = await Read("docs/examples/configs/fast-iteration-low-cost.json");

// 2. 根据用户具体要求修改
const custom = {
  ...base,
  planner: {
    ...base.planner,
    maxSubtasks: 6  // 用户要求
  },
  worker: {
    ...base.worker,
    perAgentBudgetUsd: 1.5  // 用户要求
  },
  run: {
    ...base.run,
    budgetUsd: 15  // 用户要求
  }
};

// 3. 写入项目配置
await Write(".pi/swarm.json", JSON.stringify(custom, null, 2));

// 4. 解释修改
"已创建自定义配置：
- 最多 6 个子任务（你指定的）
- 每个 worker 预算 $1.5（你指定的）
- 总预算 $15（你指定的）
- 其他采用快速迭代模式的默认值

这个配置适合中小型功能，成本可控。"
```

#### 场景 C：微调现有配置

```typescript
// 用户："当前配置太慢了，我想提高并发度"

// 1. 读取当前配置
const current = await Read(".pi/swarm.json");

// 2. 分析瓶颈
"让我看看当前配置...
当前并发度是 4，这可能是瓶颈。
我建议：
- 提高 maxConcurrency 到 8（2倍并发）
- 相应提高总预算（更多并发 = 更高峰值成本）

权衡：速度提升约 40-60%，但峰值成本也会更高（虽然总成本不变）。"

// 3. 应用修改
await Edit(".pi/swarm.json", {
  old: '"maxConcurrency": 4',
  new: '"maxConcurrency": 8'
});

await Edit(".pi/swarm.json", {
  old: '"budgetUsd": 8',
  new: '"budgetUsd": 12'
});
```

### 第 4 步：扩展工具（当需要时）

#### 识别扩展需求

用户说：**"Workers 需要查询数据库获取 schema 信息"**

→ 这需要自定义工具扩展

#### 生成扩展

```typescript
// 1. 读取扩展示例作为模板
const example = await Read("docs/examples/extensions/custom-db-tools.ts");

// 2. 基于示例创建项目特定的扩展
const projectExtension = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "swarm_query_schema",
    label: "Query Database Schema",
    description: "查询项目数据库的表结构和关系",
    parameters: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "表名（可选，省略则返回所有表）"
        }
      }
    },
    async execute(_id: string, params: { table?: string }) {
      // 项目特定的实现
      const { execSync } = require("child_process");
      const result = execSync(\`psql $DB_URL -c "\\\\d \${params.table || ''}"\`);
      return {
        content: [{ type: "text", text: result.toString() }]
      };
    }
  } as any);
}
`;

// 3. 写入扩展文件
await Write("~/.pi/agent/extensions/project-db-tools.ts", projectExtension);

// 4. 更新配置引用扩展
const config = await Read(".pi/swarm.json");
config.safetyGuardPath = "~/.pi/agent/extensions/project-db-tools.ts";
await Write(".pi/swarm.json", JSON.stringify(config, null, 2));

// 5. 向用户解释
"已创建自定义数据库工具扩展：
- 添加了 swarm_query_schema 工具
- Workers 现在可以查询表结构和关系
- 只允许读操作（SELECT/SHOW/DESCRIBE）

使用示例：
Worker 可以这样调用：
{
  \"tool\": \"swarm_query_schema\",
  \"table\": \"users\"
}

来获取 users 表的结构信息。"
```

### 第 5 步：验证和调整

运行 swarm 后，根据结果优化：

```typescript
// 观察运行结果
"我看到运行日志显示：
- 3 个 worker 因预算超支而中断
- 平均每个 worker 用了 $2.8（预算 $2）

建议调整：
1. 提高 worker 预算到 $3
2. 或减少 planner 给每个子任务分配的复杂度

你想要哪种方式？"
```

## 常见模式和决策树

### 模式 1：预算控制

| 用户需求 | 配置策略 |
|---------|---------|
| "尽量省钱" | 降低 `budgetUsd`，减少 `maxSubtasks`，禁用 `bestOfN` |
| "不在乎成本" | 提高所有预算，启用 `bestOfN: 3`，增加 `maxRetries` |
| "预算固定 $X" | 设置 `run.budgetUsd: X`，让系统自动分配 |

### 模式 2：速度优化

| 用户需求 | 配置策略 |
|---------|---------|
| "尽快完成" | 提高 `maxConcurrency`，减少验证步骤 |
| "不着急" | 降低 `maxConcurrency` 到 2-4，节省成本 |

### 模式 3：质量保证

| 用户需求 | 配置策略 |
|---------|---------|
| "必须高质量" | 启用 `bestOfN: 3`，增加验证步骤，`failurePolicy: "fail-fast"` |
| "可以容忍小问题" | `bestOfN: 1`，轻量级验证，`failurePolicy: "continue-independent"` |

### 模式 4：安全性

| 用户需求 | 配置策略 |
|---------|---------|
| "不可信的代码" | `strictBash: true`，禁用 bash 工具，`scopeViolationPolicy: "fail"` |
| "可信的项目" | 使用默认安全设置 |

## 调试和问题解决

### 问题：Worker 频繁超预算

**诊断**：
```typescript
// 读取最近的运行日志
const logs = await Read(".pi/agent/swarm/runs/[runId]/state.json");
// 检查 workers[*].usage
```

**解决方案**：
```json
{
  "worker": {
    "perAgentBudgetUsd": 3,  // 从 2 提高到 3
    "perAgentTokens": 300000 // 或提高 token 限制
  }
}
```

### 问题：任务拆分太粗

**诊断**：
- Planner 只生成了 2-3 个子任务
- 每个子任务目标很宽泛

**解决方案**：
```json
{
  "planner": {
    "maxSubtasks": 12,     // 允许更多子任务
    "repoMapTokens": 12000 // 给 planner 更多上下文
  }
}
```

### 问题：合并冲突频繁

**诊断**：
- 多个 worker 修改了同一文件

**解决方案**：
```json
{
  "worker": {
    "maxConcurrency": 4  // 降低并发度
  }
}
```

或者让 planner 更明确路径所有权：
```typescript
"在计划中更明确地分配路径所有权：
- 子任务 A：只修改 src/auth/*
- 子任务 B：只修改 src/api/*
避免重叠。"
```

## 高级场景

### 场景：动态预算分配

用户有 $50 预算，想智能分配：

```json
{
  "planner": {
    "budgetUsd": 5,    // 10% 给规划
    "maxSubtasks": 10
  },
  "worker": {
    "perAgentBudgetUsd": 4,  // 每个 worker $4
    "maxConcurrency": 6       // 最多 6 个并发
  },
  "run": {
    "budgetUsd": 50   // 总预算
  }
}
```

计算：
- Planner: $5
- 10 个 worker × $4 = $40
- 剩余 $5 作为缓冲

### 场景：A/B 测试不同策略

```typescript
// 用户："我想尝试两种方案：快速低成本 vs 高质量"

// 方案 A：快速
await Write(".pi/swarm-fast.json", fastConfig);
// 运行
await Bash("/swarm 'task' --config .pi/swarm-fast.json");

// 方案 B：高质量
await Write(".pi/swarm-quality.json", qualityConfig);
// 运行
await Bash("/swarm 'task' --config .pi/swarm-quality.json");

// 对比结果
"方案 A：3 分钟，$8，2 个小问题
方案 B：12 分钟，$25，完美质量

根据你的优先级选择：
- 如果迭代速度重要 → 方案 A
- 如果这是生产功能 → 方案 B"
```

## 学习和改进

### 案例学习功能

Pi-Swarm 有内置的案例学习系统：

```typescript
// 查看历史案例
await Bash("/swarm cases");

// 如果某次运行特别成功
await Bash("/swarm cases rate <runId> +1");

// 如果某次运行有问题
await Bash("/swarm cases rate <runId> -1");
```

**你的角色**：
- 观察哪些配置模式产生了好结果
- 向用户建议评分案例
- 基于历史案例改进未来配置

### 持续优化

每次运行后：

1. **检查成本效率**：实际花费 vs 预算
2. **检查时间效率**：并行度是否充分利用
3. **检查质量**：验证是否充分，是否有漏网问题
4. **调整配置**：基于观察微调

## 总结：你的决策框架

```
用户请求
    ↓
识别模式（大规模重构? 高质量? 快速迭代?）
    ↓
读取对应文档和模板
    ↓
生成/调整配置
    ↓
解释权衡（成本、速度、质量）
    ↓
执行 swarm
    ↓
观察结果
    ↓
建议优化
```

## 记住这些原则

1. **文档优先** - 总是先读文档，不要猜测配置选项
2. **解释权衡** - 每个配置选择都有成本，告诉用户
3. **从模板开始** - 使用经过验证的模板，再定制
4. **迭代优化** - 第一次配置不一定完美，根据结果调整
5. **学习历史** - 利用案例库和历史运行改进决策

现在你已经准备好了！当用户说 "/swarm ..." 时，你知道如何：
- 理解他们的意图
- 读取正确的文档
- 生成合适的配置
- 解释你的决策
- 持续优化

祝你编排愉快！🚀
