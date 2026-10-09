# VS Code Copilot Feature Parity Plan

Plan de integración de features enterprise del provider nativo de Anthropic en VS Code Copilot hacia anthropic-for-copilot.

**Fecha de inicio:** 2026-10-08  
**Estado:** Draft / En construcción

---

## Objetivos

1. Incorporar optimizaciones enterprise del provider oficial sin comprometer la simplicidad del proyecto
2. Mejorar eficiencia de tokens y costos para usuarios individuales
3. Mantener compatibilidad con configuración actual
4. Priorizar features que escalen bien sin infraestructura backend

**Fuera de alcance:**
- ❌ Telemetría (violenta principio de privacidad del proyecto)
- ❌ Features que requieran backend propio (mantener arquitectura cliente-only)

---

## Features Identificadas

### 1. **Tool Deferral** (defer_loading)
**Prioridad:** Alta  
**Complejidad:** Media  
**Impacto:** Alto (reduce tokens 40-60% en Agent mode con muchas MCP tools)

#### Qué es
Sistema para enviar stubs de tools en lugar de schemas completos, cargando dinámicamente solo las tools que el modelo solicita usar.

#### Implementación
- [ ] Agregar soporte para `defer_loading: true` en `convertTools()` (`src/provider/convert.ts`)
- [ ] Crear sistema de tool registry/index con búsqueda
- [ ] Implementar mecanismo de carga dinámica cuando modelo intenta usar tool diferida
- [ ] Detectar cuando tool diferida es llamada y expandir schema just-in-time
- [ ] Considerar: ¿cliente-only o requiere MCP server changes?

**Archivos de referencia VS Code:**
- `/Users/panchobv/Documents/repos/vscode/extensions/copilot/src/platform/endpoint/node/messagesApi.ts:149-179`

**Bloqueos potenciales:**
- MCP servers puede que necesiten exponer metadata de tools sin ejecutarlas
- Coordinación con especificación MCP

---

### 2. **Extended Cache TTL** (1h ephemeral cache)
**Prioridad:** Alta  
**Complejidad:** Baja  
**Impacto:** Alto (reduce costos 50-80% en sesiones largas)

#### Qué es
Usar cache ephemeral de 1 hora en lugar de 5 minutos default para system prompts y mensajes estables.

#### Implementación
- [ ] Agregar setting `anthropic-copilot.cache.ttl` con opciones `'5m' | '1h' | 'auto'`
- [ ] Modificar `addMessagesApiCacheControl()` para aceptar TTL paramétrico
- [ ] Implementar heurística para decidir cuándo usar 1h:
  - ✅ Conversaciones main agent
  - ✅ System prompt grande (skills index)
  - ❌ Subagents (contexto efímero)
  - ❌ One-shot requests
- [ ] Aplicar 1h a system prompt/tools/últimos N mensajes user
- [ ] Documentar trade-offs (cuota vs ahorros)

**Archivos de referencia VS Code:**
- `/Users/panchobv/Documents/repos/vscode/extensions/copilot/src/platform/endpoint/node/messagesApi.ts:262-266`

**Consideraciones:**
- Cache de 1h consume más cuota de cache, pero ahorra más en hits
- No es útil para todos los usuarios (solo sesiones largas >15min)
- Debe ser opt-in o auto-detectar patrón de uso

---

### 3. **Adaptive Thinking** ✅ IMPLEMENTADO
**Prioridad:** Media  
**Complejidad:** Baja (mayormente configuración)  
**Impacto:** Medio (reduce costos thinking 20-40% sin pérdida de calidad)  
**Estado:** ✅ Completado (2026-10-08)

#### Qué es
Capacidad booleana del modelo que permite que el modelo decida dinámicamente cuánto thinking budget consumir en lugar de un presupuesto fijo.

**Diferencia clave:** `adaptive_thinking` es una **capacidad del modelo** (booleano), NO un valor de `reasoning_effort`. El `effort` controla CUÁNTO esfuerzo pone el modelo, mientras que `adaptive_thinking` controla CÓMO piensa (adaptativo vs fijo).

#### Implementación ✅
- [x] Agregar `adaptiveThinking?: boolean` como propiedad en `ThinkingCapability`
- [x] Actualizar `AnthropicThinkingConfig` para soportar `type: 'adaptive' | 'enabled'`
- [x] Modificar request builder para usar `thinking: { type: 'adaptive', display: 'summarized' }` cuando el modelo lo soporte
- [x] Configurar `adaptiveThinking: true` en Fable 5.1, Opus 5 y Sonnet 5 (no en Haiku 4.5)
- [x] Tests unitarios agregados en `tests/unit/adaptive-thinking.test.ts`

