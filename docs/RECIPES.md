# Recetas de uso para MCP IBM i Docs

Estas recetas están pensadas para agentes en Codex, VS Code u otros clientes MCP. La idea es que el agente no use el corpus como un simple buscador, sino como evidencia técnica para responder, corregir y comparar.

Regla base: **empieza con `ibmi_docs_resolve`**. Usa `ibmi_docs_search` solo para exploración o depuración de ranking y continúa con `ibmi_docs_read`/`ibmi_docs_sections` antes de responder.

## 1. Diagnosticar RNF

Prompt sugerido:

```text
Usa IBM i Docs para explicar RNF0004, causa probable, mensajes relacionados y checklist de recuperación.
```

Tools recomendadas:

1. `ibmi_docs_resolve`
2. `ibmi_docs_explain_message`
3. `ibmi_docs_read`

CLI:

```powershell
node dist/src/cli.js resolve "Diagnostica RNF0004 en una compilación RPGLE" --language RPGLE --limit 3
```

Resultado esperado: intención `message_diagnostic`, lectura del tópico `RPG Messages`, explicación del mensaje y checklist de recuperación.

## 2. Crear o revisar SQLRPGLE

```text
Necesito un programa SQLRPGLE con EXEC SQL y /COPY. Contrasta comandos y opciones contra documentación IBM i.
```

Tools:

- `ibmi_docs_resolve`
- `ibmi_docs_context`
- `ibmi_docs_compile_guidance`
- `ibmi_docs_validate_code_context` si hay snippet

CLI:

```powershell
node dist/src/cli.js resolve "Cómo compilo un SQLRPGLE con EXEC SQL y /COPY" --language SQLRPGLE --compile --limit 5
```

Resultado esperado: guía con `CRTSQLRPGI`, `RPGPPOPT`, `COMMIT`, `DBGVIEW`, riesgos de precompilador/includes y evidencia trazable.

## 3. Entender opcodes modernos RPG

```text
Explica SND-MSG, %MSG y %TARGET con sintaxis, operandos, notas y ejemplos.
```

Tools:

- `ibmi_docs_resolve`
- `ibmi_docs_sections`
- `ibmi_docs_read`
- `ibmi_docs_explain_ranking` si el ranking sorprende

CLI:

```powershell
node dist/src/cli.js resolve "Explica la sintaxis de SND-MSG con %MSG y %TARGET" --language RPGLE --ibmi-version 7.6 --examples
```

Resultado esperado: intención `syntax_lookup`, lectura automática de tópico fuerte, secciones `syntax`/`parameters`/`messages` y citas.

## 4. Comparar releases IBM i

```text
Compara CRTRPGMOD entre IBM i 7.3, 7.4, 7.5 y 7.6.
```

Tools:

- `ibmi_docs_resolve`
- `ibmi_docs_compare_versions`
- `ibmi_docs_read`

CLI:

```powershell
node dist/src/cli.js resolve "Compara CRTRPGMOD entre IBM i 7.3, 7.4, 7.5 y 7.6" --limit 4
```

La comparación incluye disponibilidad por versión, longitud del tópico, secciones detectadas y notas estructurales.

## 5. Depurar ranking

```text
El resultado para SND-MSG no parece el tópico principal. Explica por qué ganó ese ranking.
```

Tools:

- `ibmi_docs_explain_ranking`
- `ibmi_docs_search`
- `ibmi_docs_read` para auditar el candidato real

CLI:

```powershell
node dist/src/cli.js explain-ranking "SND-MSG Send a Message to the Joblog RPG operation code message-type %MSG %TARGET" --category ile-rpg
node dist/src/cli.js search "SND-MSG Send a Message to the Joblog" --category ile-rpg --sections --auto-read
```

## 6. Revisar calidad del corpus

```powershell
node dist/src/cli.js quality-report
node dist/src/cli.js validate-pack
npm run bench:golden
```

Estos comandos ayudan a detectar tópicos cortos, duplicados, cobertura débil y regresiones de búsqueda.

## 7. Medir comportamiento del agente

Activa trazas locales si quieres detectar si el cliente MCP se queda en search-only:

```powershell
$env:IBMI_DOCS_TRACE = "1"
$env:IBMI_DOCS_TRACE_FILE = "D:\MCP-IBMiDocs\data\ibmi-docs-trace.ndjson"
node dist/src/cli.js resolve "Explica SND-MSG con %MSG y %TARGET" --language RPGLE --ibmi-version 7.6
node dist/src/cli.js trace-report --limit 30
```

Métricas clave:

- `search_only_rate`
- `search_then_read_rate`
- `answer_usage_rate`
- uso por tool
- eventos recientes con duración y top result
