# Uso agéntico de IBM i Docs

## Contrato principal

El perfil MCP predeterminado es `agent` y expone una sola tool:

| Tool | Responsabilidad |
| --- | --- |
| `ibmi_docs_assist` | Recibir la tarea IBM i completa y devolver únicamente la respuesta técnica final. |

El agente no necesita conocer la arquitectura de recuperación ni encadenar tools manualmente.

```text
humano -> agente -> ibmi_docs_assist -> respuesta final
```

Internamente el servidor puede ejecutar embeddings, búsquedas multi-perspectiva, reranking,
lecturas y comprobaciones de relevancia. Ninguno de esos detalles forma parte de la respuesta
pública normal.

## Qué enviar

`ibmi_docs_assist` acepta un esquema pequeño:

- `question`: tarea o pregunta completa.
- `code`: fuente relacionado, si existe.
- `language`: lenguaje o tecnología, si se conoce.
- `version`: release IBM i preferido, si aplica.

Ejemplo conceptual:

```json
{
  "question": "Cómo compilo un módulo RPGLE?",
  "language": "RPGLE",
  "version": "7.5"
}
```

## Qué recibe el agente

La tool devuelve exactamente un bloque `content` de tipo texto:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Create RPG Module (CRTRPGMOD) command"
    }
  ]
}
```

No devuelve `structuredContent`. Tampoco expone:

- índices del corpus;
- scores de embeddings o reranking;
- IDs de documentos o pasajes;
- planes de recuperación;
- consultas derivadas;
- lecturas internas;
- cobertura o trazas;
- instrucciones para llamar otra tool.

Si no existe soporte documental suficiente, la respuesta lo indica directamente en lugar de
rellenar el espacio con un tópico tangencial.

## Ejemplos de tareas

### Desarrollo RPGLE o SQLRPGLE

Envía la tarea completa, el código existente y el release cuando estén disponibles. El agente puede
usar la respuesta documental como base para crear o corregir el fuente.

### CLLE

Incluye el objetivo y el fragmento CL relevante. Para errores, agrega el ID de mensaje y el contexto
del joblog o compilación.

### DDS

Describe si se trata de PF, LF, DSPF o PRTF y qué comportamiento buscas. No es necesario seleccionar
una categoría del corpus.

### Administración IBM i

Formula la necesidad operativa en lenguaje natural: trabajos activos, joblogs, locks, objetos,
miembros, bibliotecas, colas o subsistemas. Los nombres propios de un servidor pueden incluirse como
contexto; el MCP recupera la documentación general aplicable.

### Versiones

Si pides IBM i 7.6 y la documentación relevante solo está disponible en otro release del corpus, la
respuesta puede usarla, pero debe indicar expresamente qué versión está citando.

## Perfiles avanzados

Los perfiles siguientes son opt-in y están destinados a operadores que necesitan inspeccionar el
runtime:

- `standard`: aliases de alto nivel;
- `full`: búsqueda, lectura, secciones, ranking, calidad y trazas;
- `maintainer`: operación avanzada del proyecto.

```powershell
$env:IBMI_DOCS_TOOL_PROFILE = 'full'
ibmi-docs-mcp
```

Las tools avanzadas pueden devolver datos estructurados porque su objetivo es diagnóstico explícito.
Eso no cambia el contrato limpio de `ibmi_docs_assist`.

## Sincronización

`ibmi_docs_sync` es mantenimiento. No aparece en el perfil `agent` y solo se registra cuando el
operador activa un perfil avanzado junto con `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`.

Nunca debe utilizarse como paso previo para responder una consulta documental.

## Trazas locales

La telemetría es opcional, local y desactivada por defecto:

```powershell
$env:IBMI_DOCS_TRACE = '1'
$env:IBMI_DOCS_TRACE_FILE = 'D:\MCP-IBMiDocs\data\ibmi-docs-trace.ndjson'
ibmi-docs trace-report --limit 30
```

Un mantenedor puede usarla para reproducir consultas difíciles sin contaminar el contexto del
agente usuario.

## Skill opcional

El skill `skills/ibmi-docs/SKILL.md` ayuda a clientes compatibles a decidir cuándo invocar el MCP,
pero no es requisito de runtime. La autonomía y el contrato de salida viven dentro del servidor.

## Checklist

- ¿Se llamó únicamente `ibmi_docs_assist` en el perfil normal?
- ¿La petición contiene la tarea completa y el código disponible?
- ¿La respuesta contiene un solo bloque de texto?
- ¿No aparecen JSON interno, scores, IDs ni planes?
- ¿Una falta de soporte se comunica claramente en vez de devolver otro tópico?
- ¿Cuando se usa otro release, la respuesta indica la versión?
