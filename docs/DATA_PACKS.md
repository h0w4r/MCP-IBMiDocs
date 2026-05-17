# Data packs IBM i Docs

Actualmente el repo incluye `data/pack` para desarrollo y uso local. Todavía no hay paquete npm ni release asset público del data pack.

La estrategia de distribución preparada para futuras publicaciones es que el paquete npm no incluya `data/pack` y que el corpus se publique como release asset independiente para mantener el paquete ligero y permitir actualizaciones separadas.

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
