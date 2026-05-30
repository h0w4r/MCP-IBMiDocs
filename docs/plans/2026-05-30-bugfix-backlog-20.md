# Backlog de 20 correcciones de bugs para MCP IBM i Docs

Fecha de auditoría: 30/05/2026
Repositorio auditado: `D:\MCP-IBMiDocs`
Commit base observado: `c77d2c7 feat: implementa mejoras de calidad documental`
Objetivo: detectar 20 correcciones de bugs a implementar, con evidencia real del estado actual del proyecto.

## Alcance y metodología

Esta auditoría revisó el runtime MCP/CLI, resolución de data packs, validación de corpus, construcción del pack, crawler IBM Docs, exportador RDi de bootstrap y comportamiento real de búsquedas problemáticas.

Checks ejecutados:

```powershell
npm run build
npm test
node dist\src\cli.js quality-report
node dist\src\cli.js resolve "Diagnostica CPF0001 en joblog IBM i" --limit 4
node dist\src\cli.js search "SBMJOB command" --limit 5
node dist\src\cli.js --help
```

Resultado base:

- `npm run build`: OK.
- `npm test`: OK, 3 archivos de test, 41 tests pasados.
- `quality-report`: `ok=true`, aunque reporta 103 `stub`, categoría `ibm-i-general` con 1 documento, duplicados canónicos masivos y documentos cortos como `Examples: DDS`.
- `resolve "Diagnostica CPF0001 en joblog IBM i"`: detecta intención `message_diagnostic`, pero genera respuesta base con evidencia ILE COBOL irrelevante y `confidence="alta"`, mientras `messageExplanation.evidence=[]`.
- `search "SBMJOB command"`: no encuentra una página exacta de SBMJOB; devuelve índices genéricos y recomienda `language: "SBMJOB COMMAND"`.
- `--help`: expone varios comandos CLI, pero faltan comandos directos equivalentes a varias tools MCP públicas.

## Resumen ejecutivo

El proyecto ya compila y pasa tests, pero hay bugs de precisión, integridad y distribución que pueden afectar confianza del usuario y del agente. Los más urgentes son los que provocan respuestas con evidencia incorrecta o validaciones `ok=true` demasiado optimistas.

| ID | Área | Severidad | Resumen de corrección |
| --- | --- | --- | --- |
| BUG-001 | Resolución de pack | Media | Distinguir `--pack` explícito de `IBMI_DOCS_PACK_DIR`. |
| BUG-002 | Resolución de pack | Alta | No aceptar rutas forzadas si no contienen un pack válido. |
| BUG-003 | Validación de pack | Alta | Abrir SQLite y validar schema/conteos, no solo existencia de archivos. |
| BUG-004 | Validación de pack | Alta | Bloquear path traversal en rutas del manifest. |
| BUG-005 | Instalación de pack | Alta | Instalar data packs de forma atómica para evitar residuos. |
| BUG-006 | Instalación de pack | Alta | Ejecutar verificación completa post-instalación y rollback. |
| BUG-007 | Extracción de pack | Alta | Aplicar filtro explícito anti path traversal en `.tar/.tgz`. |
| BUG-008 | Descarga de pack | Media | Agregar timeout, límite de tamaño y validación de tipo. |
| BUG-009 | Crawler/export | Media | Agregar timeouts/reintentos consistentes a `fetch` de IBM/RDi. |
| BUG-010 | Build pack | Alta | Resolver raíz de archivos por documento/fuente, no por `sources[0]`. |
| BUG-011 | Dedupe | Media | Dedupe por tópico canónico antes que por hash HTML. |
| BUG-012 | Canonicalización | Media | Evitar que palabras mayúsculas genéricas sean tratadas como comandos. |
| BUG-013 | Mensajes | Alta | Tratar `CPFxxxx` y `MCHxxxx` como términos técnicos exactos. |
| BUG-014 | Mensajes | Alta | No limitar CPF/MCH a `ibm-i-general`; usar búsqueda/fallback especializado. |
| BUG-015 | Confianza | Alta | Bajar confianza cuando falta evidencia requerida por intención. |
| BUG-016 | Evidencia | Alta | Evitar evidencia no relacionada cuando no hay términos exactos útiles. |
| BUG-017 | Comandos CL | Alta | Ampliar detección de comandos IBM i más allá de prefijos actuales. |
| BUG-018 | Recomendaciones | Media | `normalizeLanguage` no debe devolver texto crudo desconocido. |
| BUG-019 | Quality gate | Media | `qualityReport.ok` debe fallar ante stubs/sparse/duplicados críticos. |
| BUG-020 | CLI/MCP parity | Baja | Agregar comandos CLI equivalentes a tools MCP públicas faltantes. |

