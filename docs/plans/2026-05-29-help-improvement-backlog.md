# Backlog de 10 mejoras grandes para MCP IBM i Docs

Fecha de investigación: 29/05/2026  
Repositorio auditado: `D:\MCP-IBMiDocs`  
Objetivo: detectar mejoras grandes, bugs y capacidades nuevas para mejorar la ayuda IBM i expuesta por el MCP.

## Estado de implementación

Actualizado: 30/05/2026.

Los 10 puntos de este backlog quedaron implementados en el runtime/código fuente:

1. CLI usa `--ibmi-version` / `--release` para filtrar release IBM i y reserva `--version` para la versión del programa.
2. Ranking exacto/version-aware agrega fallback canónico cuando la versión solicitada no contiene tópico exacto.
3. Crawler IBM Docs público amplía rutas técnicas, patrones de comandos/lenguajes/mensajes y eleva el límite por versión.
4. Runtime clasifica documentos como `topic`, `reference`, `index`, `landing` o `stub`.
5. Build del data pack genera `canonicalTopicKey`, dedupe por clave canónica y métricas de duplicados.
6. Normalización HTML preserva headings, listas, tablas y bloques `pre/code` para mejorar sintaxis/parámetros/ejemplos.
7. `answer`/`resolve` aplican guardrails de relevancia para no citar evidencia sin términos exactos.
8. CLI agrega `pack update`, `pack install --latest` y verificación más estricta de archivos del pack.
9. CLI/MCP agregan `report-query` / `ibmi_docs_report_query` para reproducir y reportar mal ranking.
10. Tests, benchmark golden y CI quedan reforzados con regresiones CLI, ranking SND-MSG 7.5, report-query y matriz Windows/Linux/macOS.

## Resumen ejecutivo

El MCP ya tiene una base sólida: data pack local, SQLite FTS5, runtime sin dependencia de RDi, CLI, herramientas MCP agénticas, smoke tests y benchmark golden. La auditoría encontró que los principales riesgos no están en que el MCP “no funcione”, sino en calidad de recuperación, completitud documental, empaquetado del corpus y fuerza de las pruebas.

La prioridad recomendada es atacar primero los bugs que pueden engañar al usuario o al agente:

1. conflicto CLI con `--version`;
2. ranking/resolución exacta cuando se filtra por versión;
3. respuestas extractivas que citan tópicos irrelevantes;
4. pruebas golden demasiado débiles para detectar ranking malo.

Luego conviene mejorar el corpus y distribución para que el proyecto sea cómodo y confiable para la comunidad.

## Evidencia levantada

Comandos y pruebas ejecutadas durante la auditoría:

```powershell
npm run bench:golden
npm run pack:validate
npm run setup:check
node dist/src/cli.js quality-report
node dist/src/cli.js search "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET" --category ile-rpg --version 7.5 --limit 5
node dist/src/cli.js search "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET" --category ile-rpg --limit 5
```

Resultados relevantes:

- `bench:golden`: 104/104 queries pasaron, pero el benchmark solo valida que existan resultados, no que el resultado sea correcto.
- `pack:validate`: OK, 6929 documentos, 10588 chunks, sin archivos faltantes.
- `setup:check`: OK, smoke queries básicas pasan.
- `quality-report`: detecta documentos cortos, duplicados y categoría `ibm-i-general` con cobertura mínima.
- Conteo del data pack vía SQLite:
  - documentos: 6929;
  - chunks: 10588;
  - documentos con menos de 500 caracteres: 304;
  - fuentes: `rdi-local-export` 5908 docs, `ibm-docs` 1021 docs;
  - versiones: 7.3 = 2178, 7.4 = 255, 7.5 = 255, 7.6 = 1501, RDi-local = 2740.
- El uso de `--version 7.5` en subcomandos CLI imprime `0.4.0` y no ejecuta la búsqueda, por conflicto con la opción global de Commander.
- `ibmi_docs_resolve` para SND-MSG con `version=7.5` devuelve como base principal `What's New since 7.5?`, `What's New in 7.5?` y hasta `Description of the CRTRPGMOD command`, en vez de anclar la respuesta al tópico específico de SND-MSG o advertir que no hay tópico exacto en esa versión.

Referencias de código relevantes:

- `src/cli.ts:15`: registra `.version("0.4.0")` global.
- `src/cli.ts:74`, `src/cli.ts:113`, `src/cli.ts:134`, `src/cli.ts:157`: subcomandos usan también `--version <version>`.
- `src/ingest/ibmDocsCrawler.ts:36-42`: crawler público usa pocas raíces técnicas.
- `src/ingest/ibmDocsCrawler.ts:44-57`: lista de tópicos importantes todavía pequeña.
- `src/ingest/ibmDocsCrawler.ts:70-80`: sync recibe límite por versión; el CLI actual usa 160 páginas por versión.
- `scripts/golden-benchmark.ts:17-20`: benchmark solo falla si no hay resultados.
- `scripts/smoke.ts:43-45`: smoke de answer solo exige citas y texto base, no precisión de tópicos.
- `.github/workflows/ci.yml:14-16`: CI corre solo en Windows.

## Las 10 mejoras grandes

### 1. Corregir conflicto CLI de `--version`

**Problema:** los subcomandos `search`, `answer`, `resolve` y `explain-ranking` usan `--version <version>` para indicar release IBM i, pero Commander también reserva `--version` para mostrar la versión del programa. Resultado observado: el comando imprime `0.4.0` y no ejecuta la búsqueda.

**Impacto:** cualquier usuario que siga el patrón natural `--version 7.5` recibe una salida engañosa. Es un bug de UX y de funcionalidad.

**Solución propuesta:**

- Cambiar la opción de release IBM i a `--ibmi-version <version>` o `--release <version>`.
- Mantener compatibilidad transitoria con `--version` solo si Commander lo permite sin interceptar; si no, documentar el cambio claramente.
- Agregar pruebas CLI reales invocando `node dist/src/cli.js search ... --ibmi-version 7.5`.

**Criterio de aceptación:**

- `ibmi-docs search "CRTRPGMOD" --ibmi-version 7.5 --limit 1` devuelve resultado IBM i 7.5.
- `ibmi-docs --version` sigue imprimiendo la versión del paquete.
- CI falla si cualquier subcomando vuelve a interceptar mal la versión IBM i.

---

### 2. Ranking exacto y version-aware para tópicos técnicos

**Problema:** cuando se pide un tópico exacto con versión específica, el ranking puede preferir páginas agregadoras como `What's New` o documentos relacionados, en vez del tópico exacto. Caso observado: SND-MSG con `version=7.5` terminó citando `What's New since 7.5?` y `CRTRPGMOD`.

**Impacto:** el MCP puede dar una respuesta con confianza alta pero evidencia equivocada o tangencial. Eso es veneno fino para un agente: parece serio, pero cita lo que no toca.

**Solución propuesta:**

- Implementar una capa de `exactTopicResolver` antes del ranking general.
- Reconocer familias: comandos (`CRT*`, `DSP*`, `WRK*`), RPG opcodes (`SND-MSG`, `CHAIN`, `MONITOR`), BIFs (`%MSG`, `%TARGET`), DDS keywords, mensajes (`RNFxxxx`, `CPFxxxx`, `SQLxxxx`).
- Si se filtra por versión y no hay tópico exacto, devolver fallback controlado con advertencia: “no encontré tópico exacto en 7.5; encontré tópico exacto en RDi-local/7.6 y notas de disponibilidad”.
- Penalizar páginas `What's New`, índices y referencias generales cuando existe un tópico exacto.

**Criterio de aceptación:**

- `resolve("SND-MSG ...", version="7.5")` no cita `CRTRPGMOD`.
- Si el tópico exacto solo existe en otra fuente/release, la respuesta lo declara explícitamente.
- `explain-ranking` muestra el boost exacto y la razón del fallback.

---

### 3. Ampliar cobertura del crawler público de IBM Docs

**Problema:** el corpus público está desbalanceado: IBM Docs suma 1021 documentos frente a 5908 del export RDi. Por versión, 7.4 y 7.5 tienen solo 255 documentos cada una, contra 2178 en 7.3 y 1501 en 7.6.

**Impacto:** al filtrar por versión, el agente puede perder tópicos específicos y caer en páginas genéricas. También reduce la independencia real del bootstrap RDi.

**Solución propuesta:**

- Ampliar raíces de `CORE_PATH_PREFIXES` para cubrir comandos IBM i, APIs, IFS, Db2 for i programming, SQL services, security básica de objetos, joblog/mensajes y programación ILE general.
- Convertir `IMPORTANT_TOPIC_IDS` en archivo de configuración versionado, no constante pequeña en código.
- Ajustar `maxPagesPerVersion` con presupuesto por rama documental, no límite plano.
- Registrar cobertura esperada por versión/categoría y fallar el build si cae demasiado.

**Criterio de aceptación:**

- Cobertura IBM Docs por 7.4/7.5 aumenta de forma significativa.
- `quality-report` muestra alerta si una versión queda anómalamente baja.
- El MCP puede responder más casos sin depender de `RDi-local`.

---

