# Workflows agénticos para IBM i Docs

Este documento define cómo debe usar un agente el MCP IBM i Docs para responder preguntas, revisar código o diagnosticar problemas IBM i / AS400 sin quedarse en una búsqueda superficial.

## Principio central

Las tools de alto nivel son **orquestadores autocontenidos**.

Cuando un agente llama a `ibmi_docs_assist`, `ibmi_docs_resolve`, `ibmi_docs_answer` o `ibmi_docs_context`, el MCP no debe devolver tareas pendientes del tipo “llama `ibmi_docs_read`” o “usa `ibmi_docs_sections` si necesitas sintaxis”. La tool que recibió la tarea debe materializar internamente la evidencia necesaria: búsqueda, lectura de tópicos, secciones enfocadas, citas, advertencias y acciones sugeridas.

`ibmi_docs_search` sigue existiendo, pero es una tool de bajo nivel para exploración, auditoría o debugging de ranking. No es la respuesta final para un usuario que pidió sintaxis, corrección, diagnóstico o implementación.

Las tools de mantenimiento/build no forman parte del flujo de consulta de usuario. En particular,
`ibmi_docs_sync` no se registra en el MCP público por defecto; solo aparece si el operador arranca
el servidor con un perfil avanzado y `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`. Un agente que quiere
documentación debe usar `ibmi_docs_assist` como entrada principal, nunca sincronización como
prerequisito de una tarea.

## Perfil `agent` por defecto

El runtime está diseñado para que el usuario real sea un agente IA. Por eso el perfil por defecto no
expone todo el panel de control; expone solo lo que reduce ambigüedad:

| Tool | Rol desde la perspectiva del agente |
| --- | --- |
| `ibmi_docs_assist` | Entrada universal para preguntas, desarrollo, corrección, diagnóstico, sintaxis, comandos, mensajes y comparación de versiones. |
| `ibmi_docs_categories` | Descubrir categorías del corpus si la consulta viene muy abierta. |
| `ibmi_docs_diagnostics` | Ver salud del corpus, pack activo, perfil MCP y tools registradas. |

Esto resuelve el fallo típico donde el agente llamaba `ibmi_docs_search`, recibía IDs o hints y no
continuaba con `read/sections`. En perfil `agent`, el camino feliz queda forzado por diseño:

```text
humano -> agente -> ibmi_docs_assist -> resolve/context/search/read/sections/follow-ups internos -> respuesta final
```

Los perfiles avanzados siguen disponibles para operadores:

- `IBMI_DOCS_TOOL_PROFILE=standard`: expone tools de alto nivel especializadas.
- `IBMI_DOCS_TOOL_PROFILE=full`: expone también tools de bajo nivel y debugging.
- `IBMI_DOCS_TOOL_PROFILE=maintainer`: reservado para operación avanzada.

Un agente de uso diario no necesita esos perfiles. Menos botones, menos accidentes: el 5250 ya tuvo
suficiente sufrimiento visual por una generación.

## Orden recomendado

1. En perfil `agent`, usar siempre `ibmi_docs_assist` como entrada por defecto.
2. En perfiles avanzados, usar `ibmi_docs_resolve` para preguntas normales o ambiguas cuando se necesita ver la política/workflow interno.
3. En perfiles avanzados, usar `ibmi_docs_context` para desarrollo, corrección de bugs, revisión de código o tareas donde el agente necesita contexto operativo.
4. En perfiles avanzados, usar `ibmi_docs_answer` para respuestas extractivas directas con citas.
5. En perfiles avanzados, usar tools específicas cuando el usuario ya pide una acción concreta:
   - `ibmi_docs_compile_guidance`
   - `ibmi_docs_explain_message`
   - `ibmi_docs_compare_versions`
   - `ibmi_docs_validate_code_context`
6. Usar `ibmi_docs_search`, `ibmi_docs_read` y `ibmi_docs_sections` solo para exploración manual, auditoría, pruebas o debugging en perfil `full`.
7. No usar `ibmi_docs_sync` para responder usuarios. Si no aparece, es correcto: es mantenimiento explícito fuera del runtime normal.

## Matriz de políticas internas