---

## BUG-001 - `--pack` explícito aparece como `source: "env"`

**Área:** `src/util/paths.ts` / resolución de data pack.
**Severidad:** Media.

### Evidencia

En `src/util/paths.ts`, la interfaz `PackResolution.source` solo admite `"env" | "cwd" | "user" | "bundled" | "default-user"`. Además, en `resolvePackDir(moduleUrl, explicit)` el candidato explícito usa `source: "env"`:

- `src/util/paths.ts:6-9`: `PackResolution.source` no tiene valor `explicit`.
- `src/util/paths.ts:24`: `explicit ? { source: "env", dir: explicit, force: true } : undefined`.

### Impacto

`doctor`, `diagnostics` y cualquier diagnóstico de instalación no puede distinguir entre:

- un usuario que pasó `--pack D:\...`;
- un pack elegido por `IBMI_DOCS_PACK_DIR`.

Esto complica soporte, issues y troubleshooting. El usuario cree que el CLI respetó una ruta explícita, pero el diagnóstico dice `env`, como si viniera de variable de entorno.

### Corrección propuesta

- Extender `PackResolution.source` con `"explicit"`.
- Cambiar el candidato explícito a `{ source: "explicit", dir: explicit, force: true }`.
- Agregar test unitario y CLI para `doctor --pack ...` verificando `packResolution.source === "explicit"`.

### Validación sugerida

```powershell
node dist\src\cli.js doctor --pack data\pack
```

Debe reportar:

```json
"packResolution": {
  "source": "explicit"
}
```

---

## BUG-002 - Rutas forzadas se aceptan aunque no sean data pack válido

**Área:** `src/util/paths.ts` / resolución de pack.
**Severidad:** Alta.

### Evidencia

`resolvePackDir` devuelve inmediatamente una ruta marcada como `force`, sin validar `hasPack(dir)`:

- `src/util/paths.ts:24-25`: `explicit` y `IBMI_DOCS_PACK_DIR` se marcan con `force: true`.
- `src/util/paths.ts:34`: `if (candidate.force || hasPack(dir)) return ...`.

### Impacto

Si el usuario ejecuta:

```powershell
ibmi-docs doctor --pack D:\ruta\equivocada
```

el resolver devuelve esa ruta como si fuera válida. Luego `CorpusRepository` falla con un error más genérico al no encontrar `ibmi-docs.sqlite`. El diagnóstico pierde la oportunidad de explicar que la ruta explícita no contiene `manifest.json`/`ibmi-docs.sqlite`.

### Corrección propuesta

- Validar siempre `hasPack(dir)`.
- Si la ruta viene de `explicit` o `env` y no es válida, devolver un error accionable con:
  - ruta recibida;
  - archivos faltantes;
  - rutas revisadas;
  - sugerencia `ibmi-docs pack install --latest` o `IBMI_DOCS_PACK_DIR`.
- Evitar que `CorpusRepository` sea quien descubra tarde el problema.

### Validación sugerida

```powershell
node dist\src\cli.js doctor --pack D:\no-existe
```

Debe fallar con mensaje específico: “la ruta explícita no contiene un data pack válido”.

---

## BUG-003 - `verifyDataPack` no valida SQLite ni schema real

**Área:** `src/pack/dataPack.ts` / integridad del pack.
**Severidad:** Alta.

### Evidencia

`verifyDataPack(packDir)` comprueba principalmente existencia de archivos y rutas declaradas en `manifest.json`:

- `src/pack/dataPack.ts:71-73`: define rutas `manifest.json` e `ibmi-docs.sqlite`.
- `src/pack/dataPack.ts:73`: solo verifica existencia de `ibmi-docs.sqlite`.
- `src/pack/dataPack.ts:78-95`: parsea manifest y valida archivos `rawHtmlPath` / `normalizedTextPath`.

No abre `ibmi-docs.sqlite`, no valida tablas (`documents`, `chunks`, `chunks_fts`, `meta`, `document_sections`) ni compara conteos manifest vs SQLite.

### Impacto

Un pack con SQLite corrupto, vacío o con schema incompatible puede pasar `pack verify` siempre que exista el archivo y el manifest tenga rutas válidas. Luego el runtime falla tarde al consultar.

### Corrección propuesta

- En `verifyDataPack`, abrir `ibmi-docs.sqlite` en readonly con `better-sqlite3`.
- Validar tablas mínimas y columnas críticas.
- Leer `meta.manifest` y comparar:
  - `manifest.documents.length` vs `SELECT COUNT(*) FROM documents`;
  - chunks declarados vs `SELECT COUNT(*) FROM chunks`;
  - presencia de FTS5.
