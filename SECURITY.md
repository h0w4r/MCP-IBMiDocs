# Política de seguridad

## Reportar problemas

Abre un issue privado o público en GitHub con:

- versión del paquete
- versión del data pack
- sistema operativo
- pasos de reproducción
- logs relevantes sin secretos

## Alcance

Este proyecto es un MCP documental local. Los reportes de seguridad útiles incluyen:

- ejecución inesperada de comandos
- lectura fuera del data pack configurado
- exposición de rutas o secretos locales
- bypass de la política anti-RDi runtime
- vulnerabilidades de dependencias
- corrupción de data packs

## Política runtime

El runtime público no debe requerir ni consultar:

- RDi instalado
- Eclipse Help activo
- endpoints locales privados de Eclipse/RDi Help usados solo para bootstrap
- endpoints locales de bootstrap

`ibmi_docs_sync` solo puede consultar IBM Docs público cuando se habilita explícitamente con `IBMI_DOCS_ALLOW_NETWORK_SYNC=1`.
