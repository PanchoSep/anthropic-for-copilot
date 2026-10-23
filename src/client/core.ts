import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CancellationToken } from 'vscode';
import { getCustomHeaders } from '../config';
import { buildSdkAuth, CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT, type Credential } from '../credentials';
import { safeStringify } from '../json';
import { logger } from '../logger';
import type {
	AnthropicRequest,
	AnthropicToolCall,
	AnthropicUsage,
	CompletedThinkingBlock,
	StreamCallbacks,
} from '../types';
import { buildMessagesEndpoint, normalizeSdkBaseUrl } from './base-url';
import { formatRequestError, normalizeRequestError, sanitizeHeaders } from './error';

/**
 * Anthropic Messages API client built on top of official `@anthropic-ai/sdk`.
 */
export class AnthropicClient {
	private readonly sdk: Anthropic;

	constructor(
		private readonly baseUrl: string,
		private readonly credential: Credential | undefined,
	) {
		const auth = buildSdkAuth(credential, getCustomHeaders());

		this.sdk = new Anthropic({
			apiKey: auth.apiKey,
			authToken: auth.authToken,
			baseURL: normalizeSdkBaseUrl(this.baseUrl),
			defaultHeaders: auth.defaultHeaders,
		});
	}

	/**
	 * Stream a chat completion from the Anthropic Messages API using official SDK stream.
	 */
	async streamChatCompletion(
		request: AnthropicRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const customHeaders = getCustomHeaders();
		const requestHeaders: Record<string, string> = {};
		if (request.betas?.length) {
			requestHeaders['anthropic-beta'] = request.betas.join(',');
		}
		Object.assign(requestHeaders, customHeaders);

		const endpoint = buildMessagesEndpoint(this.baseUrl);
		const authSummary = describeAuth(this.credential, customHeaders);

		logger.info(
			`Initiating Anthropic SDK request: endpoint="${endpoint}" model="${request.model}" ` +
				`auth=${authSummary} ` +
				`betas=${request.betas?.join(',') || 'none'} ` +
				`system=${describeSystem(request.system)} ` +
				`customHeaders=${safeStringify(sanitizeHeaders(customHeaders))}`,
		);

		const payloadPath = join(tmpdir(), `anthropic-request-${Date.now()}.json`);
		try {
			await writeFile(payloadPath, safeStringify(request, null, 2), 'utf8');
			logger.info(`Full request payload saved to: ${payloadPath}`);
			console.log(`Full request payload saved to: ${payloadPath}`);
		} catch (err) {
			logger.warn(`Failed to save request payload: ${err}`);
		}

		const pendingToolCalls = new Map<number, AnthropicToolCall>();
		const pendingThinking = new Map<number, { thinking: string; signature: string }>();
		const latestUsage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

		try {
			const stream = this.sdk.messages.stream(
				{
					model: request.model,
					max_tokens: request.max_tokens,
					messages: request.messages as any,
					system: request.system as any,
					tools: request.tools as any,
					tool_choice: request.tool_choice as any,
					thinking: request.thinking as any,
					output_config: request.output_config as any,
					temperature: request.temperature,
					top_p: request.top_p,
				},
				{
					headers: requestHeaders,
				},
			);

			const cancelListener = cancellationToken?.onCancellationRequested(() => {
				stream.controller.abort();
			});

			if (cancellationToken?.isCancellationRequested) {
				stream.controller.abort();
				return;
			}

			let eventCount = 0;
			let finalized = false;
			const finalize = () => {
				// `message_stop` and the post-loop path would otherwise both report,
				// handing Copilot the same usage twice.
				if (finalized) {
					return;
				}
				finalized = true;
				flushPendingToolCalls(pendingToolCalls, callbacks);
				reportFinalUsage(callbacks, latestUsage);
				callbacks.onDone();
			};

			for await (const event of stream) {
				eventCount++;

				if (cancellationToken?.isCancellationRequested) {
					stream.controller.abort();
					break;
				}

				switch (event.type) {
					case 'message_start': {
						if (event.message?.usage) {
							mergeUsageSnapshot(latestUsage, event.message.usage as any);
						}
						break;
					}

					case 'content_block_start': {
						const index = event.index;
						const block = event.content_block;
						if (block?.type === 'text') {
							if (block.text) {
								callbacks.onContent(block.text);
							}
						} else if (block?.type === 'thinking') {
							const initial: string = (block as any).thinking ?? '';
							pendingThinking.set(index, {
								thinking: initial,
								signature: (block as any).signature ?? '',
							});
							if (initial) {
								callbacks.onThinking(initial);
							}
						} else if (block?.type === 'redacted_thinking') {
							callbacks.onThinkingBlock?.({
								type: 'redacted_thinking',
								data: (block as any).data ?? '',
							});
						} else if (block?.type === 'tool_use') {
							pendingToolCalls.set(index, {
								id: block.id || `tool_${Date.now()}_${index}`,
								type: 'function',
								function: {
									name: block.name || '',
									arguments: '',
								},
							});
						}
						break;
					}

					case 'content_block_delta': {
						const index = event.index;
						const delta = event.delta;

						if (delta?.type === 'text_delta' && delta.text) {
							callbacks.onContent(delta.text);
						} else if (delta?.type === 'thinking_delta' && (delta as any).thinking) {
							const text: string = (delta as any).thinking;
							const thinking = pendingThinking.get(index);
							if (thinking) {
								thinking.thinking += text;
							}
							callbacks.onThinking(text);
						} else if (delta?.type === 'signature_delta') {
							const thinking = pendingThinking.get(index);
							if (thinking) {
								thinking.signature += (delta as any).signature ?? '';
							}
						} else if (delta?.type === 'input_json_delta' && delta.partial_json) {
							const pending = pendingToolCalls.get(index);
							if (pending) {
								pending.function.arguments += delta.partial_json;
							}
						}
						break;
					}

					case 'content_block_stop': {
						const index = event.index;
						const thinking = pendingThinking.get(index);
						if (thinking) {
							pendingThinking.delete(index);
							emitThinkingBlock(callbacks, thinking);
						}
						const pending = pendingToolCalls.get(index);
						if (pending) {
							callbacks.onToolCall(pending);
							pendingToolCalls.delete(index);
						}
						break;
					}

					case 'message_delta': {
						if (event.usage) {
							mergeUsageSnapshot(latestUsage, event.usage as any);
						}
						break;
					}

					case 'message_stop': {
						finalize();
						break;
					}
				}
			}

			cancelListener?.dispose();

			finalize();
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			const normalizedError = normalizeRequestError(error, {
				baseUrl: this.baseUrl,
				request,
				headers: { 'anthropic-auth': authSummary },
				customHeaders,
			});
			logger.error('Anthropic SDK request failed:', formatRequestError(normalizedError));
			callbacks.onError(normalizedError);
		}
	}
}

