import vscode from 'vscode';
import { createUserFacingError } from '../client';
import { logger } from '../logger';
import type { AnthropicToolCall, AnthropicUsage, CompletedThinkingBlock } from '../types';
import {
	observeCancellationToken,
	type CacheDiagnosticsRun,
	type ReplayMarkerReportTrigger,
} from './debug';
import {
	createReplayMarkerPart,
	hasReplayMarkerMetadata,
	type ReplayMarkerMetadata,
} from './replay';
import type { PreparedChatRequest } from './request';
import { formatRequestLogLine, type RequestKind } from './routing';
import { THINKING_COMPLETE_KEY, THINKING_REDACTED_KEY, THINKING_SIGNATURE_KEY } from './thinking';

interface ResponseStreamState {
	accumulatedReasoning: string;
	emittedToolCallIds: string[];
	initialResponseNoticeReported: boolean;
	replayMarkerReported: boolean;
}

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

export interface StreamChatCompletionOptions {
	prepared: PreparedChatRequest;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	initialResponseNotice?: string;
	getCharsPerToken: () => number;
	setCharsPerToken: (charsPerToken: number) => void;
}

export function streamChatCompletion({
	prepared,
	progress,
	token,
	initialResponseNotice,
	getCharsPerToken,
	setCharsPerToken,
}: StreamChatCompletionOptions): Promise<void> {
	const state: ResponseStreamState = {
		accumulatedReasoning: '',
		emittedToolCallIds: [],
		initialResponseNoticeReported: false,
		replayMarkerReported: false,
	};
	const cancelListener = observeCancellationToken(token, prepared.cacheDiagnostics);

	return prepared.client
		.streamChatCompletion(
			prepared.request,
			{
				onContent: (content: string) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					progress.report(new vscode.LanguageModelTextPart(content));
				},

				onThinking: (text: string) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleThinking(text, state, progress);
				},

				onThinkingBlock: (block: CompletedThinkingBlock) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleThinkingBlock(block, progress);
				},

				onToolCall: (toolCall: AnthropicToolCall) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleToolCall(toolCall, state, progress);
				},

				onError: (error: Error) => {
					throw createUserFacingError(error);
				},

				onDone: () => {
					reportReplayMarkerOnce(prepared, progress, state, 'done');
					finalizeReplayDiagnostics(
						prepared.trailingToolResultIds,
						state,
						prepared.cacheDiagnostics,
					);
				},

				onUsage: (usage: AnthropicUsage) => {
					const charsPerToken = prepared.hasNativeImages
						? getCharsPerToken()
						: updateCharsPerToken(prepared.totalRequestChars, usage, getCharsPerToken());
					if (!prepared.hasNativeImages) {
						setCharsPerToken(charsPerToken);
					}
					prepared.cacheDiagnostics.onUsage(usage, charsPerToken);
					reportCopilotContextUsage(progress, usage, prepared.requestKind);
				},
			},
			token,
		)
		.then(undefined, (error: unknown) => {
			reportSkippedReplayMarkerIfNeeded(
				prepared,
				state,
				token.isCancellationRequested ? 'cancelled' : 'stream-error',
				error,
			);
			throw error;
		})
		.then(() => {
			if (token.isCancellationRequested) {
				reportSkippedReplayMarkerIfNeeded(prepared, state, 'cancelled');
			}
		})
		.finally(() => {
			cancelListener.dispose();
		});
}

function reportInitialResponseNoticeOnce(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	initialResponseNotice: string | undefined,
): void {
	if (!initialResponseNotice || state.initialResponseNoticeReported) {
		return;
	}
	state.initialResponseNoticeReported = true;
	progress.report(new vscode.LanguageModelTextPart(initialResponseNotice));
}

function reportReplayMarkerOnce(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	reportReplayMarker(prepared, progress, state, trigger);
}

function reportSkippedReplayMarkerIfNeeded(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
	reason: 'cancelled' | 'stream-error',
	error?: unknown,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	prepared.cacheDiagnostics.onReplayMarkerReport({
		status: 'skipped',
		reason,
		visionTextChars: prepared.visionMarkerTextChars,
		reasoningTextChars: state.accumulatedReasoning.length || undefined,
		error,
	});
}