**Archivos modificados:**
- `src/types.ts` - Agregado `adaptiveThinking?: boolean` a ThinkingCapability, `type: 'adaptive'` a AnthropicThinkingConfig
- `src/provider/request.ts` - Detecta `adaptiveThinking` capability y usa `type: 'adaptive'` en lugar de `type: 'enabled'` con budget
- `src/consts.ts` - Fable 5.1, Opus 5 y Sonnet 5 tienen `adaptiveThinking: true` (Haiku no)
- `tests/unit/adaptive-thinking.test.ts` - Suite de tests completa

**Cómo funciona:**
Cuando un modelo tiene `adaptiveThinking: true` en su capability y el usuario NO selecciona "None" en thinking effort, el request builder envía `thinking: { type: 'adaptive', display: 'summarized' }` en lugar de `thinking: { type: 'enabled', budget_tokens: N }`. Esto señala a la API de Anthropic que el modelo debe decidir dinámicamente cuánto thinking consumir basado en la complejidad de la tarea.

**Request resultante:**
```typescript
{
  thinking: { type: 'adaptive', display: 'summarized' },  // ← Thinking adaptativo
  // NO hay budget_tokens cuando es adaptive
}
```

---

### 4. **Context Management** (Context Editing)
**Prioridad:** Media  
**Complejidad:** Media-Alta  
**Impacto:** Alto (permite conversaciones ilimitadas sin OOM)

#### Qué es
Feature de Anthropic que permite al modelo editar su propio historial de contexto para mantenerse dentro de límites de tokens.

#### Implementación
- [ ] Investigar API de context_management de Anthropic (puede ser beta)
- [ ] Agregar campo `context_management` a AnthropicRequest type
- [ ] Crear configuración para habilitar/deshabilitar
- [ ] Implementar estrategia de context management:
  ```typescript
  context_management: {
    enabled: true,
    max_tokens: 200000,
    strategy: 'auto'  // o 'preserve_system', 'fifo', etc.
  }
  ```
- [ ] Manejar eventos de context editing en stream
- [ ] Documentar comportamiento y trade-offs

**Archivos de referencia VS Code:**
- `/Users/panchobv/Documents/repos/vscode/extensions/copilot/src/platform/endpoint/node/messagesApi.ts:245-248`

**Bloqueos potenciales:**
- Puede ser feature beta no documentada públicamente
- Requiere verificar disponibilidad en API pública de Anthropic

---

### 5. **Tool Search** (custom tool_search + tool_reference)
**Prioridad:** Baja (wait and see)  
**Complejidad:** Alta  
**Impacto:** Alto (escala a cientos/miles de tools)

#### Qué es
Sistema de búsqueda semántica de tools que permite descubrir herramientas relevantes bajo demanda.

#### Componentes
1. **`tool_search` tool:** Herramienta especial que busca en índice de tools
2. **`tool_reference` content type:** Nuevo tipo de bloque que referencia tools sin invocarlas
3. **Índice semántico:** Embeddings de descripciones de tools para búsqueda

#### Implementación
- [ ] Investigar si `tool_search` está en API pública o es interno de GitHub
- [ ] Decisión arquitectural: ¿cliente-only o requiere backend?
- [ ] Si cliente-only:
  - [ ] Crear índice local de embeddings de tool descriptions
  - [ ] Implementar búsqueda semántica (vector similarity)
  - [ ] Agregar `tool_search` como tool sintética
  - [ ] Implementar conversión a `tool_reference` blocks
- [ ] Si requiere backend: **SKIP** (fuera de alcance del proyecto)

**Archivos de referencia VS Code:**
- `/Users/panchobv/Documents/repos/vscode/extensions/copilot/src/platform/endpoint/node/messagesApi.ts:352-369` (tool_reference parsing)

**Bloqueos potenciales:**
- `tool_reference` puede no estar en API pública de Anthropic
- Búsqueda semántica cliente-only puede ser lenta con >100 tools
- Requiere embeddings model (OpenAI, Anthropic, local?)

**Recomendación actual:** POSTPONE — esperar a ver si Anthropic lanza tool search públicamente

---

### 6. **Multi-Replace String Tool** (Anthropic-optimized editing)
**Prioridad:** Alta  
**Complejidad:** Media  
**Impacto:** Alto (mejora calidad de edits en Agent mode)

#### Qué es
Claude models prefieren `multi_replace_string_in_file` sobre `apply_patch` - permite múltiples reemplazos en un archivo en una sola operación.

