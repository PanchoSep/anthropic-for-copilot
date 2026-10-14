import vscode from 'vscode';

const MAX_CACHE_BREAKPOINTS = 4;
const CACHE_CONTROL_MIME = 'cache_control';

/**
 * Agrega breakpoints de cache a los mensajes de forma estratégica.
 *
 * Estrategia (máximo 4 breakpoints):
 * 1. System prompt (si existe)
 * 2. Penúltimo mensaje del usuario (contexto de conversación)
 * 3. Mensajes del asistente sin tool calls (respuestas completas)
 * 4. Último tool result en cada round
 *
 * Los breakpoints se agregan como LanguageModelDataPart con mimeType='cache_control'
 * que luego son convertidos a { cache_control: { type: 'ephemeral' } } en formato Anthropic.
 */
export function addCacheBreakpoints(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): vscode.LanguageModelChatRequestMessage[] {
	// Si hay muy pocos mensajes, no vale la pena cachear
	if (messages.length < 2) {
		return [...messages];
	}

	let breakpointsAdded = 0;
	const result: vscode.LanguageModelChatRequestMessage[] = [];
	const cacheMarker = new vscode.LanguageModelDataPart(
		Buffer.from('ephemeral'),
		CACHE_CONTROL_MIME,
	);

	// Procesar system message primero si existe
	// System role es el valor 3 (no hay enum público para System en VS Code API)
	const firstMsg = messages[0];
	const isSystemRole = (firstMsg.role as number) === 3;

	if (isSystemRole && breakpointsAdded < MAX_CACHE_BREAKPOINTS) {
		// Agregar cache breakpoint al system message
		const newContent = [...firstMsg.content, cacheMarker] as vscode.LanguageModelInputPart[];
		result.push({
			role: 3 as any,
			content: newContent,
			name: firstMsg.name,
		} as vscode.LanguageModelChatRequestMessage);
		breakpointsAdded++;
	} else if (isSystemRole) {
		result.push(firstMsg);
	}

	// Procesar el resto de mensajes en reversa para agregar breakpoints estratégicamente
	const remainingMessages = isSystemRole ? messages.slice(1) : [...messages];

	const reversedIndices: number[] = [];
	for (
		let i = remainingMessages.length - 1;
		i >= 0 && breakpointsAdded < MAX_CACHE_BREAKPOINTS;
		i--
	) {
		const msg = remainingMessages[i];
		const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
		const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant;

		// Omitir el último mensaje del usuario (el actual - no queremos cachearlo aún)
		if (i === remainingMessages.length - 1 && isUser) {
			continue;
		}

		// Agregar breakpoint si es:
		// 1. Un mensaje del usuario (contexto de conversación previo)
		// 2. Un mensaje del asistente sin tool calls (respuesta completa)
		const hasToolCalls = msg.content.some((p) => p instanceof vscode.LanguageModelToolCallPart);
		const shouldAddBreakpoint = isUser || (isAssistant && !hasToolCalls);

		if (shouldAddBreakpoint) {
			reversedIndices.unshift(i);
			breakpointsAdded++;
		}
	}

	// Reconstruir el array con breakpoints en las posiciones correctas
	for (let i = 0; i < remainingMessages.length; i++) {
		const msg = remainingMessages[i];

		if (reversedIndices.includes(i)) {
			// Agregar breakpoint a este mensaje
			const newContent = [...msg.content, cacheMarker] as vscode.LanguageModelInputPart[];

			result.push({
				role: msg.role,
				content: newContent,
				name: msg.name,
			} as vscode.LanguageModelChatRequestMessage);
		} else {
			result.push(msg);
		}
	}

	return result;
}
