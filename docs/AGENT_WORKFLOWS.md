# Workflows agénticos para IBM i Docs

Este documento define cómo debe usar un agente el MCP IBM i Docs para responder preguntas, revisar código o diagnosticar problemas IBM i / AS400 sin quedarse en una búsqueda superficial.

## Principio central

`ibmi_docs_search` **no es la respuesta final**. Es una herramienta de descubrimiento de candidatos. Para responder con evidencia técnica se debe continuar con lectura completa, secciones o una tool de mayor nivel.

Orden recomendado:

1. Usar `ibmi_docs_resolve` para preguntas normales.
2. Usar `ibmi_docs_answer` cuando se quiere una respuesta extractiva directa con citas.
3. Usar `ibmi_docs_context`, `ibmi_docs_compile_guidance`, `ibmi_docs_explain_message` o `ibmi_docs_compare_versions` cuando la intención sea específica.
4. Usar `ibmi_docs_search` solo para exploración/ranking y continuar con `ibmi_docs_read`/`ibmi_docs_sections`.

## Matriz de políticas internas

| Intención | Cuándo aplica | Secuencia esperada |
| --- | --- | --- |
| `explain_topic` | Explicar un tópico, comando, concepto, API o guía IBM i. | `ibmi_docs_resolve` → `ibmi_docs_answer` → `ibmi_docs_read`. |
| `syntax_lookup` | Sintaxis de comandos, opcodes RPG, BIFs, keywords DDS o sentencias SQL. | `ibmi_docs_resolve` → `ibmi_docs_search` → `ibmi_docs_read` → `ibmi_docs_sections`. |
| `compile_guidance` | Cómo compilar RPGLE, SQLRPGLE, CLLE, COBOL o programas con `/COPY`/SQL embebido. | `ibmi_docs_resolve` → `ibmi_docs_context` → `ibmi_docs_compile_guidance`. |
| `message_diagnostic` | Mensajes `RNFxxxx`, `SQLxxxx`, `CPFxxxx` u otros diagnósticos. | `ibmi_docs_resolve` → `ibmi_docs_explain_message` → `ibmi_docs_read`. |
| `code_review` | Revisar snippet o fuente contra documentación IBM i. | `ibmi_docs_resolve` con `code` → `ibmi_docs_validate_code_context` → `ibmi_docs_answer`. |
| `version_question` | Comparar disponibilidad o cambios entre IBM i 7.3/7.4/7.5/7.6. | `ibmi_docs_resolve` → `ibmi_docs_compare_versions` → `ibmi_docs_read`. |
| `ranking_debug` | Entender por qué aparece un resultado o depurar ranking. | `ibmi_docs_explain_ranking` → `ibmi_docs_search`. |
| `search_discovery` | Exploración abierta de documentación. | `ibmi_docs_search` → `ibmi_docs_read` si se va a responder. |

## `ibmi_docs_resolve`

`ibmi_docs_resolve` es el orquestador de alto nivel. Clasifica la consulta, ejecuta búsqueda híbrida, lee los mejores tópicos, extrae secciones y llama herramientas específicas cuando aplica.

Campos útiles de salida:

- `intent`: intención detectada.
- `policy`: política aplicada.
- `stages`: herramientas ejecutadas internamente.
- `evidence`: resultados candidatos.
- `reads`: tópicos leídos completos.
- `sections`: secciones detectadas como `syntax`, `parameters`, `examples`, `notes`, `messages`.
- `suggestedTools`: siguiente paso recomendado.
- `warnings`: limitaciones o señales de baja evidencia.

Ejemplo:

```powershell
node dist/src/cli.js resolve "Explica la sintaxis de SND-MSG con %MSG y %TARGET" --language RPGLE --version 7.6 --examples
```

## Recomendaciones dentro de `ibmi_docs_search`

Cada resultado de `ibmi_docs_search` puede incluir:

- `nextRecommendedTool`: por ejemplo `ibmi_docs_read`, `ibmi_docs_sections` o `ibmi_docs_resolve`.
- `nextRecommendedReason`: por qué conviene ese siguiente paso.
- `nextRecommendedArguments`: argumentos sugeridos para llamar la siguiente tool.
- `workflowHints`: señales como `read_before_answer`, `extract_sections`, `compare_versions`, `diagnose_message`.

Uso correcto:

```text
1. ibmi_docs_search("CRTRPGMOD command")
2. Tomar el ID fuerte.
3. ibmi_docs_read(id)
4. ibmi_docs_sections(id) si la pregunta requiere parámetros/sintaxis.
5. Responder citando título, versión y fuente.
```

