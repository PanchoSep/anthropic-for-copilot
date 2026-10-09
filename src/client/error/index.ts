import { isOfficialAnthropicBaseUrl } from '../../endpoint';
import { t } from '../../i18n';
import { safeStringify } from '../../json';
import type { AnthropicMessage } from '../../types';
import { API_PROVIDER_HTTP_ERROR_LINKS, MAX_DIAGNOSTIC_FIELD_LENGTH } from '../consts';
import type {
    AnthropicRequestErrorKind,
    ApiProviderId,
    ErrorActionLink,
    ErrorActionUrls,
    HttpErrorLinkDefinition,
    HttpErrorLinkStatusKey,
    RequestErrorContext,
} from '../types';
import { getNetworkErrorCauseInfo, getNetworkErrorCode, getNetworkErrorMessage } from './network';
export type { AnthropicRequestErrorKind, ErrorActionUrls } from '../types';

const errorActionUrlStore = (() => {
	let current: ErrorActionUrls = {};

	return {
		get: () => current,
		set: (key: keyof ErrorActionUrls, url: string) => {
			current = { ...current, [key]: url };
		},
	};
})();

export function setErrorActionUrl(key: keyof ErrorActionUrls, url: string): void {
	errorActionUrlStore.set(key, url);
}

export class AnthropicRequestError extends Error {
	readonly kind: AnthropicRequestErrorKind;
	readonly userSummary: string;
	readonly diagnosticMessage: string;
	readonly baseUrl?: string;
	readonly status?: number;
	readonly code?: string;

	constructor(options: {
		message: string;
		userSummary?: string;
		kind: AnthropicRequestErrorKind;
		diagnosticMessage?: string;
		baseUrl?: string;
		status?: number;
		code?: string;
		cause?: unknown;
	}) {
		super(options.message, { cause: options.cause });
		this.name = 'AnthropicRequestError';
		this.kind = options.kind;
		this.userSummary = options.userSummary ?? options.message;
		this.diagnosticMessage = options.diagnosticMessage ?? options.message;
		this.baseUrl = options.baseUrl;
		this.status = options.status;
		this.code = options.code;
	}
}

export function createHttpErrorFromStatus(
	status: number,
	statusText: string,
	responseText: string,
	context: RequestErrorContext,
): AnthropicRequestError {
	const { baseUrl } = context;
	const serverMessage = extractServerMessage(responseText);
	const baseSummary = getHttpErrorMessage(status, getCreateApiKeyUrl(status, baseUrl));
	const userSummary = serverMessage ? `${baseSummary} (${serverMessage})` : baseSummary;

	return new AnthropicRequestError({
		message: `Anthropic API request failed with HTTP ${status}`,
		userSummary,
		kind: 'http',
		baseUrl,
		status,
		code: `HTTP_${status}`,
		diagnosticMessage: joinDiagnosticParts(
			`kind=http`,
			`status=${status}`,
			getRequestDiagnosticMessage(context),
			`statusText=${safeStringify(statusText || 'unknown')}`,
			serverMessage ? `serverMessage=${safeStringify(serverMessage)}` : undefined,
			responseText && responseText !== serverMessage
				? `body=${safeStringify(truncateSingleLine(responseText))}`
				: undefined,
		),
	});
}

export async function createHttpError(
	response: Response,
	context: RequestErrorContext,
): Promise<AnthropicRequestError> {
	const responseText = await response.text();
	return createHttpErrorFromStatus(response.status, response.statusText, responseText, context);
}

export function normalizeRequestError(error: unknown, context: RequestErrorContext): Error {
	if (error instanceof AnthropicRequestError) {
		return error;
	}

	if (
		error &&
		typeof error === 'object' &&
		'status' in error &&
		typeof (error as { status: unknown }).status === 'number'
	) {
		const errObj = error as Record<string, unknown>;
		const status = errObj.status as number;
		const responseText = safeStringify(errObj.error || errObj.message || error);
		return createHttpErrorFromStatus(
			status,
			typeof errObj.name === 'string' ? errObj.name : 'APIError',
			responseText,
			context,
		);
	}

	if (!(error instanceof Error)) {
		const value = truncateSingleLine(String(error));
		return new AnthropicRequestError({
			message: `Anthropic request failed with a non-Error value: ${value}`,
			userSummary: t('error.unknown', value),
			kind: 'unknown',
			baseUrl: context.baseUrl,
			diagnosticMessage: joinDiagnosticParts(
				`kind=unknown`,
				getRequestDiagnosticMessage(context),
				`error=${safeStringify(value)}`,
			),
		});
	}

	const causeInfo = getNetworkErrorCauseInfo(error);
	if (!causeInfo) {
		return error;
	}

	const code = getNetworkErrorCode(causeInfo);
	const userSummary = getNetworkErrorMessage(code);
	const enhanced = new AnthropicRequestError({
		message: code
			? `Anthropic request failed due to network error ${code}`
			: 'Anthropic request failed due to a network error',
		userSummary,
		kind: 'network',
		baseUrl: context.baseUrl,
		code,
		cause: error,
		diagnosticMessage: joinDiagnosticParts(
			`kind=network`,
			code ? `code=${code}` : undefined,
			getRequestDiagnosticMessage(context),
			`message=${safeStringify(truncateSingleLine(error.message))}`,
			`cause=${causeInfo.value}`,
		),
	});
	enhanced.stack = error.stack;
	return enhanced;
}

