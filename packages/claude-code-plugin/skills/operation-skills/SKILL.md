---
name: operation-skills
description: "Turn a project's frontend or any reusable flow into verified operation skills with ctx_skill: map each button/form/event to the API it calls, the data it writes, the state it updates and how saving and linked updates complete, then verify and save it. Use when the user asks to 把前端/项目流程做成 skill、记录哪些按钮写入什么、沉淀/复用操作流程、梳理前端与后端的写入关系, or to document UI actions, map buttons to backend writes, or capture a verified workflow for reuse; also before working out how an existing button or flow of the project works."
---

# Operation skills（操作技能）

把用户项目里**已经验证过的完整操作流程**沉淀成可复用的 Skill，形成稳定映射：

```
项目目录 → Skill（一个页面/功能区） → 按钮操作 / 触发事件 → Action → 已验证的完整流程
```

以后在这个目录里遇到同样的操作，直接执行记录好的流程，不再重新分析代码。Skill 存在项目的 `.claude/skills/<name>/`（`SKILL.md` + `flow.json`），由 `ctx_skill` 工具读写；下次会话起 Claude Code 也会把它当原生 skill 自动触发。

所有分析、验证、保存都由当前会话的模型完成，不需要额外配置模型。

## 1. 先查，再分析

遇到"点某个按钮 / 做某个操作 / 某个流程怎么走"的请求：

1. `ctx_skill` `find`，`query` 填用户原话（或按钮名、事件名）。
2. 命中：按返回的 Action 和执行步骤直接做。如果它列出了"验证后有改动的文件"，只重新检查这些文件；确认流程没变就执行，然后用 `ctx_skill verify` 记一次新的验证；流程变了就按第 4 节更新。
3. 没命中：按第 2 节采集，验证后保存。

## 2. 采集一个目录的操作

### 2.1 定范围

确定前端目录（如 `apps/web`、`src/pages`）和要覆盖的页面或功能。一个页面或功能区对应一个 Skill；一个按钮或事件对应一个 operation。

### 2.2 找出所有触发点，写入类优先

按框架搜索事件处理：

| 框架 | 搜索模式 |
|---|---|
| React / Solid / Preact | `onClick=` `onSubmit=` `onChange=` `onBlur=` |
| Vue | `@click` `@submit` `v-on:` `@change` |
| Svelte | `on:click` `onclick=` `on:submit` |
| Angular | `(click)=` `(ngSubmit)=` `(change)=` |
| 原生 / jQuery | `addEventListener(` `.on("click"` `<form action=` |
| Next.js / Remix | `"use server"` `action=` `useActionState` `<Form` |
| React Native / Flutter / 小程序 | `onPress=` `onPressed:` `bindtap` `bind:tap` |

把处理函数里**会写后端或持久化**的找出来，这是最重要的部分：`fetch(` `axios.` `request(` `useMutation` `.mutate(` `trpc.*.mutate` GraphQL `mutation`、`supabase.from(..).insert/update/upsert/delete`、`setDoc/updateDoc/addDoc`、`localStorage.setItem`、`indexedDB`、WebSocket `send(`。只读按钮可以记，但写入类必须全部覆盖。

### 2.3 每个操作追到底

从按钮一路追到数据落地，再回到界面：

1. **触发**：组件文件和行号、按钮文字、选择器或 test id、事件名。
2. **Action**：处理函数名和位置，做了什么，包括校验、确认弹窗和参数组装。
3. **接口**：经过哪个 API 封装，最终的 method + path（或 RPC / mutation 名）、请求体字段、响应。
4. **后端写入**：路由 → service → 落库代码。写到哪张表/集合/文件/缓存键、哪些字段；事务、触发器、异步任务、消息队列也要记。
5. **状态更新**：store / Redux / Pinia / Zustand 的变更，React Query `invalidateQueries` / `setQueryData`，SWR `mutate`，组件局部 state。
6. **保存与联动**：成功和失败分别怎么处理（toast、跳转、关闭弹窗），哪些列表或其他组件会刷新，发出的事件、广播、WebSocket。
7. **需修改的文件**：以后改这个操作要动哪些文件（前端组件、API 封装、后端路由、service、schema/migration、类型定义）。
8. **执行步骤**：你（agent）不经过界面就能直接跑的命令，例如带占位符的 `curl -X POST $BASE/api/notes -d '{"text":"<text>"}'`、脚本或 CLI，以及执行后怎么确认写入。不要写"点击保存按钮"这类界面步骤，触发里已经写明是哪个按钮；只有确实没有其他办法时才写界面步骤，并给出选择器。
9. **准备（setup，整个 skill 共用）**：怎么把项目跑起来才能执行这些操作，包括启动命令、端口怎么确定、base URL、测试账号或鉴权、需要的环境变量。以后的会话要靠它直接动手，不用再去读代码找启动方式。

先在回复里列一张写入矩阵，让用户一眼看清"哪个按钮写什么"：

| 按钮/事件 | 位置 | 接口 | 写入（表.字段） | 状态更新 | 联动 |
|---|---|---|---|---|---|

### 2.4 验证，不验证不保存

每个操作都要真正跑一遍，可以选择：

- 启动服务后按"执行步骤"发请求，再查库或文件确认写入；
- 跑覆盖这个流程的已有测试（单测、接口测试、e2e / Playwright）；
- 浏览器里实际点一次，确认请求和数据变化。

记录用的方法和证据（命令、测试名、查到的行）。暂时无法验证的操作不要保存，告诉用户缺什么条件。

### 2.5 保存

`ctx_skill` `save`：

- `name`：页面或功能的英文 kebab 名，如 `order-editor`；`title` 写中文名。
- `description`：说明什么时候用，并点名主要按钮和事件。Claude Code 靠它自动触发。
- `scope`：前端目录（相对项目根）。
- `setup`：第 2.3 节第 9 条的准备步骤，写成命令。
- `operations`：每个按钮一个，`id` 稳定不变（如 `save-order`）。`intents` 写用户可能的说法，中英文都写。`writes` 写清楚到表和字段。
- 已有同名 Skill 时用同一个 `name` 和 `id` 更新，不要新建重复的。先 `ctx_skill list` 看一下。

## 3. 执行已记录的操作

用户说"帮我点保存 / 新建一个订单 / 删除这条记录"时，只要话里出现了某个操作的按钮名或意图，Magic Context 会在这一轮开始前自动把对应的已验证操作注入上下文（`<operation-skill>`）。没有注入时用 `find` 查。

拿到操作后：按"准备"把项目跑起来（已经在跑的跳过）→ 有改动的文件只复查那几个 → 按"执行步骤"操作 → 按"写入"确认数据确实落地 → 汇报结果。不要重新通读代码，也不要换别的 skill 去摸索流程。

## 4. 维护

- 代码改动导致流程变化：重新追踪变化的部分，验证后用同一个 `name` 和 `id` 再 `save`。
- 流程没变、只是文件有改动：复查后 `verify`。
- 按钮或流程已删除：`remove`。
