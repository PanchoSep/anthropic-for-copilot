import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

describe('Adaptive Thinking', () => {
	describe('ThinkingCapability.adaptiveThinking', () => {
		it('should be a boolean property indicating adaptive thinking support', () => {
			const { MODELS } = require('../../src/consts');
			const fable = MODELS.find((m: any) => m.id === 'claude-fable-5-1');
			assert.ok(fable, 'Fable 5.1 model should exist');
			assert.ok(fable.capabilities.thinking, 'Fable should have thinking capability');
			assert.strictEqual(
				fable.capabilities.thinking.adaptiveThinking,
				true,
				'Fable should support adaptive thinking',
			);
		});

		it('should be true for Opus 5', () => {
			const { MODELS } = require('../../src/consts');
			const opus = MODELS.find((m: any) => m.id === 'claude-opus-5-5');
			assert.ok(opus, 'Opus 5 model should exist');
			assert.ok(opus.capabilities.thinking, 'Opus should have thinking capability');
			assert.strictEqual(
				opus.capabilities.thinking.adaptiveThinking,
				true,
				'Opus should support adaptive thinking',
			);
		});

		it('should be true for Sonnet 5', () => {
			const { MODELS } = require('../../src/consts');
			const sonnet = MODELS.find((m: any) => m.id === 'claude-sonnet-5-5');
			assert.ok(sonnet, 'Sonnet 5 model should exist');
			assert.ok(sonnet.capabilities.thinking, 'Sonnet should have thinking capability');
			assert.strictEqual(
				sonnet.capabilities.thinking.adaptiveThinking,
				true,
				'Sonnet should support adaptive thinking',
			);
		});

		it('should be undefined/false for Haiku (does not support adaptive thinking)', () => {
			const { MODELS } = require('../../src/consts');
			const haiku = MODELS.find((m: any) => m.id === 'claude-haiku-4-5');
			assert.ok(haiku, 'Haiku 4.5 model should exist');
			// Haiku may not have thinking capability at all, or if it does, adaptiveThinking should be false/undefined
			if (haiku.capabilities.thinking) {
				assert.notStrictEqual(
					haiku.capabilities.thinking.adaptiveThinking,
					true,
					'Haiku should NOT support adaptive thinking',
				);
			}
		});
	});

	describe('AnthropicThinkingConfig type', () => {
		it('should support type: "adaptive"', () => {
			const config: { type: 'enabled' | 'adaptive'; budget_tokens?: number; display?: 'summarized' } = {
				type: 'adaptive',
				display: 'summarized',
			};
			assert.equal(config.type, 'adaptive');
			assert.equal(config.display, 'summarized');
		});

		it('should support type: "enabled" with budget_tokens', () => {
			const config: { type: 'enabled' | 'adaptive'; budget_tokens?: number } = {
				type: 'enabled',
				budget_tokens: 1024,
			};
			assert.equal(config.type, 'enabled');
			assert.equal(config.budget_tokens, 1024);
		});

		it('should allow budget_tokens to be optional', () => {
			const config: { type: 'enabled' | 'adaptive'; budget_tokens?: number } = {
				type: 'enabled',
			};
			assert.equal(config.budget_tokens, undefined);
		});
	});

	describe('Request building with adaptive thinking', () => {
		it('should use type: "adaptive" when model supports adaptiveThinking', () => {
			const { MODELS } = require('../../src/consts');
			const fable = MODELS.find((m: any) => m.id === 'claude-fable-5-1');
			
			// When adaptiveThinking is true, the request should use type: 'adaptive'
			assert.strictEqual(fable.capabilities.thinking.adaptiveThinking, true);
			
			// This verifies the capability is properly configured
			// The actual request building is tested through integration
		});
	});
});