### 4. Detectar y tratar páginas stub, índice o redirección documental

**Problema:** hay 304 documentos con menos de 500 caracteres. Ejemplos: `Examples: DDS` con 123 caracteres, `Db2 for i SQL reference` con 146 caracteres, `Language elements` con 168 caracteres.

**Impacto:** el agente puede citar una página vacía o de navegación como si fuera ayuda completa. Eso empeora respuestas y ranking.

**Solución propuesta:**

- Agregar campo `documentKind`: `topic`, `index`, `stub`, `redirect`, `landing`, `reference`.
- Enriquecer stubs con hijos del TOC cuando sea seguro.
- Excluir stubs como evidencia primaria salvo que el usuario pida navegación.
- En `quality-report`, mostrar conteos por tipo y top stubs por impacto.

**Criterio de aceptación:**

- Los documentos cortos dejan de aparecer como evidencia primaria para preguntas técnicas.
- Si un resultado es índice, la respuesta recomienda leer sus hijos concretos.
- El conteo de stubs queda visible y accionable.

---

### 5. Dedupe y canonicalización entre IBM Docs y RDi-local

**Problema:** `quality-report` muestra duplicados masivos, especialmente en C/C++ (`ILE C/C++ Programmer's Guide` con 646 entradas, `Runtime Library Functions` con 408, etc.). También hay títulos repetidos entre versiones y fuentes.

**Impacto:** el ranking puede sobre-representar una familia documental, confundir `related`, inflar el corpus y producir navegación ruidosa.

**Solución propuesta:**

- Crear `canonicalTopicKey` basado en familia, título normalizado, breadcrumbs normalizados y versión.
- Dedupe por tópico lógico, no solo por hash HTML.
- Mantener variantes por versión, pero agrupar equivalentes por fuente.
- Exponer `equivalentSources` y `equivalentVersions` en resultados.

**Criterio de aceptación:**

- Duplicados masivos bajan drásticamente sin perder cobertura real.
- `related` devuelve equivalentes útiles y no vecinos por ruido de hash.
- `quality-report` distingue duplicado legítimo por versión vs duplicado accidental.

---

### 6. Preservar estructura rica: tablas, sintaxis, parámetros y ejemplos

**Problema:** `extractDocumentContent` usa texto plano de `body`, lo que aplasta tablas y diagramas. Ejemplo observado en CRTRPGMOD: la sintaxis queda como una línea gigantesca difícil de leer. En SND-MSG, algunas secciones de sintaxis se clasifican como `messages`.

**Impacto:** aunque se lea el tópico correcto, la respuesta puede perder la forma que más necesita un programador: tabla de parámetros, bloque de sintaxis y ejemplos copiados con claridad.

**Solución propuesta:**

- Normalizar HTML a Markdown estructurado.
- Preservar `pre`, `code`, tablas y listas.
- Convertir syntax diagrams a bloques legibles con saltos y tokens.
- Guardar secciones en tabla SQLite separada: `sections(document_id, kind, title, body, order, anchors)`.

**Criterio de aceptación:**

- `read` de CRTRPGMOD muestra sintaxis y parámetros legibles.
- `sections` de SND-MSG clasifica `Free-Form Syntax`, operandos, notas y ejemplos correctamente.
- Las respuestas pueden citar una sección concreta, no solo el documento completo.

---

### 7. Mejorar la respuesta extractiva y sus guardrails

**Problema:** `answer` arma una respuesta base desde los primeros tópicos leídos. Si el ranking trae algo tangencial, la respuesta lo presenta como evidencia. En el caso SND-MSG 7.5, llegó a incluir CRTRPGMOD como cita.

**Impacto:** el usuario recibe una respuesta que parece fundamentada, pero con citas débiles o incorrectas.

**Solución propuesta:**

- Agregar validación de relevancia antes de citar: título, breadcrumbs, tokens exactos y tipo documental deben coincidir con la intención.
- Separar `primaryEvidence`, `supportingEvidence` y `rejectedEvidence`.
- Bajar confianza cuando no hay tópico exacto.
- Generar respuesta desde secciones relevantes, no desde snippets globales.
- Incluir advertencias explícitas cuando la evidencia es parcial.

**Criterio de aceptación:**

- Una respuesta de opcode no cita comandos no relacionados.
- La confianza no es `alta` si no existe tópico exacto.
- `structuredContent` incluye evidencia rechazada y motivo en modo diagnóstico/ranking.

---

### 8. Mejorar instalación y actualización del data pack

**Problema:** el paquete npm instala runtime/CLI, pero el corpus pesado vive fuera. Hoy el onboarding práctico requiere clonar el repo o instalar manualmente un pack. Eso es razonable para beta, pero fricciona a usuarios finales.

