import type { ModelDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'anthropic-copilot';

/**
 * vscode.lm vendor id this extension registers under.
 *
 * Must stay distinct from the literal `'anthropic'`, which GitHub Copilot Chat's own
 * built-in Anthropic BYOK provider registers for itself (near-unconditionally, for any
 * individual Copilot subscriber). Two extensions cannot hold the same vendor id in
 * VS Code's runtime `_providers` registry — whichever calls
 * `registerLanguageModelChatProvider` second throws synchronously, which previously
 * aborted this extension's activation depending on race timing. Must match
 * `contributes.languageModelChatProviders[0].vendor` in package.json.
 */
export const VENDOR_ID = CONFIG_SECTION;

export const EXTERNAL_URLS = {
	anthropic: {
		apiKeys: 'https://console.anthropic.com/settings/keys',
		usage: 'https://console.anthropic.com/settings/usage',
		status: 'https://status.anthropic.com',
	},
} as const;

/** URI path handled by this extension to reveal the output log. */
export const SHOW_LOGS_URI_PATH = '/showLogs';

/** URI path handled by this extension to open API key configuration. */
export const CONFIGURE_API_KEY_URI_PATH = '/setApiKey';

/** URI path handled by this extension to open vision model configuration. */
export const SET_VISION_MODEL_URI_PATH = '/setVisionModel';

// VS Code's internal LanguageModelChatMessageRole.System is not exposed in @types/vscode.
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Skills index trimming (see docs/superpowers/specs/2026-09-14-skill-index-trimming-design.md) ----

/** Trim only when Copilot's `<skills>` block has more entries than this. 0 means always. */
export const DEFAULT_SKILL_INDEX_THRESHOLD = 128;
/** Entries appended to each user request after trimming. */
export const DEFAULT_SKILL_INDEX_MAX_RELEVANT = 12;
export const MAX_SKILL_INDEX_MAX_RELEVANT = 64;

// ---- Secret keys ----

/** SecretStorage key for the Anthropic API key. */
export const API_KEY_SECRET = 'anthropic-copilot.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'anthropic-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'Luorj.anthropic-for-copilot#anthropicGettingStarted';

// ---- Model registry ----

/**
 * Built-in default preset models.
 * Note: Models are NOT locked to this array. Dynamic model discovery via `getAllModels()`
 * and `getModelDefinition()` allows adding new custom models in settings or auto-handling
 * any future Anthropic model without releasing a new extension version.
 */
export const MODELS: ModelDefinition[] = [
	{
		id: 'claude-fable-5-1',
		name: 'Fable 5.1',
		family: 'claude',
		version: 'v5.1',
		detail: 'Anthropic 5.1 Fable reasoning & creative model with 1M context',
		maxInputTokens: 1000000,
		maxOutputTokens: 64000,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			nativeImageInput: true,
			thinking: {
				supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
				defaultEffort: 'high',
				canDisable: true,
				adaptiveThinking: true,
			},
		},
		requiresThinkingParam: false,
		pricing: {
			USD: {
				offPeak: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 },
				peak: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 },
			},
			CNY: {
				offPeak: { cacheHitInput: 2.1, cacheMissInput: 21.0, output: 105.0 },
				peak: { cacheHitInput: 2.1, cacheMissInput: 21.0, output: 105.0 },
			},
		},
		priceCategory: 'high',
	},
	{
		id: 'claude-opus-5-5',
		name: 'Opus 5.5',
		family: 'claude',
		version: 'v5.5',
		detail: 'Anthropic 5.5 Opus flagship reasoning model with 1M context',
		maxInputTokens: 1000000,
		maxOutputTokens: 64000,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			nativeImageInput: true,
			thinking: {
				supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
				defaultEffort: 'high',
				canDisable: true,
				adaptiveThinking: true,
			},
		},
		requiresThinkingParam: false,
		pricing: {
			USD: {
				offPeak: { cacheHitInput: 1.5, cacheMissInput: 15.0, output: 75.0 },
				peak: { cacheHitInput: 1.5, cacheMissInput: 15.0, output: 75.0 },
			},
			CNY: {
				offPeak: { cacheHitInput: 10.5, cacheMissInput: 105.0, output: 525.0 },
				peak: { cacheHitInput: 10.5, cacheMissInput: 105.0, output: 525.0 },
			},
		},
		priceCategory: 'very_high',
	},
	{
		id: 'claude-sonnet-5-5',
		name: 'Sonnet 5.5',
		family: 'claude',
		version: 'v5.5',
		detail: 'Anthropic 5.5 Sonnet high-performance model with 1M context',
		maxInputTokens: 1000000,
		maxOutputTokens: 64000,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			nativeImageInput: true,
			thinking: {
				supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
				defaultEffort: 'high',
				canDisable: true,
				adaptiveThinking: true,
			},
		},
		requiresThinkingParam: false,
		pricing: {
			USD: {
				offPeak: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 },
				peak: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 },
			},
			CNY: {
				offPeak: { cacheHitInput: 2.1, cacheMissInput: 21.0, output: 105.0 },
				peak: { cacheHitInput: 2.1, cacheMissInput: 21.0, output: 105.0 },
			},
		},
		priceCategory: 'medium',
	},
	{
		id: 'claude-haiku-4-5',
		name: 'Haiku 4.5',
		family: 'claude',
		version: 'v4.5',
		detail: 'Anthropic 4.5 Haiku lightweight high-speed model',
		maxInputTokens: 200000,
		maxOutputTokens: 8192,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			nativeImageInput: true,
			thinking: false,
		},
		requiresThinkingParam: false,
		pricing: {
			USD: {
				offPeak: { cacheHitInput: 0.08, cacheMissInput: 0.8, output: 4.0 },
				peak: { cacheHitInput: 0.08, cacheMissInput: 0.8, output: 4.0 },
			},
			CNY: {
				offPeak: { cacheHitInput: 0.56, cacheMissInput: 5.6, output: 28.0 },
				peak: { cacheHitInput: 0.56, cacheMissInput: 5.6, output: 28.0 },
			},
		},
		priceCategory: 'low',
	},
];
