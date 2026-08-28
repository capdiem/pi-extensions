# Context — pi-extensions

pi-extensions 工作区的术语表（glossary）。只收录领域语言，不含实现细节。

## Language

**ask_user**：
`pi-ask-user` 扩展注册的交互式提问工具。把一个或多个问题（单选/自由文本）以 UI 表单呈现给用户，替代纯文本提问。
_Avoid_: 纯文本 `Q1..QN` 块

**提问轮次（question round）**：
grilling / domain-modeling / 设计访谈类流程中，模型向用户成轮提问并等待回答的一组回合。
_Avoid_: 一次性提问

**关键场景（key context）**：
需要按轮提问的流程上下文（grilling / domain-modeling / 设计访谈）。在这些场景中模型必须使用 `ask_user` 表单。

**触发/发现性（trigger / discoverability）**：
模型在需要用户输入时调用 `ask_user` 的可靠程度。`pi-ask-user` 当前优化工作流的主线。

**升级门槛（escalation gate）**：
从"纯工具元数据"升级到"主动注入"所需满足的证据判据（多次/多场景实测中多数提问轮仍不调用 `ask_user`）。

**复读循环（repetition loop）**：
模型在输出或长思考阶段反复输出相同/高度雷同文本、迟迟不收敛到答案的失效模式；万字复读（thinking-runaway）是其深度思考模式下的极端表现。
_Avoid_: 复读、跑飞

**主动打断（active abort）**：
检测到复读循环后中止当前生成并触发重试的干预动作。本扩展的核心干预策略。
_Avoid_: 仅提示、被动告警

**检测信号（detection signal）**：
判定复读所用的信号。定案为「组合」：块级重复作主信号（整段原样重复、误报最低），n-gram 新颖度确认持续性。
_Avoid_: 单一指标

**干预管线（intervention pipeline）**：
从检测命中到最终动作的完整流程。定案为「中止+重试」：中止当前生成后注入纠正提示并重跑一轮，不做消息清理。
_Avoid_: 仅中止、清理式重试

**触发策略（trigger policy）**：
检测的激进程度。定案为「两段式」：先记录「疑似复读」（低打扰），达到更硬阈值才中止。
_Avoid_: 一到阈值立即中止