/**
 * Describes the credential actually put on the wire. Reporting a header map
 * the client never sends makes auth failures impossible to diagnose.
 */
function describeAuth(
	credential: Credential | undefined,
	customHeaders: Record<string, string>,
): string {
	const overridden = Object.keys(customHeaders).find((key) =>
		['authorization', 'x-api-key'].includes(key.toLowerCase()),
	);
	if (overridden) {
		return `custom-header(${overridden.toLowerCase()})`;
	}
	if (!credential) {
		return 'none';
	}
	return `${credential.scheme}(from ${credential.origin})`;
}

/**
 * Summarizes the system prompt actually being sent, without logging its full
 * content. An OAuth access token 429s unless `system[0]` is *exactly* the
 * Claude Code identity line as its own block — merely containing that text
 * somewhere in a single concatenated string still 429s. `identity=strict`
 * confirms the isolated-block form; `identity=loose` flags the
 * looks-right-but-still-fails concatenated form so it's visible from the log
 * alone, without needing to reproduce against the relay again.
 */
function describeSystem(system: AnthropicRequest['system']): string {
	if (!system) {
		return 'none';
	}
	const blocks = typeof system === 'string' ? [system] : system.map((b) => b.text);
	const chars = blocks.reduce((sum, b) => sum + b.length, 0);
	let identity: 'strict' | 'loose' | 'no' = 'no';
	if (blocks[0] === CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT) {
		identity = 'strict';
	} else if (blocks.some((b) => b.includes(CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT))) {
		identity = 'loose';
	}
	return `chars=${chars} identity=${identity}`;
}

function emitThinkingBlock(
	callbacks: StreamCallbacks,
	thinking: { thinking: string; signature: string },
): void {
	// A thinking block without a signature can never be replayed, so it is not worth reporting.
	if (!thinking.signature) {
		return;
	}
	const block: CompletedThinkingBlock = {
		type: 'thinking',
		thinking: thinking.thinking,
		signature: thinking.signature,
	};
	callbacks.onThinkingBlock?.(block);
}

function flushPendingToolCalls(
	pendingToolCalls: Map<number, AnthropicToolCall>,
	callbacks: StreamCallbacks,
): void {
	for (const tc of pendingToolCalls.values()) {
		callbacks.onToolCall(tc);
	}
	pendingToolCalls.clear();
}

// Anthropic reports usage as cumulative snapshots (`message_start` carries the
// input side, `message_delta` the running output total) and some relays repeat
// the full snapshot in `message_delta`. Summing them therefore double-counts the
// input: 2 input + 75,559 cache-write tokens were reported as 151,122.
function mergeUsageSnapshot(target: AnthropicUsage, source: Partial<AnthropicUsage>): void {
	// Widening keeps a later, smaller delta from erasing an earlier total.
	const take = (current: number | undefined, next: unknown): number | undefined =>
		typeof next === 'number' ? Math.max(current ?? 0, next) : current;

	target.input_tokens = take(target.input_tokens, source.input_tokens)!;
	target.output_tokens = take(target.output_tokens, source.output_tokens)!;
	target.cache_read_input_tokens = take(
		target.cache_read_input_tokens,
		(source as any).cache_read_input_tokens,
	);
	target.cache_creation_input_tokens = take(
		target.cache_creation_input_tokens,
		(source as any).cache_creation_input_tokens,
	);
	// prompt_tokens includes every input flavour: input + cache_creation + cache_read
	const cacheRead = target.cache_read_input_tokens || 0;
	const cacheCreation = target.cache_creation_input_tokens || 0;
	target.prompt_tokens = target.input_tokens + cacheRead + cacheCreation;
	target.completion_tokens = target.output_tokens;
	target.total_tokens = target.prompt_tokens + target.output_tokens;
	target.prompt_cache_hit_tokens = target.cache_read_input_tokens;
	target.prompt_cache_miss_tokens = target.cache_creation_input_tokens;
}

function reportFinalUsage(callbacks: StreamCallbacks, usage: AnthropicUsage): void {
	if (!callbacks.onUsage) {
		return;
	}
	callbacks.onUsage(usage);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error &&
			(error.name === 'AbortError' || error.name === 'APIUserAbortError')) ||
		(typeof error === 'object' && error !== null && (error as any).name === 'APIUserAbortError')
	);
}
