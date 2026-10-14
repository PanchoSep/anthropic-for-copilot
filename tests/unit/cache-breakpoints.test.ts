import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vscode from 'vscode';
import { addCacheBreakpoints } from '../../src/provider/cache-breakpoints';

const CACHE_CONTROL_MIME = 'cache_control';

type Message = vscode.LanguageModelChatRequestMessage;

function userText(value: string): Message {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(value)],
		name: undefined,
	} as unknown as Message;
}

function assistantText(value: string): Message {
	return {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [new vscode.LanguageModelTextPart(value)],
		name: undefined,
	} as unknown as Message;
}

function assistantWithTool(callId: string, name: string): Message {
	return {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [new vscode.LanguageModelToolCallPart(callId, name, {})],
		name: undefined,
	} as unknown as Message;
}

function systemText(value: string): Message {
	return {
		role: 3 as any, // System role
		content: [new vscode.LanguageModelTextPart(value)],
		name: undefined,
	} as unknown as Message;
}

describe('Cache Breakpoints', () => {
	it('should not add breakpoints to very short conversations', () => {
		const messages = [userText('Hello')];

		const result = addCacheBreakpoints(messages);

		// Should return messages unchanged
		assert.equal(result.length, 1);
		
		// Check no cache marker was added
		const hasCacheMarker = result[0].content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
		);
		assert.equal(hasCacheMarker, false);
	});

	it('should add cache breakpoint to system message', () => {
		const messages = [
			systemText('You are a helpful assistant.'),
			userText('Hello'),
			assistantText('Hi!'),
		];

		const result = addCacheBreakpoints(messages);

		// System message should have cache marker
		const systemMsg = result[0];
		const hasCacheMarker = systemMsg.content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
		);
		assert.equal(hasCacheMarker, true, 'System message should have cache marker');
	});

	it('should add cache breakpoint to previous user messages, not the last one', () => {
		const messages = [
			userText('First message'),
			assistantText('Response 1'),
			userText('Second message'),
			assistantText('Response 2'),
			userText('Current message'),
		];

		const result = addCacheBreakpoints(messages);

		// Last user message (current) should NOT have cache marker
		const lastMsg = result[result.length - 1];
		const lastHasCacheMarker = lastMsg.content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
		);
		assert.equal(lastHasCacheMarker, false, 'Current user message should not have cache marker');

		// Previous user message should have cache marker
		const secondUserMsg = result[2]; // "Second message"
		const secondHasCacheMarker = secondUserMsg.content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
		);
		assert.equal(secondHasCacheMarker, true, 'Previous user message should have cache marker');
	});

	it('should add cache breakpoint to assistant messages without tool calls', () => {
		const messages = [
			userText('Hello'),
			assistantText('Hi there!'),
			userText('How are you?'),
		];

		const result = addCacheBreakpoints(messages);

		// Assistant message without tool calls should have cache marker
		const assistantMsg = result[1];
		const hasCacheMarker = assistantMsg.content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
		);
		assert.equal(hasCacheMarker, true, 'Assistant message without tool calls should have cache marker');
	});

	it('should NOT add cache breakpoint to assistant messages with tool calls', () => {
		const messages = [
			userText('What time is it?'),
			assistantWithTool('call-1', 'get_time'),
			userText('Current time'),
		];

		const result = addCacheBreakpoints(messages);

		// Assistant message with tool calls should NOT have cache marker
		const assistantMsg = result[1];
		const hasCacheMarker = assistantMsg.content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
		);
		assert.equal(hasCacheMarker, false, 'Assistant message with tool calls should not have cache marker');
	});

	it('should respect MAX_CACHE_BREAKPOINTS limit (4)', () => {
		const messages = [
			systemText('System prompt'),
			userText('Message 1'),
			assistantText('Response 1'),
			userText('Message 2'),
			assistantText('Response 2'),
			userText('Message 3'),
			assistantText('Response 3'),
			userText('Message 4'),
			assistantText('Response 4'),
			userText('Current message'),
		];

		const result = addCacheBreakpoints(messages);

		// Count cache markers
		let cacheMarkerCount = 0;
		for (const msg of result) {
			const hasCacheMarker = msg.content.some(
				(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CACHE_CONTROL_MIME
			);
			if (hasCacheMarker) {
				cacheMarkerCount++;
			}
		}

		assert.equal(cacheMarkerCount, 4, 'Should have exactly 4 cache breakpoints');
	});

	it('should preserve message content when adding cache markers', () => {
		const messages = [
			userText('Hello'),
			assistantText('Hi! How can I help you?'),
			userText('Tell me a joke'),
		];

		const result = addCacheBreakpoints(messages);

		// Verify text content is preserved
		const assistantMsg = result[1];
		const textPart = assistantMsg.content.find(
			(part) => part instanceof vscode.LanguageModelTextPart
		) as vscode.LanguageModelTextPart | undefined;
		
		assert.ok(textPart, 'Text part should exist');
		assert.equal(textPart?.value, 'Hi! How can I help you?', 'Text content should be preserved');
	});
});
