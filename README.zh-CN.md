# Capstan · Pi 多智能体编码编排

**并行修改代码，逐项核对交付。**

[![npm](https://img.shields.io/npm/v/pi-capstan?color=38bdf8)](https://www.npmjs.com/package/pi-capstan)
[![CI](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml/badge.svg)](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-34d399)](./LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-extension-a78bfa)](https://pi.dev/packages)

[English](./README.md) · [验证证据](./docs/evidence/v0.11.0/README.md) · [配置](./docs/CONFIGURATION.md)

Capstan 是 [Pi coding agent](https://github.com/earendil-works/pi) 的多智能体编码扩展：先审计划，再让多个 subagent 在独立 Git worktree 中并行工作，最后核对集成分支上的修改、检查结果和提交记录。规划与 worker 复用你在 Pi 中选择的模型及认证。

![Capstan：审阅计划、并行 worker、候选分支检查与交付证据](./docs/assets/capstan-overview.png)

## 快速开始

需要 **Node.js ≥22.19、Pi ≥0.84.1**，并在 Git 仓库中使用。

```bash
pi install npm:pi-capstan
```

重启 Pi，通过 `/login` 和 `/model` 配置模型，然后运行：

```text
/capstan "增加 CSV 导出接口，实现下载按钮，并更新接口文档"
```

先检查任务拆分、依赖关系和文件归属，批准后 worker 才启动。规划阶段可能已经产生模型用量。用 `/capstan board` 看进度，结束后审阅集成分支和报告，再用 `/capstan pr` 创建 PR。

无需另存一份 API 密钥。显式模型配置必须能在 Pi 中解析且已认证，配置错误会停止运行。[模型与预算配置 →](./docs/CONFIGURATION.md)

## 可以直接核对的特性

| 特性 | 解决的问题 | 实现与验证 |
|---|---|---|
| 人工审批计划 | 开工前审阅任务依赖、文件归属 | [计划校验](./src/plan-validation.ts) · [生命周期测试](./test/worker-orchestrator.test.ts) |
| 独立 Git worktree | 分开并行 worker 的工作区，并限制修改范围 | [工作区实现](./src/workspace.ts) · [范围与安全测试](./test/resilience-security.test.ts) |
| 候选分支晋升 | 先在 candidate 合并、检查，再推进集成分支 | [编排器](./src/orchestrator.ts) · [恢复测试](./test/recovery-hardening.test.ts) |
| 带验证证据的 PR | 逐项列出任务检查、提交 SHA、最终检查和待复核项 | [PR 示例](./docs/evidence/v0.11.0/after-pr.md) · [报告测试](./test/reporter.test.ts) |
| 用量预算与恢复 | 统计用量、限制后续执行，恢复中断的 run | [配置](./docs/CONFIGURATION.md) · [状态存储](./src/state.ts) |
| Pi 原生模型选择 | 规划与 worker 使用 Pi 已配置的供应商及认证 | [模型策略](./src/model-policy.ts) · [模型测试](./test/model-policy.test.ts) |

适合能按文件或模块拆分、且具有有效项目检查的任务。Git worktree 分离 Git 状态，不提供操作系统级安全沙箱；预算控制依赖已返回的用量，美元费用是估算值。

## v0.11.0 前后对比

**同一输入，核对交付结论。** 将固定的合成 run 分别交给已发布 v0.10.0 和新版报告器：两个任务均已合入，但任务、候选分支、最终集成的检查全部跳过。

![前后对比：旧版报告完整，新版明确验证不完整并要求复核](./docs/assets/verification-before-after.png)

| 项目 | v0.10.0 | v0.11.0 |
|---|---|---|
| 所有检查跳过 | PR 仍写 “Merged verified subtasks” 和 “Result: complete” | 明确 “verification incomplete”，列出待复核原因 |
| 最终检查缺失 | 根据 run 状态标记结果完整 | 缺少证据时不能给出完整验证成功结论 |
| 审阅内容 | 已合入任务名称 | 各任务检查、candidate/晋升 SHA、最终集成检查 |
| 本地自动测试 | 已发布 tag 上 61 项通过 | 此次发布 80 项通过 |

这是可复现的报告行为对照，**不是模型性能提升测评**。两版测试数量来自不同测试集，不代表覆盖率。[输入、原始输出、正向对照与复现方法 →](./docs/evidence/v0.11.0/README.md)

另有一次真实 DeepSeek 冒烟：从失败测试开始，两个 Pi worker 实现两个小模块，集成分支测试通过；**17 个 worker 回合、21,532 个 token，估算 $0.0208**。它来自已记录的开发源码快照，只是一项合成任务。此前规划冒烟完成 **4/10 案例**，后续 OAuth 计划仍因不安全命令语法被拒绝；复杂规划仍有局限。[完整验收记录 →](./docs/validation-2026-09-09.md)

## 常用命令

```text
/capstan "任务"                       提出计划，审批后启动
/capstan "任务" --plan-only           只看计划
/capstan board                       查看进度
/capstan pause | resume | abort       控制运行
/capstan replan                       提议追加任务
/capstan merge | clean | replay       管理已结束的运行
/capstan pr [runId]                   推送集成分支并创建 PR
/capstan config | validate | status   配置、校验和状态
/capstan cases                       查看和评价历史运行
```

Pi 还可以通过 `capstan_delegate` 工具进入同一审批流程。支持 `--force`、`--max 4`、`--best-of 2` 等选项，详见[命令文档](./docs/README.md)。

## 文档与开发

- [交付证据](./docs/EVIDENCE.md)：Proof-Carrying PR 指随附检查记录，不是形式化证明
- [配置说明](./docs/CONFIGURATION.md)：模型、并发、预算、验证与合并策略
- [设计](./docs/DESIGN_PHILOSOPHY.md) · [扩展](./docs/EXTENSION_POINTS.md) · [插件](./docs/PLUGINS.md)
- [示例](./docs/examples/README.md) · [基准协议](./scripts/bench/README.md) · [更新日志](./CHANGELOG.md)

```bash
git clone https://github.com/Yongthyuan/pi-capstan.git
cd pi-capstan
npm ci
npm run check
npm test
npm run test:native       # 离线：Pi 命令注册与受限 worker 启动
npm run evidence:compare  # 离线：重新生成前后对比
pi -e ./index.ts
```

真实模型验收会产生供应商用量，按需执行：

```bash
PI_CAPSTAN_TEST_MODEL=deepseek/deepseek-v4-flash npm run test:native:e2e
```

CI 在 push 时检查 Linux 与 Windows，另有定期 soak。当前 UI 中英文混用。欢迎在 [Issues](https://github.com/Yongthyuan/pi-capstan/issues) 中附上任务、版本、模型/供应商、检查结果及脱敏复现步骤。

Capstan 意为绞盘，曾用名 `pi-agent-swarm`。[MIT 许可证](./LICENSE)。
