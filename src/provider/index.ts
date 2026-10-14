import vscode from 'vscode';
import { AuthManager } from '../auth';
import {
	getAllModels,
	getBaseUrl,
	getSkillIndexSettings,
	getStabilizeToolListEnabled,
} from '../config';
import { VENDOR_ID } from '../consts';
import { isOfficialAnthropicBaseUrl, normalizeBaseUrl } from '../endpoint';
import { t } from '../i18n';
import { logger } from '../logger';
import { addCacheBreakpoints } from './cache-breakpoints';
import { createCacheDiagnosticsRecorder, dumpProviderInput } from './debug';
import { isExtensionHostShutdownCancellation } from './deactivate';
import { toChatInfo } from './models';
import { BalanceCurrencyResolver } from './pricing/currency';
import { PricingRefreshScheduler } from './pricing/schedule';
import { prepareChatRequest } from './request';
import { classifyProviderRequest } from './routing';
import { resolveConversationSegment } from './segment';
import { processSkillIndex } from './skills';
import { streamChatCompletion } from './stream';
import { estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';
import { createVisionService } from './vision';

/**
 * Anthropic Chat Provider — implements vscode.LanguageModelChatProvider so
 * Anthropic Claude models (Sonnet 5, Opus 5, Fable 5.1, Claude 3.7 Sonnet) appear directly in Copilot Chat model picker.
 */
export class AnthropicChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly globalStorageUri: vscode.Uri;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private isActive = true;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	private readonly cacheDiagnostics = createCacheDiagnosticsRecorder();

	private readonly vision: ReturnType<typeof createVisionService>;
	private readonly balanceCurrencyResolver: BalanceCurrencyResolver;
	private readonly pricingRefreshScheduler: PricingRefreshScheduler;

	private charsPerToken = 4.0;

	constructor(context: vscode.ExtensionContext) {
		this.authManager = new AuthManager(context);
		this.globalStorageUri = context.globalStorageUri;
		this.vision = createVisionService(context);
		this.balanceCurrencyResolver = new BalanceCurrencyResolver(context, this.authManager, () =>
			this.onDidChangeLanguageModelChatInformationEmitter.fire(),
		);
		this.pricingRefreshScheduler = new PricingRefreshScheduler(() =>
			this.onDidChangeLanguageModelChatInformationEmitter.fire(),
		);

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			this.pricingRefreshScheduler,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration('anthropic-copilot.apiKey') ||
					e.affectsConfiguration('anthropic-copilot.baseUrl') ||
					e.affectsConfiguration('anthropic-copilot.modelIdOverrides') ||
					e.affectsConfiguration('anthropic-copilot.customModels')
				) {
					this.invalidateCurrencyAndRefreshModels();
				}
			}),
			context.secrets.onDidChange((e) => {
				if (e.key === 'anthropic-copilot.apiKey') {
					this.invalidateCurrencyAndRefreshModels();
				}
			}),
		);
	}

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.invalidateCurrencyAndRefreshModels();
		}
	}

	async clearApiKey(): Promise<void> {
		await this.authManager.deleteApiKey();
		this.invalidateCurrencyAndRefreshModels();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	private refreshDebounceTimer: NodeJS.Timeout | undefined;

	refreshModelPicker(): void {
		if (this.refreshDebounceTimer) {
			clearTimeout(this.refreshDebounceTimer);
		}
		this.refreshDebounceTimer = setTimeout(() => {
			this.refreshDebounceTimer = undefined;
			this.onDidChangeLanguageModelChatInformationEmitter.fire();
		}, 300);
	}

	private invalidateCurrencyAndRefreshModels(): void {
		void this.balanceCurrencyResolver
			.invalidate()
			.catch((error) => logger.warn('Failed to invalidate balance currency', error))
			.finally(() => this.refreshModelPicker());
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.refreshModelPicker();

		try {
			await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
		} catch (error) {
			if (isExtensionHostShutdownCancellation(error)) {
				logger.debug(
					'Anthropic model refresh canceled during deactivate (extension host shutting down)',
				);
				return;
			}
			logger.warn('Failed to refresh Anthropic models during deactivate', error);
		}
	}

	async setVisionModel(): Promise<void> {
		await this.vision.openConfiguration();
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}

		const hasKey = await this.authManager.hasApiKey();
		const pricingCurrency = this.balanceCurrencyResolver.getDisplayCurrency();
		const showPricingNotice = isOfficialAnthropicBaseUrl(normalizeBaseUrl(getBaseUrl()));
		const now = new Date();
		if (hasKey) {
			this.balanceCurrencyResolver.refreshInBackground();
		}

		const seenIds = new Set<string>();
		const result: vscode.LanguageModelChatInformation[] = [];
		for (const model of getAllModels()) {
			if (seenIds.has(model.id)) {
				continue;
			}
			seenIds.add(model.id);
			result.push(toChatInfo(model, hasKey, pricingCurrency, now, showPricingNotice));
		}
		return result;
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const segment = resolveConversationSegment(messages);
		const requestKind = classifyProviderRequest({
			messages,
			tools: options.tools,
		});

		// Agregar cache breakpoints a los mensajes antes de procesarlos
		const messagesWithCache = addCacheBreakpoints(messages);

		dumpProviderInput({
			globalStorageUri: this.globalStorageUri,
			segment,
			modelInfo,
			messages: messagesWithCache,
			requestOptions: options,
			requestKind,
		});

		const toolFlow = processToolFlow({
			stabilizeToolList: getStabilizeToolListEnabled(),
			messages: messagesWithCache,
			tools: options.tools,
			progress,
			requestKind,
		});
		if (toolFlow.preflightHandled) {
			return;
		}

		const skillIndex = processSkillIndex({
			messages: toolFlow.messages,
			rawMessages: messagesWithCache,
			requestKind,
			settings: getSkillIndexSettings(),
		});

		const prepared = await prepareChatRequest({
			authManager: this.authManager,
			globalStorageUri: this.globalStorageUri,
			modelInfo,
			segment,
			messages: skillIndex.messages,
			options,
			token,
			cacheDiagnostics: this.cacheDiagnostics,
			getVisionDescriber: () => this.vision.get(),
			skillIndexStats: skillIndex.stats,
		});

		return streamChatCompletion({
			prepared,
			progress,
			token,
			initialResponseNotice: joinInitialResponseNotices(
				toolFlow.initialResponseNotice,
				skillIndex.initialResponseNotice,
				prepared.initialResponseNotice,
			),
			getCharsPerToken: () => this.charsPerToken,
			setCharsPerToken: (charsPerToken) => {
				this.charsPerToken = charsPerToken;
			},
		});
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text, this.charsPerToken);
	}
}

function joinInitialResponseNotices(...notices: (string | undefined)[]): string | undefined {
	const joined = notices.filter((notice) => notice && notice.trim().length > 0).join('\n');
	return joined || undefined;
}
