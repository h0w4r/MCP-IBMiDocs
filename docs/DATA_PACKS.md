# Data packs IBM i Docs

El paquete npm del MCP no incluye `data/pack`. El corpus se distribuye como release asset para mantener el paquete ligero y permitir actualizaciones independientes.

## Crear release asset

```powershell
npm run build:pack
npm run pack:validate
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
```

## Instalar data pack desde release asset

```powershell
ibmi-docs pack install --from https://github.com/h0w4r/MCP-IBMiDocs/releases/download/v0.2.0/ibmi-docs-pack.tgz
```

Destino por defecto:

```text
~/.ibmi-docs/pack
```

También puedes usar un directorio explícito:

```powershell
ibmi-docs pack install --from .\dist\ibmi-docs-pack.tgz --out D:\MCP-IBMiDocs\data\pack
```

## Resolución runtime

El servidor busca el pack en este orden:

1. `IBMI_DOCS_PACK_DIR`
2. `data/pack` relativo al `cwd`
3. `~/.ibmi-docs/pack`
4. `data/pack` empaquetado junto al servidor, si existiera

## Integridad

```powershell
ibmi-docs validate-pack
ibmi-docs doctor
```
