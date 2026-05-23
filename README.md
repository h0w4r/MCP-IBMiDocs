# MCP IBM i Docs

MCP comunitario para consultar documentación IBM i / AS400 localmente. Se basa en documentación oficial de IBM y sus herramientas de desarrollo.

## Qué incluye

- Servidor MCP TypeScript por stdio.
- Corpus local versionado como **data pack** (`manifest.json`, `raw/`, `normalized/`, `ibmi-docs.sqlite`).
- Índice SQLite FTS5 con ranking heurístico para comandos, mensajes, DDS, SQLRPGLE, CLLE y RPGLE.
- CLI `ibmi-docs` para diagnóstico, búsqueda, lectura, validación e instalación de data packs.
- Tests golden de recuperación documental en `tests/fixtures/golden-queries.json`.
- Herramientas MCP:
  - `ibmi_docs_resolve` — orquestador recomendado para preguntas normales de agentes.
  - `ibmi_docs_answer` — respuesta extractiva con citas.
  - `ibmi_docs_context` — contexto compacto para tareas de desarrollo/revisión.
  - `ibmi_docs_compile_guidance` — comandos y evidencia de compilación.
  - `ibmi_docs_explain_message` — diagnóstico de mensajes como `RNF0004`.
  - `ibmi_docs_compare_versions` — comparación documental entre releases IBM i.
  - `ibmi_docs_validate_code_context` — revisión documental de snippets RPGLE/SQLRPGLE/CL/DDS.
  - `ibmi_docs_search` — descubrimiento de candidatos; no es la respuesta final.
  - `ibmi_docs_read` — lectura completa del tópico.
  - `ibmi_docs_sections` — extracción de sintaxis, parámetros, ejemplos, notas y mensajes.
  - `ibmi_docs_related` — tópicos equivalentes o relacionados.
  - `ibmi_docs_explain_ranking` — auditoría de ranking.
  - `ibmi_docs_quality_report` — calidad/cobertura del corpus.
  - `ibmi_docs_recipes` — recetas de uso sugeridas.
  - `ibmi_docs_categories`
  - `ibmi_docs_pack_diagnostics`
  - `ibmi_docs_diagnostics`
  - `ibmi_docs_trace_report`
  - `ibmi_docs_sync`

## Por qué usar este MCP

Los modelos generalistas suelen conocer IBM i de forma irregular: recuerdan conceptos, pero pueden mezclar versiones, comandos, parámetros, mensajes RNF, DDS y detalles de compilación. Este MCP agrega una capa de contraste documental local para que el agente consulte evidencia antes de responder o modificar código.

En castellano simple: menos “creo que era así” y más “esto aparece en el corpus IBM i que tengo indexado”. El mainframe ya es suficientemente dramático; no necesita alucinaciones actuando de consultor senior.

### Flujo recomendado para agentes

Para preguntas normales, el punto de entrada debe ser `ibmi_docs_resolve`. Esa tool clasifica la intención, busca candidatos, lee los tópicos fuertes, extrae secciones útiles y sugiere el siguiente paso. `ibmi_docs_search` queda como herramienta de bajo nivel para depurar ranking o explorar candidatos, no como respuesta final.

| Intención detectada | Tool principal | Complementos esperados |
| --- | --- | --- |
| Explicar un tópico IBM i | `ibmi_docs_resolve` o `ibmi_docs_answer` | `ibmi_docs_read` para auditar la cita completa. |
| Sintaxis de comando/opcode/BIF | `ibmi_docs_resolve` | `ibmi_docs_sections` para parámetros, sintaxis y ejemplos. |
| Guía de compilación RPGLE/SQLRPGLE/CLLE | `ibmi_docs_resolve` | `ibmi_docs_context`, `ibmi_docs_compile_guidance`. |
| Mensajes RNF/SQL/CPF | `ibmi_docs_resolve` | `ibmi_docs_explain_message`, `ibmi_docs_read`. |
| Revisión de código | `ibmi_docs_resolve` con `code` | `ibmi_docs_validate_code_context`, `ibmi_docs_compile_guidance`. |
| Diferencias por release | `ibmi_docs_resolve` | `ibmi_docs_compare_versions`, `ibmi_docs_read`. |
| Ranking extraño | `ibmi_docs_explain_ranking` | `ibmi_docs_search` con `includeSections=true`. |