## Auto-read para comandos IBM i

El repositorio detecta consultas con comandos IBM i exactos, por ejemplo:

- `CRTRPGMOD command`
- `SND-MSG`
- `CRTSQLRPGI`

Cuando el resultado superior es fuerte, el runtime puede adjuntar contenido completo automáticamente (`autoReadApplied=true`). Esto evita respuestas pobres que solo muestran un snippet minúsculo cuando el usuario necesita sintaxis, parámetros o notas completas.

Ejemplo:

```powershell
node dist/src/cli.js search "CRTRPGMOD command" --version 7.6 --limit 1
```

El resultado debería priorizar un tópico tipo `CRTRPGMOD Command` y sugerir lectura/sections como siguiente paso.

## Diagnóstico de mensajes

Para mensajes como `RNF0004`, evita responder solo desde memoria del modelo:

```powershell
node dist/src/cli.js resolve "Diagnostica RNF0004 en una compilación RPGLE" --language RPGLE
```

Secuencia esperada:

1. Detectar `message_diagnostic`.
2. Ejecutar búsqueda sobre mensajes RPG.
3. Leer el tópico principal.
4. Complementar con `ibmi_docs_explain_message`.
5. Responder con causa, recuperación y validaciones sugeridas.

## Guía de compilación

Para SQLRPGLE o código con SQL embebido:

```powershell
node dist/src/cli.js resolve "Cómo compilo un SQLRPGLE con EXEC SQL y /COPY" --language SQLRPGLE --compile
```

Secuencia esperada:

1. Detectar `compile_guidance`.
2. Recuperar contexto de lenguaje.
3. Recomendar comandos como `CRTSQLRPGI` cuando corresponde.
4. Avisar sobre precompilador, includes/copybooks y opciones relevantes.

## Comparación de versiones

```powershell
node dist/src/cli.js resolve "Compara CRTRPGMOD entre IBM i 7.3, 7.4, 7.5 y 7.6" --limit 4
```

Secuencia esperada:

1. Detectar `version_question`.
2. Buscar tópico base.
3. Ejecutar `ibmi_docs_compare_versions`.
4. Leer tópicos principales si hay que responder con detalle.

## Trazas locales

Las trazas son opcionales y locales. No se envían a ningún servicio externo.

```powershell
$env:IBMI_DOCS_TRACE = "1"
$env:IBMI_DOCS_TRACE_FILE = "D:\MCP-IBMiDocs\data\ibmi-docs-trace.ndjson"
node dist/src/cli.js resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --version 7.6
node dist/src/cli.js trace-report --limit 30
```

El reporte incluye:

- `search_only_rate`: porcentaje aproximado de búsquedas que no fueron seguidas por lectura dentro de la ventana local.
- `search_then_read_rate`: porcentaje aproximado de búsquedas seguidas por `read` del tópico.
- `answer_usage_rate`: porcentaje de uso de `answer`/`resolve` frente a búsquedas.
- `byTool`: conteo por tool.
- `recentEvents`: eventos recientes con duración y top result.

Úsalo para detectar clientes o prompts que abusan de `ibmi_docs_search` y no leen evidencia completa. Si el reporte muestra mucha búsqueda sin lectura, el prompt del agente necesita mano dura documental, no incienso.

## Prompts recomendados para clientes MCP

### Pregunta normal

```text
Usa ibmi_docs_resolve para responder. Si usas ibmi_docs_search, debes llamar ibmi_docs_read y, si aplica, ibmi_docs_sections antes de responder.
```

### Revisión de código

```text
Usa ibmi_docs_resolve con language y code. Complementa con ibmi_docs_validate_code_context y ibmi_docs_compile_guidance si detectas SQL embebido, /COPY o dudas de compilación.
```

### Diagnóstico de errores

```text
Usa ibmi_docs_resolve. Si detectas RNF/SQL/CPF, complementa con ibmi_docs_explain_message y lee la evidencia principal antes de resumir causa, recuperación y validación.
```

## Checklist antes de responder

- ¿La respuesta está basada en `resolve`, `answer`, `context`, `compile_guidance`, `explain_message` o `compare_versions`?
- Si se usó `search`, ¿se leyó al menos un tópico completo con `read`?
- Si el usuario pidió sintaxis, ¿se extrajeron secciones?
- Si la consulta menciona versión, ¿se comparó o filtró por versión?
- Si la consulta menciona código, ¿se validó contexto del código?
- Si hay baja evidencia, ¿se dijo claramente en vez de inventar?
