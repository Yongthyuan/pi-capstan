# Pi Agent Swarm 插件系统

> 插件是**可选表面**，不是主产品。主路径是计划 `acceptance.commands` + `run.verify`。
>
> 诚实限制：验证插件已接到 worker 验收（含真实 git porcelain diff 与 `classifyFailure`）；调度插件只调节并发宽度；协作插件会加载但**不会**把 `getTools()` 注入 worker。

## 核心理念

配置优先于插件。需要插件时复制 `docs/examples/plugins/*.ts`，写成可 `import()` 的模块，再把**绝对路径**写入 `run.verificationStrategy` / `run.schedulingStrategy`。

## 插件类型

### 1. 验证策略（Verification Strategy）

控制如何验证 worker 输出。

**用途**：
- 增量测试（只跑受影响的测试）
- 缓存验证（相同输出跳过）
- 智能重试（分类错误并决定是否重试）

**接口**：
```typescript
interface VerificationStrategy {
  name: string;
  description: string;
  version: string;
  
  // 选择要运行的验证命令（null = 用默认命令，[] = 跳过）
  selectCommands?(
    task: Subtask,
    worktreePath: string,
    changes: { modified: string[]; added: string[]; deleted: string[] }
  ): Promise<string[] | null>;
  
  // 运行时不会调用。选中的命令一律走 verifyCommands（语法门 + 前缀 allowlist）
  verify?(
    task: Subtask,
    worktreePath: string,
    commands: string[]
  ): Promise<VerificationResult>;
  
  // 分类失败并决定重试策略
  classifyFailure?(
    task: Subtask,
    error: { exitCode: number; stdout: string; stderr: string },
    attemptNumber: number
  ): Promise<{
    category: 'flaky' | 'environment' | 'timeout' | 'real-bug';
    shouldRetry: boolean;
    retryWithModifications?: {
      simplifyGoal?: string;
      reduceScope?: string[];
      additionalContext?: string;
    };
  }>;
}
```

**示例**：增量验证器（`docs/examples/plugins/incremental-verifier.ts`）
- 只运行受影响的测试
- 自动检测测试框架
- 查找共定位的测试文件

**配置**：
```json
{
  "run": {
    "verificationStrategy": "~/.pi/agent/plugins/incremental-verifier.js"
  }
}
```

### 2. 调度策略（Scheduling Strategy）

控制任务的执行顺序和并行度。

**用途**：
- 关键路径优化
- 成本感知调度（昂贵任务优先/延后）
- 根据冲突率自适应并发

**接口**：
```typescript
interface SchedulingStrategy {
  name: string;
  description: string;
  version: string;
  
  // 初始调度决策
  schedule(
    plan: SwarmPlan,
    context: {
      maxConcurrency: number;
      remainingBudget: number;
      completedTasks: string[];
    }
  ): Promise<{
    batches: string[][]; // 每批并行执行
    reasoning?: string;
  }>;
  
  // 运行时动态调整
  adjust?(metrics: {
    avgTaskDuration: number;
    conflictRate: number;
    budgetUtilization: number;
    stalledWorkers: string[];
  }): Promise<{
    newConcurrency?: number;
    deprioritizeTasks?: string[];
    reasoning?: string;
  }>;
}
```

**示例**：自适应调度器（`docs/examples/plugins/adaptive-scheduler.ts`）
- 计算关键路径并优先执行
- 昂贵任务先执行（fail fast）
- 冲突率高时降低并发度
- 预算不足时减少并发

**配置**：
```json
{
  "run": {
    "schedulingStrategy": "~/.pi/agent/plugins/adaptive-scheduler.js"
  }
}
```

### 3. 协作原语（Collaboration Primitive）

为 workers 添加自定义工具和协调机制。

**用途**：
- 共享键值存储
- 请求-响应协议
- Barrier 同步
- 发布-订阅消息

**接口**：
```typescript
interface CollaborationPrimitive {
  name: string;
  description: string;
  version: string;
  
  // 返回要注入到 worker 的工具
  getTools(): Array<{
    name: string;
    description: string;
    inputSchema: object;
    handler: (input: object, workerId: string) => Promise<unknown>;
  }>;
  
  // 处理跨 worker 协调请求
  coordinate?(request: {
    from: string;
    to?: string;
    type: string;
    payload: unknown;
  }): Promise<unknown>;
}
```

**示例**：共享 KV 存储（`docs/examples/plugins/shared-kv-store.ts`）
- `swarm_kv_set(key, value, ttl?)` - 设置键值
- `swarm_kv_get(key)` - 获取值
- `swarm_kv_list(prefix?)` - 列出所有键
- `swarm_kv_delete(key)` - 删除键
- `swarm_kv_watch(key)` - 等待键被设置（barrier 原语）

**配置**：
```json
{
  "run": {
    "collaborationPrimitives": [
      "~/.pi/agent/plugins/shared-kv-store.js"
    ]
  }
}
```

## 编写插件

### 步骤 1：创建插件文件

```typescript
// ~/.pi/agent/plugins/my-plugin.ts
import type { VerificationStrategy, Subtask, VerificationResult } from 'pi-agent-swarm';

export default class MyVerifier implements VerificationStrategy {
  readonly name = 'my-verifier';
  readonly description = '我的自定义验证器';
  readonly version = '1.0.0';
  
  async initialize(config: Record<string, unknown>): Promise<void> {
    // 初始化逻辑
  }
  
  async verify(
    task: Subtask,
    worktreePath: string,
    commands: string[]
  ): Promise<VerificationResult> {
    // 验证逻辑
    return { ok: true, commands: [] };
  }
  
  async cleanup(): Promise<void> {
    // 清理逻辑
  }
}
```

