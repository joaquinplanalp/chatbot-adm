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
- WhatsApp Cloud API: app "CHATBOT ADM" en Meta for Developers, en modo desarrollo con un número de prueba de Meta.
  El token es permanente (usuario del sistema `chatbot-adm` del portfolio comercial "Manuel Jose Lorenzo & Asociados").
  - El número de prueba original dejó de existir en WhatsApp (noviembre 2026). El 13/11/2026 se pidió uno nuevo:
    **+1 555 141 9741**, Phone Number ID `1469735912892139` (ya cargado en Render). Se le dio a `chatbot-adm`
    control total sobre su cuenta de WhatsApp (`1408692508012459`).
  - Ese número nuevo **todavía no aparece en WhatsApp** (el celular ofrece "Invitar"; Meta mostró un error al
    registrarlo y el Graph API Explorer responde "This API is not supported for this WhatsApp Business Account").
  - El portfolio también tiene la línea de la administración **+54 9 223 598-8977** (cuenta "Adm Lorenzo"),
    en estado "No verificado". Esa línea se usa con clientes reales: no conectarla al bot sin planificarlo con Joaquín.
- Reclamos: Google Sheets, una hoja por consorcio, con cuenta de servicio.
- Panel: PostgreSQL en Neon (plan gratuito, proyecto "my-first-project", región AWS US East 2, Ohio).

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
| `DATABASE_URL` | Configurada | Connection string de PostgreSQL (Neon). Sin ella el bot anda igual y el panel queda desactivado. |
| `PANEL_INITIAL_PASSWORD` | Configurada | Contraseña provisoria de los usuarios iniciales (mínimo 8 caracteres). Solo se usa si la tabla de usuarios está vacía. |
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

## Estado al 13/11/2026

Hecho y probado con WhatsApp real (con el número de prueba anterior): flujo del bot, validación de consorcios,
Google Sheets, consulta de estado, token permanente.

Subido a `main` y desplegado en Render con la base de Neon: todo el panel. Joaquín entró como supervisor.
Se probó con un chat simulado enviado al webhook (número inventado `5490000000001`, ya borrado de la base):
llega a "Sin asignar", se toma, se escribe y se resuelve. El saludo y las respuestas fallan por ser un número
inventado, y el panel lo muestra bien.

Arreglo del 13/11: si falla el envío de la respuesta del bot, la derivación al panel se hace igual
(antes el chat se perdía).

**Falta probar con WhatsApp real**: el número de prueba nuevo todavía no está activo en WhatsApp.

## Próximos pasos, en orden

1. Ver si el número de prueba nuevo ya está activo (`wa.me/15551419741` desde el celular de Joaquín). Si sigue sin
   andar, evaluar con Joaquín un chip nuevo para el número definitivo.
2. Probar con WhatsApp real: opción 3, asignación, saludo, respuesta desde el panel, resolver, y `0`.
   Revisar el parche del 15 (ver Pendientes): la lista de prueba nueva guardó a Joaquín como `542235814901`, sin 15.
3. Que Micaela, Belén y Bautista entren al panel y cambien la contraseña provisoria.
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