Regla práctica: si el agente usa `ibmi_docs_search`, debe continuar con `ibmi_docs_read` y, cuando aplique, `ibmi_docs_sections` antes de responder. Search-only es útil para diagnóstico, pero como respuesta final es básicamente “te traje el índice, suerte con el dragón”.

### Antes y después

| Situación | Sin MCP | Con MCP IBM i Docs |
| --- | --- | --- |
| Crear un módulo RPGLE | El agente puede recordar `CRTRPGMOD`, pero omitir opciones relevantes o mezclarlo con `CRTBNDRPG`. | Consulta `CRTRPGMOD Command`, recupera versiones IBM i disponibles y puede justificar la recomendación con tópicos del corpus. |
| Revisar un programa SQLRPGLE | Puede sugerir compilar como RPGLE normal aunque exista `EXEC SQL`. | Detecta SQL embebido y orienta hacia `CRTSQLRPGI`, `RPGPPOPT`, copybooks y opciones a revisar. |
| Explicar `RNF0004` | Puede dar una explicación genérica del error. | Busca la familia documental `RPG Messages` y devuelve evidencia trazable. |
| Trabajar con DDS PF/LF | Puede confundir PF, LF, keywords o ejemplos de DDS. | Prioriza documentación de DDS para archivos físicos/lógicos y keywords como `UNIQUE`. |
| Responder diferencias por versión | Puede asumir que IBM i 7.3, 7.4, 7.5 y 7.6 son iguales. | Usa `ibmi_docs_compare_versions` para contrastar tópicos entre versiones disponibles. |
| Preparar contexto para un agente | El prompt queda largo y frágil. | `ibmi_docs_context` empaqueta intención, lenguaje, comandos, riesgos y documentos recomendados. |

### Ejemplos de prompts útiles para agentes

Estos ejemplos están pensados para Codex u otros clientes MCP. La idea es que el agente use automáticamente las tools del MCP antes de responder:

```text
Estoy creando un programa SQLRPGLE con EXEC SQL y /COPY.
Contrasta la guía de compilación contra IBM i Docs antes de proponer el comando.
```

Tools esperadas:

- `ibmi_docs_resolve`
- `ibmi_docs_context`
- `ibmi_docs_compile_guidance`
- `ibmi_docs_validate_code_context` si el prompt incluye código

Resultado esperado: recomendación enfocada en `CRTSQLRPGI`, opciones a revisar como `RPGPPOPT`, evidencia documental y advertencias sobre copybooks/precompilador.

```text
Tengo el mensaje RNF0004 en un listado RPGLE.
Explícalo y dame una checklist de recuperación basada en documentación.
```

Tools esperadas:

- `ibmi_docs_resolve`
- `ibmi_docs_explain_message`
- `ibmi_docs_read`

Resultado esperado: explicación trazable contra `RPG Messages`, pasos para revisar severidad, línea de listado, causa probable y documentación relacionada.

```text
Necesito definir un PF con DDS y claves únicas.
Busca la documentación sobre DDS PF y UNIQUE antes de generar el fuente.
```

Tools esperadas:

- `ibmi_docs_resolve`
- `ibmi_docs_sections`
- `ibmi_docs_context`
- `ibmi_docs_related`

Resultado esperado: recuperación de `Defining a physical file using DDS` y `UNIQUE (Unique) keyword for physical and logical files`, con menos magia negra y más fuente verificable.

### Ejemplos desde la CLI local

La CLI permite probar el corpus sin conectar ningún cliente MCP:

```powershell
node dist/src/cli.js resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --version 7.6 --examples
node dist/src/cli.js search "CRTRPGMOD" --category ile-rpg --limit 2
node dist/src/cli.js search "RNF0004" --category mensajes-rnf --limit 2
node dist/src/cli.js search "DDS UNIQUE physical logical file" --category dds --limit 2
node dist/src/cli.js read ibm-740-commands-crtrpgmod-command-bd55c5ef
node dist/src/cli.js trace-report
node dist/src/cli.js doctor
```

Ejemplos de documentos que debería recuperar el pack actual:

- `CRTRPGMOD Command`
- `RPG Messages`
- `UNIQUE (Unique) keyword for physical and logical files`
- `Defining a physical file using DDS`

### Ideas para contribuir

Este proyecto mejora muchísimo con aportes pequeños y verificables:

| Aporte | Dónde tocar | Cómo validar |
| --- | --- | --- |
| Mejorar ranking de una consulta | `src/repository/CorpusRepository.ts` | Agrega un caso en `tests/fixtures/golden-queries.json` y ejecuta `npm test`. |
| Añadir una categoría IBM i | Ingesta/corpus + tipos en `src/types.ts` | Reconstruye el pack y revisa `node dist/src/cli.js diagnostics`. |
| Reportar resultado flojo | Issue template `ranking.yml` | Incluye query, resultado esperado, resultado actual y versión del corpus. |
| Mejorar documentación | `README.md`, `docs/` | `git diff --check` y lectura manual. |
| Validar instalación en otro entorno | `docs/DATA_PACKS.md`, `README.md` | Ejecuta `node dist/src/cli.js doctor` y comparte salida saneada. |

Si ves una respuesta pobre para `CLLE`, `DDS`, `SQLRPGLE`, `RNFxxxx`, COBOL o comandos IBM i, abre un issue. Un buen caso de prueba vale más que veinte opiniones y tres cafés quemados.

## Fuentes IBM públicas complementarias

El complemento de IBM Docs se obtiene desde endpoints públicos de IBM Docs:

- <https://www.ibm.com/docs/en/i/7.6.0>
- <https://www.ibm.com/docs/en/i/7.5.0>
- <https://www.ibm.com/docs/en/i/7.4.0>
- <https://www.ibm.com/docs/en/i/7.3.0>

El crawler usa APIs públicas de IBM Docs para obtener contenido documental real, no solo el shell web.

## Instalación recomendada desde GitHub

Estado actual: la instalación soportada es desde el repositorio GitHub. Todavía no hay paquete publicado en npm ni release asset público del data pack, así que no uses comandos `npm install -g` con este paquete hasta que el README indique una publicación verificable.

El servidor final no depende de RDi, Eclipse Help ni del endpoint temporal local usado durante el bootstrap documental. El repositorio incluye `data/pack` para que puedas usar el MCP desde una máquina limpia.

### Prerrequisitos

- Git.
- Node.js 22.x recomendado. El CI del proyecto se valida con Node.js 22 en Windows.
- npm incluido con Node.js.
- Codex, Claude Desktop u otro cliente MCP si quieres conectarlo como servidor MCP.

### Instalación en Windows PowerShell

Usa una carpeta definitiva, no temporal, porque esa ruta quedará referenciada por tu cliente MCP.

```powershell
git clone https://github.com/h0w4r/MCP-IBMiDocs.git D:\MCP-IBMiDocs
cd D:\MCP-IBMiDocs
npm ci
npm run build
npm run pack:validate
npm run bench:golden
npm run smoke
node dist/src/cli.js doctor
```

### Instalación en macOS/Linux

```bash
git clone https://github.com/h0w4r/MCP-IBMiDocs.git ~/MCP-IBMiDocs
cd ~/MCP-IBMiDocs
npm ci
npm run build
npm run pack:validate
npm run bench:golden
npm run smoke
node dist/src/cli.js doctor
```

### Qué valida esta instalación

- `npm ci`: instala dependencias exactamente desde `package-lock.json`, igual que el CI.
- `npm run build`: compila TypeScript en `dist/`.
- `npm run pack:validate`: verifica que `data/pack` tenga `manifest.json`, normalizados e índice SQLite.
- `npm run smoke`: prueba búsquedas clave como `CRTRPGMOD`, `RNF0004`, `CLLE`, `DDS PF` y `SQLRPGLE`.
- `node dist/src/cli.js doctor`: confirma resolución del pack, conteos y diagnóstico del runtime.

### Ejecutar el servidor MCP manualmente

```powershell
node dist/src/server.js
```

El servidor usa stdio. Es normal que el proceso quede esperando mensajes del cliente MCP y no abra una URL web.

### CLI local opcional

Puedes usar la CLI sin instalar nada global:

```powershell
node dist/src/cli.js search "CRTRPGMOD" --category ile-rpg --limit 3
node dist/src/cli.js doctor
```

Si quieres exponer los binarios `ibmi-docs` e `ibmi-docs-mcp` durante desarrollo local:

```powershell
npm link
ibmi-docs doctor
ibmi-docs search "RNF0004" --limit 3
```

## Estado de distribución

Actualmente este proyecto está disponible desde el repositorio GitHub:

- <https://github.com/h0w4r/MCP-IBMiDocs>

Todavía **no** hay paquete publicado en npm ni release asset público versionado para el data pack. Cuando exista una publicación en npm o un release de GitHub, esta sección se actualizará con el nombre, versión y URL verificables.

La estrategia preparada para distribución futura es:

- publicar el código/CLI como paquete npm;
- publicar el data pack como release asset independiente;
- evitar que el paquete npm incluya `data/pack` o `ibmi-docs.sqlite` directamente.

Mientras tanto, usa la instalación desde GitHub descrita arriba.

## Actualización de una instalación existente

### Si instalaste desde este repo

Esta es la ruta de actualización válida mientras el proyecto no esté publicado en npm:

```powershell
cd D:\MCP-IBMiDocs
git status --short
git pull --ff-only
npm ci
npm run build
npm run pack:validate
npm run bench:golden
npm run smoke
node dist/src/cli.js doctor
```

Notas:

- Si `git status --short` muestra cambios locales tuyos, guárdalos con commit o `git stash` antes de hacer `git pull`.
- Si Codex apunta a `D:\MCP-IBMiDocs\dist\src\server.js` y `D:\MCP-IBMiDocs\data\pack`, normalmente no necesitas cambiar `config.toml`; solo reinicia la sesión de Codex después de actualizar.
- Si moviste el servidor o el data pack a otra ruta, regenera el bloque de configuración:

```powershell
node dist/src/cli.js codex-config --pack D:\MCP-IBMiDocs\data\pack --server D:\MCP-IBMiDocs\dist\src\server.js --cwd D:\MCP-IBMiDocs
```

- Si usas el binario local con `npm link`, puedes refrescar el enlace después de actualizar:

```powershell
npm link
ibmi-docs doctor
```

### Si usas un data pack copiado a otra carpeta

Si tu runtime usa una ruta externa mediante `IBMI_DOCS_PACK_DIR`, actualiza también ese pack:

```powershell
cd D:\MCP-IBMiDocs
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
node dist/src/cli.js pack install --from D:\MCP-IBMiDocs\dist\ibmi-docs-pack.tgz --out <ruta-del-pack-en-uso>
node dist/src/cli.js validate-pack --pack <ruta-del-pack-en-uso>
```

Sustituye `<ruta-del-pack-en-uso>` por la ruta real configurada en `IBMI_DOCS_PACK_DIR`.

### Cuando exista publicación npm/release

Esta opción todavía no aplica porque no hay paquete npm ni release asset público. Cuando existan, usa únicamente el nombre de paquete y la URL publicados en este README o en la página de releases del proyecto. El flujo esperado será:

```powershell
npm update -g <nombre-publicado-en-npm>
<binario-publicado> pack install --from <url-verificada-del-release-asset>
<binario-publicado> doctor
```

## Data pack local

Puedes crear un archive local del pack y reinstalarlo en otra ruta:

```powershell
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
node dist/src/cli.js pack install --from D:\MCP-IBMiDocs\dist\ibmi-docs-pack.tgz --out D:\MCP-IBMiDocs\data\pack
```

Resolución del pack en runtime:

1. `IBMI_DOCS_PACK_DIR`
2. `data/pack` relativo al `cwd`
3. `~/.ibmi-docs/pack`
4. pack empaquetado junto al servidor, si existiera

## Instalación en Codex como MCP local

Primero completa la instalación desde GitHub y confirma que `node dist/src/cli.js doctor` funciona.

Genera el bloque TOML con rutas absolutas:

```powershell
node dist/src/cli.js codex-config --pack D:\MCP-IBMiDocs\data\pack --server D:\MCP-IBMiDocs\dist\src\server.js --cwd D:\MCP-IBMiDocs
```

