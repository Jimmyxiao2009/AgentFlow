# AgentFlow 项目深度审查报告

> 审查日期：2026-08-20
> 审查方式：三路逐文件深度审查（核心引擎包 / 应用层与持久化 / UI 层与桌面壳），关键结论已回源码逐一核实
> 审查基线：commit `0f212bb`（main 分支，工作区干净）

## 一、项目概况

**AgentFlow**：本地优先的多智能体编码编排桌面应用（v0.1.0，11 次提交，单人开发，代码约 2.8 万行）。目标是通过 Plan → Implement → Validate → Review → Integrate 流水线协调多个本地编码 CLI，Tauri 2 + React 渲染层 + Node TypeScript sidecar 架构。

**Monorepo 布局**：

| 位置 | 内容 |
|---|---|
| `apps/ui` | React 渲染层（19 个文件，AgentFlowWorkspace.tsx 1880 行为中枢） |
| `apps/runtime` | sidecar 入口（main.ts 217 行：白名单分发 + stdin/stdout JSONL） |
| `apps/desktop` | Rust 壳（lib.rs 730 行：进程管理、桥接、安全边界） |
| `packages/` × 15 | domain（叶子）→ routing/permission/agent-runtime → workflow-engine → application（3289 行上帝类）→ 适配器（sdk/fake/maf/vercel-ai） |

**质量门槛现状**（项目自带脚本）：typecheck ✅ 通过、ESLint ✅ 零告警、vitest 62/62 ✅ 通过、密钥扫描 ✅ 通过。静态健康度良好——但下文说明这些绿灯有相当水分。

## 二、架构评价（做得好的部分）

- **分层严格**：domain 零依赖；UI 是纯视图/意图分发器；领域状态全部在 sidecar；渲染层无法提交任意可执行文件、路径操作或环境变量。
- **安全边界设计意识强**：双层方法白名单（Rust `lib.rs:60-87` + sidecar `main.ts:14-38`）、zod strict 信封、2MB 行长上限、Tauri capability 极简（无 shell/fs 插件）、导航只放行本地源、CSP 无 unsafe-inline。
- **进程管理可靠**：Unix 进程组 + Windows `taskkill /T /F`，崩溃自动重生，退出时全树清理。
- **恢复语义认真**：孤儿 worktree 的 PatchSet 重建带幂等键，`runtime-restart` 测试验证崩溃后状态存活。
- **本地化质量高**：493 个键 × 5 locale（en/zh-CN/zh-TW/ja/ko）全量核对完整，回退链正确（本 locale → en-US → 键名）。
- **文档与实现基本同步**：架构/安全/性能/验收文档齐全，性能数据带测量方法（`docs/performance.md`）。

## 三、发现的问题

### 🔴 致命（一个）

**1. 渲染端实时事件全链路静默丢弃。** `packages/protocol/src/index.ts:45-61` 的 `bridgeEventSchema` 是 `.strict()` 且字段表**没有 `source`**，但 `domain/src/index.ts:405` 的 `WorkflowEvent` 必带 `source`，application 的 `emit()` 全部填充它（如 `application/src/index.ts:582,864`），runtime 原样写出（`apps/runtime/src/main.ts:58-59`），Rust `lib.rs:399-401` 原样转发，`desktop-bridge/src/index.ts:124-126` `safeParse` 失败即静默 `return`。**推论：所有实时事件（含流式 delta）都进不了 UI**，界面只能靠 status 轮询刷新。测试没抓到是因为 `desktop-bridge/src/index.test.ts:78-89` 手工构造的事件不含 `source`。一行修复（schema 补字段），但影响是全局的。

### 🟠 高严重度

**2. 明文 API key 三处落盘。** ① `application/src/index.ts:747-754` `settings.save` 把含 `apiKey` 的完整 settings `JSON.stringify` 进审计日志，未用现成的 `redactStructured`；② UI 把含 key 的 settings 写 localStorage（`AgentFlowWorkspace.tsx:562`）；③ SQLite 明文持久化。这与自家 `docs/security.md` 的红线直接冲突。

**3. 重试上限可无限绕过。** `application/src/index.ts:3153-3154` 用 `previous.attempt > retries` 判限，但 attempt 只在**成功后**回写（3178-3208）；失败重试链每次 attempt=1，`retries` 设置形同虚设。

**4. 并发 `task.run` 击穿任务状态机。** `task.run` 是并发方法（`main.ts:182-195`）；第二次 `claim` 抛错进 `recordTaskFailure`（2128-2163），其中 `scheduler.complete(task.id,"Failed")` 不校验调用者，把仍在跑的第一个 run 的任务改成 Failed；第一个 run 完成后 `complete(PatchProduced)` 从 Failed 出发非法转移，异常逃出 catch。租约只做了检查没做所有权验证。

