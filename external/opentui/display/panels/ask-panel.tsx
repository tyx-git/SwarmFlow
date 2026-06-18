/** @jsxImportSource @opentui/react */

import React from "react";

import type { AgentQuestionItem } from "../../../src/ask.js";
import type { DisplayTheme } from "../theme/index.js";
import type { AskPanelProps } from "../types.js";
import { PanelSurface } from "../primitives/panel-surface.js";
import { countWrappedDisplayLines } from "../utils/format.js";

function formatAskSource(ask: AskPanelProps["ask"]): string {
  const sourceName = ask.source.agentName || ask.source.agentId || "Main agent";
  const lower = sourceName.toLowerCase();
  const isMain = lower === "primary" || lower === "main" || lower === "root";
  return isMain ? "Source: Main agent" : `Source: Sub-Agent ${sourceName}`;
}

export function AskPanelView({
  ask,
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
        <text fg={theme.colors.dim} content={formatAskSource(ask)} />
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
        <text fg={theme.colors.dim} content="Use 鈫?鈫?to select, Enter to confirm." />
        {error ? <text fg={theme.colors.red} content={error} /> : null}
      </PanelSurface>
    );
  }

  if (ask.kind !== "agent_question") {
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing}>
        <text fg={theme.colors.red} content={`Unsupported ask kind: ${ask.kind}`} />
        <text content={ask.summary} />
        {error ? <text fg={theme.colors.red} content={error} /> : null}
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
        <text fg={theme.colors.green} content="Review your answers" />
        <text fg={theme.colors.dim} content={formatAskSource(ask)} />
        {questions.map((question, index) => {
          const answer = questionAnswers.get(index);
          const selected = answer ? question.options[answer.optionIndex] : undefined;
          const answerDisplay = !answer
            ? "(unanswered)"
            : selected?.kind === "custom_input"
              ? `鉁?${answer.customText ?? ""}`
              : selected?.label ?? "(unknown)";
          const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
          const note = noteKey ? optionNotes.get(noteKey) : undefined;
          return (
            <box key={`ask-review-${index}`} flexDirection="column">
              <text content={`${index + 1}. ${question.question}`} />
              <text fg={!answer ? theme.colors.accent : selected?.kind === "discuss_further" ? theme.colors.accent : theme.colors.green} content={`   鈫?${answerDisplay}`} />
              {note ? <text fg={theme.colors.accent} content={`     Note: ${note}`} /> : null}
            </box>
          );
        })}
        <text fg={theme.colors.dim} content="Enter to submit. Esc to go back." />
        {error ? <text fg={theme.colors.red} content={error} /> : null}
      </PanelSurface>
    );
  }

  const question = questions[currentQuestionIndex];
  if (!question) {
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing}>
        <text fg={theme.colors.red} content="Question index out of range." />
      </PanelSurface>
    );
  }

  const existingAnswer = questionAnswers.get(currentQuestionIndex);
  const agentOptionCount = question.options.filter((option) => !option.systemAdded).length;
  const optionContentLines = question.options.reduce((total, option, index) => {
    const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
    return total + 1 + (option.description ? 1 : 0) + (note ? 1 : 0);
  }, 0);
  const inlineLines = customInputMode || noteInputMode ? 3 : 0;
  const panelContentLines = 2 + optionContentLines + inlineLines + 1 + (error ? 1 : 0);
  const panelHeight = panelContentLines + 2;

  return (
    <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
      <text fg={theme.colors.accent} content={`Question ${currentQuestionIndex + 1}/${totalQuestions}: ${question.question}`} />
      <text fg={theme.colors.dim} content={formatAskSource(ask)} />
      {question.options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const isAnswered = existingAnswer?.optionIndex === index;
        const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
        return (
          <box key={`ask-option-${index}`} flexDirection="column">
            <text
              fg={isSelected ? theme.colors.accent : isAnswered ? theme.colors.green : theme.colors.text}
              content={`${isSelected ? "> " : isAnswered ? "鉁?" : "  "}${option.label}`}
            />
            {option.description ? <text fg={theme.colors.dim} content={`   ${option.description}`} /> : null}
            {note ? <text fg={theme.colors.accent} content={`   Note: ${note}${isSelected ? " (Tab to edit)" : ""}`} /> : null}
          </box>
        );
      })}
      {customInputMode || noteInputMode ? (
        <box flexDirection="column">
          <text fg={customInputMode ? theme.colors.accent : theme.colors.accent} content={customInputMode ? "Your answer:" : "Note:"} />
          <input
            ref={(node) => {
              inputRef.current = node;
            }}
            value={inlineValue}
            focused={customInputMode || noteInputMode}
            placeholder={customInputMode ? "Type a custom answer" : "Add a note"}
            textColor={theme.colors.text}
            focusedTextColor={theme.colors.text}
            placeholderColor={theme.colors.dim}
            onInput={onInput}
            onChange={onInput}
            onSubmit={onSubmit as any}
          />
          <text
            fg={theme.colors.dim}
            content={customInputMode ? "Enter to confirm. Esc to cancel." : "Enter to save note. Esc to cancel."}
          />
        </box>
      ) : null}
      <text
        fg={theme.colors.dim}
        content={`Use 鈫?鈫?to select, 鈫?鈫?to navigate questions, Enter to confirm.${agentOptionCount > 0 && selectedIndex < agentOptionCount ? " Tab to add note." : ""}`}
      />
      {error ? <text fg={theme.colors.red} content={error} /> : null}
    </PanelSurface>
  );
}
