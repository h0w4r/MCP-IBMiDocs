# MCP IBM i Docs

MCP comunitario para consultar documentación IBM i / AS400 localmente. El runtime es independiente de RDi, Eclipse Help y endpoints locales.

## Qué incluye

- Servidor MCP TypeScript por stdio.
- Corpus local versionado como **data pack** (`manifest.json`, `raw/`, `normalized/`, `ibmi-docs.sqlite`).
- Índice SQLite FTS5 con ranking heurístico para comandos, mensajes, DDS, SQLRPGLE, CLLE y RPGLE.
- CLI `ibmi-docs` para diagnóstico, búsqueda, lectura, validación e instalación de data packs.
- Tests golden de recuperación documental en `tests/fixtures/golden-queries.json`.
- Herramientas MCP:
  - `ibmi_docs_search`
  - `ibmi_docs_read`
  - `ibmi_docs_context`
  - `ibmi_docs_compile_guidance`
  - `ibmi_docs_explain_message`
  - `ibmi_docs_related`
  - `ibmi_docs_compare_versions`
  - `ibmi_docs_validate_code_context`
  - `ibmi_docs_categories`
  - `ibmi_docs_pack_diagnostics`
  - `ibmi_docs_diagnostics`
  - `ibmi_docs_sync`

## Fuentes IBM públicas complementarias

El complemento de IBM Docs se obtiene desde endpoints públicos de IBM Docs:

- <https://www.ibm.com/docs/en/i/7.6.0>
- <https://www.ibm.com/docs/en/i/7.5.0>
- <https://www.ibm.com/docs/en/i/7.4.0>
- <https://www.ibm.com/docs/en/i/7.3.0>

El crawler usa APIs públicas de IBM Docs para obtener contenido documental real, no solo el shell web.

## Instalación y ejecución local desde repo

```powershell
git clone https://github.com/h0w4r/MCP-IBMiDocs.git D:\MCP-IBMiDocs
cd D:\MCP-IBMiDocs
npm install
npm run build
npm run smoke
node dist/src/server.js
```

El repositorio mantiene `data/pack` para desarrollo/smoke local. El paquete npm, en cambio, no incluye el data pack: se instala como release asset independiente.

## Instalación como paquete + data pack

```powershell
npm install -g @chriskirsch/ibmi-docs-mcp
ibmi-docs pack install --from https://github.com/h0w4r/MCP-IBMiDocs/releases/download/v0.2.0/ibmi-docs-pack.tgz
ibmi-docs doctor
```

También puedes instalar un pack local:

```powershell
ibmi-docs pack install --from D:\MCP-IBMiDocs\dist\ibmi-docs-pack.tgz --out D:\MCP-IBMiDocs\data\pack
```

Resolución del pack en runtime:

1. `IBMI_DOCS_PACK_DIR`
2. `data/pack` relativo al `cwd`
3. `~/.ibmi-docs/pack`
4. pack empaquetado junto al servidor, si existiera

## Instalación en Codex como MCP local

Genera el bloque TOML:

```powershell
ibmi-docs codex-config --pack D:\MCP-IBMiDocs\data\pack --server D:\MCP-IBMiDocs\dist\src\server.js --cwd D:\MCP-IBMiDocs
```

Ejemplo de `C:\Users\<usuario>\.codex\config.toml`:

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

## CLI útil

```powershell
ibmi-docs diagnostics
ibmi-docs search "CRTRPGMOD" --category ile-rpg --limit 5
ibmi-docs read ibm-730-commands-crtrpgmod-command-7d3ce327
ibmi-docs validate-pack
ibmi-docs doctor
ibmi-docs pack archive --pack data/pack --out dist/ibmi-docs-pack.tgz
```

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
- [`docs/DATA_PACKS.md`](docs/DATA_PACKS.md)
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
