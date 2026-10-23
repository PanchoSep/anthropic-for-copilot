// Mock vscode module for standalone unit testing outside VS Code runtime.
// Tests drive configuration through globalThis.__vscodeMock.config, keyed by
// the full setting id (e.g. 'anthropic-copilot.baseUrl').
const Module = require('node:module');
const originalRequire = Module.prototype.require;

const mock = {
	config: {},
	language: 'en',
	reset() {
		mock.config = {};
		mock.language = 'en';
	},
};
globalThis.__vscodeMock = mock;

const noopChannel = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	appendLine: () => {},
	show: () => {},
	dispose: () => {},
};

// Minimal Language Model API surface. Source modules and tests both receive
// these same classes through the patched require, so `instanceof` checks in
// src/ work against parts constructed in tests.
class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelThinkingPart {
	constructor(value, id, metadata) {
		this.value = value;
		this.id = id;
		this.metadata = metadata;
	}
}
class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}

const vscodeStub = {
	workspace: {
		getConfiguration: (section) => ({
			get: (key, defaultValue) => {
				const value = mock.config[section ? `${section}.${key}` : key];
				return value === undefined ? defaultValue : value;
			},
			inspect: (key) => ({
				globalValue: mock.config[section ? `${section}.${key}` : key],
				workspaceValue: undefined,
				workspaceFolderValue: undefined,
			}),
			update: async () => {},
		}),
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
		workspaceFolders: undefined,
		workspaceFile: undefined,
	},
	window: {
		createOutputChannel: () => noopChannel,
		showInformationMessage: () => {},
		showErrorMessage: () => {},
	},
	env: {
		get language() {
			return mock.language;
		},
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelThinkingPart,
	LanguageModelToolResultPart,
	LanguageModelDataPart,
};

Module.prototype.require = function (id) {
	if (id === 'vscode') {
		return vscodeStub;
	}
	return originalRequire.apply(this, arguments);
};