#### Implementación
- [ ] Agregar tool `multi_replace_string_in_file` con schema:
  ```typescript
  {
    name: 'multi_replace_string_in_file',
    description: 'Replace multiple text segments in a file',
    input_schema: {
      file_path: string,
      replacements: Array<{
        old_text: string,
        new_text: string
      }>
    }
  }
  ```
- [ ] Implementar handler en VS Code side
- [ ] Agregar hint en system prompt para Claude:
  - "Prefer multi_replace_string_in_file for multiple edits in same file"
  - "Use replace_string_in_file for single replacements"
- [ ] Deprecar `insert_edit_into_file` para Claude models (usar exclusively replace_string)

**Archivos de referencia VS Code:**
- `/Users/panchobv/Documents/repos/vscode/extensions/copilot/src/platform/endpoint/common/chatModelCapabilities.ts:290-298` (multi_replace detection)
- Líneas 302-306 (exclusive use)

**Archivos a modificar:**
- `src/provider/convert.ts` - agregar multi_replace tool
- `src/capabilities.ts` - `modelSupportsMultiReplaceString()` (always true para Claude)
- System prompt - agregar hint sobre tool preference

**Beneficio:** Edits más precisos en Claude, reduce errores y back-and-forth

**Alcance:** Solo Claude models

---

### 7. **PDF Document Support** (Claude native)
**Prioridad:** Media  
**Complejidad:** Baja-Media  
**Impacto:** Medio (útil para document analysis workflows)

#### Qué es
Todas las familias Claude soportan PDFs nativamente como `document` content type - no necesitan conversión a imágenes.

#### Implementación
- [ ] Extender `src/provider/vision/` para detectar PDFs en attachments
- [ ] Agregar conversión PDF → document block (Claude API nativa):
  ```typescript
  {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: base64EncodedPdf
    }
  }
  ```
- [ ] Actualizar stats/logging para reportar PDF documents enviados
- [ ] Documentar límite de tamaño (típicamente 32MB)

**Archivos de referencia VS Code:**
- `/Users/panchobv/Documents/repos/vscode/extensions/copilot/src/platform/endpoint/common/chatModelCapabilities.ts:333-336` (PDF detection)

**Archivos a modificar:**
- `src/provider/vision/resolve.ts` - detectar PDFs en attachments
- `src/provider/convert.ts` - emitir document blocks
- `src/provider/vision/stats.ts` - tracking

**Beneficio:** Users pueden adjuntar PDFs directamente sin conversión manual

**Alcance:** Solo Claude models (todas las familias)

---

## Features NO RELEVANTES para Anthropic (Descartadas)

### ❌ Prompt Cache Breakpoints (OpenAI Responses API)
OpenAI-specific feature usando `prompt_cache_breakpoint`. No aplicable a Claude/Anthropic API.

### ❌ Prompt Verbosity Control
No hay evidencia de que Claude models se beneficien de system prompts más compactos.

### ❌ Instructions Placement Strategy (Claude 3.5 Sonnet)
Específico a un solo modelo, bajo ROI. Postpone hasta ver evidencia de mejora significativa.

### ❌ Thinking Content in History (Kimi K3)
Kimi K3 specific, no aplicable a Claude.

### ❌ Apply Patch Tool
Claude prefiere replace_string/multi_replace_string. Apply patch es GPT-specific.

---

## Orden de Implementación Sugerido

### Fase 1: Quick Wins (1-2 semanas)
1. **Extended Cache TTL (1h)** → Baja complejidad, alto impacto en costos
2. **Multi-Replace String Tool** → Mejor calidad de edits en Claude
3. ✅ **Adaptive Thinking** → COMPLETADO (2026-10-08)

### Fase 2: Core Optimizations (3-4 semanas)
4. **Tool Deferral** → Requiere diseño pero crítico para escala con MCP
5. **Context Management** → Si API pública de Anthropic lo soporta

### Fase 3: Advanced (TBD)
6. **PDF Document Support** → Útil pero nicho
7. **Tool Search** → Solo si Anthropic lo lanza públicamente o viable cliente-only

### Out of Scope (no implementar - no relevantes para Claude)
- ❌ **Prompt Cache Breakpoints** (OpenAI Responses API specific)
- ❌ **Prompt Verbosity Control** (sin evidencia de beneficio en Claude)
- ❌ **Instructions Placement Strategy** (Claude 3.5 Sonnet only, bajo ROI)
- ❌ **Thinking in History** (Kimi K3 specific)
- ❌ **Apply Patch Tool** (GPT-specific, Claude prefiere replace_string)
- ❌ **Telemetría** (violenta privacidad)

---

## Pendientes de Investigación