export function formatRequestError(error: Error): string {
	const diagnosticMessage = joinDiagnosticParts(
		error instanceof AnthropicRequestError
			? error.diagnosticMessage
			: `message=${safeStringify(error.message)}`,
	);
	return error.stack ? `${diagnosticMessage}\n${error.stack}` : diagnosticMessage;
}

export function createUserFacingError(error: Error): Error {
	const message =
		error instanceof AnthropicRequestError
			? formatMarkdownMessage(error.userSummary, getErrorActions(error, errorActionUrlStore.get()))
			: error.message;
	const displayError = new Error(message);
	displayError.stack = undefined;
	return displayError;
}

function getHttpErrorMessage(status: number, createApiKeyUrl?: string): string {
	switch (status) {
		case 400:
			return t('error.http.400', status);
		case 401:
			return createApiKeyUrl
				? t('error.http.401.withCreateApiKeyLink', status, createApiKeyUrl)
				: t('error.http.401', status);
		case 402:
			return t('error.http.402', status);
		case 422:
			return t('error.http.422', status);
		case 429:
			return t('error.http.429', status);
		case 500:
			return t('error.http.500', status);
		case 503:
			return t('error.http.503', status);
		default:
			return t('error.http.generic', status);
	}
}

function extractServerMessage(responseText: string): string | undefined {
	const trimmed = responseText.trim();
	if (!trimmed) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(trimmed);
		const error = getObjectProperty(parsed, 'error');
		const message =
			getStringProperty(error, 'message') ??
			getStringProperty(parsed, 'message') ??
			getStringProperty(parsed, 'detail') ??
			(typeof error === 'string' ? error : undefined);
		return message ? truncateSingleLine(message) : undefined;
	} catch {
		return truncateSingleLine(trimmed);
	}
}

function getObjectProperty(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	const property = getObjectProperty(value, key);
	return typeof property === 'string' && property.length > 0 ? property : undefined;
}

function formatMarkdownMessage(
	summary: string,
	actions: readonly ErrorActionLink[] | undefined = undefined,
): string {
	const formattedSummary = `**${escapeBoldText(summary)}**`;
	const actionLinks = actions?.map(formatActionLink).join(' · ');
	return actionLinks
		? [formattedSummary + '\\', '\\', `**${actionLinks}**`].join('\n')
		: formattedSummary;
}

function formatActionLink(action: ErrorActionLink): string {
	return `[${t(action.labelKey)}](${action.url})`;
}

function getErrorActions(
	error: AnthropicRequestError,
	actionUrls: ErrorActionUrls,
): readonly ErrorActionLink[] {
	if (error.kind === 'http' && error.status !== undefined && error.baseUrl) {
		return getHttpErrorActions(error.status, error.baseUrl, actionUrls);
	}

	return getDiagnosticErrorActions(actionUrls);
}

function getHttpErrorActions(
	status: number,
	baseUrl: string,
	actionUrls: ErrorActionUrls,
): readonly ErrorActionLink[] {
	return [
		...getUniversalHttpErrorActions(status, actionUrls),
		...getProviderHttpErrorActions(status, baseUrl),
		...getDiagnosticErrorActions(actionUrls),
	];
}

function getUniversalHttpErrorActions(
	status: number,
	actionUrls: ErrorActionUrls,
): readonly ErrorActionLink[] {
	const url = actionUrls.configureApiKey;
	return status === 401 && url ? [{ labelKey: 'error.action.setApiKey', url }] : [];
}

function getProviderHttpErrorActions(status: number, baseUrl: string): readonly ErrorActionLink[] {
	if (status === 401) {
		return [];
	}

	const link = getProviderHttpErrorLink(status, baseUrl);
	return link ? [{ labelKey: link.labelKey, url: link.url }] : [];
}

