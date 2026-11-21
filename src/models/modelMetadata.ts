import type { ModelProtocol } from '../../contracts/v1.js';
import type { ModelMetadataView } from '../../contracts/models.js';
import { resolveVisionSupport, resolveThinkingCapability, resolveModelContextWindow, resolveModelMaxOutputTokens } from '../agent/modelCatalog.js';
import { parseAdvancedOptions } from './advancedOptions.js';

export function modelMetadata(protocol: ModelProtocol, baseUrl: string, modelId: string, parameters: Record<string, unknown>): ModelMetadataView {
    const advanced = parseAdvancedOptions(parameters.advanced);
    const automatic = resolveThinkingCapability(protocol,baseUrl,modelId);
    const resolved = resolveThinkingCapability(protocol,baseUrl,modelId,advanced);
    return {
        smartConfig: advanced?.smartConfig !== false,
        source: advanced && (advanced.smartConfig === false || advanced.image !== undefined || advanced.thinkingLevels !== undefined || advanced.thinkingParameterMap) ? 'manual' : automatic.vendorSource === 'vendor-docs' ? 'vendor-docs' : automatic.verified ? 'catalog' : 'unverified',
        image: resolveVisionSupport(protocol,baseUrl,modelId,advanced),
        thinkingLevels: resolved.thinkingLevels,
        thinkingParameterMap: advanced?.thinkingParameterMap ?? null,
        defaults: { image: resolveVisionSupport(protocol,baseUrl,modelId), thinkingLevels: automatic.thinkingLevels, contextWindow: resolveModelContextWindow(baseUrl,modelId) ?? null, maxOutputTokens: resolveModelMaxOutputTokens(baseUrl,modelId) ?? 4096 },
    };
}