| Intención | Cuándo aplica | Tool recomendada | Qué debe entregar |
| --- | --- | --- | --- |
| `explain_topic` | Explicar un tópico, comando, concepto, API o guía IBM i. | `ibmi_docs_assist` o `ibmi_docs_resolve` | Respuesta con evidencia leída, citas y advertencias. |
| `syntax_lookup` | Sintaxis de comandos, opcodes RPG, BIFs, keywords DDS o sentencias SQL. | `ibmi_docs_assist` o `ibmi_docs_resolve` | Sintaxis/secciones/parámetros ya materializados. |
| `compile_guidance` | Cómo compilar RPGLE, SQLRPGLE, CLLE, COBOL o programas con `/COPY`/SQL embebido. | `ibmi_docs_assist`, `ibmi_docs_resolve` o `ibmi_docs_compile_guidance` | Comandos, opciones, pitfalls y evidencia. |
| `message_diagnostic` | Mensajes `RNFxxxx`, `SQLxxxx`, `CPFxxxx` o `MCHxxxx`. | `ibmi_docs_assist`, `ibmi_docs_resolve` o `ibmi_docs_explain_message` | Explicación, recuperación, cobertura y evidencia. |
| `code_review` | Revisar snippet o fuente contra documentación IBM i. | `ibmi_docs_assist` con `code`, `ibmi_docs_resolve` con `code` o `ibmi_docs_context` | Señales detectadas, contexto, hallazgos y pasos. |
| `version_question` | Comparar disponibilidad o cambios entre IBM i 7.3/7.4/7.5/7.6. | `ibmi_docs_assist`, `ibmi_docs_resolve` o `ibmi_docs_compare_versions` | Comparación por release y evidencia. |
| `ranking_debug` | Entender por qué aparece un resultado o depurar ranking. | `ibmi_docs_explain_ranking` | Razones de ranking, FTS query y señales semánticas. |
| `search_discovery` | Exploración abierta de documentación. | `ibmi_docs_search` | Candidatos trazables; no usar como respuesta final si falta lectura. |

## `ibmi_docs_assist`

`ibmi_docs_assist` es el camino feliz para clientes MCP y agentes que no conocen la arquitectura interna del servidor. Recibe la tarea completa y devuelve una salida final lista para usar:

- `answer`: respuesta redactada con resumen, evidencia específica, pasos, validación, cobertura y citas.
- `executiveSummary`: resumen corto para que el agente pueda decidir rápido.
- `specificFindings`: extractos enfocados por término técnico y por sección.
- `implementationSteps`: pasos concretos para aplicar o diagnosticar.
- `validationChecklist`: cómo comprobar que la respuesta/corrección quedó bien.
- `coverage`: estado `complete`, `partial` o `thin`, con términos técnicos cubiertos/faltantes.
- `retrievalPlan`: plan agéntico ejecutado por el MCP; incluye `strategy`, `axes`, `initialQueries`, `followUpQueries`, `hops` y `coverageGaps`.
- `evidence`, `reads`, `sections`, `citations`: material ya recuperado, sin pedir sub-tools.

El flujo interno ya no es “busca una palabra y cruza los dedos”. Para consultas complejas,
`ibmi_docs_assist` arma ejes de intención como `primary`, `syntax`, `compile`, `message`,
`version`, `code` o `gap-followup`; ejecuta búsquedas focalizadas, materializa lecturas y
secciones, detecta gaps de cobertura y lanza follow-ups acotados antes de sintetizar la
respuesta final.

Ejemplo:

```powershell
node dist/src/cli.js assist "Corregir CLLE con RTVJOBA y MONMSG; necesito sintaxis, parámetros y validación" --language CLLE --ibmi-version 7.5 --depth deep
```

Usa `coverage.status` así:

- `complete`: puedes usar la respuesta como base fuerte.
- `partial`: hay evidencia útil, pero revisa advertencias por release, término o sección débil.
- `thin`: no hay evidencia suficiente; el agente no debe inventar parámetros ni sintaxis.

## `ibmi_docs_resolve`

`ibmi_docs_resolve` es el orquestador principal. Clasifica la consulta, recupera evidencia, lee tópicos principales, extrae secciones cuando aplica y sintetiza una respuesta utilizable por el agente.

Campos útiles de salida:

- `intent`: intención detectada.
- `policy`: política aplicada.
- `stages`: etapas internas ejecutadas.
- `answer`: respuesta autocontenida.
- `evidence`: resultados candidatos sanitizados.
- `reads`: tópicos completos ya leídos/resumidos.
- `sections`: secciones detectadas como `syntax`, `parameters`, `examples`, `notes`, `messages` o `recovery`.
- `citations`: citas auditables.
- `warnings`: limitaciones o señales de baja evidencia.

Ejemplo:

```powershell
node dist/src/cli.js resolve "Explica la sintaxis de SND-MSG con %MSG y %TARGET" --language RPGLE --ibmi-version 7.6 --examples
```

## `ibmi_docs_context`

`ibmi_docs_context` está pensada para desarrollo/corrección. Si el agente está trabajando sobre un problema concreto —por ejemplo un CLLE con `RTVJOBA` y `MONMSG`— esta tool debe devolver todo lo que el agente necesita para avanzar sin pedirle llamadas adicionales.

Salida esperada:

- `answer`: resumen contextual orientado a acción.
- `appliedWorkflow`: etapas internas como búsqueda, lectura y secciones.
- `recommendedDocs`: documentos candidatos sanitizados.
- `reads`: lecturas materializadas.
- `sections`: secciones enfocadas.
- `actionItems`: pasos concretos para aplicar en código o diagnóstico.
- `warnings`: límites documentales.

Ejemplo:

```powershell
node dist/src/cli.js context "Corregir CLLE con RTVJOBA y MONMSG para manejar CPF/MCH" --language CLLE --ibmi-version 7.5 --limit 5
```

## Tools de bajo nivel