Copia el bloque generado en `C:\Users\<usuario>\.codex\config.toml`. Ejemplo para Windows:

```toml
[mcp_servers.ibmi-docs]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\MCP-IBMiDocs\dist\src\server.js']
cwd = 'D:\MCP-IBMiDocs'
startup_timeout_sec = 30.0
tool_timeout_sec = 120.0

[mcp_servers.ibmi-docs.env]
IBMI_DOCS_PACK_DIR = 'D:\MCP-IBMiDocs\data\pack'
```

Después de editar `config.toml`, reinicia la sesión de Codex y valida con:

```powershell
codex mcp list
```

También puedes hacer una prueba rápida desde el chat preguntando algo como:

```text
Usa el MCP IBM i Docs para buscar CRTRPGMOD y resume cuándo usarlo.
```

## CLI útil

Desde el repo, usa la CLI con Node:

```powershell
node dist/src/cli.js diagnostics
node dist/src/cli.js resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --version 7.6 --examples --limit 3
node dist/src/cli.js resolve "Diagnostica RNF0004 en una compilación RPGLE" --language RPGLE --limit 3
node dist/src/cli.js resolve "Compara CRTRPGMOD entre IBM i 7.3, 7.4, 7.5 y 7.6" --limit 4
node dist/src/cli.js search "CRTRPGMOD" --category ile-rpg --limit 5 --mode hybrid
node dist/src/cli.js search "SND-MSG %MSG %TARGET" --category ile-rpg --auto-read --sections
node dist/src/cli.js answer "Explica SND-MSG, %MSG y %TARGET" --language RPGLE --examples
node dist/src/cli.js explain-ranking "SND-MSG Send a Message to the Joblog" --category ile-rpg
node dist/src/cli.js trace-report
node dist/src/cli.js sections rdi-b314bc2569c3d305
node dist/src/cli.js read ibm-730-commands-crtrpgmod-command-7d3ce327
node dist/src/cli.js quality-report
node dist/src/cli.js recipes
node dist/src/cli.js validate-pack
node dist/src/cli.js doctor
node dist/src/cli.js setup --pack data/pack --print-codex
node dist/src/cli.js pack verify --pack data/pack
node dist/src/cli.js pack list --root "$env:USERPROFILE\.ibmi-docs"
node dist/src/cli.js pack lint-contribution --input .\mi-corpus
node dist/src/cli.js pack archive --pack data/pack --out dist/ibmi-docs-pack.tgz
```

Si quieres usar el binario `ibmi-docs` localmente durante desarrollo, enlaza el paquete desde este repo:

```powershell
npm link
ibmi-docs doctor
```


## Capacidades agénticas avanzadas

La versión actual no se limita a FTS plano. Incluye una capa híbrida local para mejorar respuestas de agentes sin depender de red ni embeddings externos:

- búsqueda FTS5 + expansión semántica local por dominio IBM i;
- `ibmi_docs_resolve` como orquestador agéntico para elegir search/read/sections/context/compile/message/compare;
- `autoRead` para adjuntar contenido completo cuando el resultado es fuerte;
- extracción de secciones (`syntax`, `parameters`, `examples`, `notes`, `messages`, etc.);
- taxonomía fina: comandos, RPG opcodes, RPG BIFs, mensajes, DDS keywords, SQL/Db2 for i, APIs y guías de lenguaje;
- `ibmi_docs_answer` para respuestas extractivas con citas;
- `ibmi_docs_trace_report` para medir search-only, search→read y uso de answer/resolve cuando activas trazas locales;
- `ibmi_docs_explain_ranking` para auditar por qué ganó un resultado;
- `ibmi_docs_quality_report` para revisar cobertura, duplicados y tópicos cortos;
- benchmark ampliado con más de 100 queries doradas (`npm run bench:golden`).

Ejemplo rápido:

```powershell
node dist/src/cli.js resolve "Cómo envío un mensaje al joblog desde RPG usando SND-MSG" --language RPGLE --version 7.6 --examples
node dist/src/cli.js answer "Cómo envío un mensaje al joblog desde RPG usando SND-MSG" --language RPGLE --examples
node dist/src/cli.js explain-ranking "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET" --category ile-rpg
$env:IBMI_DOCS_TRACE = "1"; node dist/src/cli.js resolve "Diagnostica RNF0004" --language RPGLE; node dist/src/cli.js trace-report
npm run bench:golden
```

