/**
 * Metadata keys carried on the `LanguageModelThinkingPart` we report, matching
 * the ones GitHub Copilot's own Anthropic provider uses so Copilot's thinking
 * bookkeeping treats both the same way.
 */
export const THINKING_SIGNATURE_KEY = 'signature';
export const THINKING_COMPLETE_KEY = '_completeThinking';
export const THINKING_REDACTED_KEY = 'redactedData';
