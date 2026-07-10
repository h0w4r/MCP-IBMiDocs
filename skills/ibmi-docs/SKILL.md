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

## No delegar sub-tools al usuario

Usa directamente el único bloque de texto devuelto por `ibmi_docs_assist`. No le
pidas al usuario ni al agente que llame manualmente `ibmi_docs_read`, `ibmi_docs_sections` o
`ibmi_docs_search`.

Las tools de bajo nivel solo son para auditoría o debugging si el operador activó un perfil avanzado.

El perfil normal no expone JSON, scores, IDs, planes, cobertura ni documentos leídos. Esos datos son
telemetría de mantenimiento y no deben solicitarse durante una tarea de usuario.

## No usar sync para responder

No llames `ibmi_docs_sync` para resolver una consulta de usuario. Sincronizar o reconstruir el corpus
es mantenimiento, no consulta documental. Si la tool no aparece, es correcto.

## Patrones recomendados

### Crear o corregir RPGLE/SQLRPGLE

Llama a `ibmi_docs_assist` con:

- `language`: `RPGLE` o `SQLRPGLE`.
- `code`: fuente si existe.

Luego usa la salida para proponer fuente, comandos de compilación y checklist de validación.

### Crear o corregir CLLE

Llama a `ibmi_docs_assist` con:

- `language`: `CLLE`.
- `code`: fuente si existe.

Revisa en la respuesta los comandos, parámetros, `MONMSG`, mensajes y validaciones sugeridas.

### Diseñar DDS o pantalla/reporte

Llama a `ibmi_docs_assist` con `language: DDS` y la tarea completa. Usa la respuesta final para no
inventar keywords, niveles de registro, claves, indicadores o restricciones.

### Comandos, trabajos, locks, objetos o administración

Llama a `ibmi_docs_assist` con el comando o necesidad completa. Si el usuario pregunta “cómo veo
trabajos activos” o “cómo reviso bloqueos”, la propia tool debe devolver la orientación documental
aplicable; no solicites una segunda llamada ni metadatos de recuperación.

Para administración IBM i, incluye los comandos o conceptos conocidos en la pregunta si están
disponibles: `WRKACTJOB`, `WRKOBJLCK`, `DSPJOB`, `WRKJOB`, joblog, objeto, miembro, biblioteca,
subsystem/job queue. El MCP expande estos términos y recupera tópicos procedurales aunque no exista
una página canónica perfecta por comando.

### Mensajes RNF/CPF/MCH/SQL

Llama a `ibmi_docs_assist` con el mensaje exacto y todo el contexto disponible.

## Cómo usar la salida

La salida pública ya es la respuesta final. Si indica que no encontró evidencia documental
suficientemente relacionada, no inventes sintaxis ni parámetros; comunica esa limitación y continúa
solo con otra fuente verificable.
