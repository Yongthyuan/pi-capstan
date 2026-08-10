# Pi Agent Swarm

Pi Agent Swarm 是一个面向 `@earendil-works/pi-coding-agent` 0.84.1 的原生多智能体扩展。它通过 `/swarm <task>` 完成复杂度门控、证据化拆解、计划确认、Git worktree 并行执行、验证、合并、恢复和报告回注。当前版本为 `0.3.0`，定位是可受控自用的 beta，而不是不可信代码的安全沙箱。

## 当前实现

- 两层复杂度门控与 `--force` / `--solo` / `--plan-only`
- 读取 tracked/untracked 文件、manifest、符号/测试结构和带行号相关源码的 planner scout
- 严格 SwarmPlan 校验：DAG、拓扑 mergeOrder、契约和路径所有权
- 原生 `pi --mode rpc` worker、JSONL、usage、steer/abort、UI 审批转发
- worker 扩展隔离：`--no-extensions`，显式 safety guard + scope guard
- 仓库级跨进程 lease、PID 启动身份校验、心跳式孤儿 worker 回收和幂等 `/swarm resume`
- Git worktree、临时 dirty baseline、last-green candidate 合并、冲突仲裁和集成 fixer
- worker/集成两级验证；验证命令使用 `shell:false`、语法门和前缀 allowlist
- pause、持久化预算、受保护 detach、kill 使用统一控制屏障；stall 先 steer 一次，再确定性失败
- dashboard、widget、报告 renderer、运行 entry、案例库和日志回放
- 默认 `branch` 落地；仅干净且未漂移的主工作区允许 `apply`

## 安装

开发时直接加载：

```bash
npm ci
pi --no-extensions -e /absolute/path/to/pi-swarm/index.ts
```

用户级自动发现：

```bash
ln -s /absolute/path/to/pi-swarm ~/.pi/agent/extensions/swarm
```

然后在 Pi 中执行 `/reload`，或重新启动 Pi。也可以复制整个目录，扩展根入口是 `index.ts`。

## 使用

```text
/swarm "实现 OAuth 服务端、前端登录页、测试和文档"
/swarm "任务" --force --max 4 --budget 2 --model provider/model
/swarm "任务" --plan-only
/swarm board
/swarm pause | resume | abort
/swarm merge | clean | replay <runId>
/swarm cases [rate <id> +1|-1 | delete <id>]
/swarm config | status
```

Pi 主模型也可以调用 `swarm_delegate` 工具，但不会绕过人工计划确认。

## 配置

合并顺序：内置默认值 → `~/.pi/agent/swarm.json` → `<repo>/.pi/swarm.json` → 命令行 flags。

安全默认值：

- `mergeStrategy: "branch"`
- `caseStore.enabled: false`
- worker 仅加载明确列出的工具和守卫扩展
- planner 只能选择 `run.verifyAllowedPrefixes` 中的验证命令；管道、重定向、命令替换和多行命令会被拒绝
- planner 和 worker 都有调用超时、token 与美元预算；planner 使用量计入 run 总量
- 预算越界先中断当前模型回合，再由用户选择扩容或停止整个 run
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
```

`test:native` 使用临时 `PI_CODING_AGENT_DIR`，模拟 `~/.pi/agent/extensions/swarm/` 自动发现，并通过 Pi RPC 验证 `/swarm` 注册和命令处理；不会修改真实的 `~/.pi`。

使用已经认证的真实模型运行可选 canary：

```bash
PI_SWARM_TEST_MODEL=provider/model npm run test:native:plan
PI_SWARM_TEST_MODEL=provider/model npm run test:native:model
PI_SWARM_TEST_MODEL=provider/model npm run test:native:e2e
```

前两个命令分别验证真实 planner 和真实 worker；`test:native:e2e` 从原生 `/swarm` 命令贯通计划确认、两个真实 worker、候选验证、推进 integration 和报告状态。测试都会清理临时仓库，但 Pi 可能更新自身的短时认证锁文件。

## 安全边界

Git worktree 是并发隔离，不是操作系统安全沙箱。scope guard、bash denylist、扩展隔离、安全验证执行器和合并前 diff 检查用于防误操作，但项目测试脚本本身仍会执行代码。对恶意仓库、脚本或提示词必须使用独立容器或 OS 沙箱，并隔离网络和凭据。