- Reportar issues claros sin lanzar excepción cruda.

### Validación sugerida

Crear un pack temporal con `ibmi-docs.sqlite` vacío y ejecutar:

```powershell
node dist\src\cli.js pack verify --pack .\tmp\pack-corrupto
```

Debe marcar `ok=false` con error de schema/conteos.

---

## BUG-004 - Rutas del manifest pueden escapar del directorio del pack

**Área:** `src/pack/dataPack.ts` / seguridad e integridad de rutas.
**Severidad:** Alta.

### Evidencia

`verifyDataPack` y `lintContribution` usan `path.join(resolved, relative)` con rutas declaradas por el manifest, pero no comprueban que el resultado quede dentro del pack:

- `src/pack/dataPack.ts:91`: `fsSync.existsSync(path.join(resolved, relative))`.
- `src/pack/dataPack.ts:129`: `fsSync.existsSync(path.join(resolved, value))`.

### Impacto

Un manifest malicioso o accidental podría declarar rutas como:

```json
"rawHtmlPath": "..\\..\\archivo-externo.html"
```

y la verificación podría revisar archivos fuera del pack. Aunque el runtime normal no modifica esos archivos, esto rompe la garantía de que un data pack es autocontenido y complica validaciones de contribuciones.

### Corrección propuesta

Crear helper común:

```ts
function resolvePackRelative(root: string, relative: string): string {
  const full = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (!full.startsWith(prefix)) throw new Error(`Ruta fuera del pack: ${relative}`);
  return full;
}
```

Usarlo en:

- `verifyDataPack`;
- `lintContribution`;
- `CorpusRepository.packDiagnostics`;
- copias del `packBuilder` si procesa manifests externos.

### Validación sugerida

Fixture de manifest con `../escape.html` debe producir `ok=false`.

---

## BUG-005 - Instalación de data pack no es atómica y deja residuos

**Área:** `src/pack/dataPack.ts` / instalación de pack.
**Severidad:** Alta.

### Evidencia

`installDataPack` escribe directamente sobre `outDir`:

- `src/pack/dataPack.ts:36-37`: resuelve y crea `outDir`.
- `src/pack/dataPack.ts:43`: `fs.cp(source, outDir, { recursive: true, force: true })`.
- `src/pack/dataPack.ts:46`: `tar.x({ file: source, cwd: outDir, ... })`.

No limpia el destino ni instala en directorio temporal.

### Impacto

Si el usuario actualiza desde un pack viejo a uno nuevo, pueden quedar archivos `raw/`, `normalized/` o `sqlite` antiguos. Eso puede provocar:

- archivos huérfanos que aparentan cobertura inexistente;
- validaciones confusas;
- mezcla de versiones del corpus;
- diagnósticos difíciles de reproducir.

### Corrección propuesta

- Extraer/copiar siempre a un directorio temporal hermano: `.pack-install-<timestamp>`.
- Ejecutar `verifyDataPack` completo en el temporal.
- Reemplazar destino con operación controlada:
  - mover destino actual a backup temporal;
  - mover nuevo pack a destino final;
  - borrar backup solo tras éxito.
- En Windows, contemplar locks de SQLite y mensajes claros.

### Validación sugerida

Instalar pack A con archivo extra, instalar pack B sin ese archivo y comprobar que el archivo extra ya no existe.

---

## BUG-006 - `installDataPack` valida solo `hasPack`, no integridad completa

**Área:** `src/pack/dataPack.ts` / post-instalación.
**Severidad:** Alta.

### Evidencia

Al final de `installDataPack`, solo se llama `hasPack(outDir)`:

- `src/pack/dataPack.ts:49`: comprueba presencia de `manifest.json` e `ibmi-docs.sqlite`.
- `src/util/paths.ts:16-18`: `hasPack` solo verifica esos dos archivos.

### Impacto

Un pack con `manifest.json` y `ibmi-docs.sqlite` presentes pero corruptos, incompatibles o incompletos queda “instalado”. El error aparece después, cuando el usuario corre búsquedas o arranca el MCP.

### Corrección propuesta

- Reemplazar `hasPack(outDir)` por `verifyDataPack(outDir)`.
- Si `verifyDataPack.ok === false`, abortar instalación y mostrar `issues`.
- En instalación atómica, hacer rollback al pack anterior.

### Validación sugerida

Un `.tgz` con SQLite vacío debe fallar durante `pack install`, no en `doctor` posterior.

---

## BUG-007 - Extracción `.tar/.tgz` sin filtro explícito anti path traversal

