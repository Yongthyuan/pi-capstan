# Capstan

> **Many hands. One winch. Total control.**
> 绞盘：一人摇柄，众人推杆，千斤锚分节离底，棘爪落下绝不倒滑。

[![CI](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml/badge.svg)](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-58A6FF.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-3FB950.svg)](./package.json)
[![Pi](https://img.shields.io/badge/Pi-%E2%89%A50.84.1-8957E5.svg)](https://github.com/badlogic/pi-mono)

[English](./README.md)

**Capstan 让多个 AI 编码智能体同时在你的仓库上干活——而方向盘始终在你手里。** 开工前先给你审计划，每个 worker 隔离在独立的 Git worktree 里，花费有硬性上限，只有通过验证的结果才会被合并。它是 [Pi](https://github.com/badlogic/pi-mono) 的扩展，曾用名 *pi-agent-swarm*。

<!-- 录好演示动图后放到 docs/assets/demo.gif，然后取消注释：
<p align="center"><img src="docs/assets/demo.gif" alt="Capstan: 计划 → 确认 → 并行 worker → 验证合并" width="720"></p>
-->

## 问题所在

一个 agent 干活慢；五个 agent 一起干是灾难：改同一批文件、互相踩测试、token 花了多少没人知道，半成品直接落到你的分支上。

Capstan 的答案是流水线，而不是放羊：

```text
/capstan "实现 OAuth 服务端、登录页、测试和文档"
   │
   ├─ 1. 门控      琐碎请求？直接单线程跑——不开群，不多花钱
   ├─ 2. 计划      planner 读取仓库，提出任务 DAG
   ├─ 3. 确认      你审计划（任务、顺序、验收标准）——此时一分钱没花
   ├─ 4. 建造      最多 8 个 worker，各自拥有独立 Git worktree 和文件所有权
   ├─ 5. 验证      worker 产出和合并结果都要通过白名单命令的检查
   └─ 6. 落地      last-green 结果合并到集成分支；你说了算才发 PR
```

## 快速开始

```bash
pi install npm:pi-capstan
```

重启 Pi，然后正常说话：

```text
/capstan "实现 OAuth 服务端、登录页、测试和文档"
```

你会先看到计划。批准它，看 worker 在 dashboard 上铺开；拒绝它，一分钱不花。**零配置即可用**——安全默认值始终开启。想调并发、预算或验证时再运行 `/capstan config`；大多数人从来不需要。

## 你能得到什么

- **没有你的同意，什么都不开工。** 每个 capstan 先产出可审阅的计划并等待确认；拒绝零成本。
- **worker 永不打架。** 每个任务在自己的 Git worktree 里工作，文件所有权明确声明；越界改动被精确回滚——其余成果原样保留。
- **花费双重封顶。** worker 级和 run 级的美元与 token 预算会拦住失控回合，而不是给你的账单制造惊喜。
- **绿色就是真绿。** 结果要过两级验证（任务级 + 集成级），验证命令只允许白名单前缀。
- **失败只影响局部。** 一个任务挂了不会拖垮独立任务；崩溃的会话从断点恢复；孤儿 worker 会被回收。
- **小事保持便宜。** 复杂度门控把简单请求路由到单线程模式，不为琐事开群。不服？`--force`。

## Capstan 与委派类工具的区别

Pi 生态里有优秀的*委派*扩展——父 agent 请子 agent 思考、审查、调研。Capstan 解决的是另一件事：**多个 agent 安全地并行修改你的仓库。**

| | 委派式 subagents | Capstan |
|---|---|---|
| 擅长 | 思考、审查、答疑 | 建造——并行改代码 |
| 隔离 | 共享工作区，因工具而异 | 每任务独立 worktree，强制执行 |
| 成本 | 通常无人统计 | 硬预算 + 实时记账 |
| 落地 | 模型做了什么就是什么 | 验证后 branch 优先合并，由你掌控 |

## 命令

```text
/capstan "任务"                      启动 capstan（可加 --force --max 4 --best-of 2 --plan-only）
/capstan board                       实时看板
/capstan pause | resume | abort      控制运行中的 capstan
/capstan replan                       运行中追加任务
/capstan merge | clean | replay      落地或清理已结束的 run
/capstan pr [runId]                  推送集成分支并创建 PR
/capstan cases                       浏览/评分历史 run（改进未来规划）
/capstan config | validate | status  配置、检查配置、查看状态
```

程序化委派同样是一等公民：Pi 主模型可以调用 `capstan_delegate` 工具，它走的和其他一切一样的计划确认门。

## 安全默认值（始终开启）

Branch 优先落地（绝不自动 apply 到主工作区） · 计划确认门 · worker 与 run 双级美元/token 预算 · 越界自动回滚 · 两级验证 + 命令前缀白名单 · worker 扩展隔离 · 日志与案例库凭据脱敏 · 原子状态写入与断点恢复。

Git worktree 隔离的是并发冲突，而不是恶意代码。信任你的仓库，这套默认值就足够兜底；不信任？请把 Capstan 关进容器里运行。

## 文档

- **[docs/README.md](./docs/README.md)** — 从这里开始：快速参考与常见模式
- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** — 全部 51 个配置键（等你超出默认需求再看）
- **[docs/DESIGN_PHILOSOPHY.md](./docs/DESIGN_PHILOSOPHY.md)** — 为什么这样设计
- **[docs/EXTENSION_POINTS.md](./docs/EXTENSION_POINTS.md)** · **[docs/PLUGINS.md](./docs/PLUGINS.md)** — guard 与插件
- **[docs/examples/](./docs/examples/)** — 可直接复制的配置和插件示例

## 开发

```bash
npm ci
npm run check        # 类型 + 语法
npm test             # 单元测试
npm run test:native  # 真实 Pi RPC 冒烟
```

CI 在每次 push 时跑 Linux + Windows 矩阵，另有每日跨平台 soak。

## 为什么叫 Capstan

绞盘能把一个人的拉力放大成数吨的可控力量，而棘爪保证载荷永不倒滑。多只手（并行 worker），一个绞盘（编排器），完全可控（门控、预算、计划确认、可回退合并）。

## 许可证

[MIT](./LICENSE)
