---
name: ibmi-docs
description: Use when answering, planning, coding, debugging, reviewing, compiling or explaining anything related to IBM i/AS400, RPGLE, SQLRPGLE, CLLE, DDS, Db2 for i, 5250 commands, messages, jobs, objects or libraries.
---

# IBM i Docs MCP usage skill

## Objetivo

Usa el MCP `ibmi-docs` para contrastar respuestas IBM i contra el corpus documental local antes de
responder o modificar código. El MCP está diseñado para agentes: en el perfil normal la entrada
principal es `ibmi_docs_assist`.

## Regla principal

Para cualquier tarea IBM i/AS400, llama primero a `ibmi_docs_assist` con la tarea completa.

Incluye, cuando exista:

- `question`: lo que el usuario quiere lograr.
- `language`: `RPGLE`, `SQLRPGLE`, `CLLE`, `DDS`, `COBOL`, `Db2 for i` u otra tecnología IBM i.
- `version`: release IBM i objetivo si el usuario lo dio.
- `code`: código relevante para revisión o corrección.
- `depth`: `standard` por defecto; `deep` para bugs, compilación, migración o cambios delicados.
- `includeExamples`: `true` cuando el usuario pide sintaxis, comandos o fuente de ejemplo.
- `includeCompileCommands`: `true` cuando la tarea implique compilar, crear módulos/programas o SQL embebido.

## No delegar sub-tools al usuario

Si `ibmi_docs_assist` devuelve una respuesta autocontenida con evidencia, úsala directamente. No le
pidas al usuario ni al agente que llame manualmente `ibmi_docs_read`, `ibmi_docs_sections` o
`ibmi_docs_search`.

Las tools de bajo nivel solo son para auditoría o debugging si el operador activó un perfil avanzado.

## No usar sync para responder

No llames `ibmi_docs_sync` para resolver una consulta de usuario. Sincronizar o reconstruir el corpus
es mantenimiento, no consulta documental. Si la tool no aparece, es correcto.

## Patrones recomendados

### Crear o corregir RPGLE/SQLRPGLE

Llama a `ibmi_docs_assist` con:

- `language`: `RPGLE` o `SQLRPGLE`.
- `code`: fuente si existe.
- `depth`: `deep`.
- `includeCompileCommands`: `true`.

Luego usa la salida para proponer fuente, comandos de compilación y checklist de validación.

### Crear o corregir CLLE

Llama a `ibmi_docs_assist` con:

- `language`: `CLLE`.
- `code`: fuente si existe.
- `includeExamples`: `true`.

Revisa en la respuesta los comandos, parámetros, `MONMSG`, mensajes y validaciones sugeridas.

### Diseñar DDS o pantalla/reporte

Llama a `ibmi_docs_assist` con:

- `language`: `DDS`.
- `depth`: `deep`.
- `includeExamples`: `true`.

Usa la evidencia para no inventar keywords, niveles de registro, claves, indicadores o restricciones.

### Comandos, trabajos, locks, objetos o administración

Llama a `ibmi_docs_assist` con el comando o necesidad completa. Si el usuario pregunta “cómo veo
trabajos activos” o “cómo reviso bloqueos”, pide evidencia documental y pasos de validación.

### Mensajes RNF/CPF/MCH/SQL

Llama a `ibmi_docs_assist` con el mensaje exacto y el contexto. Pide `depth=deep` para bugs de
compilación o runtime.

## Cómo usar la salida

Prioriza:

1. `answer` / resumen final.
2. `implementationSteps`.
3. `validationChecklist`.
4. `specificFindings`.
5. `coverage.status` y `warnings`.
6. `citations`, `reads` y `sections` si necesitas auditar evidencia.

Si `coverage.status` es `thin`, no inventes sintaxis ni parámetros: explica la limitación y usa la
mejor alternativa verificable disponible.
