/**
 * Shared types for the Anthropic Copilot extension.
 */

// ---- API request/response types for Anthropic Messages API ----

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicTextBlock {
	type: 'text';
	text: string;
}

export interface AnthropicImageBlock {
	type: 'image';
	source: {
		type: 'base64';
		media_type: string;
		data: string;
	};
	// Compatibility property
	image_url?: {
		url: string;
	};
}

export interface AnthropicToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
	is_error?: boolean;
}

export interface AnthropicThinkingBlock {
	type: 'thinking';
	thinking: string;
	signature: string;
}

export interface AnthropicRedactedThinkingBlock {
	type: 'redacted_thinking';
	data: string;
}

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock;

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
	// Optional compatibility fields for legacy debug logging
	tool_call_id?: string;
	tool_calls?: AnthropicToolCall[];
	reasoning_content?: string;
}

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
	// Optional compatibility field for legacy debug logging
	function?: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface AnthropicUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	// Compatibility fields
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

export interface AnthropicThinkingConfig {
	type: 'enabled' | 'adaptive';
	budget_tokens?: number;
	display?: 'summarized';
}

export interface AnthropicRequest {
	model: string;
	messages: AnthropicMessage[];
	system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
	max_tokens: number;
	stream: boolean;
	temperature?: number;
	top_p?: number;
	tools?: AnthropicTool[];
	tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string } | 'none' | 'auto' | 'required';
	thinking?: AnthropicThinkingConfig | { type: 'enabled' | 'disabled' };
	output_config?: { effort?: ReasoningEffort };
	/** Anthropic beta flags sent as the `anthropic-beta` header. */
	betas?: string[];
}

export interface AnthropicToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

// ---- Stream callbacks ----

/**
 * A thinking block once Anthropic has finished streaming it. The signature
 * (or the opaque redacted payload) is what makes it replayable: the API
 * rejects thinking blocks sent back without it.
 */
export type CompletedThinkingBlock =
	| { type: 'thinking'; thinking: string; signature: string }
	| { type: 'redacted_thinking'; data: string };

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string) => void;
	onThinkingBlock?: (block: CompletedThinkingBlock) => void;
	onToolCall: (toolCall: AnthropicToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: AnthropicUsage) => void;
}

// ---- Model definitions ----

export type PricingCurrency = 'USD' | 'CNY';

export type PriceCategory = 'low' | 'medium' | 'high' | 'very_high';

export interface ModelPricing {
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
}

export interface ModelPricingSchedule {
	offPeak: ModelPricing;
	peak: ModelPricing;
}

export interface ThinkingCapability {
	supportedEfforts: readonly ReasoningEffort[];
	defaultEffort: ReasoningEffort;
	canDisable: boolean;
	adaptiveThinking?: boolean;
}

export interface ModelDefinition {
	id: string;
	name: string;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean | number;
		imageInput: boolean;
		nativeImageInput?: boolean;
		thinking: ThinkingCapability | false;
	};
	requiresThinkingParam: boolean;
	pricing?: Readonly<Record<PricingCurrency, ModelPricingSchedule>>;
	priceCategory?: PriceCategory;
}