**Área:** `src/pack/dataPack.ts` / extracción de archivos.
**Severidad:** Alta.

### Evidencia

La extracción se hace directamente con `tar.x`:

- `src/pack/dataPack.ts:46`: `await tar.x({ file: source, cwd: outDir, gzip: ... })`.

No hay filtro propio que rechace entradas absolutas, `..`, rutas Windows con drive letter, symlinks peligrosos o archivos fuera de la raíz esperada.

### Impacto

Aunque la librería `tar` tenga protecciones por defecto, el proyecto no declara una política explícita. Para un instalador de data packs descargables, conviene evitar depender de defaults implícitos: una contribución o release asset malformado no debe poder escribir fuera de `outDir`.

### Corrección propuesta

- Extraer primero a temporal.
- Usar `filter`/validación de entradas para rechazar:
  - rutas absolutas;
  - `..`;
  - symlinks/hardlinks si no se necesitan;
  - rutas que no pertenezcan a `raw/`, `normalized/`, `manifest.json`, `ibmi-docs.sqlite`.
- Validar después con `verifyDataPack`.

### Validación sugerida

Fixture `.tgz` con entrada `../escape.txt` debe fallar sin crear archivo fuera del temporal.

---

## BUG-008 - Descarga de data pack sin timeout, límite de tamaño ni validación de contenido

**Área:** `src/pack/dataPack.ts` / descarga remota de packs.
**Severidad:** Media.

### Evidencia

`materializeSource` descarga URLs con `fetch(source)` y carga todo a memoria:

- `src/pack/dataPack.ts:148`: `const response = await fetch(source)`.
- `src/pack/dataPack.ts:150`: `Buffer.from(await response.arrayBuffer())`.

No hay timeout, límite de bytes, validación de `Content-Type`, extensión real ni checksum.

### Impacto

`ibmi-docs pack install --latest` o `--from <url>` puede:

- quedarse colgado si el servidor no responde;
- consumir memoria excesiva ante una descarga gigante;
- guardar HTML/JSON de error como si fuera `.tgz`;
- fallar más tarde con mensajes poco claros.

### Corrección propuesta

- Usar `AbortController` con timeout configurable.
- Descargar por stream con límite de bytes, por ejemplo 1-2 GB configurable.
- Validar extensión/`Content-Type` esperados.
- Incorporar SHA256 cuando exista manifest de release.
- Mostrar error específico si la URL devuelve HTML o JSON en vez de pack.

### Validación sugerida

Mock HTTP que nunca termina debe abortar con timeout. Mock con archivo grande debe abortar por límite.

---

## BUG-009 - Crawler IBM Docs y exportador RDi pueden colgar por `fetch` sin timeout

**Área:** `src/ingest/ibmDocsCrawler.ts`, `src/ingest/rdiExporter.ts`.
**Severidad:** Media.

### Evidencia

IBM Docs crawler:

- `src/ingest/ibmDocsCrawler.ts:359-375`: `fetchTextWithRetry` reintenta, pero `fetch` no tiene timeout.
- `src/ingest/ibmDocsCrawler.ts:363`: `fetch(url, { headers: ... })`.

Exportador RDi de bootstrap:

- `src/ingest/rdiExporter.ts:185-188`: `fetchText` no tiene timeout ni retry.

### Impacto

Una conexión colgada puede bloquear `sync-ibm` o `export-rdi`. En un crawler con concurrencia, unos pocos sockets en mal estado pueden hacer que el proceso parezca congelado.

### Corrección propuesta

- Crear helper compartido `fetchTextWithTimeout`.
- Parámetros: timeout por request, retries, backoff, user-agent, tamaño máximo.
- Registrar fallos por URL sin detener toda la sincronización cuando sea recuperable.
- En RDi bootstrap, mantenerlo como herramienta interna, pero con la misma robustez.

### Validación sugerida

Test con servidor local que no responde debe terminar en tiempo acotado y registrar fallo recuperable.

---

## BUG-010 - `copyDocumentFiles` asigna raíz por `manifest.sources[0]` y puede copiar desde el directorio equivocado

**Área:** `src/ingest/packBuilder.ts` / build del data pack.
**Severidad:** Alta.

### Evidencia

En `copyDocumentFiles`, la raíz de cada manifest se decide mirando solo la primera fuente:

- `src/ingest/packBuilder.ts:142-145`:

```ts
const root = manifest.sources[0]?.kind === "rdi-local-export"
  ? path.join(inputDir, "rdi-export")
  : path.join(inputDir, "ibm-docs-cache");
for (const doc of manifest.documents) sourceRoots.set(doc.id, root);
```

### Impacto

