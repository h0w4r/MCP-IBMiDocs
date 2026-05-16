# MCP IBM i Docs

MCP comunitario para consultar documentación IBM i / AS400 desde un corpus local propio. El servidor final **no depende de RDi**, **no depende de Eclipse Help** y **no intenta conectarse a endpoints locales**.

## Qué incluye

- Servidor MCP TypeScript por stdio.
- Corpus local empaquetado en `data/pack`.
- Índice SQLite FTS5 en `data/pack/ibmi-docs.sqlite`.
- HTML original y texto normalizado del snapshot documental.
- Herramientas MCP:
  - `ibmi_docs_search`
  - `ibmi_docs_read`
  - `ibmi_docs_context`
  - `ibmi_docs_diagnostics`
  - `ibmi_docs_sync`

## Política sobre RDi

La ayuda local de RDi/Eclipse Help se usó solo como **fuente temporal de bootstrap durante la construcción del data pack**. En el paquete runtime:

- no se consulta RDi;
- no se arranca Eclipse Help;
- no se requiere `127.0.0.1:52070`;
- no se usa ese endpoint en `npm install`;
- no se usa en el primer arranque;
- no se usa en `ibmi_docs_sync`.

La fuente queda registrada como `rdi-help-bootstrap://local-export` para trazabilidad interna, no como URL ejecutable.

## Fuentes IBM públicas complementarias

El complemento de IBM Docs se obtiene desde endpoints públicos de IBM Docs:

- <https://www.ibm.com/docs/en/i/7.6.0>
- <https://www.ibm.com/docs/en/i/7.5.0>
- <https://www.ibm.com/docs/en/i/7.4.0>
- <https://www.ibm.com/docs/en/i/7.3.0>

El crawler usa `https://www.ibm.com/docs/api/v1/toc/...` y `https://www.ibm.com/docs/api/v1/content/...` para obtener contenido documental real, no solo el shell web de IBM Docs.

## Instalación y ejecución

```powershell
npm install
npm run build
node dist/src/server.js
```

También puedes apuntar a un data pack externo:

```powershell
$env:IBMI_DOCS_PACK_DIR = "D:\ruta\a\data\pack"
node dist/src/server.js
```

## Desarrollo del corpus

> Estos comandos son para mantenedores del proyecto. No son requisitos de usuarios finales.

Exportación interna desde una ayuda RDi disponible solo en la máquina de construcción:

```powershell
npx tsx src/cli.ts export-rdi --base-url http://127.0.0.1:52070/help --out data/rdi-export --max-topics 30000 --concurrency 10
```

Sincronización desde IBM Docs público:

```powershell
npx tsx src/cli.ts sync-ibm --out data/ibm-docs-cache --versions "7.3.0,7.4.0,7.5.0,7.6.0" --max-pages-per-version 260 --concurrency 8
```

Construcción del data pack:

```powershell
npx tsx src/cli.ts build-pack --input data --out data/pack
```

## Validación

```powershell
npm run build
npm test
npm run smoke
```

El smoke valida búsquedas base:

- `CRTRPGMOD`
- `RNF0004`
- `CLLE`
- `DDS PF`
- `SQLRPGLE`

## Sync runtime

`ibmi_docs_sync` está deshabilitado por defecto. Si se habilita con `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`, solo consulta IBM Docs público y reconstruye el data pack local. Nunca usa la exportación RDi ni endpoints locales.
