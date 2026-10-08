import Anthropic from '@anthropic-ai/sdk';
import type { CancellationToken } from 'vscode';
import { getCustomHeaders } from '../config';
import { buildSdkAuth, CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT, type Credential } from '../credentials';
import { safeStringify } from '../json';
import { logger } from '../logger';
import type {
	AnthropicRequest,
	AnthropicToolCall,
	AnthropicUsage,
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

		const pendingToolCalls = new Map<number, AnthropicToolCall>();
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

			stream.on('streamEvent', (event) => {
				if (cancellationToken?.isCancellationRequested) {
					stream.controller.abort();
					return;
				}

				switch (event.type) {
					case 'message_start': {
						if (event.message?.usage) {
							accumulateUsage(latestUsage, event.message.usage as any);
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
							if ((block as any).thinking) {
								callbacks.onThinking((block as any).thinking);
							}
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
							callbacks.onThinking((delta as any).thinking);
						} else if (delta?.type === 'input_json_delta' && delta.partial_json) {
							const pending = pendingToolCalls.get(index);
							if (pending) {
								pending.function.arguments += delta.partial_json;
								// Report incremental tool call arguments if callback is provided
								if (callbacks.onToolCallDelta) {
									callbacks.onToolCallDelta(
										pending.id,
										pending.function.name,
										pending.function.arguments,
									);
								}
							}
						}
						break;
					}

					case 'content_block_stop': {
						const index = event.index;
						const pending = pendingToolCalls.get(index);
						if (pending) {
							callbacks.onToolCall(pending);
							pendingToolCalls.delete(index);
						}
						break;
					}

					case 'message_delta': {
						if (event.usage) {
							accumulateUsage(latestUsage, event.usage as any);
						}
						break;
					}

					case 'message_stop': {
						flushPendingToolCalls(pendingToolCalls, callbacks);
						reportFinalUsage(callbacks, latestUsage);
						callbacks.onDone();
						break;
					}
				}
			});

			await stream.done();
			cancelListener?.dispose();

			flushPendingToolCalls(pendingToolCalls, callbacks);
			reportFinalUsage(callbacks, latestUsage);
			callbacks.onDone();
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

function flushPendingToolCalls(
	pendingToolCalls: Map<number, AnthropicToolCall>,
	callbacks: StreamCallbacks,
): void {
	for (const tc of pendingToolCalls.values()) {
		callbacks.onToolCall(tc);
	}
	pendingToolCalls.clear();
}

function accumulateUsage(target: AnthropicUsage, source: Partial<AnthropicUsage>): void {
	if (typeof source.input_tokens === 'number') {
		target.input_tokens = (target.input_tokens || 0) + source.input_tokens;
	}
	if (typeof source.output_tokens === 'number') {
		target.output_tokens = (target.output_tokens || 0) + source.output_tokens;
	}
	if (typeof (source as any).cache_read_input_tokens === 'number') {
		target.cache_read_input_tokens =
			(target.cache_read_input_tokens || 0) + (source as any).cache_read_input_tokens;
	}
	if (typeof (source as any).cache_creation_input_tokens === 'number') {
		target.cache_creation_input_tokens =
			(target.cache_creation_input_tokens || 0) + (source as any).cache_creation_input_tokens;
	}
	// prompt_tokens debe incluir TODOS los tokens de entrada: input + cache_creation + cache_read
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
