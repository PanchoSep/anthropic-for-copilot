import vscode from 'vscode';
import { safeStringify } from '../json';
import type {
	AnthropicContentBlock,
	AnthropicMessage,
	AnthropicTool,
	AnthropicToolCall,
} from '../types';
import { THINKING_COMPLETE_KEY, THINKING_REDACTED_KEY, THINKING_SIGNATURE_KEY } from './thinking';
import {
	isImageDataPart,
	normalizeToolResult,
	type NormalizedToolResult,
} from './vision/normalize';

const CACHE_CONTROL_MIME = 'cache_control';

export interface ConvertedAnthropicPayload {
	system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
	messages: AnthropicMessage[];
}

/**
 * Convert VS Code chat messages to Anthropic Messages API format.
 * Extracts system prompts to top-level `system` property.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	replayThinking: boolean,
	nativeImageInput: boolean,
): ConvertedAnthropicPayload {
	const resultMessages: AnthropicMessage[] = [];
	let systemPrompt = '';
	let systemHasCache = false;

	for (const message of messages) {
		const role = mapRole(message.role);

		// Handle System messages separately for Anthropic API
		if (role === 'system') {
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					if (systemPrompt) {
						systemPrompt += '\n\n';
					}
					systemPrompt += part.value;
				} else if (
					part instanceof vscode.LanguageModelDataPart &&
					part.mimeType === CACHE_CONTROL_MIME &&
					part.data.toString() === 'ephemeral'
				) {
					systemHasCache = true;
				}
			}
			continue;
		}

		let textContent = '';
		const contentBlocks: AnthropicContentBlock[] = [];
		const thinkingBlocks: AnthropicContentBlock[] = [];
		const toolCalls: AnthropicToolCall[] = [];
		const toolResults: NormalizedToolResult[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textContent += part.value;
				// Copilot replays a tool-only assistant turn as an empty text part in
				// front of the tool call, so these accumulate one per tool round.
				// Anthropic rejects the whole request over any of them with
				// `messages: text content blocks must be non-empty`, so an empty part
				// never becomes a block.
				if (part.value.length > 0) {
					contentBlocks.push({
						type: 'text',
						text: part.value,
					});
				}
			} else if (
				part instanceof vscode.LanguageModelDataPart &&
				part.mimeType === CACHE_CONTROL_MIME
			) {
				const data = part.data.toString();
				if (data === 'ephemeral') {
					const lastBlock = contentBlocks[contentBlocks.length - 1];

					// Agregar cache_control al último bloque si es compatible
					if (lastBlock && blockSupportsCacheControl(lastBlock)) {
						(lastBlock as any).cache_control = { type: 'ephemeral' };
					} else {
						// Crear un bloque dummy con cache_control
						contentBlocks.push({
							type: 'text',
							text: ' ',
							cache_control: { type: 'ephemeral' },
						} as any);
					}
				}
			} else if (nativeImageInput && role === 'user' && isImageDataPart(part)) {
				contentBlocks.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: part.mimeType,
						data: Buffer.from(part.data).toString('base64'),
					},
				});
			} else if (isLanguageModelThinkingPart(part)) {
				const block = toReplayableThinkingBlock(part);
				if (block) {
					thinkingBlocks.push(block);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const inputObj =
					typeof part.input === 'object' && part.input !== null
						? (part.input as Record<string, unknown>)
						: {};
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
				contentBlocks.push({
					type: 'tool_use',
					id: part.callId,
					name: part.name,
					input: inputObj,
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push(normalizeToolResult(part));
			}
		}

		if (role === 'assistant') {
			if (contentBlocks.length > 0) {
				// Anthropic requires signed thinking blocks to lead the turn, so unsigned
				// reasoning text (e.g. from a replay marker) is never sent back.
				const assistantBlocks: AnthropicContentBlock[] = replayThinking
					? [...thinkingBlocks, ...contentBlocks]
					: [...contentBlocks];

				resultMessages.push({
					role: 'assistant',
					content: assistantBlocks,
				});
			}
		} else {
			if (contentBlocks.length > 0) {
				resultMessages.push({
					role: 'user',
					content: contentBlocks,
				});
			}
		}

		// Tool result messages are added as 'user' content blocks in Anthropic API
		for (const tr of toolResults) {
			resultMessages.push({
				role: 'user',
				content: [convertToolResultContent(tr, nativeImageInput)],
			});
		}
	}

	return {
		system:
			systemHasCache && systemPrompt
				? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
				: systemPrompt || undefined,
		messages: resultMessages,
	};
}

function convertToolResultContent(
	toolResult: NormalizedToolResult,
	nativeImageInput: boolean,
): AnthropicContentBlock {
	const hasImages = toolResult.parts.some((part) => part.type === 'image');
	if (!nativeImageInput || !hasImages) {
		const text = toolResult.parts
			.filter((part) => part.type === 'text')
			.map((part) => part.text)
			.join('');
		const textContent =
			text ||
			(toolResult.originalContent.length > 0 ? safeStringify(toolResult.originalContent) : '');

		return {
			type: 'tool_result',
			tool_use_id: toolResult.callId,
			content: textContent,
		};
	}

	const blocks: Array<
		import('../types').AnthropicTextBlock | import('../types').AnthropicImageBlock
	> = [];
	for (const part of toolResult.parts) {
		if (part.type === 'text') {
			blocks.push({ type: 'text', text: part.text });
		} else if (part.type === 'image') {
			blocks.push({
				type: 'image',
				source: {
					type: 'base64',
					media_type: part.mimeType,
					data: Buffer.from(part.data).toString('base64'),
				},
			});
		}
	}

	return {
		type: 'tool_result',
		tool_use_id: toolResult.callId,
		content: blocks,
	};
}

function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

/**
 * Rebuilds a thinking block from the metadata `stream.ts` attached when it was
 * reported. Parts without it are the incremental display text and are dropped.
 */
