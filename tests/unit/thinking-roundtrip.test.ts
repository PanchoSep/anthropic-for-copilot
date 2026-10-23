import assert from 'node:assert/strict';
import test from 'node:test';
import vscode from 'vscode';
import { AnthropicClient } from '../../src/client';
import { canContinueToolLoopWithThinking, convertMessages } from '../../src/provider/convert';
import type {
	AnthropicMessage,
	AnthropicToolCall,
	CompletedThinkingBlock,
	StreamCallbacks,
} from '../../src/types';

// Anthropic only accepts a replayed `thinking` block together with its
// signature, and while a tool loop is in flight the last assistant turn must
// lead with that block. This covers capturing it from the stream and handing it
// back through Copilot's LanguageModelThinkingPart metadata.

for (const name of [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_API_KEY',
	'CLAUDE_AUTH_TOKEN',
]) {
	delete process.env[name];
}

function event(type: string, data: object): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const THINKING_STREAM = [
	event('message_start', {
		message: {
			id: 'm',
			type: 'message',
			role: 'assistant',
			model: 'm',
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	}),
	event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
	event('content_block_delta', {
		index: 0,
		delta: { type: 'thinking_delta', thinking: 'Let me ' },
	}),
	event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'look.' } }),
	event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-' } }),
	event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
	event('content_block_stop', { index: 0 }),
	event('content_block_start', {
		index: 1,
		content_block: { type: 'redacted_thinking', data: 'opaque' },
	}),
	event('content_block_stop', { index: 1 }),
	event('content_block_start', {
		index: 2,
		content_block: { type: 'tool_use', id: 'toolu_1', name: 'grep_search', input: {} },
	}),
	event('content_block_delta', {
		index: 2,
		delta: { type: 'input_json_delta', partial_json: '{"a":' },
	}),
	event('content_block_delta', {
		index: 2,
		delta: { type: 'input_json_delta', partial_json: '1}' },
	}),
	event('content_block_stop', { index: 2 }),
	event('message_delta', {
		delta: { stop_reason: 'tool_use', stop_sequence: null },
		usage: { output_tokens: 1 },
	}),
	event('message_stop', {}),
].join('');

test('the client reports completed thinking blocks and one tool call', async () => {
	globalThis.__vscodeMock.reset();
	globalThis.__vscodeMock.config['anthropic-copilot.useClaudeCodeSettings'] = false;
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(THINKING_STREAM, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		})) as typeof globalThis.fetch;

	const blocks: CompletedThinkingBlock[] = [];
	const toolCalls: AnthropicToolCall[] = [];
	let streamed = '';
	const callbacks: StreamCallbacks = {
		onContent: () => {},
		onThinking: (text) => {
			streamed += text;
		},
		onThinkingBlock: (block) => blocks.push(block),
		onToolCall: (call) => toolCalls.push(call),
		onError: (error) => {
			throw error;
		},
		onDone: () => {},
	};

	try {
		const client = new AnthropicClient('http://relay.example', {
			value: 'k',
			scheme: 'x-api-key',
			origin: 'api-key-env',
		});
		await client.streamChatCompletion(
			{
				model: 'm',
				max_tokens: 16,
				stream: true,
				messages: [{ role: 'user', content: 'hi' }],
			},
			callbacks,
		);
	} finally {
		globalThis.fetch = original;
	}

	assert.equal(streamed, 'Let me look.');
	assert.deepEqual(blocks, [
		{ type: 'thinking', thinking: 'Let me look.', signature: 'sig-abc' },
		{ type: 'redacted_thinking', data: 'opaque' },
	]);
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0].function.arguments, '{"a":1}');
});

type Message = vscode.LanguageModelChatRequestMessage;

function assistant(...content: unknown[]): Message {
	return {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content,
		name: undefined,
	} as unknown as Message;
}

function toolResultMessage(callId: string): Message {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [
			new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart('ok')]),
		],
		name: undefined,
	} as unknown as Message;
}

const signed = () =>
	new vscode.LanguageModelThinkingPart('', undefined, {
		signature: 'sig-abc',
		_completeThinking: 'Let me look.',
	});

test('a signed thinking part is replayed first in the assistant turn', () => {
	const { messages } = convertMessages(
		[
			assistant(
				new vscode.LanguageModelThinkingPart('Let me '),
				new vscode.LanguageModelTextPart('Searching'),
				signed(),
				new vscode.LanguageModelToolCallPart('toolu_1', 'grep_search', {}),
			),
			toolResultMessage('toolu_1'),
		],
		true,
		false,
	);

	const turn = messages[0].content as Array<{ type: string }>;
	assert.deepEqual(
		turn.map((block) => block.type),
		['thinking', 'text', 'tool_use'],
	);
	assert.deepEqual(turn[0], { type: 'thinking', thinking: 'Let me look.', signature: 'sig-abc' });
});

test('redacted thinking is replayed as redacted_thinking', () => {
	const { messages } = convertMessages(
		[
			assistant(
				new vscode.LanguageModelThinkingPart('', undefined, { redactedData: 'opaque' }),
				new vscode.LanguageModelToolCallPart('toolu_1', 'grep_search', {}),
			),
		],
		true,
		false,
	);

	assert.deepEqual((messages[0].content as unknown[])[0], {
		type: 'redacted_thinking',
		data: 'opaque',
	});
});

test('unsigned thinking text is never replayed', () => {
	const { messages } = convertMessages(
		[
			assistant(
				new vscode.LanguageModelThinkingPart('plain reasoning'),
				new vscode.LanguageModelTextPart('answer'),
			),
		],
		true,
		false,
	);

	assert.deepEqual(
		(messages[0].content as Array<{ type: string }>).map((block) => block.type),
		['text'],
	);
});

test('thinking is not replayed when the request has thinking off', () => {
	const { messages } = convertMessages(
		[assistant(signed(), new vscode.LanguageModelTextPart('answer'))],
		false,
		false,
	);

	assert.deepEqual(
		(messages[0].content as Array<{ type: string }>).map((block) => block.type),
		['text'],
	);
});

test('a tool loop continues only from an assistant turn that leads with thinking', () => {
	const toolUse = { type: 'tool_use', id: 't', name: 'n', input: {} } as const;
	const toolResult: AnthropicMessage = {
		role: 'user',
		content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
	};
	const user: AnthropicMessage = { role: 'user', content: 'hi' };

	assert.equal(
		canContinueToolLoopWithThinking([
			user,
			{
				role: 'assistant',
				content: [{ type: 'thinking', thinking: 'x', signature: 's' }, toolUse],
			},
			toolResult,
		]),
		true,
	);
	assert.equal(
		canContinueToolLoopWithThinking([user, { role: 'assistant', content: [toolUse] }, toolResult]),
		false,
	);
	// Not in a tool loop: a fresh user turn may start without prior thinking.
	assert.equal(canContinueToolLoopWithThinking([user]), true);
});