Si un manifest contiene documentos de varias fuentes, o si un contributor genera un manifest combinado, todos sus documentos usarán la raíz de `sources[0]`. Resultado:

- archivos no encontrados;
- archivos copiados desde el origen incorrecto;
- pack incompleto aunque el manifest parezca correcto.

### Corrección propuesta

- Resolver raíz por documento usando `doc.sourceKind` o `doc.sourceId`.
- Si el manifest incluye múltiples fuentes, mapear `sourceId -> root`.
- Validar que `rawHtmlPath` y `normalizedTextPath` existan antes de construir SQLite.
- Fallar el build si hay documentos sin archivo, no solo omitir silenciosamente.

### Validación sugerida

Fixture con manifest mixto `rdi-local-export` + `ibm-docs` debe copiar cada documento desde su raíz correcta.

---

## BUG-011 - Dedupe prioriza `sha256` y deja duplicados lógicos

**Área:** `src/ingest/packBuilder.ts` / deduplicación.
**Severidad:** Media.

### Evidencia

`buildDocumentDedupeKey` usa `sha256` antes que la clave canónica:

- `src/ingest/packBuilder.ts:117-121`:

```ts
if (doc.sha256) return `sha:${doc.sha256}`;
const canonical = doc.canonicalTopicKey ?? canonicalTopicKeyForBuild(doc);
```

### Impacto

Dos documentos del mismo tópico lógico con diferencias menores de HTML tienen hashes distintos y no se deduplican por `canonicalTopicKey`. El `quality-report` confirma duplicados canónicos grandes, por ejemplo `ile-c-cpp:ile-c-c-programmer-s-guide` con `count=518`.

### Corrección propuesta

- Cambiar prioridad:
  1. `version + category + canonicalTopicKey` cuando la clave sea confiable;
  2. `canonicalUrl` normalizada;
  3. `sha256` como último recurso para contenido sin identidad documental.
- Mantener `sourcePriority` para preferir `rdi-local-export` o `ibm-docs` según política explícita.
- Guardar equivalentes descartados como metadatos (`equivalentSources`) si aporta valor.

### Validación sugerida

Pack fixture con mismo tópico, distinto hash y misma clave canónica debe conservar un solo documento lógico.

---

## BUG-012 - Canonicalización interpreta palabras mayúsculas genéricas como comandos

**Área:** `src/ingest/packBuilder.ts` / `canonicalTopicKeyForBuild`.
**Severidad:** Media.

### Evidencia

`canonicalTopicKeyForBuild` extrae el primer token uppercase de 2+ letras como `command`:

- `src/ingest/packBuilder.ts:415-426`.
- Línea crítica: `doc.title.match(/\b[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)?\b/)`.

Esto puede capturar `IBM`, `ILE`, `SQL`, `COBOL`, `DDS` o palabras de título que no son comandos.

### Impacto

La clave canónica puede quedar demasiado genérica o errónea. Eso afecta:

- dedupe;
- `related`;
- `quality-report`;
- ranking exact-topic.

Ejemplo observado indirecto: `quality-report` muestra duplicados canónicos gigantes y categorías con ruido. Además, en runtime se clasifica `Compiler-Directing Statements` como taxonomía `command` por señales de prefijo, aunque no es un comando IBM i de estilo CL.

### Corrección propuesta

- Usar un detector compartido de términos técnicos basado en contexto:
  - comandos CL: diccionario extraído del corpus o patrones con `command`/`Description of the ... command`;
  - RPG opcodes con guion o lista conocida;
  - BIFs `%...`;
  - mensajes `RNF/CPF/MCH/SQL`.
- Excluir stopwords técnicas: `IBM`, `ILE`, `SQL`, `COBOL`, `DDS`, `RPG`, `CL` cuando no aparecen en contexto de comando exacto.

### Validación sugerida

Tests de canonicalización para:

- `Db2 for i SQL reference`;
- `ILE COBOL Language Reference`;
- `Description of the CRTRPGMOD command`;
- `SND-MSG operation code`.

---

## BUG-013 - `CPFxxxx` y `MCHxxxx` no son términos técnicos exactos

**Área:** `src/repository/CorpusRepository.ts` / extracción de términos exactos.
**Severidad:** Alta.

### Evidencia

`isCommandOrOpcodeTerm` reconoce RNF y SQL, pero no CPF/MCH:

- `src/repository/CorpusRepository.ts:1779-1785`:
  - `^rnf\d{4}$`;
  - `^sql\d{4,5}$`;
  - falta `^cpf\d{4}$` y `^mch\d{4}$`.

El comportamiento real lo confirma:

