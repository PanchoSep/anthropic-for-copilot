import assert from 'node:assert/strict';
import test from 'node:test';
import vscode from 'vscode';
import { streamChatCompletion } from '../../src/provider/stream';
import type { StreamCallbacks, AnthropicToolCall } from '../../src/types';

// Every LanguageModelToolCallPart reported to VS Code is a distinct call. Reporting
// partial arguments under the same id replays duplicate `tool_use` ids in the next
// request, which Anthropic rejects with
// `messages.N.content.M: tool_use ids must be unique`.

function toolCall(id: string, args: string): AnthropicToolCall {
	return { id, type: 'function', function: { name: 'grep_search', arguments: args } };
}

async function run(emit: (callbacks: StreamCallbacks) => void): Promise<unknown[]> {
	const reported: unknown[] = [];
	const prepared = {
		client: {
			streamChatCompletion: async (_request: unknown, callbacks: StreamCallbacks) => {
				emit(callbacks);
				callbacks.onDone();
			},
		},
		request: {},
		cacheDiagnostics: { onUsage() {}, onDone() {}, onReplayMarkerReport() {} },
		replayMarkerMetadata: {},
		visionMarkerTextChars: 0,
		trailingToolResultIds: [],
		requestKind: 'main-agent',
		hasNativeImages: false,
		totalRequestChars: 0,
	};
	await streamChatCompletion({
		prepared: prepared as never,
		progress: { report: (part) => reported.push(part) },
		token: {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as never,
		getCharsPerToken: () => 4,
		setCharsPerToken: () => {},
	});
	return reported.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
}

test('a tool call is reported once with its complete arguments', async () => {
	const parts = (await run((cb) =>
		cb.onToolCall(toolCall('toolu_1', '{"pattern":"auth"}')),
	)) as vscode.LanguageModelToolCallPart[];
	assert.equal(parts.length, 1);
	assert.equal(parts[0].callId, 'toolu_1');
	assert.deepEqual(parts[0].input, { pattern: 'auth' });
});

test('a repeated tool call id is not reported twice', async () => {
	const parts = await run((cb) => {
		cb.onToolCall(toolCall('toolu_1', '{}'));
		cb.onToolCall(toolCall('toolu_1', '{}'));
	});
	assert.equal(parts.length, 1);
});

test('empty arguments become an empty input object', async () => {
	const parts = (await run((cb) =>
		cb.onToolCall(toolCall('toolu_1', '')),
	)) as vscode.LanguageModelToolCallPart[];
	assert.deepEqual(parts[0].input, {});
});
