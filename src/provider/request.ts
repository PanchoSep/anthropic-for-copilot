import vscode from 'vscode';
import { AuthManager } from '../auth';
import { AnthropicClient } from '../client';
import { getApiModelId, getBaseUrl, getMaxTokens, getModelDefinition } from '../config';
import { buildSystemWithClaudeCodeIdentity, isOAuthAccessToken } from '../credentials';
import { t } from '../i18n';
import { logger } from '../logger';
import { parseModelId } from '../model-id';
import type { AnthropicRequest } from '../types';
import {
	canContinueToolLoopWithThinking,
	convertMessages,
	convertTools,
	countMessageChars,
} from './convert';
import {
	dumpAnthropicRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
} from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import type { ReplayMarkerMetadata } from './replay';
import { classifyAnthropicRequest, type RequestKind } from './routing';
import type { ConversationSegment } from './segment';
import type { SkillIndexStats } from './skills';
import { filterUnsupportedMcpTools } from './tools/mcp-filter';
import { prepareVisionMessages, type VisionDescriber } from './vision';

export interface PreparedChatRequest {
	client: AnthropicClient;
	request: AnthropicRequest;
	isThinkingModel: boolean;
	totalRequestChars: number;
	hasNativeImages: boolean;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	visionMarkerTextChars?: number;
	initialResponseNotice?: string;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
	getVisionDescriber: () => Promise<VisionDescriber | undefined>;
	skillIndexStats?: SkillIndexStats;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	token,
	cacheDiagnostics,
	getVisionDescriber,
	skillIndexStats,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const credential = await authManager.getCredential();
	if (!credential) {
		throw new Error(t('auth.notConfigured'));
	}

	const baseUrl = getBaseUrl();
	const client = new AnthropicClient(baseUrl, credential);
	const modelDef = getModelDefinition(modelInfo.id);
	const thinkingCapability = modelDef?.capabilities.thinking;
	const isThinkingModel = Boolean(thinkingCapability);
	const nativeImageInput = modelDef?.capabilities.nativeImageInput === true;
	const configuredMaxTokens = getMaxTokens();
	const maxTokens = configuredMaxTokens || modelDef?.maxOutputTokens || 8192;

	const visionResolution = await prepareVisionMessages({
		messages,
		nativeImageInput,
		token,
		getDescriber: getVisionDescriber,
	});

	const configuredThinkingEffort = thinkingCapability
		? getConfiguredThinkingEffort(options as ModelConfigurationOptions, thinkingCapability)
		: 'none';
	const thinkingRequested = isThinkingModel && configuredThinkingEffort !== 'none';

	const resolvedMessages = visionResolution.messages;
	const converted = convertMessages(resolvedMessages, thinkingRequested, nativeImageInput);
	const anthropicMessages = converted.messages;

	const isOAuthToken = isOAuthAccessToken(credential.value);

	// Anthropic rejects every request made with a Claude subscription OAuth
	// token with 429 rate_limit_error unless `system[0]` is *exactly* the
	// Claude Code identity line as its own block — concatenating it into one
	// string with the rest of the system prompt still 429s, only a separate
	// leading block satisfies the check.
	const system = isOAuthToken
		? buildSystemWithClaudeCodeIdentity(converted.system)
		: converted.system;

	const mcpFilter = filterUnsupportedMcpTools(options.tools, isOAuthToken);
	if (mcpFilter.removedNames.length > 0) {
		logger.warn(
			`Dropped ${mcpFilter.removedNames.length} MCP tool(s) the Claude subscription gateway ` +
				`rejects requests over: ${mcpFilter.removedNames.join(', ')}`,
		);
	}
	const tools = convertTools(mcpFilter.tools);
	const totalRequestChars = countMessageChars(anthropicMessages);
	const hasNativeImages =
		visionResolution.stats.imageHandlingMode === 'native' &&
		visionResolution.stats.input.forwardedImageParts +
			visionResolution.stats.tool.forwardedImageParts >
			0;

	const thinkingBudget = getThinkingBudgetTokens(configuredThinkingEffort, maxTokens);
	const useAdaptiveThinking =
		thinkingCapability !== false && thinkingCapability?.adaptiveThinking === true;

	const { model, betas } = parseModelId(getApiModelId(modelInfo.id));

	// `adaptive` lets the model skip thinking on a turn, so only `enabled` is bound
	// by the "tool loop must continue from a thinking block" rule.
	const thinkingBreaksToolLoop =
		thinkingRequested &&
		!useAdaptiveThinking &&
		!canContinueToolLoopWithThinking(anthropicMessages);
	if (thinkingBreaksToolLoop) {
		logger.warn(
			'Thinking disabled for this request: the in-flight tool loop has no signed thinking block to continue from.',
		);
	}
	const sendThinking = thinkingRequested && !thinkingBreaksToolLoop;

	const request: AnthropicRequest = {
		model,
		...(betas.length > 0 ? { betas } : {}),
		messages: anthropicMessages,
		system,
		stream: true,
		max_tokens: maxTokens,
		tools,
		tool_choice: tools && tools.length > 0 ? { type: 'auto' } : undefined,
		...(sendThinking
			? useAdaptiveThinking
				? {
						thinking: {
							type: 'adaptive',
							display: 'summarized',
						},
					}
				: {
						thinking: {
							type: 'enabled',
							...(thinkingBudget !== undefined ? { budget_tokens: thinkingBudget } : {}),
						},
					}
			: {}),
		...(sendThinking ? { output_config: { effort: configuredThinkingEffort } } : {}),
	};

	const requestKind = classifyAnthropicRequest({
		request,
		inputMessages: messages,
	});

	dumpAnthropicRequest(request, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort: configuredThinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		requestOptions: options,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
		skillIndexStats,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest({
		request,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort: configuredThinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	return {
		client,
		request,
		isThinkingModel,
		totalRequestChars,
		hasNativeImages,
		trailingToolResultIds: [],
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: visionResolution.replayMarkerMetadata,
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
		initialResponseNotice: visionResolution.initialResponseNotice,
	};
}

function getThinkingBudgetTokens(effort: string, maxTokens: number): number | undefined {
	if (effort === 'adaptive') {
		return undefined;
	}
	let ratio = 0.25;
	if (effort === 'low') {
		ratio = 0.15;
	} else if (effort === 'max') {
		ratio = 0.6;
	} else if (effort === 'high') {
		ratio = 0.35;
	}
	const computed = Math.floor(maxTokens * ratio);
	const minBudget = 1024;
	const maxBudget = Math.max(1024, maxTokens - 100);
	return Math.min(Math.max(computed, minBudget), maxBudget);
}