### 步骤 2：编译为 JavaScript

```bash
npx tsc my-plugin.ts --module esnext --target es2022
```

### 步骤 3：配置使用

在 `.pi/swarm.json` 中引用：

```json
{
  "run": {
    "verificationStrategy": "~/.pi/agent/plugins/my-plugin.js"
  }
}
```

### 步骤 4：测试

```bash
/swarm "test task" --plan-only
```

## Claude 如何使用插件

### 场景 1：用户要求增量验证

```
用户："我需要一个只跑受影响测试的 swarm 配置"

Claude 的思考过程：
1. 阅读 docs/PLUGINS.md
2. 发现增量验证器示例
3. 检查示例代码 docs/examples/plugins/incremental-verifier.ts
4. 生成配置：
   {
     "run": {
       "verificationStrategy": "~/.pi/agent/plugins/incremental-verifier.js"
     }
   }
5. 解释权衡：更快但可能漏掉间接依赖
```

### 场景 2：用户需要自定义协调

```
用户："workers 需要共享一个 API 端点列表"

Claude 的思考过程：
1. 阅读 docs/PLUGINS.md
2. 发现共享 KV 存储示例
3. 配置协作原语
4. 告诉用户 workers 可以使用：
   - swarm_kv_set("api_endpoints", [...])
   - swarm_kv_get("api_endpoints")
```

### 场景 3：用户遇到高冲突率

```
用户："swarm 一直有合并冲突"

Claude 的思考过程：
1. 分析问题：并发度太高导致路径冲突
2. 阅读 docs/PLUGINS.md
3. 推荐自适应调度器
4. 配置并解释：会根据冲突率自动降低并发度
```

## 插件开发最佳实践

### 1. 清晰的元数据

```typescript
readonly name = 'my-plugin'; // 短横线分隔
readonly description = '简洁描述插件功能'; // 一句话
readonly version = '1.0.0'; // 语义化版本
```

### 2. 健壮的错误处理

```typescript
async verify(...): Promise<VerificationResult> {
  try {
    // 验证逻辑
  } catch (error) {
    // 返回失败结果而不是抛出异常
    return {
      ok: false,
      commands: [{
        command: '...',
        exitCode: 1,
        stdout: '',
        stderr: String(error),
        durationMs: 0,
        timedOut: false,
      }],
    };
  }
}
```

### 3. 可配置参数

```typescript
async initialize(config: Record<string, unknown>): Promise<void> {
  this.threshold = (config.threshold as number) ?? 0.5;
  this.timeout = (config.timeout as number) ?? 30000;
}
```

用户可以在配置中传递参数：

```json
{
  "run": {
    "verificationStrategy": "~/.pi/agent/plugins/my-plugin.js",
    "verificationConfig": {
      "threshold": 0.8,
      "timeout": 60000
    }
  }
}
```

### 4. 清理资源

```typescript
async cleanup(): Promise<void> {
  // 关闭文件句柄
  // 停止定时器
  // 清理临时文件
}
```

## 调试插件

### 查看加载的插件

```bash
/swarm status
```

会显示：
```
Plugins:
  Verification: incremental-verifier v1.0.0
  Scheduling: adaptive-scheduler v1.0.0
  Collaboration: shared-kv-store v1.0.0
```

### 插件加载失败

如果插件无法加载，会显示错误：

```
Error: Plugin module not found: ~/.pi/agent/plugins/my-plugin.js
```

常见原因：
- 路径错误（使用绝对路径或 `~`）
- 未编译为 JS（TypeScript 需要先编译）
- 缺少 default export

### 插件运行时错误

插件运行时错误会记录在日志中：

```bash
cat ~/.pi/agent/swarm/runs/<run-id>/log.txt
```

## 内置 vs 插件

| 功能 | 何时内置 | 何时插件 |
|------|---------|---------|
| 验证 | 基本命令执行 | 增量测试、缓存、分类 |
| 调度 | DAG 拓扑排序 | 关键路径、自适应并发 |
| 协作 | mailbox、contracts | KV 存储、barrier、RPC |

## 未来扩展点

正在规划中的插件类型：

- **任务模板（Task Templates）** - 预定义常见模式（OAuth、数据库迁移等）
- **合并策略（Merge Strategy）** - 自定义冲突解决逻辑
- **预算策略（Budget Strategy）** - 动态分配 token 预算
- **通知器（Notifiers）** - Slack、邮件、webhook 通知

## 示例场景

### 完整示例：大型重构项目

```json
{
  "planner": {
    "maxSubtasks": 20,
    "budgetUsd": 5
  },
  "worker": {
    "maxConcurrency": 6,
    "perAgentBudgetUsd": 2
  },
  "run": {
    "budgetUsd": 50,
    "verificationStrategy": "~/.pi/agent/plugins/incremental-verifier.js",
    "schedulingStrategy": "~/.pi/agent/plugins/adaptive-scheduler.js",
    "collaborationPrimitives": [
      "~/.pi/agent/plugins/shared-kv-store.js"
    ],
    "mergeStrategy": "branch"
  }
}
```

**效果**：
- 增量验证减少 60% 验证时间
- 自适应调度在冲突率高时自动降低并发
- Workers 通过 KV 存储共享重构进度

---

**相关文档**：
- [配置参考](./CONFIGURATION.md)
- [扩展点指南](./EXTENSION_POINTS.md)
- [示例插件](./examples/plugins/)