function getProviderHttpErrorLink(
	status: number,
	baseUrl: string,
): HttpErrorLinkDefinition | undefined {
	const providerId = identifyApiProvider(baseUrl);
	const statusKey = getHttpErrorLinkStatusKey(status);
	return providerId && statusKey ? API_PROVIDER_HTTP_ERROR_LINKS[statusKey][providerId] : undefined;
}

function getCreateApiKeyUrl(status: number, baseUrl: string): string | undefined {
	return status === 401 ? getProviderHttpErrorLink(status, baseUrl)?.url : undefined;
}

function getDiagnosticErrorActions(actionUrls: ErrorActionUrls): readonly ErrorActionLink[] {
	const url = actionUrls.showLogs;
	return url ? [{ labelKey: 'error.action.viewDetails', url }] : [];
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const lowerKey = key.toLowerCase();
		if (lowerKey === 'x-api-key' || lowerKey === 'authorization') {
			sanitized[key] = value ? (value.length > 8 ? `${value.slice(0, 6)}***` : '***') : '';
		} else if (
			lowerKey.includes('key') ||
			lowerKey.includes('secret') ||
			lowerKey.includes('password') ||
			lowerKey.includes('token')
		) {
			sanitized[key] = value ? (value.length > 6 ? `${value.slice(0, 3)}***` : '***') : '***';
		} else {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function getRequestDiagnosticMessage(context: RequestErrorContext): string {
	const { request, headers, customHeaders } = context;
	const sanitizedHeaders = headers ? sanitizeHeaders(headers) : undefined;
	const sanitizedCustomHeaders = customHeaders ? sanitizeHeaders(customHeaders) : undefined;

	return joinDiagnosticParts(
		`baseUrl=${safeStringify(context.baseUrl)}`,
		`model=${safeStringify(request.model)}`,
		`stream=${request.stream}`,
		request.temperature !== undefined ? `temperature=${request.temperature}` : undefined,
		request.top_p !== undefined ? `topP=${request.top_p}` : undefined,
		request.max_tokens !== undefined ? `maxTokens=${request.max_tokens}` : undefined,
		request.thinking?.type ? `thinking=${safeStringify(request.thinking.type)}` : undefined,
		request.output_config?.effort
			? `effort=${safeStringify(request.output_config.effort)}`
			: undefined,
		request.tool_choice ? `toolChoice=${safeStringify(request.tool_choice)}` : undefined,
		`toolCount=${request.tools?.length ?? 0}`,
		`messageCount=${request.messages.length}`,
		`messageChars=${request.messages.reduce((total, message) => total + getContentChars(message.content), 0)}`,
		`imageParts=${request.messages.reduce((total, message) => total + countImageParts(message.content), 0)}`,
		sanitizedCustomHeaders && Object.keys(sanitizedCustomHeaders).length > 0
			? `customHeaders=${safeStringify(sanitizedCustomHeaders)}`
			: `customHeaders={none}`,
		sanitizedHeaders ? `requestHeaders=${safeStringify(sanitizedHeaders)}` : undefined,
	);
}

/**
 * Measure only the content values sent to the API. Serializing a multimodal
 * content array would also count JSON keys and punctuation, making this
 * diagnostic depend on the object representation rather than payload content.
 * Image URL characters are included because data URLs can dominate request size.
 */
function getContentChars(content: AnthropicMessage['content']): number {
	if (typeof content === 'string') {
		return content.length;
	}
	return content.reduce(
		(total, part) =>
			total +
			(part.type === 'text'
				? part.text.length
				: part.type === 'thinking'
					? part.thinking.length
					: 0),
		0,
	);
}

function countImageParts(content: AnthropicMessage['content']): number {
	if (typeof content === 'string') {
		return 0;
	}
	return content.filter((part) => part.type === 'image' || part.type === ('image_url' as string))
		.length;
}

function joinDiagnosticParts(...parts: (string | undefined)[]): string {
	return parts.filter(Boolean).join(' ');
}

function truncateSingleLine(value: string): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > MAX_DIAGNOSTIC_FIELD_LENGTH
		? `${singleLine.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH)}...`
		: singleLine;
}

function escapeBoldText(value: string): string {
	return value.replace(/\*/g, '\\*');
}

function identifyApiProvider(baseUrl: string): ApiProviderId | undefined {
	return isOfficialAnthropicBaseUrl(baseUrl) ? 'anthropic' : undefined;
}

function getHttpErrorLinkStatusKey(status: number): HttpErrorLinkStatusKey | undefined {
	if (status === 401 || status === 402) {
		return status;
	}

	return status >= 500 && status <= 599 ? '5xx' : undefined;
}
