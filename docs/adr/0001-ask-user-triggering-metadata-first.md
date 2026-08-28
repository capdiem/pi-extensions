# ask_user 触发机制：纯工具元数据优先，证据不足再升级注入

Status: accepted

`ask_user` 是 `pi-ask-user` 注册的**工具**，模型本就会在自己的工具 schema 里看到它并自行决定是否调用。本次 grilling 事故（模型输出纯文本 `❓Q1..QN` 而非调用 `ask_user`）是**优先级**失败，不是**可见性**失败——模型知道工具存在，只是被 skill 的字面格式指令压过了。

因此决定：**先只强化工具元数据**（`description` + `promptGuidelines`），在关键场景（grilling / domain-modeling / 设计访谈，点名 grilling 家族 + "成轮提问"泛化兜底）中明确要求使用 `ask_user` 替换纯文本提问。**不做** per-turn 主动注入（`before_agent_start`）、**不做**活跃窗口生命周期、**不做**过期阈值、**不做**手动 `/ask` 兜底。

## Considered Options

- **主动注入 + 生命周期**：可提高触发可靠度，但必须引入激活/过期/阈值来界定"grilling 何时结束"——这正是被质疑掉的复杂度。仅当元数据被实测证明不足时才升级。
- **基于模型输出的转换**（看到模型写 `Q1..` 就截断重问）：架构上不可行——`message_update` 不能中途改写，`message_end` 触发时纯文本问题已显示。

## Consequences

- 升级门槛 = 多次/多场景实测（2-3 个 grilling 会话、不同模型/场景），多数提问轮仍未调用 `ask_user` 才判定元数据不足，此时再评估主动注入。
- 需配套轻量诊断记录：每回合记录"是否提问轮 / 是否调用了 `ask_user`"，以支撑升级门槛的判定。
