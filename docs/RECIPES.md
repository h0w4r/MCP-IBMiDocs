# Recetas de uso para MCP IBM i Docs

Estas recetas están pensadas para agentes en Codex, VS Code u otros clientes MCP. La idea es que el agente no use el corpus como un simple buscador, sino como evidencia técnica para responder, corregir y comparar.

## 1. Diagnosticar RNF

Prompt sugerido:

```text
Usa IBM i Docs para explicar RNF0004, causa probable, mensajes relacionados y checklist de recuperación.
```

Tools recomendadas:

1. `ibmi_docs_explain_message`
2. `ibmi_docs_read`
3. `ibmi_docs_answer`

## 2. Crear o revisar SQLRPGLE

```text
Necesito un programa SQLRPGLE con EXEC SQL y /COPY. Contrasta comandos y opciones contra documentación IBM i.
```

Tools:

- `ibmi_docs_answer`
- `ibmi_docs_compile_guidance`
- `ibmi_docs_validate_code_context`

Resultado esperado: guía con `CRTSQLRPGI`, `RPGPPOPT`, `COMMIT`, `DBGVIEW` y evidencia trazable.

## 3. Entender opcodes modernos RPG

```text
Explica SND-MSG, %MSG y %TARGET con sintaxis, operandos, notas y ejemplos.
```

Tools:

- `ibmi_docs_search` con `includeSections=true`
- `ibmi_docs_sections`
- `ibmi_docs_answer`
- `ibmi_docs_explain_ranking` si el ranking sorprende

## 4. Comparar releases IBM i

```text
Compara CRTRPGMOD entre IBM i 7.3, 7.4, 7.5 y 7.6.
```

Tool principal: `ibmi_docs_compare_versions`.

La comparación incluye disponibilidad por versión, longitud del tópico, secciones detectadas y notas estructurales.

## 5. Revisar calidad del corpus

```powershell
ibmi-docs quality-report
ibmi-docs pack verify --pack data/pack
npm run bench:golden
```

Estos comandos ayudan a detectar tópicos cortos, duplicados, cobertura débil y regresiones de búsqueda.
