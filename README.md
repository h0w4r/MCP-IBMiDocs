# MCP IBM i Docs

MCP comunitario para que agentes de IA consulten documentación IBM i / AS400 desde un corpus local antes de responder sobre RPGLE, SQLRPGLE, CLLE, DDS, comandos, mensajes y Db2 for i.

La idea es simple: menos “creo que era así” y más “lo contrasté contra documentación IBM i indexada”. El AS/400 ya trae suficiente mística; no hace falta añadirle alucinaciones con corbata.

## Qué problema resuelve

Los modelos generalistas suelen recordar IBM i de forma irregular: mezclan releases, comandos, parámetros de compilación, mensajes RNF o detalles de DDS. Este MCP agrega una capa local de evidencia documental para que el agente pueda buscar, leer y citar contexto antes de ayudarte.

Sirve para:

- explicar comandos como `CRTRPGMOD`, `CRTSQLRPGI` o `SND-MSG`;
- revisar código RPGLE, SQLRPGLE, CLLE o DDS;
- diagnosticar mensajes como `RNF0004`;
- comparar documentación entre IBM i 7.3, 7.4, 7.5 y 7.6;
- preparar contexto compacto para Codex u otros clientes MCP.

## Lo importante en 30 segundos

- **No necesitas RDi instalado** para usar el MCP.
- **No usa Eclipse Help en runtime**.
- **No depende de endpoints locales de RDi** ni de servicios temporales de bootstrap.
- El paquete npm instala el servidor y la CLI.
- El corpus documental vive en un **data pack local** con SQLite FTS5.
- Por ahora, el data pack público disponible está en este repositorio bajo `data/pack`.

## Instalación rápida

Prerrequisito: Node.js 22.x recomendado.

### 1. Instala el runtime desde npm

```powershell
npm install -g @ckirsch94/ibmi-docs-mcp@latest
ibmi-docs --version
```

### 2. Obtén el data pack

El paquete npm no incluye el corpus pesado. Para empezar, clona el repo y usa el pack incluido:

```powershell
git clone https://github.com/h0w4r/MCP-IBMiDocs.git D:\MCP-IBMiDocs
```

En macOS/Linux puedes usar `~/MCP-IBMiDocs`.

### 3. Valida que todo funciona

```powershell
$env:IBMI_DOCS_PACK_DIR = 'D:\MCP-IBMiDocs\data\pack'
ibmi-docs doctor
ibmi-docs search "CRTRPGMOD" --category ile-rpg --limit 3
```

Si `doctor` muestra `Sin RDi, sin Eclipse Help, sin endpoint local de RDi`, vas bien.

Más opciones: [instalación, actualización y desinstalación](docs/INSTALLATION.md).

## Configuración rápida en Codex

Primero ubica el binario global:

```powershell
(Get-Command ibmi-docs-mcp.cmd).Source
```

Ejemplo de `C:\Users\<usuario>\.codex\config.toml`:

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

Reinicia Codex y prueba algo como:

```text
Usa IBM i Docs para explicar CRTRPGMOD y cuándo conviene frente a CRTBNDRPG.
```

## Ejemplos de uso

### En un agente MCP

```text
Estoy creando un programa SQLRPGLE con EXEC SQL y /COPY.
Contrasta la guía de compilación contra IBM i Docs antes de proponer el comando.
```

```text
Tengo RNF0004 en un listado RPGLE. Explícalo y dame una checklist de revisión.
```

```text
Necesito un PF DDS con claves únicas. Busca la documentación de DDS PF y UNIQUE antes de generar el fuente.
```

### Desde la CLI

```powershell
ibmi-docs resolve "Cómo compilo SQLRPGLE con EXEC SQL" --language SQLRPGLE --examples
ibmi-docs answer "Explica SND-MSG, %MSG y %TARGET" --language RPGLE --examples
ibmi-docs search "RNF0004" --category mensajes-rnf --limit 3
ibmi-docs doctor
```