`ibmi_docs_search`, `ibmi_docs_read` e `ibmi_docs_sections` son útiles cuando el usuario o mantenedor quiere inspeccionar el corpus manualmente:

```text
1. ibmi_docs_search("CRTRPGMOD command")
2. ibmi_docs_read(id)
3. ibmi_docs_sections(id)
```

Ese flujo es válido para auditoría humana, debugging o tests, pero no debe ser la única respuesta de una tool de alto nivel. Si un agente llamó `ibmi_docs_resolve` o `ibmi_docs_context`, el MCP ya debe haber ejecutado internamente lo necesario.

## Auto-read y secciones enfocadas

El repositorio detecta consultas con comandos IBM i exactos, por ejemplo:

- `CRTRPGMOD command`
- `SND-MSG`
- `CRTSQLRPGI`
- `RTVJOBA`
- `MONMSG`

Cuando la evidencia es fuerte, el runtime adjunta lectura y secciones útiles para evitar respuestas pobres basadas solo en snippets. Esto es especialmente importante para sintaxis, parámetros, notas, recuperación y mensajes.

## Diagnóstico de mensajes

Para mensajes como `RNF0004`, `CPF0001` o familias `MCH`, evita responder solo desde memoria del modelo:

```powershell
node dist/src/cli.js resolve "Diagnostica RNF0004 en una compilación RPGLE" --language RPGLE
```

La respuesta debe incluir evidencia, causa/recuperación cuando esté disponible, cobertura exacta o por familia y validaciones sugeridas.

## Guía de compilación

Para SQLRPGLE o código con SQL embebido:

```powershell
node dist/src/cli.js resolve "Cómo compilo un SQLRPGLE con EXEC SQL y /COPY" --language SQLRPGLE --compile
```

La respuesta debe cubrir comandos como `CRTSQLRPGI`, precompilador, includes/copybooks y opciones relevantes.

## Comparación de versiones

```powershell
node dist/src/cli.js resolve "Compara CRTRPGMOD entre IBM i 7.3, 7.4, 7.5 y 7.6" --limit 4
```

La respuesta debe indicar qué se encontró por release y citar evidencia comparable.

## Trazas locales

Las trazas son opcionales y locales. No se envían a ningún servicio externo.

```powershell
$env:IBMI_DOCS_TRACE = "1"
$env:IBMI_DOCS_TRACE_FILE = "D:\MCP-IBMiDocs\data\ibmi-docs-trace.ndjson"
node dist/src/cli.js resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --ibmi-version 7.6
node dist/src/cli.js trace-report --limit 30
```

El reporte incluye:

- `search_only_rate`
- `search_then_read_rate`
- `answer_usage_rate`
- `byTool`
- `recentEvents`

Úsalo para detectar clientes o prompts que abusan de `ibmi_docs_search` y no consumen evidencia completa. Si el reporte muestra mucha búsqueda sin lectura, el prompt del cliente necesita una nalgada documental, no más incienso.

## Skill opcional

El MCP no debe depender de un skill para funcionar bien. La autonomía principal vive en
`ibmi_docs_assist` y en el perfil `agent`. Aun así, el repositorio incluye
`skills/ibmi-docs/SKILL.md` como ayuda para clientes que soportan skills: sirve para enseñar al
agente cuándo invocar el MCP, qué argumentos pasar y por qué no debe encadenar manualmente
`search/read/sections` salvo debugging.

Recomendación práctica:

- instala/configura el MCP siempre;
- usa el skill solo como mejora de comportamiento del agente cliente;
- no trates el skill como requisito de runtime ni como reemplazo de la orquestación interna.

## Prompts recomendados para clientes MCP

### Pregunta normal

```text
Usa ibmi_docs_assist como tool principal. Trata su respuesta como autocontenida: incluye búsqueda, lectura, secciones, citas, pasos, validación y advertencias cuando aplica.
```

### Revisión de código

```text
Usa ibmi_docs_assist con language y code. Si necesitas depurar el workflow interno, usa ibmi_docs_context o ibmi_docs_resolve. No esperes que el agente encadene manualmente read/sections: el MCP debe devolver contexto materializado.
```

### Diagnóstico de errores

```text
Usa ibmi_docs_resolve. Si detectas RNF/SQL/CPF/MCH, la respuesta debe incluir evidencia documental y recuperación/validación sin pedir llamadas adicionales al agente.
```

## Checklist antes de responder

- ¿La respuesta salió de una tool de alto nivel (`assist`, `resolve`, `answer`, `context`, `compile_guidance`, `explain_message`, `compare_versions`)?
- Si el agente no conocía el flujo, ¿usó primero `ibmi_docs_assist`?
- ¿Incluye evidencia ya materializada, no solo IDs?
- Si el usuario pidió sintaxis, ¿hay secciones o extractos útiles?
- Si la consulta menciona versión, ¿se filtró o comparó por versión?
- Si la consulta menciona código, ¿se detectaron señales del código?
- Si hay baja evidencia, ¿se dijo claramente en vez de inventar?