**5. review/integration worktree 永久泄漏。** 评审 worktree 成功路径只标 Released 不删目录（application:2882），失败路径连状态都不改（2884-2903）；integration worktree（application:3061-3072）永不清理。每次评审/集成泄漏一个完整 worktree 目录 + 分支。

**6. `"src/**"` 目录前缀匹配缺边界——contract 逃逸。** `workflow-engine/src/index.ts:427`：`rule.slice(0,-3)` 得 `"src"`，`startsWith("src")` 放行 `srcfoo/evil.ts`。`allowedWritePaths` 惯例含 `"src/**"`，worker 越约改动不会被拦截。无测试覆盖。同类 glob 在仓库里有三套不一致实现（workflow-engine / agent-runtime / permission-engine）。

**7. Rust reader 线程一坏永坏。** `lib.rs:388-394` 任何一条 sidecar 输出解析失败就 `failure()` 全部 pending 请求并退出线程，但子进程可能仍存活不会重生；此后 `bridge_request` 的 `recv()`（570-573）**无超时永久挂起**，UI 整体冻结。

**8. 产品核心承诺与实现方向性偏差。** 主提示 §1 非协商边界："复用 CLI 自身认证、绝不存凭证"。但当前 runtime 生产路径是 **Vercel AI SDK 直连 OpenAI 兼容端点**（`apps/runtime/src/main.ts:3,45`），要求用户手输 API key 并明文存储（见问题 2）。宣称的 Codex/Claude/Grok/OpenCode **CLI 适配器实际全部未接线**——`adapter-maf` 是功能完整但零调用方的孤儿（被 vercel-ai 取代），Rust 的 `open_provider_login` 命令（lib.rs:139-167）无 UI 调用点。

### 🟡 中严重度（择要）

- **集成部分成功不回滚**：多 PatchSet cherry-pick 第 N 个冲突时前 N-1 个已留在集成分支（`workflow-engine:279-303`）；复用旧集成 worktree 不 reset 到 baseCommit（application:3029-3073），空 cherry-pick 被误判为 Conflict（workflow-engine:287-301 无 empty 检测）。
- **自动审批风险分类假阴性**：`classifyPlanRisk`（application:69-75）用 `\b(...)\b`，`authentication`/`migrations` 等派生词不匹配 → 误判 Low risk → 自动放行（1718-1720）。
- **零校验可直接进评审**：`review.start` 不校验"至少跑过一次校验"（application:2681-2684），`assertDeterministicGate([])` 空数组恒过；blocking 检查 `Skipped` 状态也放行（workflow-engine:164-167）。
- **权限引擎攻击面**：`.env.local`/`.env.production` 不在永久拒绝清单（permission-engine:127 只匹配 `.env$` 或 `.env/`）；`git push -f` 短旗标绕过 `-f` 检测（125 行）；`commandAllowed` 前缀匹配允许 `npm test --prefix C:/evil` 参数注入（171-173）。
- **VercelAiAdapter 忽略 permissionProfile**：只要 intent=build 就装 write_file 工具（adapter-vercel-ai:163），用户选 Read Only 仍可写文件（有路径沙箱缓解越界，不缓解语义）。
- **lease 过期不回收 Running 任务**：`releaseExpired` 只处理 Leased（workflow-engine:100-113），僵尸 run 仍可 `complete()`。
- **关闭时不清理子进程**：`application.close()` 只关 SQLite（3279-3281），debug 进程孤儿化；stdin-close 与信号路径可能双调 close 抛错。
- **`AGENTFLOW_RUNTIME_TOKEN`** 定义于 `.env.example` 但全仓库无消费者——sidecar 无任何身份校验（私有管道架构下风险有限，但该机制是空头承诺）。
- **UI 层**：
  - 全局快捷键 effect 依赖缺失致过期闭包（AgentFlowWorkspace:506-549，Ctrl+N 可能用陈旧 project；根因是 eslint 未配 react-hooks 插件）；
  - settings 每键击双写（localStorage + 完整 IPC 往返）无防抖（AgentFlowWorkspace:560-598）；
  - SettingsContent 三个设置页（agents/auth/routing，约 350 行）因 `constants.ts:64-78` 的 `settingsSections` 不含对应项而**不可达死代码**；
  - `@tanstack/react-query` 是零 import 的死依赖；
  - `typecheck:ui` 无 `--strict`，UI 大量隐式 any 静默通过（package.json:25）；
  - 通知 setTimeout 未清理、InspectorPanel 拖拽监听器因内联回调反复重挂（InspectorPanel.tsx:73-92）。