```powershell
node dist\src\cli.js resolve "Diagnostica CPF0001 en joblog IBM i" --limit 4
```

Resultado observado:

- `intent`: `message_diagnostic`.
- `messageExplanation.evidence`: `[]`.
- respuesta base usa tópicos ILE COBOL irrelevantes.
- `confidence`: `alta`.

### Impacto

Los guardrails de exactitud no se activan para CPF/MCH, justo una familia de mensajes crítica para IBM i. El agente puede mezclar resultados de COBOL, RPG o cualquier documento que contenga tokens genéricos de la expansión semántica.

### Corrección propuesta

- Extender `isCommandOrOpcodeTerm`:

```ts
|| /^cpf\d{4}$/i.test(token)
|| /^mch\d{4}$/i.test(token)
```

- Asegurar que `extractExactTechnicalTerms` devuelva CPF/MCH.
- Agregar golden tests para `CPF0001`, `CPF9898`, `MCH3601`.

### Validación sugerida

`resolve("CPF0001")` no debe citar ILE COBOL si no hay evidencia exacta.

---

## BUG-014 - `explainMessage` envía CPF/MCH a una categoría casi vacía

**Área:** `src/repository/CorpusRepository.ts` / diagnóstico de mensajes.
**Severidad:** Alta.

### Evidencia

`explainMessage` calcula categoría así:

- `src/repository/CorpusRepository.ts:562-567`:

```ts
const category = family === "RNF" ? "mensajes-rnf" : family === "SQL" ? "sql-db2-for-i" : "ibm-i-general";
const evidence = this.search({ query: messageId, category, limit: ... });
```

`quality-report` muestra `ibm-i-general: 1`, por lo que CPF/MCH quedan forzados a una categoría prácticamente vacía.

### Impacto

La herramienta especializada `ibmi_docs_explain_message` no tiene una ruta realista para mensajes CPF/MCH. Esto degrada diagnósticos de joblog, una de las razones fuertes para usar el MCP.

### Corrección propuesta

- Crear categoría o estrategia específica para mensajes IBM i generales:
  - `mensajes-cpf`;
  - `mensajes-mch`;
  - `joblog-messages`;
  - o búsqueda sin categoría si el corpus aún no tiene clasificación granular.
- Añadir expansión semántica para `CPF`, `MCH`, `QCPFMSG`, `joblog`, `second-level text`.
- Si no hay entrada exacta, devolver solo checklist y advertencia; no mezclar evidencia de otras familias.

### Validación sugerida

`ibmi_docs_explain_message({ messageId: "CPF0001" })` debe:

- buscar fuera de `ibm-i-general` si está vacío;
- o devolver `evidence=[]` sin permitir respuesta base irrelevante.

---

## BUG-015 - `resolve` puede reportar confianza alta aunque falte evidencia requerida

**Área:** `src/repository/CorpusRepository.ts` / cálculo de confianza.
**Severidad:** Alta.

### Evidencia

En `resolve`, la confianza final usa principalmente `answerResult?.confidence` o score general:

- `src/repository/CorpusRepository.ts:995`:

```ts
confidence: answerResult?.confidence ?? (evidence[0]?.score >= 60 ? "alta" : evidence.length >= 2 ? "media" : "baja")
```

No hay compuerta por intención. En el caso real `CPF0001`:

- `intent=message_diagnostic`;
- `messageExplanation.evidence=[]`;
- aun así `confidence="alta"` por evidencia base irrelevante.

### Impacto

La confianza deja de representar si el workflow obligatorio obtuvo la evidencia requerida. Para un agente, esto es peligroso: una respuesta con `alta` parece lista para usarse, aunque la parte diagnóstica no encontró nada.

### Corrección propuesta

- Crear `computeResolveConfidence(intent, evidence, answerResult, messageExplanation, compileGuidance, versionComparison, warnings)`.
- Para `message_diagnostic`, exigir:
  - mensaje exacto encontrado; o
  - evidencia de familia + advertencia clara.
- Si `messageExplanation.evidence.length === 0`, máximo `baja`.
- Agregar `missingRequiredEvidence` en `structuredContent`.

### Validación sugerida

`resolve("CPF0001")` debe devolver `confidence="baja"` si no hay evidencia exacta.

---

## BUG-016 - `selectAnswerEvidence` puede elegir evidencia no relacionada cuando faltan términos exactos

**Área:** `src/repository/CorpusRepository.ts` / selección de evidencia.
**Severidad:** Alta.

### Evidencia

`selectAnswerEvidence` filtra según `exactTerms`, pero si no hay exact terms acepta casi todo:

- `src/repository/CorpusRepository.ts:1338-1347`.
- Línea clave: `if (!exactTerms.length) return true`.
- Fallback: si el filtro queda vacío, retorna el primer no-landing.

Debido al BUG-013, `CPF0001` no produce exactTerms. Por eso la respuesta base puede tomar resultados ILE COBOL.

### Impacto

La respuesta extractiva puede citar documentos que solo coinciden por ruido semántico o tokens genéricos. El caso CPF0001 lo confirma con `IBM Extensions`, `Simple Insertion Editing` y `Compiler-Directing Statements`.

### Corrección propuesta

- Pasar `intent` a `answer` o permitir modo estricto desde `resolve`.
- Para mensajes, comandos, opcodes y BIFs, si no hay término exacto reconocido, no generar respuesta base con documentos genéricos.
- Separar:
  - `primaryEvidence`;
  - `supportingEvidence`;
  - `rejectedEvidence`.
- Si solo hay evidencia rechazada, responder con advertencia y sugerir `report-query`.

### Validación sugerida

Test de regresión:

```powershell
node dist\src\cli.js resolve "Diagnostica CPF0001 en joblog IBM i" --limit 4
```

No debe incluir `ILE COBOL` como evidencia primaria.

---

## BUG-017 - Detector de comandos IBM i omite prefijos comunes como `SBM*`, `CPY*`, `RTV*`

**Área:** `src/repository/CorpusRepository.ts` / reconocimiento de comandos.
**Severidad:** Alta.

### Evidencia

`isCommandOrOpcodeTerm` y `isLikelyIbmCommandQuery` usan una allowlist corta de prefijos:

- `src/repository/CorpusRepository.ts:1782`.
- `src/repository/CorpusRepository.ts:1787-1788`.

Prefijos actuales:

```text
add, chg, crt, dlt, dsp, end, mon, ovr, rcv, rmv, rst, sav, snd, str, wrk
```

Faltan prefijos IBM i/CL muy comunes:

```text
sbm, cpy, rtv, go, run, call, grt, rev, wrk? ya está, chg? sí, dmp, prt, dsp? sí
```

Comportamiento real:

```powershell
node dist\src\cli.js search "SBMJOB command" --limit 5
```

Top resultados observados:

- `IBM i commands`;
- `CL command finder`;
- `Using the Call Program command...`;
- no aparece una página exacta de `SBMJOB`.

### Impacto

Consultas de comandos perfectamente normales no activan ranking exact-topic ni autoread correcto. Esto reduce muchísimo la utilidad para usuarios CL/5250.

### Corrección propuesta

- Extraer diccionario real de comandos desde el corpus (`CL command finder`, páginas `Description of the ... command`, títulos `XXX Command`).
- Usar patrón contextual:
  - token uppercase 3-10 letras + palabra `command`;
  - o token incluido en diccionario.
- Mantener allowlist solo como fallback.

### Validación sugerida

Golden tests:

- `SBMJOB command`;
- `CPYF command`;
- `RTVJOBA command`;
- `WRKACTJOB command`;
- `CHGJOB command`.

---

## BUG-018 - `normalizeLanguage` devuelve texto crudo para valores desconocidos

**Área:** `src/repository/CorpusRepository.ts` / recomendaciones de siguiente tool.
**Severidad:** Media.

### Evidencia

`normalizeLanguage` termina con:

- `src/repository/CorpusRepository.ts:1809-1817`:

```ts
return value || undefined;
```

Comportamiento real con `SBMJOB command`:

```json
"nextRecommendedArguments": {
  "language": "SBMJOB COMMAND",
  "limit": 5
}
```

### Impacto

El agente recibe una recomendación inválida para `ibmi_docs_compile_guidance`, como si `SBMJOB COMMAND` fuera un lenguaje. Esto genera workflows torpes y respuestas menos útiles.

### Corrección propuesta

- `normalizeLanguage` debe devolver solo presets conocidos: `SQLRPGLE`, `RPGLE`, `CLLE`, `DDS`, `COBOL`.
- Para desconocidos, devolver `undefined`.
- `buildNextToolRecommendation` debe inferir `CLLE` para comandos CL, o no enviar `language` si no hay preset.

### Validación sugerida

`search "SBMJOB command"` debe recomendar:

```json
"arguments": { "language": "CLLE" }
```

o no incluir `language`.

---

## BUG-019 - `qualityReport.ok` es demasiado permisivo

**Área:** `src/repository/CorpusRepository.ts` / quality gate.
**Severidad:** Media.

### Evidencia

`qualityReport` define `ok` así:

- `src/repository/CorpusRepository.ts:706-708`:

```ts
ok: pack.ok && shortDocuments.length < 100
```

Resultado real:

```powershell
node dist\src\cli.js quality-report
```

Muestra:

- `ok=true`;
- `documentKinds.stub=103`;
- `sparseCategories` contiene `ibm-i-general` con `count=1`;
- `duplicateCanonicalTopics` incluye claves con cientos de duplicados;
- `shortDocuments` incluye `Examples: DDS` con 123 caracteres en varias versiones.

### Impacto

Un maintainer o CI puede interpretar `ok=true` como “corpus sano”, aunque el reporte contiene señales serias de mala cobertura o mala deduplicación.

### Corrección propuesta

Agregar criterios configurables:

- fallar si una categoría crítica tiene menos de N documentos (`ibm-i-general`, `cl-clle`, `ile-rpg`, `dds`, `sql-db2-for-i`, `mensajes-rnf`);
- fallar o advertir fuerte si `stub` supera umbral;
- fallar si duplicados canónicos exceden umbral;
- fallar si una versión cae demasiado frente a media/mediana de cobertura;
- exponer `severity` por issue.

### Validación sugerida

Con el corpus actual, `quality-report.ok` debería ser `false` o `warning`, no `true` plano.

---

## BUG-020 - CLI no tiene paridad con varias tools MCP públicas

**Área:** `src/cli.ts` y `src/server.ts` / experiencia de usuario y testing.
**Severidad:** Baja.

### Evidencia

`src/server.ts` registra tools públicas como:

- `ibmi_docs_context` (`src/server.ts:141-158`);
- `ibmi_docs_compile_guidance` (`src/server.ts:160-179`);
- `ibmi_docs_explain_message` (`src/server.ts:181-193`);
- `ibmi_docs_related` (`src/server.ts:195-207`);
- `ibmi_docs_compare_versions` (`src/server.ts:209-226`);
- `ibmi_docs_validate_code_context` (`src/server.ts:248-260`).

El `--help` del CLI no muestra comandos directos equivalentes para esas tools; sí expone `search`, `read`, `sections`, `answer`, `resolve`, `explain-ranking`, `report-query`, `quality-report`, `trace-report`, etc.

### Impacto

La CLI no sirve como harness completo para reproducir todas las tools MCP. Eso dificulta:

- pruebas manuales;
- reportes de bugs;
- documentación de ejemplos;
- adopción por usuarios que quieren probar sin cliente MCP.

### Corrección propuesta

Agregar comandos CLI:

```text
ibmi-docs context <task>
ibmi-docs compile-guidance --language SQLRPGLE --uses-copybook
ibmi-docs explain-message CPF0001
ibmi-docs related <id>
ibmi-docs compare-versions <query> --versions 7.3,7.4,7.5,7.6
ibmi-docs validate-code-context --language RPGLE --code-file fuente.rpgle
```

Cada comando debe llamar al mismo método de `CorpusRepository` usado por el servidor MCP.

### Validación sugerida

`node dist\src\cli.js --help` debe listar los comandos anteriores y los tests CLI deben cubrir al menos un happy path por comando.

---

## Orden recomendado de implementación

| Prioridad | Bugs | Motivo |
| --- | --- | --- |
| P0 | BUG-013, BUG-014, BUG-015, BUG-016, BUG-017 | Evitan respuestas con evidencia incorrecta o confianza engañosa. |
| P1 | BUG-003, BUG-004, BUG-005, BUG-006, BUG-007, BUG-008 | Endurecen instalación/distribución del data pack. |
| P1 | BUG-010, BUG-011, BUG-012, BUG-019 | Mejoran calidad del corpus y previenen duplicados/ranking malo. |
| P2 | BUG-001, BUG-002, BUG-009, BUG-018, BUG-020 | Mejoran DX, diagnósticos, estabilidad y reproducibilidad. |

## Propuesta de paquete de trabajo inicial

Para avanzar con bajo riesgo, sugiero implementar primero un PR enfocado en mensajes/comandos y confianza:

1. BUG-013: reconocer CPF/MCH como términos exactos.
2. BUG-014: mejorar `explainMessage` para CPF/MCH.
3. BUG-015: compuertas de confianza por intención.
4. BUG-016: evidencia estricta para mensajes/comandos.
5. BUG-017 y BUG-018: detector de comandos + `normalizeLanguage` seguro.
6. Tests golden para `CPF0001`, `CPF9898`, `MCH3601`, `SBMJOB`, `CPYF`, `RTVJOBA`.

Ese PR atacaría el problema más grave observado: el MCP puede sonar convincente mientras cita COBOL para un CPF. El AS/400 ya sobrevivió décadas; no merece que lo diagnostiquemos con una ouija de snippets.
