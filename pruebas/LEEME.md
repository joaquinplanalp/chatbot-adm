# Pruebas del panel

Prueban el flujo completo (ingreso, derivación, asignación, respuesta, resolución, permisos, usuarios)
contra una base PostgreSQL local y una API de WhatsApp simulada. No tocan Meta ni la base real.

1. Tener un PostgreSQL local con una base **vacía** (las pruebas esperan los usuarios iniciales sin usar).
2. En una terminal: `node pruebas/api-whatsapp-simulada.js` (escucha en el puerto 5600).
3. En otra, levantar el bot apuntando a la simulación:

   ```
   PORT=5700 DATABASE_URL=postgres://postgres@localhost:5432/panel_prueba \
   PANEL_INITIAL_PASSWORD=provisoria123 GRAPH_API_BASE=http://localhost:5600 \
   PHONE_NUMBER_ID=PHONE WHATSAPP_TOKEN=tok VERIFY_TOKEN=v node index.js
   ```
4. `node pruebas/flujo-panel.js`

Resultado esperado: todo "ok" salvo una línea, "dos lo toman a la vez", que espera 200,409 y recibe 200,403.
El comportamiento es correcto (gana uno solo); lo que está desactualizado es el valor esperado en la prueba.
