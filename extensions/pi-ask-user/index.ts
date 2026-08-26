/**
 * Ask User Questions - interactive question form tool
 *
 * Lets the LLM ask the user one or more questions as an interactive form
 * (choice + free-text), instead of dumping plain-text "Q1..QN" blocks.
 *
 * Mode behavior:
 *  - TUI mode: full-screen tabbed form via ctx.ui.custom()
 *  - RPC mode: per-question select/input dialogs over the extension UI protocol
 *  - print/json mode: structured fallback so the LLM can ask in plain text
 *
 * Each question carries a "recommendation" hint (the grilling skill's
 * "➡️ recommended answer"). When it matches one of a choice question's
 * options, it is highlighted on that option; otherwise it is shown dimmed
 * under the prompt.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------- Types ----------

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

interface Question {
  id: string;
  title?: string;
  prompt: string;
  type: "choice" | "text";
  options?: QuestionOption[];
  allowOther: boolean;
  recommendation?: string;
  number: number;
  numbered: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface AskUserResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// ---------- Schema ----------

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "Value returned to the LLM when this option is selected" }),
  label: Type.String({ description: "Display label shown to the user" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown under the label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique question id (e.g. q1, q2, scope)" }),
  title: Type.Optional(
    Type.String({ description: "Optional short title shown after the question number, e.g. 'Scope'" }),
  ),
  prompt: Type.String({ description: "Full question text to display" }),
  type: StringEnum(["choice", "text"] as const, {
    description: "'choice' for an options list, 'text' for free-form input",
  }),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, { description: "Options for type=choice (required for choice)" }),
  ),
  allowOther: Type.Optional(
    Type.Boolean({ description: "Choice questions: allow free-text 'Type something' (default true)" }),
  ),
  recommendation: Type.Optional(
    Type.String({
      description:
        "Your recommended answer (the grilling '➡️ recommended answer'). When it matches an option's value or label, that option is highlighted in the form.",
    }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One or more questions to ask the user in a single interactive form",
    minItems: 1,
    maxItems: 10,
  }),
  numbered: Type.Optional(
    Type.Boolean({
      description: "Prefix each question with its number (Q1, Q2…) in grilling style. Default: false.",
    }),
  ),
});

// ---------- Helpers ----------

/** Raw question shape as accepted by the tool (optional fields not yet normalized). */
interface RawQuestion {
  id: string;
  title?: string;
  prompt: string;
  type: "choice" | "text";
  options?: QuestionOption[];
  allowOther?: boolean;
  recommendation?: string;
}

function defaultQuestions(params: {
  questions: RawQuestion[];
  numbered?: boolean;
}): Question[] {
  return params.questions.map((q, i) => ({
    ...q,
    allowOther: q.allowOther !== false,
    options: q.type === "choice" ? q.options ?? [] : undefined,
    number: i + 1,
    numbered: params.numbered === true,
  }));
}

/**
 * Question label: "Q1 - Scope" when numbered, "Scope" when not. Empty string
 * when not numbered and no title is set.
 */
function questionLabel(q: Pick<Question, "number" | "numbered" | "title">): string {
  if (q.numbered) return `Q${q.number}${q.title ? ` - ${q.title}` : ""}`;
  return q.title ?? "";
}

/** Whether a question's recommendation points at a specific option (heuristic match). */
function recommendationMatch(q: Question, opt: QuestionOption): boolean {
  const rec = q.recommendation?.trim().toLowerCase();
  if (!rec) return false;
  const value = (opt.value ?? "").trim().toLowerCase();
  const label = (opt.label ?? "").trim().toLowerCase();
  if (value && rec === value) return true;
  if (label && rec === label) return true;
  if (value.length >= 3 && rec.includes(value)) return true;
  if (label.length >= 3 && rec.includes(label)) return true;
  if (rec.length >= 3) {
    if (value && value.includes(rec)) return true;
    if (label && label.includes(rec)) return true;
  }
  return false;
}