function toReplayableThinkingBlock(
	part: vscode.LanguageModelThinkingPart,
): AnthropicContentBlock | undefined {
	const metadata = part.metadata;
	if (!metadata) {
		return undefined;
	}
	const redacted = metadata[THINKING_REDACTED_KEY];
	if (typeof redacted === 'string' && redacted) {
		return { type: 'redacted_thinking', data: redacted };
	}
	const signature = metadata[THINKING_SIGNATURE_KEY];
	const thinking = metadata[THINKING_COMPLETE_KEY];
	if (typeof signature === 'string' && signature && typeof thinking === 'string') {
		return { type: 'thinking', thinking, signature };
	}
	return undefined;
}

/**
 * While a tool loop is in flight (the conversation ends in tool results),
 * Anthropic rejects an `enabled` thinking request unless the last assistant
 * turn starts with a thinking block. History that predates signature capture,
 * or a turn the model answered without thinking, cannot satisfy that.
 */
export function canContinueToolLoopWithThinking(messages: readonly AnthropicMessage[]): boolean {
	let index = messages.length - 1;
	while (index >= 0 && isToolResultMessage(messages[index])) {
		index--;
	}
	if (index === messages.length - 1 || index < 0 || messages[index].role !== 'assistant') {
		return true;
	}
	const content = messages[index].content;
	if (!Array.isArray(content)) {
		return false;
	}
	const first = content[0]?.type;
	return first === 'thinking' || first === 'redacted_thinking';
}

function isToolResultMessage(message: AnthropicMessage): boolean {
	return (
		message.role === 'user' &&
		Array.isArray(message.content) &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === 'tool_result')
	);
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return role === 3 ? 'system' : 'user';
	}
}

/**
 * Convert VS Code tool definitions to Anthropic format.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): AnthropicTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: (tool.inputSchema as Record<string, unknown>) || {
			type: 'object',
			properties: {},
		},
	}));
}

/**
 * Count total characters across all messages for chars-per-token calibration.
 */
export function countMessageChars(messages: AnthropicMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			total += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text') {
					total += block.text.length;
				} else if (block.type === 'thinking') {
					total += block.thinking.length;
				} else if (block.type === 'tool_use') {
					total += block.name.length + safeStringify(block.input).length;
				}
			}
		}
	}
	return total;
}

/**
 * Determina si un bloque de contenido soporta cache_control.
 * Solo text, image y tool_use blocks pueden tener cache_control según la API de Anthropic.
 */
function blockSupportsCacheControl(block: AnthropicContentBlock): boolean {
	return block.type === 'text' || block.type === 'image' || block.type === 'tool_use';
}
