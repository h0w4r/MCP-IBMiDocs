# Data packs IBM i Docs

El repo incluye `data/pack` para desarrollo y uso local. El paquete npm `@ckirsch94/ibmi-docs-mcp` instala el runtime MCP/CLI y también incluye el `data/pack` oficial de la versión publicada.

El repositorio y los archives completos conservan `raw/` para trazabilidad. El
paquete npm de ejecución omite ese HTML original para reducir la descarga: el
MCP instalado trabaja con SQLite, `manifest.json` y el texto `normalized/`.

El objetivo es que `npm install -g @ckirsch94/ibmi-docs-mcp@latest` funcione en una máquina limpia sin clonar el repositorio y sin RDi. Los packs externos siguen soportados para organizaciones que quieran probar corpus propios o distribuir snapshots internos.

## Crear archive local del data pack

```powershell
npm run build:pack
npm run pack:validate
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
```

## Instalar data pack desde un archive local

```powershell
node dist/src/cli.js pack install --from .\dist\ibmi-docs-pack.tgz
```

Destino por defecto:

```text
~/.ibmi-docs/pack
```

También puedes usar un directorio explícito:

```powershell
node dist/src/cli.js pack install --from .\dist\ibmi-docs-pack.tgz --out D:\MCP-IBMiDocs\data\pack
```

## Actualizar el data pack incluido en npm

```powershell
npm install -g @ckirsch94/ibmi-docs-mcp@latest
ibmi-docs doctor
ibmi-docs validate-pack
```

Esto actualiza el runtime y el pack empaquetado con esa versión. También ejecuta el `postinstall`
para instalar localmente el Transformer E5 afinado, la cabeza neuronal query→corpus y el reranker
cross-encoder.

## Actualizar un data pack de repo clonado

Si usas el pack del propio repo (`D:\MCP-IBMiDocs\data\pack`), basta con actualizar el repositorio y validar:

```powershell
cd D:\MCP-IBMiDocs
git pull --ff-only
npm install
npm run build
npm run pack:validate
node dist/src/cli.js doctor
```

Si copiaste el pack a otra carpeta o configuraste `IBMI_DOCS_PACK_DIR`, vuelve a instalar el archive local sobre esa ruta:

```powershell
cd D:\MCP-IBMiDocs
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
node dist/src/cli.js pack install --from .\dist\ibmi-docs-pack.tgz --out <ruta-del-pack-en-uso>
node dist/src/cli.js validate-pack --pack <ruta-del-pack-en-uso>
```

Cuando exista un release asset público, esta sección se actualizará con la URL verificable. Hasta entonces, no uses URLs de releases inventadas.

## Resolución runtime

El servidor busca el pack en este orden:

1. `IBMI_DOCS_PACK_DIR`
2. `data/pack` relativo al `cwd`
3. `~/.ibmi-docs/pack`
4. `data/pack` empaquetado junto al servidor npm

## Integridad

```powershell
node dist/src/cli.js validate-pack
node dist/src/cli.js doctor
```
