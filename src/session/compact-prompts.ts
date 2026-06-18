/**
 * Compact-phase prompt templates (P2.3).
 *
 * Used by Session's compact machinery (_runCompactPhase / runManualCompact).
 * Wording changes here directly shape continuation quality after compaction.
 */

// -- Compact Prompt: Output scenario --
export const COMPACT_PROMPT_OUTPUT = `Condense this conversation into a continuation prompt 鈥?imagine you're writing a briefing for a fresh instance of yourself who must seamlessly pick up where we left off, with zero access to the original conversation.

**Before writing the continuation prompt**, make sure any stable, long-term knowledge from this session has been written to AGENTS.md if it belongs there.

**What the new instance will already have:** your system prompt and AGENTS.md persistent memory are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt 鈥?focus on what they don't cover: current progress, session-specific context, and in-flight work state.

Your summary should capture everything that matters and nothing that doesn't. Use whatever structure best fits the actual content 鈥?there is no fixed template. But as you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, and any constraints or preferences they've expressed 鈥?stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and *why*.
- **Where exactly are we?** What's done, what's in progress, what's next. Be specific enough that work won't be repeated or skipped.
- **What artifacts exist?** Files read, created, or modified 鈥?with enough context about each to be actionable (not just a path list).
- **What tone/style/working relationship has been established?** If the user has shown preferences for how they like to collaborate, note them.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints the user has explicitly communicated (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim 鈥?they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next 鈥?anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

Write in natural prose. Use structure where it aids clarity, not for its own sake.`;

// -- Compact Prompt: Tool Call scenario --
export const COMPACT_PROMPT_TOOLCALL = `[SYSTEM: COMPACT REQUIRED] The conversation has exceeded the context limit. Do NOT continue the task. Instead, produce a **continuation prompt** 鈥?a briefing that will allow a fresh instance of you (with no access to this conversation) to seamlessly resume the work.

You just made a tool call and received its result above. That result is real and should be reflected in your summary, but do not act on it 鈥?your only job right now is to write the continuation prompt.

**Before writing the continuation prompt**, make sure any stable, long-term knowledge from this session has been written to AGENTS.md if it belongs there.

**What the new instance will already have:** your system prompt and AGENTS.md persistent memory are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt 鈥?focus on what they don't cover: current progress, session-specific context, and in-flight work state.

Write in natural prose. Use structure where it aids clarity, not for its own sake. As you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, constraints, and preferences 鈥?stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and why.
- **Where exactly did we stop?** Be precise: what was the last tool call, what did it return, and what was supposed to happen next? The new instance must be able to pick up mid-step without repeating or skipping anything.
- **What's done, what's in progress, what remains?** Give a clear picture of overall progress, not just the interrupted step.
- **What artifacts exist?** Files read, created, or modified 鈥?with enough context about each to be actionable.
- **What working style has the user shown?** Communication preferences, collaboration patterns, or explicit instructions about how they like to work.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim 鈥?they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next 鈥?anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

End the summary with a clear, imperative statement of what the next instance should do first upon resuming.`;

export function appendManualInstruction(
  basePrompt: string,
  instruction: string | undefined,
  kind: "summarize" | "compact",
): string {
  const trimmed = instruction?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\nAdditional user instruction for this manual ${kind} request:\n${trimmed}`;
}
