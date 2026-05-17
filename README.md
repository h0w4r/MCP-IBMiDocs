# MCP IBM i Docs

MCP comunitario para consultar documentación IBM i / AS400 localmente. Sin depender de conexiones externas.

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

> Dirigido a quienes deseen colaborar en este proyecto, no es necesario para usuarios que solo quieran usar el MCP:

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

`ibmi_docs_sync` está deshabilitado por defecto. Si se habilita con `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`, solo consulta IBM Docs público y reconstruye el data pack local.

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