**Impacto:** menos adopción comunitaria y más problemas de instalación.

**Solución propuesta:**

- Publicar data packs como GitHub Release assets versionados.
- Agregar `ibmi-docs pack install --latest` con índice público del proyecto.
- Verificar SHA256, tamaño, versión de schema y compatibilidad runtime/pack.
- Permitir `ibmi-docs update` para runtime + pack con pasos claros.
- Mantener modo offline para empresas: instalar desde `.tgz` descargado manualmente.

**Criterio de aceptación:**

- En máquina limpia: `npm install -g @ckirsch94/ibmi-docs-mcp` + `ibmi-docs pack install --latest` + `ibmi-docs doctor` deja el MCP operativo.
- `doctor` informa si el pack está viejo o incompatible.
- El README deja de requerir clonar el repo como camino principal.

---

### 9. Feedback loop para reportar mala ayuda/ranking

**Problema:** existen trazas opcionales e issue template de ranking, pero no hay flujo de usuario que capture automáticamente query, corpus version, top hits, ranking reasons y entorno.

**Impacto:** los usuarios novatos pueden detectar “esto está raro”, pero no sabrán reportarlo con suficiente evidencia. Se pierde feedback valioso de la comunidad.

**Solución propuesta:**

- Crear comando `ibmi-docs report-query "..." --expected "..."`.
- Generar Markdown listo para GitHub Issue con:
  - query;
  - versión/categoría;
  - corpusVersion;
  - top 5 resultados;
  - `explain-ranking`;
  - tool recomendada y args;
  - versión npm/node/SO.
- Añadir tool MCP `ibmi_docs_report_bad_query` o incluirlo en `ibmi_docs_explain_ranking`.

**Criterio de aceptación:**

- Un usuario puede crear un issue de ranking copiando un único bloque generado.
- El maintainer puede reproducir el caso sin pedir 10 datos adicionales.
- Las queries reportadas pueden promoverse a golden tests.

---

### 10. Endurecer tests, benchmark y CI para calidad real

**Problema:** las pruebas actuales pasan, pero varias no prueban precisión. `golden-benchmark` solo exige resultados no vacíos; `smoke` valida que haya lecturas y citas, no que sean las correctas; CI corre solo en Windows.

**Impacto:** bugs como el conflicto `--version` o respuestas con citas irrelevantes pueden pasar inadvertidos.

**Solución propuesta:**

- Extender fixtures con `mustBeFirstTitle`, `mustContainTitle`, `mustNotContainTitle`, `expectedIntent`, `expectedPrimaryEvidenceKind`.
- Añadir pruebas CLI con child process para `search`, `answer`, `resolve`, `doctor`, `pack install`.
- Añadir pruebas MCP stdio reales: listar tools y ejecutar `resolve`.
- Ejecutar CI en matriz `windows-latest`, `ubuntu-latest`, `macos-latest`.
- Añadir smoke de paquete instalado desde `npm pack`, no solo desde source tree.

**Criterio de aceptación:**

- CI falla con el bug actual de `--version`.
- CI falla si SND-MSG devuelve CRTRPGMOD como evidencia primaria.
- CI prueba instalación estilo usuario final.

## Orden recomendado de implementación

| Orden | Mejora | Motivo |
| --- | --- | --- |
| 1 | Corregir `--version` CLI | Bug visible y barato de arreglar. |
| 2 | Tests de precisión y CLI | Evita regresiones mientras se toca ranking. |
| 3 | Ranking exact-topic/version-aware | Ataca el riesgo principal: evidencia incorrecta. |
| 4 | Guardrails de respuesta extractiva | Evita respuestas con citas tangenciales. |
| 5 | Secciones estructuradas/Markdown | Mejora utilidad real para programadores. |
| 6 | Stubs e índices | Limpia evidencia débil. |
| 7 | Crawler público ampliado | Reduce dependencia del bootstrap RDi. |
| 8 | Dedupe/canonicalización | Mejora navegación y ranking. |
| 9 | Data pack release/update | Mejora adopción comunitaria. |
| 10 | Feedback loop | Convierte usuarios en fuente de mejora continua. |

## Nota final

El proyecto ya tiene la parte difícil encaminada: corpus local, FTS, herramientas MCP y diagnóstico. La siguiente fase debería enfocarse menos en “más features” y más en precisión, trazabilidad y experiencia de instalación. En documentación técnica, la confianza no se gana por hablar bonito; se gana citando el tópico correcto sin meter un CRTRPGMOD en una pregunta de SND-MSG como si nadie estuviera mirando.