### Trazas locales opcionales

El runtime no envía telemetría. Si quieres diagnosticar cómo está usando el agente las tools, activa trazas locales:

```powershell
$env:IBMI_DOCS_TRACE = "1"
$env:IBMI_DOCS_TRACE_FILE = "D:\MCP-IBMiDocs\data\ibmi-docs-trace.ndjson"
node dist/src/cli.js resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --version 7.6
node dist/src/cli.js trace-report --limit 30
```

`ibmi_docs_trace_report` resume `search_only_rate`, `search_then_read_rate`, `answer_usage_rate`, eventos recientes y uso por tool. Las tasas son una aproximación por ventana local; sirven para detectar agentes que se quedan en `search` sin leer evidencia completa.

## Desarrollo del corpus

> Dirigido a quienes deseen colaborar en este proyecto. No es necesario para usuarios finales.

Sincronización desde IBM Docs público:

```powershell
npx tsx src/cli.ts sync-ibm --out data/ibm-docs-cache --versions "7.3.0,7.4.0,7.5.0,7.6.0" --max-pages-per-version 260 --concurrency 8
```

Construcción del data pack:

```powershell
npm run build:pack
npm run pack:validate
npm run bench:golden
```

Crear release asset:

```powershell
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
```

## Validación

```powershell
npm run build
npm test
npm run smoke
npm run pack:validate
npm run bench:golden
npm pack --dry-run
```

El smoke valida búsquedas y contexto base:

- `CRTRPGMOD`
- `RNF0004`
- `CLLE`
- `DDS PF`
- `SQLRPGLE`
- contexto/compilación SQLRPGLE
- relacionados por versión

## Sync runtime

`ibmi_docs_sync` está deshabilitado por defecto. Si se habilita con `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`, solo consulta IBM Docs público y reconstruye el data pack local. Nunca usa RDi local ni Eclipse Help.

## Documentación adicional

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/AGENT_WORKFLOWS.md`](docs/AGENT_WORKFLOWS.md)
- [`docs/DATA_PACKS.md`](docs/DATA_PACKS.md)
- [`docs/RECIPES.md`](docs/RECIPES.md)
- [`docs/CORPUS_CONTRIBUTION.md`](docs/CORPUS_CONTRIBUTION.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SECURITY.md`](SECURITY.md)
- [`NOTICE.md`](NOTICE.md)

## Aviso legal y marcas

Este proyecto es comunitario e independiente. No está afiliado, patrocinado, aprobado ni mantenido por IBM.

IBM, IBM i, AS/400, Rational Developer for i, RDi, Db2 y otros nombres de productos o servicios de IBM mencionados en este repositorio pueden ser marcas comerciales o marcas registradas de International Business Machines Corporation en Estados Unidos y/o en otros países. Este proyecto usa esos nombres únicamente como referencias técnicas nominativas para identificar tecnologías, documentación y compatibilidad. No se usan logotipos de IBM ni se pretende sugerir respaldo oficial.

La documentación, publicaciones, páginas, textos, ejemplos y metadatos provenientes de IBM o de IBM Documentation pertenecen a sus respectivos titulares y se rigen por los términos aplicables de IBM, incluyendo:

- <https://www.ibm.com/legal/terms>
- <https://www.ibm.com/legal/copyright-trademark>
- <https://www.ibm.com/docs>

La licencia de este repositorio cubre únicamente el código fuente, scripts, configuración y documentación original del proyecto. No otorga derechos sobre contenido, marcas, publicaciones o materiales de IBM ni de terceros. El corpus documental incluido o generado conserva atribución y metadatos de fuente para facilitar trazabilidad técnica.

Si eres titular de derechos y consideras que algún material debe corregirse, atribuirse de otra forma o retirarse, abre un issue en el repositorio para revisarlo.

## Licencia

El código original de este proyecto se publica bajo licencia ISC. Consulta [`LICENSE`](LICENSE).

El aviso legal y las atribuciones de terceros están documentados en [`NOTICE.md`](NOTICE.md).
