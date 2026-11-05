/** @jsxImportSource @opentui/react */

import React from "react";

import type { AgentQuestionItem } from "../../../../src/ask.js";
import type { UiText } from "../../../../src/ui/text.js";
import type { DisplayTheme } from "../theme/index.js";
import type { AskPanelProps } from "../types.js";
import { PanelSurface } from "../primitives/panel-surface.js";
import { ErrorMessage } from "../primitives/error-message.js";
import { countWrappedDisplayLines } from "../utils/format.js";

function formatAskSource(ask: AskPanelProps["ask"], t: UiText): string {
  const sourceName = ask.source.agentName || ask.source.agentId || "Queen";
  const lower = sourceName.toLowerCase();
  const isQueen = lower === "primary" || lower === "queen" || lower === "root";
  return isQueen
    ? t.get(["Views", "ask", "sourceQueen"])
    : t.get(["Views", "ask", "sourceSubAgent"], { name: sourceName });
}

/** 计划视图的分层着色：一级标题最亮，二级次之，正文与勾选项最弱。 */
function planLineColor(colors: DisplayTheme["colors"], line: string): string {
  if (line.startsWith("# ")) return colors.accent;
  if (line.startsWith("## ")) return colors.accent;
  if (line.startsWith("- [")) return colors.text;
  return colors.dim;
}

