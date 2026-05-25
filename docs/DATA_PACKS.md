# Data packs IBM i Docs

El repo incluye `data/pack` para desarrollo y uso local. El paquete npm `@ckirsch94/ibmi-docs-mcp` instala el runtime MCP/CLI, pero no incluye `data/pack` ni `ibmi-docs.sqlite`.

La distribución separa runtime y corpus para mantener npm ligero y permitir actualizaciones independientes del data pack. Todavía no hay release asset público versionado para el data pack; por ahora, usa el pack incluido en este repositorio o uno autorizado por tu organización.

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

## Actualizar un data pack existente

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
4. `data/pack` empaquetado junto al servidor, si existiera

## Integridad

```powershell
node dist/src/cli.js validate-pack
node dist/src/cli.js doctor
```
