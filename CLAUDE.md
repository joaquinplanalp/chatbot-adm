# Chatbot ADM — Manuel José Lorenzo & Asociados

Bot de WhatsApp para una administración de consorcios de Mar del Plata. Recibe reclamos de propietarios,
informa su estado y deriva a una persona. Incluye un panel web para que el equipo atienda los chats derivados.

## Con quién trabajás

Joaquín administra el proyecto y no es programador. Hasta ahora subió cada cambio a mano desde la web de GitHub.
- Hablale en español rioplatense, sin jerga, con pasos concretos cuando tenga que hacer algo él (Meta, Render, Neon).
- Antes de armar algo con decisiones abiertas, preguntale. Lo pidió expresamente varias veces.
- No subas nada a `main` sin que lo confirme: Render despliega solo con cada commit y el bot está en uso de prueba.

## Dónde corre

- Repositorio: `github.com/joaquinplanalp/chatbot-adm` (rama `main`).
- Servidor: Render, plan gratuito, Node.js, `https://chatbot-adm.onrender.com`. Se duerme a los 15 minutos sin tráfico.
- WhatsApp Cloud API: app "CHATBOT ADM" en Meta for Developers, en modo desarrollo con el número de prueba de Meta.
  El token es permanente (usuario del sistema `chatbot-adm` del portfolio comercial).
- Reclamos: Google Sheets, una hoja por consorcio, con cuenta de servicio.
- Panel: PostgreSQL (pensado para Neon, plan gratuito). **Todavía no está creada la base.**

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.js` | Webhook de WhatsApp, flujo del bot, Google Sheets, envío de mensajes. Monta el panel. |
| `panel.js` | Panel de atención: esquema de la base, usuarios y sesiones, derivación, asignación, API en `/panel/api`. |
| `panel.html` | Pantalla del panel (un solo archivo, sin dependencias). Se sirve en `/panel`. |
| `consorcios.json` | Los 13 consorcios con sus unidades. Se generó desde un Excel de Joaquín. |
| `pruebas/` | Prueba de punta a punta con WhatsApp simulado. Ver `pruebas/LEEME.md`. |

## Variables de entorno (Render)

| Variable | Estado | Uso |
|---|---|---|
| `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN` | Configuradas | WhatsApp Cloud API |
| `GOOGLE_CREDENTIALS` | Configurada | JSON completo de la cuenta de servicio de Google |
| `DATABASE_URL` | **Falta** | Connection string de PostgreSQL. Sin ella el bot anda igual y el panel queda desactivado. |
| `PANEL_INITIAL_PASSWORD` | **Falta** | Contraseña provisoria de los usuarios iniciales (mínimo 8 caracteres). Solo se usa si la tabla de usuarios está vacía. |
| `GRAPH_API_BASE` | Solo pruebas | Reemplaza `https://graph.facebook.com/v25.0` para apuntar a la simulación. |

Nunca pongas credenciales en el repositorio ni en este archivo.

## Flujo del bot

1. Saludo y menú: 1 reclamo, 2 estado de un reclamo, 3 hablar con una persona.
2. Identificación: consorcio (por nombre o dirección; si hay varios que coinciden, repregunta), torre o cocheras
   (solo "9 de julio 5602-50"), unidad (se valida contra `consorcios.json`, tolerando mayúsculas, acentos, "local 1", "cochera 3").
3. Según la opción:
   - **Reclamo**: nombre, descripción, adjuntos opcionales, ticket y fila en Google Sheets con estado "Pendiente".
   - **Estado**: muestra los últimos 3 reclamos de la unidad leyendo la hoja. No pide nombre.
   - **Persona**: pide el nombre y deriva al panel.
4. En cualquier paso: `volver` retrocede uno y `0` reinicia.

Las sesiones del bot viven en memoria (`sesiones` en `index.js`) y se pierden cuando Render reinicia.

## Panel de atención

- Perfiles: **operador** (ve los chats sin asignar y los suyos) y **supervisor** (ve todo, asigna y reasigna,
  historial de resueltos, alta, edición y baja de usuarios).
- Usuarios iniciales: `micaela` y `belen` (operadoras), `joaquin` y `bautista` (supervisores). Entran con la
  contraseña provisoria y el panel los obliga a cambiarla.
- Asignación automática: al operador conectado (panel abierto, señal cada 4 s) con "Recibir chats automáticamente"
  activado; si hay varios, al que tenga menos chats abiertos. A los supervisores no se les asigna solo.
- Asignación manual: si no hay nadie disponible queda en "Sin asignar" y cualquiera lo toma.
- Al asignarse, el propietario recibe "Hola, soy <nombre>. ¿Cómo puedo ayudarte hoy?"; al reasignarse,
  "Hola, soy <nombre>. Sigo yo con tu consulta."
- Mientras el chat está derivado el bot no contesta. Se reanuda cuando alguien lo resuelve en el panel o cuando
  el propietario escribe `0`.
- Solo responde quien tiene el chat a su nombre; un supervisor tiene que asignárselo primero.
- Seguridad: contraseñas con scrypt, sesión por cookie HttpOnly de 12 horas, bloqueo tras 5 intentos fallidos,
  y la pantalla inserta todo texto de WhatsApp como texto plano.

## Estado al 12/11/2026

Hecho y probado con WhatsApp real: flujo del bot, validación de consorcios, Google Sheets, consulta de estado, token permanente.

Hecho y probado solo en local (base PostgreSQL local y API de WhatsApp simulada): todo el panel y la pausa del bot.
**No está subido al repositorio ni probado con Meta ni con Neon.**

## Próximos pasos, en orden

1. Comparar estos archivos con lo que hay en `main` (Joaquín pudo haber subido algo a mano) y subir
   `index.js`, `package.json`, `panel.js` y `panel.html`.
2. Guiar a Joaquín para crear la base en Neon y cargar `DATABASE_URL` y `PANEL_INITIAL_PASSWORD` en Render.
3. Probar con WhatsApp real: opción 3, asignación, saludo, respuesta desde el panel, resolver, y `0`.
4. Corregir el valor esperado en `pruebas/flujo-panel.js` (ver `pruebas/LEEME.md`).

## Pendientes conocidos

- **Pasar a producción**: falta un número dedicado y verificar el negocio en Meta. Hasta entonces solo pueden
  escribirle al bot los números cargados en la lista de prueba.
- **Parche del número de prueba**: `enviarMensaje` convierte `549AAANNNNNNN` en `54AAA15NNNNNNN` porque la lista de
  prueba de Meta guardó el número en ese formato. Asume códigos de área de 3 dígitos. Revisarlo o quitarlo al pasar a producción.
- **Ventana de 24 horas**: fuera de ella WhatsApp rechaza texto libre (error 131047). El panel lo avisa, pero no hay
  plantillas aprobadas para retomar el contacto.
- **Firma del webhook**: no se verifica `X-Hub-Signature-256`. Cualquiera que conozca la URL puede simular mensajes entrantes.
- **Sesiones del bot en memoria**: un reinicio de Render corta las conversaciones en curso con el bot. Las derivadas no se pierden.
- **Adjuntos de reclamos**: en la hoja solo queda la cantidad de archivos; no se guardan en Drive.
- **Avisos**: un chat nuevo solo aparece en el panel; no hay aviso por mail ni por WhatsApp (decisión de Joaquín).
- **Número de ticket**: es aleatorio de 5 dígitos, puede repetirse.
