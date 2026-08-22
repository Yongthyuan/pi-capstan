# Capstan

> **Many hands. One winch. Total control.**
> 绞盘：一人摇柄，众人推杆，千斤锚分节离底，棘爪落下绝不倒滑。

[English](./README.md)

**Capstan**（原名 **pi-agent-swarm**）是面向 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的原生多智能体 swarm 扩展：以计划确认为门的并行子智能体（subagents），经**受控编码流水线**执行——复杂度门控、证据化拆解、Git worktree 隔离、带路径所有权的 DAG 调度、两级验证、合并、恢复和报告回注。它**不是** [`@gjczone/pi-swarm`](https://pi.dev/packages/@gjczone/pi-swarm)（按 item 扇出 + mailbox coordinator）。

当前版本为 `0.9.0`，定位是可受控自用的 beta，而不是不可信代码的安全沙箱。已验证版本是 Pi 0.84.1；加载时会探测必需的 API 能力。支持 Pi `>=0.84.1`：0.84.x 直接按兼容加载，更新的版本会带显式警告加载，而不是拒绝启动。

## 当前实现

- 两层复杂度门控与 `--force` / `--solo` / `--plan-only`
- 读取 tracked/untracked 文件、manifest、符号/测试结构、import 邻域和 test/source 邻域的混合 planner scout
- 严格 SwarmPlan 校验：DAG、拓扑 mergeOrder、契约和路径所有权
- 原生 `pi --mode rpc` worker、JSONL、usage、steer/abort、批量 UI 审批转发
- worker 扩展隔离：`--no-extensions`，显式 safety guard + scope guard
- 仓库级跨进程 lease、PID 启动身份校验、心跳式孤儿 worker 回收和幂等 `/swarm resume`
- Git worktree、共享依赖目录与可信 setup、临时 dirty baseline、last-green candidate 合并、冲突仲裁和集成 fixer
- slot 流水调度、依赖感知的部分成功；失败任务不会吞掉无依赖的绿色结果
- scope 越界默认精确回滚，lockfile/shared/generated path 有显式通道
- worker mailbox、lead 协调请求、运行中 `/swarm replan` 和作用域内 `swarm_fs`
- 可选 `--best-of N` 同题候选竞争，只读 reviewer 选择后再进入 candidate 验证轨道
- worker/集成两级验证；验证命令使用 `shell:false`、语法门和前缀 allowlist
- pause、持久化预算、单 worker detach、kill 使用统一控制屏障；活动工具不计入 stall，真正静默时先 steer 一次再失败
- dashboard、widget、报告 renderer、运行 entry、案例库和日志回放
- 默认 `branch` 落地；仅干净且未漂移的主工作区允许 `apply`

## 安装

**一步到位（推荐）：**

```bash
pi install npm:pi-capstan
```

然后重启 Pi（或执行 `/reload`）。这是唯一必需的步骤——**零配置即可用**：安全默认值始终开启（branch 优先落地、美元与 token 双预算、计划确认门、越界自动回滚、验证门控）。想调优时再运行 `/swarm config`，大多数 run 完全不需要。

**从源码（开发模式）：**

```bash
git clone https://github.com/Yongthyuan/pi-capstan && cd pi-capstan && npm ci
pi --no-extensions -e /absolute/path/to/pi-capstan/index.ts
```

也可以通过软链接到 `~/.pi/agent/extensions/swarm` 实现用户级自动发现。扩展根入口是 `index.ts`。

## 使用

```text
/swarm "实现 OAuth 服务端、前端登录页、测试和文档"
/swarm "任务" --force --max 4 --budget 8 --model provider/model
/swarm "高风险任务" --force --best-of 2
/swarm "任务" --plan-only
/swarm board
/swarm pause | resume [runId] | abort
/swarm replan
/swarm merge [runId] | clean | replay <runId>
/swarm pr [runId]
/swarm cases [rate <id> +1|-1 | delete <id>]
/swarm config | validate | analyze | status
```

Pi 主模型也可以调用 `swarm_delegate` 工具，但不会绕过人工计划确认。

`/swarm pr [runId]` 会再次确认，然后只推送 last-green integration branch 并通过 GitHub CLI 创建 PR；本地 RPC 日志、session 和 report 正文不会被放进 PR。远端 CI 仍由目标仓库自己的规则决定。

## 文档

**给 Claude 和开发者**：完整的文档位于 [`docs/`](./docs/) 目录：

- **[docs/README.md](./docs/README.md)** - 从这里开始：快速参考、常见模式和 Claude 使用指南
- **[docs/DESIGN_PHILOSOPHY.md](./docs/DESIGN_PHILOSOPHY.md)** - Agent 可配置 Swarm 的设计哲学
- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** - 全部 51 个配置叶子键的契约
- **[docs/EXTENSION_POINTS.md](./docs/EXTENSION_POINTS.md)** - 自定义 guard（支持）与插件的诚实边界
- **[docs/PLUGINS.md](./docs/PLUGINS.md)** - 可选插件 API，不是主路径

这些文档让 Claude 能够阅读、理解和定制 swarm 行为，根据项目需求生成合适的配置和扩展。

在 Pi 内可用 `/swarm config`（向导）、`/swarm validate`、`/swarm analyze` 生成、校验并改进项目配置。

## 配置

合并顺序：内置默认值 → `~/.pi/agent/swarm.json` → `<repo>/.pi/swarm.json` → 命令行 flags。

完整细节和常见配置模式请参考 [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)。

安全默认值：

- `mergeStrategy: "branch"`
- `caseStore.enabled: true`，仅写入用户本机 agent 目录，并对常见凭据做脱敏
- `failurePolicy: "continue-independent"`
- `worker.shareDependencyDirs: ["node_modules"]`；POSIX 使用 symlink，Windows 使用 junction
- `worker.setupCommands: []`；仅受信任项目可执行，且受独立 allowlist 与超时约束
- `worker.scopeViolationPolicy: "revert"`；越界路径不会消耗整个任务成果
- `worker.strictBash: false`；可选开启后追加拦截内联解释器代码（`python -c`、`node -e`、shell `-c`、`find -exec/-delete`），代价是部分合法单行命令也会被拦截
- 默认预算为 planner `$1/160K tokens`、worker `$2/250K`、run `$8/1M`
- worker 仅加载明确列出的工具和守卫扩展
- planner 只能选择 `run.verifyAllowedPrefixes` 中的验证命令；管道、重定向、命令替换和多行命令会被拒绝
- planner 和 worker 都有调用超时、token 与美元预算；planner 使用量计入 run 总量
- 预算越界先中断当前模型回合，再由用户选择扩容或停止整个 run
- `--best-of N` 会线性增加模型成本，默认仍为 `1`
- dirty baseline 的结果永不自动 apply
- RPC 日志默认去除 prompt、命令正文和常见凭据；logs/session 默认分别保留 14/30 天
- state 使用原子写入和 `state.prev.json` 回退；损坏状态会在 session 启动时显式告警

可在 Pi 中运行 `/swarm config` 写项目配置。

## 测试

```bash
npm install
npm run check
npm test
npm run test:native
npm run test:soak [次数] [name-pattern]
```

`test:native` 使用临时 `PI_CODING_AGENT_DIR`，模拟 `~/.pi/agent/extensions/swarm/` 自动发现，并通过 Pi RPC 验证 `/swarm` 注册、guard、mailbox/安全文件工具的加载和命令处理；不会修改真实的 `~/.pi`。`test:soak` 会重复运行整个套件，暴露单次 green 掩盖的时序波动。CI 在每次 push 时运行 Linux 与 Windows 矩阵，并每日跨平台 soak。

使用已经认证的真实模型运行可选 canary：

```bash
PI_SWARM_TEST_MODEL=provider/model npm run test:native:plan
PI_SWARM_TEST_MODEL=provider/model npm run test:native:model
PI_SWARM_TEST_MODEL=provider/model npm run test:native:e2e
```

前两个命令分别验证真实 planner 和真实 worker；`test:native:e2e` 从原生 `/swarm` 命令贯通计划确认、两个真实 worker、候选验证、推进 integration 和报告状态。测试都会清理临时仓库，但 Pi 可能更新自身的短时认证锁文件。

## 安全边界

Git worktree 是并发隔离，不是操作系统安全沙箱。scope guard、bash denylist、扩展隔离、安全验证执行器和合并前 diff 检查用于防误操作，但项目测试脚本本身仍会执行代码。对恶意仓库、脚本或提示词必须使用独立容器或 OS 沙箱，并隔离网络和凭据。

## 为什么叫 Capstan

绞盘能把一个人的拉力放大成数吨的可控力量，而棘爪保证载荷永不倒滑。这正是本项目的全部论点：多只手（并行 worker），一个绞盘（编排器），完全可控（门控、预算、计划确认、可回退合并）。

## 许可证

[MIT](./LICENSE)