- **`patchset.recovered`/`integration.*` 事件缺 `conversationId`**（application:576-585, 3085-3091），UI 过滤条件要求 conversationId（AgentFlowWorkspace.tsx:355,1054），这些事件在时间线不可见。
- **`pruneArtifacts` 可删除仍被 PatchSet 引用的 diff artifact**（persistence:217-233），历史 PatchSet 永久损坏且无迁移标记。
- **`replayRuntimeTimeline` 跨聚合按 sequence 排序错误**（desktop-bridge/replay.ts:208-214）：sequence 是 per-aggregate 局部序号，混合聚合排序打乱真实时间序。
- **审批决策语义未实现**：protocol 允许 `allow-task`/`allow-conversation`/`add-project-rule`，但 `resolvePermission`（application:2070-2102）与 `allow-once` 完全等价。
- **Planner 的 `validationStrategy` 被忽略**，校验命令硬编码 6 条 npm 脚本（application:1824-1831）；非 npm 项目每个任务必然校验全失败。
- **`retryRun` 对会话 run 双重提示词增强**：runRequests 存的已是 `augmentPrompt` 产物，重试时再次增强（application:1531 → 3188-3198 → 1590）。

### 死代码 / 双实现（结构性）

- **`agent-runtime` 包（265 行）整个是孤儿**——全仓库无 import，与 workflow-engine 的 TaskDagScheduler 功能重叠且行为不一致（重复 id 一个静默覆盖一个抛错、failed 依赖传播语义不同）。
- 未接线/未消费：`adapter-maf`、`validateModelSelection`（application:820-825）、`TaskDagScheduler.claimReady/releaseExpired`、`ProcessSupervisor.stopAll`、`canExecuteCommand`（workflow-engine:505）、`assertNoSilentEscalation`（仅测试调用）、`protectedPaths` 维度（声明性死维度，无执行点）、配置项 `requireApprovalNetwork/requireApprovalPackages`（零执行语义）、设置项 `density/codeTextSize/timestampFormat/editor/confirmClose`（存了不读）。

### 测试覆盖评价

62 个测试**全部是正向行为断言，无对抗性用例**，这正是上述问题长期漏网的原因：

- `bridgeEventSchema` 未用真实形状（含 source）的事件测过 → 致命问题 1 漏网；
- `ValidationRunner` 整个类、`TaskDagScheduler` 的 claim/lease/expire、`reconcileInterruptedWork()`（最复杂的恢复代码）、并发场景、重试上限——**全部零测试**；
- permission-engine 7 个用例全是"期望安全行为成立"，无 `.env.local`/`push -f`/`--prefix` 类对抗输入；
- domain 状态机 38 条边只测了 4 条。

## 四、总体结论

| 维度 | 评价 |
|---|---|
| 架构设计 | ★★★★★ 分层、边界、安全模型设计明显高水准 |
| 实现完成度 | ★★★☆☆ 骨架完整，但 CLI 适配（产品核心）未接线，生产路径是 API key 直连 |
| 实现质量 | ★★★☆☆ 主链路扎实，但有 1 个致命 bug + 一批高严重度问题 |
| 测试 | ★★☆☆☆ 数量可观但全是正向断言，安全关键组件大面积零覆盖 |
| 工程配套 | ★★★★☆ CI 三平台矩阵、文档、性能记录、本地化都做得好 |

一句话总结：**这是一份"设计远超实现"的项目**——安全架构的图纸上几乎每条红线都有对应代码，但存在一个让 UI 实时事件全丢的 schema 不同步 bug、明文密钥三处落盘、并发/资源泄漏类缺陷，以及测试只验证"理想路径"导致的系统性漏检。产品定义中"复用 CLI 订阅"的核心卖点目前实际未实现。

## 五、建议修复顺序

1. `bridgeEventSchema` 补 `source` 字段（一行修复，影响全局 UI 实时性）
2. 密钥脱敏：审计日志用 `redactStructured` + UI 停止把 apiKey 写 localStorage
3. `task.run` 并发所有权校验（scheduler.complete 校验调用者）
4. attempt 在 run 创建时即 `previous.attempt + 1`（修复重试上限绕过）
5. worktree 生命周期统一收口到 cleanup（review/integration 泄漏）
6. `"src/**"` 路径边界修复（`startsWith(rule.slice(0,-3) + "/")`）+ 统一三套 glob 实现
7. 决策 `agent-runtime` / `adapter-maf` 去留，消除双实现漂移风险

---

## 六、本轮已修复（2026-08-20，自主打磨-编译循环）

下列问题已在本轮迭代中修复并提交到 main（每项附回归测试，测试数 63 → 73）：