/**
 * Index of the option a question's recommendation points at, or -1 when the
 * recommendation is absent or matches no option. Returns the first match.
 */
function recommendedIndex(q: Question): number {
  if (!q.recommendation || q.type !== "choice") return -1;
  const opts = q.options ?? [];
  for (let i = 0; i < opts.length; i++) {
    if (recommendationMatch(q, opts[i])) return i;
  }
  return -1;
}

/**
 * Reduce a recommendation to its "detail" for display.
 * Grill recommendation shape is "<标题> - <详情>"; we take only the <详情>
 * after the first dash separator (em/en dash, spaced hyphen, fullwidth
 * hyphen-minus), so a leading echo of the option title is dropped even when
 * the title carries extra text like "（现状）". A leading echo of the option
 * label/value is also stripped for the no-dash case.
 */
function stripRecommendationTitle(rec: string, opt?: QuestionOption): string {
  let cleaned = rec.trim();
  if (opt) {
    for (const token of [opt.label, opt.value]) {
      const t = token?.trim();
      if (!t) continue;
      if (cleaned.toLowerCase().startsWith(t.toLowerCase())) {
        cleaned = cleaned.slice(t.length).trimStart();
        break;
      }
    }
  }
  const m = cleaned.match(/[\u2014\u2013]| - |－/);
  if (m && typeof m.index === "number") {
    cleaned = cleaned
      .slice(m.index + m[0].length)
      .replace(/^[\s:：,，、.…-]+/, "");
  }
  return cleaned.trim() || rec.trim();
}

function textResult(
  message: string,
  questions: Question[],
  cancelled = true,
): { content: { type: "text"; text: string }[]; details: AskUserResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled },
  };
}

function formatAnswers(questions: Question[], answers: Answer[]): string {
  const lines = answers.map((a) => {
    const q = questions.find((x) => x.id === a.id);
    const label = q ? questionLabel(q) || `Q${q.number}` : a.id;
    if (a.wasCustom) return `${label}: user wrote: ${a.label}`;
    const idx = a.index ? ` ${a.index}.` : "";
    return `${label}: user selected:${idx} ${a.label}`;
  });
  return lines.join("\n");
}

// ---------- TUI form ----------

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
}