## Herramientas MCP principales

| Tool | Para qué usarla |
| --- | --- |
| `ibmi_docs_resolve` | Punto de entrada recomendado para preguntas normales. Clasifica intención, busca, lee y sugiere siguientes pasos. |
| `ibmi_docs_answer` | Respuestas extractivas con citas. |
| `ibmi_docs_context` | Contexto compacto para desarrollo o revisión de código. |
| `ibmi_docs_compile_guidance` | Evidencia y comandos de compilación. |
| `ibmi_docs_explain_message` | Diagnóstico de mensajes como `RNF0004`. |
| `ibmi_docs_compare_versions` | Comparación entre releases IBM i. |
| `ibmi_docs_search` / `ibmi_docs_read` / `ibmi_docs_sections` | Búsqueda, lectura completa y extracción de secciones. |

Regla práctica para agentes: empieza por `ibmi_docs_resolve`. Si usas `ibmi_docs_search`, normalmente continúa con `ibmi_docs_read` antes de responder. Search-only como respuesta final es “te traje el índice, suerte con el dragón”.

## Qué incluye el proyecto

- Servidor MCP TypeScript por stdio.
- CLI `ibmi-docs`.
- Corpus local versionado como data pack (`manifest.json`, `raw/`, `normalized/`, `ibmi-docs.sqlite`).
- Índice SQLite FTS5 con ranking para comandos, mensajes, DDS, SQLRPGLE, CLLE y RPGLE.
- Tests golden de recuperación documental.
- Workflows de CI para build, tests, smoke, validación de pack y verificación anti dependencia RDi.

## Data pack y fuentes

El data pack combina:

- export inicial desde ayuda local de RDi, usado solo como bootstrap de desarrollo;
- IBM Docs público para IBM i 7.3, 7.4, 7.5 y 7.6.

Fuentes IBM públicas complementarias:

- <https://www.ibm.com/docs/en/i/7.6.0>
- <https://www.ibm.com/docs/en/i/7.5.0>
- <https://www.ibm.com/docs/en/i/7.4.0>
- <https://www.ibm.com/docs/en/i/7.3.0>

Detalles del corpus: [docs/DATA_PACKS.md](docs/DATA_PACKS.md).

## Contribuir

Los aportes más útiles suelen ser pequeños y comprobables:

- una query que rankea mal;
- un caso golden nuevo;
- una mejora de README/docs;
- una categoría documental faltante;
- una receta para RPGLE, SQLRPGLE, CLLE, DDS o Db2 for i.

Para cambios técnicos:

```powershell
npm ci
npm run build
npm run test
npm run pack:validate
npm run smoke
```

Guías útiles:

- [Workflows agénticos](docs/AGENT_WORKFLOWS.md)
- [Recetas de uso](docs/RECIPES.md)
- [Arquitectura](docs/ARCHITECTURE.md)
- [Contribución de corpus](docs/CORPUS_CONTRIBUTION.md)

## Distribución

- npm: <https://www.npmjs.com/package/@ckirsch94/ibmi-docs-mcp>
- GitHub: <https://github.com/h0w4r/MCP-IBMiDocs>

El paquete npm publica el runtime MCP/CLI. El data pack se mantiene separado para no inflar el paquete ni mezclar runtime con corpus pesado.

## Aviso legal y marcas

Este proyecto es comunitario y no oficial. IBM, IBM i, AS/400, Rational Developer for i, RDi y otros nombres relacionados son marcas o denominaciones de IBM o sus respectivos titulares.

El proyecto no está afiliado, patrocinado ni respaldado por IBM. El contenido documental se usa con fines de interoperabilidad, referencia técnica, investigación, aprendizaje y asistencia al desarrollo. Si eres titular de derechos y consideras que algún material debe ajustarse o retirarse, abre un issue para revisarlo.

## Licencia

ISC. Consulta [LICENSE](LICENSE).
