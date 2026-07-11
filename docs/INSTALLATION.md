# Instalación y operación

Guía práctica para instalar, actualizar, configurar y eliminar MCP IBM i Docs.

## Paquete npm

El runtime público está en:

```powershell
npm install -g @ckirsch94/ibmi-docs-mcp@latest
```

Esto instala dos binarios y el data pack local de la versión publicada:

- `ibmi-docs`: CLI para diagnóstico, búsqueda y validación.
- `ibmi-docs-mcp`: servidor MCP por stdio.
- `data/pack`: corpus documental local con `manifest.json`, `raw/`, `normalized/` e `ibmi-docs.sqlite`.

Durante `postinstall` también se instalan en la caché local el bi-encoder E5-base afinado para IBM i,
la cabeza neuronal query→corpus y el reranker cross-encoder mMARCO MiniLM incluidos en el paquete. Después de instalar, las consultas
funcionan en modo local-only.

El banco de preguntas usado durante desarrollo no se instala ni se consulta en runtime. Solo viajan
los pesos ONNX cuantizados resultantes del fine-tuning y el corpus documental oficial.

El servidor MCP público arranca por defecto en perfil `agent`: expone una entrada principal
(`ibmi_docs_assist`) y oculta tools avanzadas o de mantenimiento para que el agente no se distraiga
con flujos internos. La sincronización de IBM Docs queda para operación explícita por CLI o para un
servidor arrancado deliberadamente con perfil avanzado y `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`.

## Instalación recomendada

### Windows PowerShell

```powershell
npm install -g @ckirsch94/ibmi-docs-mcp@latest
ibmi-docs doctor
ibmi-docs validate-pack
ibmi-docs assist "Explica CRTRPGMOD y cuándo conviene frente a CRTBNDRPG" --language RPGLE --ibmi-version 7.5
```

### macOS/Linux

```bash
npm install -g @ckirsch94/ibmi-docs-mcp@latest
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
startup_timeout_sec = 30.0
tool_timeout_sec = 120.0

[mcp_servers.ibmi-docs.env]
IBMI_DOCS_TOOL_PROFILE = 'agent'
```

macOS/Linux:

```bash
command -v ibmi-docs-mcp
```

Usa esa ruta absoluta como `command`. No declares `IBMI_DOCS_PACK_DIR` salvo que quieras usar un pack externo o corporativo distinto al incluido en npm.

## Perfiles de tools MCP

`IBMI_DOCS_TOOL_PROFILE` controla qué herramientas ve el agente:

| Perfil | Uso recomendado | Tools visibles |
| --- | --- | --- |
| `agent` | Usuario final y agentes genéricos. Es el valor por defecto. | Solo `ibmi_docs_assist`; devuelve únicamente la respuesta final. |
| `standard` | Agentes o clientes que sí entienden tools documentales especializadas. | `agent` + `resolve`, `answer`, `context`, `compile_guidance`, `explain_message`, `compare_versions`, `validate_code_context`. |
| `full` | Mantenedores, debugging de recuperación semántica y auditoría manual. | Todas las tools documentales de lectura, búsqueda, recuperación, reportes y trazas. |
| `maintainer` | Igual que `full`; reservado para operación avanzada del proyecto. | Todas las tools disponibles para mantenimiento. |

Recomendación: deja `agent` para uso diario. Si activas `full`, el agente vuelve a ver herramientas
de bajo nivel como `ibmi_docs_search`, `ibmi_docs_read` e `ibmi_docs_sections`; eso es útil para
debugging, pero puede empeorar la experiencia de agentes que no conocen la arquitectura del MCP.

### Instalación desde fuente

Si trabajas desde el repo, también puedes generar un bloque TOML:

```powershell
node dist/src/cli.js codex-config --pack D:\MCP-IBMiDocs\data\pack --server D:\MCP-IBMiDocs\dist\src\server.js --cwd D:\MCP-IBMiDocs
```

## Actualizar

### Instalación npm completa

```powershell
npm outdated -g @ckirsch94/ibmi-docs-mcp
npm install -g @ckirsch94/ibmi-docs-mcp@latest
ibmi-docs --version
ibmi-docs doctor
```

Actualizar npm cambia el servidor/CLI, el data pack incluido y prepara de nuevo los modelos locales de embeddings y reranking.

> `ibmi-docs --version` muestra la versión del CLI. Para filtrar documentación por release IBM i usa `--ibmi-version` o `--release`, por ejemplo `ibmi-docs search "CRTRPGMOD" --ibmi-version 7.6`.

### Desarrollo desde repo clonado

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

Este flujo es solo para colaboradores que trabajan desde código fuente. Si tienes cambios locales, haz commit o `git stash` antes de `git pull`.

### Data pack externo copiado a otra carpeta

```powershell
cd D:\MCP-IBMiDocs
npm run pack:archive -- data/pack dist/ibmi-docs-pack.tgz
node dist/src/cli.js pack install --from D:\MCP-IBMiDocs\dist\ibmi-docs-pack.tgz --out <ruta-del-pack-en-uso>
node dist/src/cli.js validate-pack --pack <ruta-del-pack-en-uso>
```

### Data pack desde release asset o URL autorizada

El comando existe para cuando el proyecto publique un release asset `ibmi-docs-pack.tgz` o cuando tú definas una URL autorizada:

```powershell
$env:IBMI_DOCS_PACK_LATEST_URL = 'https://tu-host/ibmi-docs-pack.tgz'
ibmi-docs pack update --out <ruta-del-pack-en-uso>
ibmi-docs pack verify --pack <ruta-del-pack-en-uso>
```

Si no defines `IBMI_DOCS_PACK_LATEST_URL`, el CLI intentará usar el release público más reciente de GitHub. Si ese asset no existe o tu organización usa un pack propio, usa el flujo local con `pack archive` + `pack install --from`.

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

### Data pack externo o repo local

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
$env:IBMI_DOCS_TOOL_PROFILE = 'full'
$env:IBMI_DOCS_ALLOW_NETWORK_SYNC = '1'
ibmi-docs-mcp
```

Sin ambas variables, `ibmi_docs_sync` no existe para el agente. Esto evita que un cliente confunda
una acción de mantenimiento con una consulta documental normal.

## Comandos útiles

```powershell
ibmi-docs doctor
ibmi-docs diagnostics
ibmi-docs assist "Corregir CLLE con RTVJOBA y MONMSG; necesito pasos y validación" --language CLLE --ibmi-version 7.5 --depth deep
ibmi-docs resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --ibmi-version 7.6 --examples
ibmi-docs resolve "Diagnostica RNF5393 en una compilación RPGLE" --language RPGLE
ibmi-docs resolve "Compara CRTRPGMOD entre IBM i 7.3 y 7.6"
ibmi-docs search "DDS UNIQUE physical logical file" --category dds --limit 3
ibmi-docs report-query "SND-MSG Send a Message to the Joblog" --category ile-rpg --expected-title "SND-MSG" --out snd-msg-ranking.md
ibmi-docs validate-pack
```