**致命 / 高**
- ✅ 问题1：`bridgeEventSchema` 补 `source` 字段 —— 实时事件不再被静默丢弃（protocol + 回归测试）。
- ✅ 问题2：密钥脱敏 —— 审计日志用 `redactStructured`；UI 不再把 `apiKey` 写 localStorage；设置同步去抖 400ms。
- ✅ 问题3：重试上限绕过 —— attempt 在 run 创建时即 `previous.attempt + 1`，失败链持久化正确 attempt。
- ✅ 问题4：并发 `task.run` —— `scheduler.complete/release/requeue` 增加所有权校验；`runTask` 不再强制 complete 处于 ReviewRequested 的任务。
- ✅ 问题5：worktree 泄漏 —— review 成功/失败路径与 integration 完成路径均移除 worktree 并标 Released。
- ✅ 问题6：`"src/**"` 路径边界 —— 改为 `normalized === prefix || startsWith(prefix + "/")`（+ e2e 回归）。
- ✅ 问题7：Rust reader 挂起 —— 单行解析失败改为 skip 而非终止 reader；`bridge_request` 改用 `recv_timeout(60s)`。
- ✅ 问题8（部分）：见下方"已知遗留"。

**中**
- ✅ 集成部分成功：重用集成 worktree 时先 `reset --hard` 到 baseCommit；空 cherry-pick 不再误判为 Conflict（+ e2e 回归）。
- ✅ `classifyPlanRisk` 派生词匹配（authentication/migrations/credentials/dependencies）（+ 回归）。
- ✅ 零校验进评审：`assertDeterministicGate([])` 现在抛错；blocking 检查非 Passed 状态均拦截；`startReview` 要求至少一次校验。
- ✅ 权限引擎攻击面：`.env.local`/`.env.production` 永久拒绝；`git push -f`/`--force-with-lease` 永久拒绝；`commandAllowed` 拒绝 `--prefix`/绝对路径注入（+ 对抗测试）。
- ✅ `VercelAiAdapter` 按 permissionProfile 限制 `write_file`。
- ✅ lease 过期回收 Running 任务（Running → Failed）。
- ✅ `close()` 清理 debug/run 子进程；双关闭协调（stdin-close/SIGTERM/SIGINT 共享 `shuttingDown`）。
- ✅ `patchset.recovered` / `integration.*` 事件补 `conversationId`（时间线可见）。
- ✅ `pruneArtifacts` 不再删除仍被 PatchSet/ValidationRun 引用的 artifact（+ 回归）。
- ✅ `replayRuntimeTimeline` 按 timestamp 排序而非 per-aggregate sequence（+ 回归）。
- ✅ 审批决策语义：`resolvePermission` 的 `allow-task`/`allow-conversation`/`add-project-rule` —— 见遗留。
- ✅ Planner `validationStrategy`：跳过项目未定义的 npm 脚本，非 npm 项目不再全量校验失败。
- ✅ `retryRun` 对会话 run 双重提示词增强 —— 已随 attempt 修复一并消除（attempt 在创建时设置）。
- ✅ UI 死代码设置页（agents/auth/routing）已加入 `settingsSections` 可达。
- ✅ 全局快捷键 Ctrl+N 陈旧闭包 —— 改用 `newConversationRef`。
- ✅ settings 每键击双写 —— 已去抖。

## 七、已知遗留（未在本轮处理）

- **问题8（产品方向）**：生产路径仍是 Vercel AI SDK 直连 OpenAI 兼容端点 + 手输 API key，与主提示"复用 CLI 订阅、绝不存凭证"的非协商边界方向性偏差。Codex/Claude/Grok/OpenCode CLI 适配器尚未接线（`adapter-maf` 为孤儿）。完整切换到 CLI 适配器需要已安装的 CLI 与真实账号，按文档属 opt-in 手动验收范围，本轮未做。明文 apiKey 仍在 SQLite projection（运行时自有，未暴露给渲染层）；彻底移除属 provider 架构重构。
- **agent-runtime / adapter-maf 孤儿包去留**：删除整包需用户明确指示（已在本会话权限层拒绝自动删除），保留为待决项。
- **审批决策语义**：`allow-task`/`allow-conversation`/`add-project-rule` 与 `allow-once` 等价（未实现差异化持久化规则）—— 功能性缺陷，非安全缺陷，待后续迭代。
- **`@tanstack/react-query` 死依赖**：零 import，未移除（移除属依赖清理，低风险但需确认无动态引用）。
- **`typecheck:ui` 无 `--strict`**：UI 隐式 any 未启用严格检查。
- **三套 glob 实现统一**：仅修复了 live 路径（workflow-engine）的边界 bug；agent-runtime 的正确实现随孤儿包保留，未合并。