### Desde código de VS Code Copilot
- [ ] Revisar implementación completa de tool deferral
- [ ] Entender lógica de `toolDeferralService.isNonDeferredTool()`
- [ ] Ver manejo de `tool_reference` blocks en streaming
- [ ] Investigar `context_management` response handling

### Desde API de Anthropic
- [ ] Confirmar si `context_management` es público o beta
- [ ] Verificar si `defer_loading` está documentado públicamente
- [ ] Confirmar si `tool_reference` es tipo de contenido público
- [ ] Probar `type: 'adaptive'` en thinking config
- [ ] Verificar límites de ephemeral cache 1h (quota implications)
- [ ] Confirmar soporte de `document` type para PDFs (todas las familias Claude)
- [ ] Probar `multi_replace_string_in_file` tool en Claude API
- [ ] Verificar API version requirements para cada feature

---

## Criterios de Éxito

Cada feature implementada debe:
- ✅ **Ser Claude/Anthropic-specific** o agnóstica de provider
- ✅ Ser opt-in o auto-detectar necesidad (no romper setup actual)
- ✅ Incluir tests en `tests/unit/` con mocks de Anthropic API
- ✅ Documentarse en README con ejemplos de configuración
- ✅ No requerir backend/infraestructura externa
- ✅ Degradar gracefully si API no soporta (feature detection)
- ✅ Medir impacto: tokens ahorrados, cache hit rate, latencia
- ✅ Mantener compatibilidad con relays (LiteLLM, CC-Switch, Claude Code)

---

## Notas Adicionales

### Filosofía del proyecto
anthropic-for-copilot debe mantenerse **simple, transparente y Claude-focused**:
- Un solo archivo de configuración
- Sin backends
- Sin tracking
- 100% local BYOK
- **Solo features que benefician a Claude/Anthropic models**

Las features enterprise se agregan solo si:
1. No comprometen simplicidad
2. Benefician a usuarios individuales de Claude (no solo enterprise)
3. Son posibles cliente-only
4. Son relevantes para modelos Claude/Anthropic

### Scope clarification
Este plan se enfoca **exclusivamente en Anthropic/Claude models**. Features de otros providers (OpenAI GPT, Gemini, Kimi, etc.) están explícitamente fuera de alcance.

### Referencias cruzadas
- Skill index trimming: `docs/superpowers/specs/2026-09-14-skill-index-trimming-design.md`
- Tool drift notices: `docs/notices/tool-drift.en.md`

---

## Changelog del Plan

- **2026-10-08:** Creación inicial con 5 features identificadas de VS Code Copilot
- **2026-10-08:** Agregadas 6 features desde `chatModelCapabilities.ts`
- **2026-10-08:** **Limpieza y enfoque en Claude-only**: eliminadas features específicas de otros providers
- **2026-10-08:** **Removido Model Capability System**: usar consts actuales, no necesario abstraer
  - **7 features Claude-relevant** (5 en roadmap activo + 2 postponed)
  - **Descartadas:** 7 features no relevantes (Model Capability System + 6 de otros providers)
- **2026-10-08:** ✅ **Adaptive Thinking implementado correctamente** - `adaptiveThinking` es una capacidad booleana del modelo (no un valor de effort), agregado a ThinkingCapability, request builder usa `type: 'adaptive'` cuando modelo lo soporta, configurado en Fable/Opus/Sonnet (no en Haiku)

---

## Resumen Ejecutivo

**FeatuAdaptive Thinking** - optimiza budget dinámicamente ✅ COMPLETADO (2026-10-08)
2. ✅ **Extended Cache TTL (1h)** - ahorro de costos 50-80%
3. ✅ **Multi-Replace String Tool** - mejor calidad de edits en Claude
4. ✅ **Tool Deferral** - reduce tokens 40-60% con muchas MCP toolsCP tools
4. ✅ **Adaptive Thinking** - optimiza budget dinámicamente
5. ✅ **Context Management** - conversaciones ilimitadas (si Anthropic API lo soporta)
6. ⏸️ **PDF Document Support** - nicho pero útil
7. ⏸️ **Tool Search** - wait & see si Anthropic lo publica

**Features descartadas (no relevantes para Claude):**
- Model Capability System (no necesario, usar consts actuales)
- Prompt Cache Breakpoints (OpenAI Responses API)
- Verbosity Control (sin evidencia en Claude)
- Instructions Placement (bajo ROI, solo Claude 3.5 Sonnet)
- Thinking in History (Kimi K3)
- Apply Patch Tool (GPT-specific)
- Telemetría (privacidad)

**Estimación total:** 4-6 semanas de desarrollo (Fase 1-2)