async function presentTuiForm(
  ctx: ExtensionContext,
  questions: Question[],
): Promise<AskUserResult> {
  return ctx.ui.custom<AskUserResult>((tui, theme, _kb, done) => {
    const isMulti = questions.length > 1;
    const submitTab = questions.length;

    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionId: string | null = null;
    let cachedLines: string[] | undefined;
    const answers = new Map<string, Answer>();

    const editor = new Editor(tui, editorTheme(theme));

    // ---------- helpers ----------

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      done({ questions, answers: Array.from(answers.values()), cancelled });
    }

    function currentQuestion(): Question | undefined {
      return questions[currentTab];
    }

    function currentOptions(): Array<QuestionOption & { isOther?: boolean }> {
      const q = currentQuestion();
      if (!q || q.type !== "choice") return [];
      const opts: Array<QuestionOption & { isOther?: boolean }> = [...(q.options ?? [])];
      if (q.allowOther) {
        opts.push({ value: "__other__", label: "Type something.", isOther: true });
      }
      return opts;
    }

    function allAnswered(): boolean {
      return questions.every((q) => answers.has(q.id));
    }

    function advanceAfterAnswer() {
      if (!isMulti) {
        submit(false);
        return;
      }
      if (currentTab < submitTab - 1) {
        currentTab++;
      } else {
        currentTab = submitTab;
      }
      optionIndex = 0;
      inputMode = false;
      inputQuestionId = null;
      refresh();
    }

    function saveAnswer(
      questionId: string,
      value: string,
      label: string,
      wasCustom: boolean,
      index?: number,
    ) {
      answers.set(questionId, { id: questionId, value, label, wasCustom, index });
    }

    function openInput(questionId: string) {
      inputMode = true;
      inputQuestionId = questionId;
      editor.setText("");
      refresh();
    }

    editor.onSubmit = (value) => {
      if (!inputQuestionId) return;
      const trimmed = value.trim() || "(no response)";
      saveAnswer(inputQuestionId, trimmed, trimmed, true);
      inputMode = false;
      inputQuestionId = null;
      editor.setText("");
      advanceAfterAnswer();
    };

    // ---------- input ----------

    function handleInput(data: string) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      // Tab navigation (multi-question only)
      if (isMulti) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          currentTab = (currentTab + 1) % (submitTab + 1);
          optionIndex = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          currentTab = (currentTab - 1 + submitTab + 1) % (submitTab + 1);
          optionIndex = 0;
          refresh();
          return;
        }
      }

      const q = currentQuestion();

      // Submit tab
      if (currentTab === submitTab) {
        if (matchesKey(data, Key.enter) && allAnswered()) {
          submit(false);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

      if (!q) return;

      if (q.type === "text") {
        if (matchesKey(data, Key.enter)) {
          openInput(q.id);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

      // Choice navigation
      const opts = currentOptions();
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(opts.length - 1, optionIndex + 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const opt = opts[optionIndex];
        if (!opt) return;
        if (opt.isOther) {
          openInput(q.id);
          return;
        }
        saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
        advanceAfterAnswer();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    // ---------- render ----------

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const renderWidth = Math.max(1, width);

      function addWrapped(text: string) {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
      }

      function addWrappedWithPrefix(prefix: string, text: string) {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
        const continuationPrefix = " ".repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
        }
      }

      function renderPromptAndRecommendation(q: Question) {
        const recOnOption = recommendedIndex(q) >= 0;
        const label = questionLabel(q);
        const head = label
          ? `${theme.fg("accent", theme.bold(`${label}:`))} ${theme.fg("text", q.prompt)}`
          : theme.fg("text", q.prompt);
        addWrappedWithPrefix(" ", head);
        if (q.recommendation && !recOnOption) {
          lines.push("");
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", `Recommended: ${stripRecommendationTitle(q.recommendation)}`),
          );
        }
        lines.push("");
      }

      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      // Tab bar (multi-question only)
      if (isMulti) {
        const tabs: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const isActive = i === currentTab;
          const isAnswered = answers.has(questions[i].id);
          const lbl = questions[i].title ?? `Q${i + 1}`;
          const box = isAnswered ? "■" : "□";
          const color = isAnswered ? "success" : "muted";
          const text = ` ${box} ${lbl} `;
          const styled = isActive
            ? theme.bg("selectedBg", theme.fg("text", text))
            : theme.fg(color, text);
          tabs.push(`${styled} `);
        }
        const canSubmit = allAnswered();
        const isSubmitTab = currentTab === submitTab;
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab
          ? theme.bg("selectedBg", theme.fg("text", submitText))
          : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled} →`);
        addWrappedWithPrefix(" ", tabs.join(""));
        lines.push("");
      }

      // Render an option list, highlighting the recommended option if any.
      function renderOptions() {
        const opts = currentOptions();
        const q = currentQuestion();
        const recIdx = q ? recommendedIndex(q) : -1;
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const isOther = opt.isOther === true;
          const recommended = !isOther && i === recIdx;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const labelBase = `${i + 1}. ${recommended ? "★ " : ""}${opt.label}${isOther && inputMode ? " ✎" : ""}`;
          const label = recommended ? theme.bold(labelBase) : labelBase;
          const color = selected || (isOther && inputMode) ? "accent" : "text";
          addWrappedWithPrefix(prefix, theme.fg(color, label));
          if (recommended && q?.recommendation) {
            // Recommended option: description (muted) then the recommendation
            // detail (default + bold) wrapped as （推荐：<详情>）, same line.
            const detail = stripRecommendationTitle(q.recommendation, opt);
            const desc = opt.description ? theme.fg("muted", opt.description) : "";
            addWrappedWithPrefix("     ", desc + theme.bold(`（推荐：${detail}）`));
          } else if (opt.description) {
            addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
          }
        }
      }

      const q = currentQuestion();

      // Content
      if (inputMode && q) {
        renderPromptAndRecommendation(q);
        if (q.type === "choice") renderOptions();
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, renderWidth - 2))) {
          lines.push(` ${line}`);
        }
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
      } else if (currentTab === submitTab) {
        addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
        lines.push("");
        for (const question of questions) {
          const answer = answers.get(question.id);
          if (answer) {
            const prefix = answer.wasCustom ? "(wrote) " : "";
            const summary = `${theme.fg("muted", `${questionLabel(question)}: `)}${theme.fg("text", prefix + answer.label)}`;
            addWrappedWithPrefix(" ", summary);
          }
        }
        lines.push("");
        if (allAnswered()) {
          addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
        } else {
          const missing = questions
            .filter((x) => !answers.has(x.id))
            .map((x) => questionLabel(x))
            .join(", ");
          addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
        }
      } else if (q) {
        renderPromptAndRecommendation(q);
        if (q.type === "choice") {
          renderOptions();
        } else {
          const answer = answers.get(q.id);
          addWrappedWithPrefix(" ", theme.fg("muted", "Free-form answer"));
          lines.push("");
          if (answer) {
            addWrappedWithPrefix(" ", theme.fg("text", `  ${answer.label}`));
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter to edit • Esc cancel"));
          } else {
            addWrappedWithPrefix(" ", theme.fg("dim", "Press Enter to type your answer"));
          }
        }
      }

      lines.push("");
      if (!inputMode) {
        const help = isMulti
          ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
          : "↑↓ select • Enter confirm • Esc cancel";
        addWrappedWithPrefix(" ", theme.fg("dim", help));
      }
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}

// ---------- RPC fallback (per-question dialogs) ----------

async function presentRpcDialogs(
  ctx: ExtensionContext,
  questions: Question[],
): Promise<AskUserResult> {
  const answers: Answer[] = [];
  let cancelled = false;

  for (const q of questions) {
    if (q.type === "choice") {
      // Merge the recommendation detail into the recommended option's label
      // (e.g. "保留 fallback 行（推荐：…）"), then reverse-map the selected
      // display string back to the original option index.
      const opts = q.options ?? [];
      const recIdx = recommendedIndex(q);
      const display: { index: number; label: string }[] = opts.map((o, idx) => ({
        index: idx,
        label:
          idx === recIdx && q.recommendation
            ? `${o.label}（推荐：${stripRecommendationTitle(q.recommendation, o)}）`
            : o.label,
      }));
      if (q.allowOther) display.push({ index: -1, label: "Type something..." });
      const label = questionLabel(q);
      const title = label ? `${label}: ${q.prompt}` : q.prompt;
      const choice = await ctx.ui.select(title, display.map((d) => d.label));
      if (choice === undefined) {
        cancelled = true;
        break;
      }
      if (choice === "Type something...") {
        const value = await ctx.ui.input(q.prompt, "Type your answer");
        if (value === undefined) {
          cancelled = true;
          break;
        }
        answers.push({ id: q.id, value, label: value, wasCustom: true });
      } else {
        const found = display.find((d) => d.label === choice);
        const idx = found ? found.index : -1;
        const opt = idx >= 0 ? opts[idx] : undefined;
        answers.push({
          id: q.id,
          value: opt?.value ?? choice,
          label: opt?.label ?? choice,
          wasCustom: false,
          index: idx >= 0 ? idx + 1 : undefined,
        });
      }
    } else {
      const value = await ctx.ui.input(q.prompt, questionLabel(q) || q.prompt);
      if (value === undefined) {
        cancelled = true;
        break;
      }
      answers.push({ id: q.id, value, label: value, wasCustom: true });
    }
  }

  return { questions, answers, cancelled };
}

// ---------- Extension ----------

export default function askUserExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user one or more questions as an interactive form (choice options or free-text). " +
      "Use when you need the user's decision, preference, or input to continue — especially to " +
      "present a round of design/planning questions with your recommended answer for each. " +
      "Each question may include a 'recommendation'; when it matches one of the options, that option is highlighted.",
    promptSnippet: "Ask the user questions through an interactive form",
    promptGuidelines: [
      "Use ask_user to put questions to the user as an interactive form instead of printing plain-text Q1..QN blocks.",
      "When a single turn has multiple related questions (e.g. a grilling round's frontier), pass them all in one ask_user call — one question per entry, with type 'choice' or 'text'.",
      "For each question you can include a 'recommendation' with your recommended answer. When it matches an option's value or label, that option is highlighted in the form; otherwise it is shown as a hint under the question.",
      "For grilling-style rounds set numbered: true so the questions are prefixed Q1/Q2. For ordinary questions omit it — the form then shows just the prompt (plus an optional title).",
      "ask_user works in TUI mode (full form) and RPC mode (sequential dialogs). In print/json mode it returns the questions as text so you can ask them in plain text.",
      "If ask_user reports 'cancelled', stop and let the user redirect instead of re-asking the same questions.",
    ],
    parameters: AskUserParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return textResult("Cancelled", [], true);
      }
      const questions = defaultQuestions(params);

      if (ctx.mode === "tui") {
        const result = await presentTuiForm(ctx, questions);
        if (result.cancelled) {
          return {
            content: [{ type: "text", text: "User cancelled the questions" }],
            details: result,
          };
        }
        return {
          content: [{ type: "text", text: formatAnswers(questions, result.answers) }],
          details: result,
        };
      }

      if (ctx.mode === "rpc") {
        const result = await presentRpcDialogs(ctx, questions);
        if (result.cancelled) {
          return {
            content: [{ type: "text", text: "User cancelled the questions" }],
            details: result,
          };
        }
        return {
          content: [{ type: "text", text: formatAnswers(questions, result.answers) }],
          details: result,
        };
      }

      // Non-interactive modes: structured fallback so the LLM asks in plain text.
      const fallback = questions
        .map((q) => {
          const rec = q.recommendation ? `\n  Recommended: ${q.recommendation}` : "";
          const opts =
            q.type === "choice"
              ? `\n  Options: ${(q.options ?? []).map((o) => `${o.label}`).join(" | ")}`
              : "";
          const label = questionLabel(q);
          return `${label ? `${label}: ` : ""}${q.prompt}${opts}${rec}`;
        })
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text:
              "Interactive form unavailable in this mode. Ask the user the following questions as plain text (numbered Q1..QN):\n\n" +
              fallback,
          },
        ],
        details: { questions, answers: [], cancelled: false },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const qs = Array.isArray(args.questions) ? (args.questions as Question[]) : [];
      const labels = qs
        .map((q, i) => (q.title ? `Q${i + 1} - ${q.title}` : q.id || `Q${i + 1}`))
        .join(", ");
      let content = theme.fg("toolTitle", theme.bold("ask_user "));
      content += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
      if (labels) content += theme.fg("dim", ` (${labels})`);
      text.setText(content);
      return text;
    },

    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = result.details as AskUserResult | undefined;
      if (!details) {
        const out = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        text.setText(theme.fg("warning", out || "ask_user"));
        return text;
      }
      if (details.cancelled) {
        text.setText(theme.fg("warning", "Cancelled"));
        return text;
      }
      const lines = details.answers.map((a) => {
        const q = details.questions.find((x) => x.id === a.id);
        const label = q ? questionLabel(q) || `Q${q.number}` : a.id;
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${display}`;
      });
      text.setText(lines.join("\n"));
      return text;
    },
  });
}