export function AskPanelView({
  ask,
  uiText: t,
  error,
  selectedIndex,
  currentQuestionIndex,
  totalQuestions,
  questionAnswers,
  customInputMode,
  noteInputMode,
  reviewMode,
  inlineValue,
  optionNotes,
  inputRef,
  onInput,
  onSubmit,
  theme,
  terminalHeight,
  contentWidth,
}: AskPanelProps & { theme: DisplayTheme }): React.ReactNode {
  if (ask.kind === "approval") {
    const options = ask.options ?? [];
    const persistentWarning = (ask.payload as Record<string, unknown>)["persistentWarning"] as string | undefined;

    // Fixed chrome: source + blank + options + warning + hint + error + border
    const fixedLines = 2 + options.length + (persistentWarning ? 1 : 0) + 1 + (error ? 1 : 0) + 2;
    const summaryLines = countWrappedDisplayLines(ask.summary, Math.max(1, contentWidth - 4));
    const maxSummaryLines = Math.max(1, Math.floor((terminalHeight - 8) * 0.3));
    const summaryNeedsScroll = summaryLines > maxSummaryLines;
    const effectiveSummaryLines = summaryNeedsScroll ? maxSummaryLines : summaryLines;
    const panelHeight = fixedLines + effectiveSummaryLines;

    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
        {summaryNeedsScroll ? (
          <scrollbox maxHeight={effectiveSummaryLines} scrollY={true} fitContent={true}>
            <text fg={theme.colors.accent} content={ask.summary} />
          </scrollbox>
        ) : (
          <text fg={theme.colors.accent} content={ask.summary} />
        )}
        <text fg={theme.colors.dim} content={formatAskSource(ask, t)} />
        <text content="" />
        {options.map((label, index) => {
          const isSelected = index === selectedIndex;
          const isDeny = label === "Deny";
          const showWarningBefore = persistentWarning && index === 1;
          return (
            <box key={`approval-opt-${index}`} flexDirection="column">
              {showWarningBefore ? <text fg={theme.colors.dim} content={`    ${persistentWarning}`} /> : null}
              <text
                fg={isSelected ? (isDeny ? theme.colors.red : theme.colors.accent) : theme.colors.text}
                content={`${isSelected ? "> " : "  "}${label}`}
              />
            </box>
          );
        })}
        <text fg={theme.colors.dim} content={t.get(["Views", "ask", "approvalHint"])} />
        {error ? <ErrorMessage text={error} colors={theme.colors} /> : null}
      </PanelSurface>
    );
  }

  if (ask.kind !== "agent_question") {
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing}>
        <ErrorMessage text={`Unsupported ask kind: ${ask.kind}`} colors={theme.colors} />
        <text content={ask.summary} />
        {error ? <ErrorMessage text={error} colors={theme.colors} /> : null}
      </PanelSurface>
    );
  }

  const questions = (ask.payload["questions"] as AgentQuestionItem[]) ?? [];

  if (reviewMode) {
    const reviewContentLines =
      2 +
      questions.reduce((total, question, index) => {
        const answer = questionAnswers.get(index);
        const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
        const note = noteKey ? optionNotes.get(noteKey) : undefined;
        return total + 2 + (note ? 1 : 0);
      }, 0) +
      1 +
      (error ? 1 : 0);
    const panelHeight = reviewContentLines + 2;

    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
        <text fg={theme.colors.green} content={t.get(["Views", "ask", "reviewTitle"])} />
        <text fg={theme.colors.dim} content={formatAskSource(ask, t)} />
        {questions.map((question, index) => {
          const answer = questionAnswers.get(index);
          const selected = answer ? question.options[answer.optionIndex] : undefined;
          const answerDisplay = !answer
            ? t.get(["Views", "ask", "unanswered"])
            : selected?.kind === "custom_input"
              ? `✎ ${answer.customText ?? ""}`
              : selected?.label ?? "(unknown)";
          const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
          const note = noteKey ? optionNotes.get(noteKey) : undefined;
          return (
            <box key={`ask-review-${index}`} flexDirection="column">
              <text content={`${index + 1}. ${question.question}`} />
              <text fg={!answer ? theme.colors.accent : selected?.kind === "discuss_further" ? theme.colors.accent : theme.colors.green} content={`   → ${answerDisplay}`} />
              {note ? <text fg={theme.colors.accent} content={`     ${t.get(["Views", "ask", "noteLabel"])}${note}`} /> : null}
            </box>
          );
        })}
        <text fg={theme.colors.dim} content={t.get(["Views", "ask", "reviewSubmitHint"])} />
        {error ? <ErrorMessage text={error} colors={theme.colors} /> : null}
      </PanelSurface>
    );
  }

  const question = questions[currentQuestionIndex];
  if (!question) {
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing}>
        <ErrorMessage text="Question index out of range." colors={theme.colors} />
      </PanelSurface>
    );
  }

  const existingAnswer = questionAnswers.get(currentQuestionIndex);
  const agentOptionCount = question.options.filter((option) => !option.systemAdded).length;
  const planContent = typeof question.planContent === "string" ? question.planContent : "";
  const planLines = planContent.length > 0 ? planContent.split("\n") : [];
  // 计划视图限高，超出部分交给滚动区；面板整体仍受终端高度约束。
  const planMaxLines = Math.max(1, Math.floor((terminalHeight - 12) * 0.45));
  const planVisibleLines = Math.min(planLines.length, planMaxLines);
  const optionContentLines = question.options.reduce((total, option, index) => {
    const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
    return total + 1 + (option.description ? 1 : 0) + (note ? 1 : 0);
  }, 0);
  const inlineLines = (customInputMode || noteInputMode) && !planContent ? 3 : 0;
  const panelContentLines =
    2 + (planContent ? planVisibleLines + 2 : 0) + optionContentLines + inlineLines + 1 + (error ? 1 : 0);
  const panelHeight = panelContentLines + 2;

  return (
    <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
      <text
        fg={theme.colors.accent}
        content={`${t.get(["Views", "ask", "questionProgress"], {
          index: currentQuestionIndex + 1,
          total: totalQuestions,
        })}${question.question}`}
      />
      <text fg={theme.colors.dim} content={formatAskSource(ask, t)} />
      {planContent ? (
        <box flexDirection="column" border paddingLeft={1} paddingRight={1}>
          {planLines.length > planMaxLines ? (
            <scrollbox maxHeight={planMaxLines} scrollY={true} fitContent={true}>
              {planLines.map((line, index) => (
                <text key={`plan-line-${index}`} fg={planLineColor(theme.colors, line)} content={line} />
              ))}
            </scrollbox>
          ) : (
            planLines.map((line, index) => (
              <text key={`plan-line-${index}`} fg={planLineColor(theme.colors, line)} content={line} />
            ))
          )}
        </box>
      ) : null}
      {question.options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const isAnswered = existingAnswer?.optionIndex === index;
        const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
        // 确认门的第三行就是输入行本身：不显示标签，未进入输入态时先给出背景字。
        if (planContent && option.kind === "custom_input") {
          if (isSelected && customInputMode) {
            return (
              <input
                key={`ask-option-${index}`}
                ref={(node) => {
                  inputRef.current = node;
                }}
                value={inlineValue}
                focused={true}
                placeholder={t.get(["Views", "ask", "planAdjustHint"])}
                textColor={theme.colors.text}
                focusedTextColor={theme.colors.text}
                placeholderColor={theme.colors.dim}
                onInput={onInput}
                onChange={onInput}
                onSubmit={onSubmit as any}
              />
            );
          }
          return (
            <text
              key={`ask-option-${index}`}
              fg={isSelected ? theme.colors.accent : theme.colors.dim}
              content={`${isSelected ? "> " : "  "}${t.get(["Views", "ask", "planAdjustHint"])}`}
            />
          );
        }
        return (
          <box key={`ask-option-${index}`} flexDirection="column">
            <text
              fg={isSelected ? theme.colors.accent : isAnswered ? theme.colors.green : theme.colors.text}
              content={`${isSelected ? "> " : isAnswered ? "✓ " : "  "}${option.label}`}
            />
            {option.description ? <text fg={theme.colors.dim} content={`   ${option.description}`} /> : null}
            {note ? <text fg={theme.colors.accent} content={`   ${t.get(["Views", "ask", "noteLabel"])}${note}`} /> : null}
          </box>
        );
      })}
      {inlineLines > 0 ? (
        <box flexDirection="column">
          <text
            fg={theme.colors.accent}
            content={customInputMode ? t.get(["Views", "ask", "yourAnswer"]) : t.get(["Views", "ask", "noteLabel"])}
          />
          <input
            ref={(node) => {
              inputRef.current = node;
            }}
            value={inlineValue}
            focused={customInputMode || noteInputMode}
            placeholder={customInputMode
              ? t.get(["Views", "ask", "customPlaceholder"])
              : t.get(["Views", "ask", "notePlaceholder"])}
            textColor={theme.colors.text}
            focusedTextColor={theme.colors.text}
            placeholderColor={theme.colors.dim}
            onInput={onInput}
            onChange={onInput}
            onSubmit={onSubmit as any}
          />
          <text
            fg={theme.colors.dim}
            content={customInputMode
              ? t.get(["Views", "ask", "inlineConfirmHint"])
              : t.get(["Views", "ask", "inlineNoteConfirmHint"])}
          />
        </box>
      ) : null}
      <text
        fg={theme.colors.dim}
        content={`${t.get(["Views", "ask", "selectHint"])}${
          agentOptionCount > 0 && selectedIndex < agentOptionCount ? t.get(["Views", "ask", "noteHint"]) : ""
        }`}
      />
      {error ? <ErrorMessage text={error} colors={theme.colors} /> : null}
    </PanelSurface>
  );
}
