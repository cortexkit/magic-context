---
description: 把项目的前端/流程沉淀成已验证的操作技能（按钮 → 接口 → 写入 → 状态 → 联动）
argument-hint: [目录或功能，例如 apps/web 的订单页]
allowed-tools: mcp__plugin_magic-context_magic-context__ctx_skill, Read, Grep, Glob
---

按 `magic-context:operation-skills` skill 的流程，把下面这个范围里的操作采集成操作技能：

$ARGUMENTS

（没有指定范围时，从项目的前端目录开始。）

1. 先 `ctx_skill list`，看哪些已经记录过。
2. 列出范围内所有触发点，写入类优先；先给出写入矩阵（按钮/事件 | 位置 | 接口 | 写入 | 状态更新 | 联动）。
3. 逐个追到数据落地和界面更新，并实际验证；没有验证的不保存。
4. 用 `ctx_skill save` 按页面或功能保存，每个按钮一个 operation；`setup` 写清怎么启动项目、怎么拿到地址，`steps` 写成可以直接运行的命令。
5. 最后汇报保存了哪些 skill 和 operation，以及哪些因为无法验证没有保存、缺什么条件。
