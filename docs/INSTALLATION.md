# Instalación y operación

Guía práctica para instalar, actualizar, configurar y eliminar MCP IBM i Docs.

## Paquete npm

El runtime público está en:

```powershell
npm install -g @ckirsch94/ibmi-docs-mcp@latest
```

Esto instala dos binarios:

- `ibmi-docs`: CLI para diagnóstico, búsqueda y validación.
- `ibmi-docs-mcp`: servidor MCP por stdio.

El paquete npm **no** incluye `data/pack` ni `ibmi-docs.sqlite`.

El servidor MCP público no expone tools de mantenimiento por defecto. La sincronización de IBM Docs
queda para operación explícita por CLI o para un servidor arrancado deliberadamente con
`IBMI_DOCS_ALLOW_NETWORK_SYNC=1`.

## Instalación recomendada

### Windows PowerShell

```powershell
npm install -g @ckirsch94/ibmi-docs-mcp@latest
git clone https://github.com/h0w4r/MCP-IBMiDocs.git D:\MCP-IBMiDocs
$env:IBMI_DOCS_PACK_DIR = 'D:\MCP-IBMiDocs\data\pack'
ibmi-docs doctor
ibmi-docs validate-pack
ibmi-docs assist "Explica CRTRPGMOD y cuándo conviene frente a CRTBNDRPG" --language RPGLE --ibmi-version 7.5
```

### macOS/Linux

```bash
npm install -g @ckirsch94/ibmi-docs-mcp@latest
git clone https://github.com/h0w4r/MCP-IBMiDocs.git ~/MCP-IBMiDocs
export IBMI_DOCS_PACK_DIR="$HOME/MCP-IBMiDocs/data/pack"
ibmi-docs doctor
ibmi-docs validate-pack
ibmi-docs assist "Explica CRTRPGMOD y cuándo conviene frente a CRTBNDRPG" --language RPGLE --ibmi-version 7.5
```

## Instalar una versión específica

```powershell
npm view @ckirsch94/ibmi-docs-mcp versions
npm install -g @ckirsch94/ibmi-docs-mcp@<version-publicada>
```

## Configurar Codex

### Instalación npm global

Windows:

```powershell
(Get-Command ibmi-docs-mcp.cmd).Source
```

Ejemplo para `C:\Users\<usuario>\.codex\config.toml`:

```toml
[mcp_servers.ibmi-docs]
command = 'C:\Users\<usuario>\AppData\Roaming\npm\ibmi-docs-mcp.cmd'
args = []
cwd = 'D:\MCP-IBMiDocs'
startup_timeout_sec = 30.0
tool_timeout_sec = 120.0

[mcp_servers.ibmi-docs.env]
IBMI_DOCS_PACK_DIR = 'D:\MCP-IBMiDocs\data\pack'
```

macOS/Linux:

```bash
command -v ibmi-docs-mcp
```

Usa esa ruta absoluta como `command` y apunta `IBMI_DOCS_PACK_DIR` al data pack.

### Instalación desde fuente

Si trabajas desde el repo, también puedes generar un bloque TOML:

```powershell
node dist/src/cli.js codex-config --pack D:\MCP-IBMiDocs\data\pack --server D:\MCP-IBMiDocs\dist\src\server.js --cwd D:\MCP-IBMiDocs
```

## Actualizar

### Runtime npm

```powershell
npm outdated -g @ckirsch94/ibmi-docs-mcp
npm install -g @ckirsch94/ibmi-docs-mcp@latest
ibmi-docs --version
ibmi-docs doctor
```

Actualizar npm cambia el servidor/CLI, no el corpus documental.

> `ibmi-docs --version` muestra la versión del CLI. Para filtrar documentación por release IBM i usa `--ibmi-version` o `--release`, por ejemplo `ibmi-docs search "CRTRPGMOD" --ibmi-version 7.6`.

### Repo/data pack incluido

