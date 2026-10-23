import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicClient } from '../../src/client';
import type { AnthropicRequest, AnthropicUsage, StreamCallbacks } from '../../src/types';

// Anthropic reports usage as cumulative snapshots, so a turn must end up with
// the totals from the stream's last snapshot — not the sum of every snapshot.
// A relay that repeats the full snapshot in `message_delta` used to report a
// live turn of 2 input + 75,559 cache-write tokens as 151,122.

interface Run {
	usages: AnthropicUsage[];
	doneCount: number;
}

function sse(inputTokens: number, cacheCreation: number, outputTokens: number, repeat: boolean): string {
	const start = {
		type: 'message_start',
		message: {
			id: 'm',
			type: 'message',
			role: 'assistant',
			model: 'm',
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: inputTokens,
				output_tokens: 0,
				cache_creation_input_tokens: cacheCreation,
				cache_read_input_tokens: 0,
			},
		},
	};
	const delta = {
		type: 'message_delta',
		delta: { stop_reason: 'end_turn', stop_sequence: null },
		usage: repeat
			? {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					cache_creation_input_tokens: cacheCreation,
					cache_read_input_tokens: 0,
				}
			: { output_tokens: outputTokens },
	};

	return [
		'event: message_start',
		`data: ${JSON.stringify(start)}`,
		'',
		'event: content_block_start',
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
		'',
		'event: content_block_delta',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
		'',
		'event: content_block_stop',
		'data: {"type":"content_block_stop","index":0}',
		'',
		'event: message_delta',
		`data: ${JSON.stringify(delta)}`,
		'',
		'event: message_stop',
		'data: {"type":"message_stop"}',
		'',
		'',
	].join('\n');
}

async function run(body: string): Promise<Run> {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		})) as typeof globalThis.fetch;

	const usages: AnthropicUsage[] = [];
	let doneCount = 0;
	const callbacks: StreamCallbacks = {
		onContent: () => {},
		onThinking: () => {},
		onToolCall: () => {},
		onError: (error) => {
			throw error;
		},
		onDone: () => {
			doneCount++;
		},
		onUsage: (usage) => usages.push(usage),
	};

	try {
		const client = new AnthropicClient('http://relay.example', {
			value: 'tok',
			scheme: 'bearer',
			origin: 'auth-token-env',
		});
		const request: AnthropicRequest = {
			model: '',
			max_tokens: 16,
			stream: true,
			messages: [{ role: 'user', content: 'hi' }],
		};
		await client.streamChatCompletion(request, callbacks);
	} finally {
		globalThis.fetch = original;
	}

	return { usages, doneCount };
}

test.beforeEach(() => {
	globalThis.__vscodeMock.reset();
	globalThis.__vscodeMock.config['anthropic-copilot.useClaudeCodeSettings'] = false;
});

test('a repeated cumulative snapshot is not double-counted', async () => {
	const { usages } = await run(sse(2, 75_559, 820, true));

	assert.equal(usages.length, 1);
	assert.equal(usages[0].input_tokens, 2);
	assert.equal(usages[0].cache_creation_input_tokens, 75_559);
	assert.equal(usages[0].prompt_tokens, 75_561);
	assert.equal(usages[0].completion_tokens, 820);
	assert.equal(usages[0].total_tokens, 76_381);
});

test('an output-only delta builds the same input totals', async () => {
	const { usages } = await run(sse(2, 75_559, 820, false));

	assert.equal(usages.length, 1);
	assert.equal(usages[0].prompt_tokens, 75_561);
	assert.equal(usages[0].completion_tokens, 820);
	assert.equal(usages[0].total_tokens, 76_381);
});

test('usage and completion are reported once per stream', async () => {
	const { usages, doneCount } = await run(sse(2, 75_559, 820, true));

	assert.equal(usages.length, 1);
	assert.equal(doneCount, 1);
});