function reportReplayMarker(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	const metadata = getReplayMarkerMetadata(prepared, state);
	if (!hasReplayMarkerMetadata(metadata)) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'skipped',
			trigger,
			reason: 'no-replay-data',
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
		return;
	}

	try {
		const markerPart = createReplayMarkerPart(metadata);
		progress.report(markerPart);
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'reported',
			trigger,
			markerBytes: markerPart.data.byteLength,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
	} catch (error) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'failed',
			trigger,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
			error,
		});
		logger.warn(
			formatRequestLogLine(prepared.requestKind, 'Failed to report replay marker'),
			error,
		);
	}
}

function getReplayMarkerMetadata(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
): ReplayMarkerMetadata {
	return {
		...prepared.replayMarkerMetadata,
		reasoningText: state.accumulatedReasoning || undefined,
	};
}

function handleThinking(
	text: string,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.accumulatedReasoning += text;

	// LanguageModelThinkingPart is a proposed API; the project root augmentation provides types.
	progress.report(
		new vscode.LanguageModelThinkingPart(text) as unknown as vscode.LanguageModelResponsePart,
	);
}

// Copilot hands thinking parts back on the next turn with the `metadata` it was
// given here, which is how a signed block survives the round trip through a
// tool loop. The streamed text above is display-only and is ignored on replay.
function handleThinkingBlock(
	block: CompletedThinkingBlock,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	const metadata =
		block.type === 'redacted_thinking'
			? { [THINKING_REDACTED_KEY]: block.data }
			: {
					[THINKING_SIGNATURE_KEY]: block.signature,
					[THINKING_COMPLETE_KEY]: block.thinking,
				};
	progress.report(
		new vscode.LanguageModelThinkingPart(
			'',
			undefined,
			metadata,
		) as unknown as vscode.LanguageModelResponsePart,
	);
}

// Each reported LanguageModelToolCallPart is a distinct call to VS Code, so a
// tool call must be reported exactly once, with its complete arguments.
// Reporting partial updates under the same id replays duplicate `tool_use`
// ids in history, which Anthropic rejects with a 400.
function handleToolCall(
	toolCall: AnthropicToolCall,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (state.emittedToolCallIds.includes(toolCall.id)) {
		return;
	}
	state.emittedToolCallIds.push(toolCall.id);

	let args: object = {};
	try {
		const parsed: unknown = JSON.parse(toolCall.function.arguments || '{}');
		if (parsed && typeof parsed === 'object') {
			args = parsed;
		}
	} catch {
		// Malformed arguments: fall back to empty input rather than dropping the call.
	}
	progress.report(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args));
}

function finalizeReplayDiagnostics(
	trailingToolResultIds: readonly string[],
	state: ResponseStreamState,
	cacheDiagnostics: CacheDiagnosticsRun,
): void {
	cacheDiagnostics.onDone({
		reasoningTextChars: state.accumulatedReasoning.length,
		emittedToolCalls: state.emittedToolCallIds.length,
		trailingToolResults: trailingToolResultIds.length,
	});
}

function updateCharsPerToken(
	totalRequestChars: number,
	usage: AnthropicUsage,
	charsPerToken: number,
): number {
	const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
	if (totalRequestChars > 0 && promptTokens > 0) {
		const observedRatio = totalRequestChars / promptTokens;
		return charsPerToken * 0.7 + observedRatio * 0.3;
	}
	return charsPerToken;
}

function reportCopilotContextUsage(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: AnthropicUsage,
	requestKind: RequestKind,
): void {
	const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
	const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
	const data = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
		prompt_tokens_details: {
			cached_tokens: usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0,
		},
	};

	logger.info(
		formatRequestLogLine(
			requestKind,
			`Token usage: input=${data.prompt_tokens} output=${data.completion_tokens} ` +
				`cached=${data.prompt_tokens_details.cached_tokens} total=${data.total_tokens}`,
		),
	);

	try {
		progress.report(
			new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify(data)),
				COPILOT_USAGE_DATA_PART_MIME,
			),
		);
	} catch (error) {
		logger.warn(formatRequestLogLine(requestKind, 'Failed to report usage data'), error);
	}
}