```powershell
cd D:\MCP-IBMiDocs
git status --short
git pull --ff-only
npm ci
npm run build
npm run pack:validate
npm run smoke
node dist/src/cli.js doctor
```

Si tienes cambios locales, haz commit o `git stash` antes de `git pull`.

### Data pack copiado a otra carpeta

```powershell
cd D:\MCP-IBMiDocs
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
node dist/src/cli.js pack install --from D:\MCP-IBMiDocs\dist\ibmi-docs-pack.tgz --out <ruta-del-pack-en-uso>
node dist/src/cli.js validate-pack --pack <ruta-del-pack-en-uso>
```

### Data pack desde release asset

El comando existe para cuando el proyecto publique un release asset `ibmi-docs-pack.tgz` o cuando tú definas una URL autorizada:

```powershell
$env:IBMI_DOCS_PACK_LATEST_URL = 'https://tu-host/ibmi-docs-pack.tgz'
ibmi-docs pack update --out <ruta-del-pack-en-uso>
ibmi-docs pack verify --pack <ruta-del-pack-en-uso>
```

Si no defines `IBMI_DOCS_PACK_LATEST_URL`, el CLI intentará usar el release público más reciente de GitHub. Si ese asset aún no existe, usa el flujo local con `pack archive` + `pack install --from`.

## Desinstalar

### Paquete npm

1. Quita el bloque `mcp_servers.ibmi-docs` de tu cliente MCP.
2. Desinstala el paquete global:

```powershell
npm uninstall -g @ckirsch94/ibmi-docs-mcp
```

3. Verifica:

```powershell
Get-Command ibmi-docs -ErrorAction SilentlyContinue
Get-Command ibmi-docs-mcp -ErrorAction SilentlyContinue
```

macOS/Linux:

```bash
command -v ibmi-docs || true
command -v ibmi-docs-mcp || true
```

### Data pack o repo local

Solo si ya no lo necesitas:

```powershell
Remove-Item -LiteralPath 'D:\MCP-IBMiDocs' -Recurse -Force
```

No borres el data pack si lo compartes con otra instalación o quieres conservar el corpus offline.

## Desarrollo desde fuente

```powershell
git clone https://github.com/h0w4r/MCP-IBMiDocs.git D:\MCP-IBMiDocs
cd D:\MCP-IBMiDocs
npm ci
npm run build
npm run test
npm run pack:validate
npm run smoke
node dist/src/cli.js doctor
```

## Mantenimiento del corpus

Estos comandos son para mantenedores del proyecto o para usuarios avanzados que construyen su propio
data pack. No son parte del flujo normal de un agente MCP:

```powershell
node dist/src/cli.js sync-ibm --out data/ibm-docs-cache
node dist/src/cli.js build-pack --input data --out data/pack
node dist/src/cli.js pack archive --pack data/pack --out dist/ibmi-docs-pack.tgz
```

Si realmente necesitas exponer sincronización como tool MCP, arranca el servidor con:

```powershell
$env:IBMI_DOCS_ALLOW_NETWORK_SYNC = '1'
ibmi-docs-mcp
```

Sin esa variable, `ibmi_docs_sync` no existe para el agente. Esto evita que un cliente confunda una
acción de mantenimiento con una consulta documental normal.

## Comandos útiles

```powershell
ibmi-docs doctor
ibmi-docs diagnostics
ibmi-docs assist "Corregir CLLE con RTVJOBA y MONMSG; necesito pasos y validación" --language CLLE --ibmi-version 7.5 --depth deep
ibmi-docs resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --ibmi-version 7.6 --examples
ibmi-docs resolve "Diagnostica RNF0004 en una compilación RPGLE" --language RPGLE
ibmi-docs resolve "Compara CRTRPGMOD entre IBM i 7.3 y 7.6"
ibmi-docs search "DDS UNIQUE physical logical file" --category dds --limit 3
ibmi-docs report-query "SND-MSG Send a Message to the Joblog" --category ile-rpg --expected-title "SND-MSG" --out snd-msg-ranking.md
ibmi-docs validate-pack
```
