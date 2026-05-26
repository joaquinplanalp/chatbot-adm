const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return res.sendStatus(200);

    const message = messages[0];
    const from = message.from;
    const msgType = message.type;

    let userText = '';
    if (msgType === 'text') {
      userText = message.text.body;
    } else if (msgType === 'image') {
      userText = '[imagen recibida]';
    } else if (msgType === 'audio') {
      userText = '[audio recibido]';
    } else if (msgType === 'video') {
      userText = '[video recibido]';
    } else if (msgType === 'document') {
      userText = '[documento recibido]';
    }

    console.log(`Mensaje de ${from}: ${userText}`);

    // Process with Claude
    const reply = await procesarMensaje(from, userText, msgType, message);
    if (reply) await enviarMensaje(from, reply);

    res.sendStatus(200);
  } catch (err) {
    console.error('Error:', err.message);
    res.sendStatus(200);
  }
});

// Session storage (in-memory)
const sesiones = {};

async function procesarMensaje(from, texto, tipo, message) {
  if (!sesiones[from]) {
    sesiones[from] = { estado: 'inicio', datos: {} };
  }
  const sesion = sesiones[from];

  // Media received
  if (['image', 'audio', 'video', 'document'].includes(tipo)) {
    if (sesion.estado === 'esperando_media' || sesion.estado === 'reclamo_activo') {
      sesion.datos.media = sesion.datos.media || [];
      sesion.datos.media.push({ tipo, id: message[tipo]?.id });
      sesion.estado = 'reclamo_activo';
      return '✅ Archivo recibido. ¿Querés agregar algo más o damos por registrado el reclamo? Respondé *listo* para confirmar o seguí enviando archivos.';
    }
  }

  const texto_lower = texto.toLowerCase().trim();

  switch (sesion.estado) {
    case 'inicio':
      sesion.estado = 'esperando_confirmacion';
      return `¡Hola! 👋 Soy el asistente de *Manuel Jose Lorenzo & Asociados*.\n\n¿Podés confirmarme tu nombre, unidad y consorcio?\n\nEjemplo: _Juan Pérez, 3°B, Edificio Alsina_`;

    case 'esperando_confirmacion':
      sesion.datos.identificacion = texto;
      sesion.estado = 'menu';
      return `Gracias, *${texto}*. ¿En qué te puedo ayudar?\n\n1️⃣ Hacer un reclamo\n2️⃣ Consultar estado de un reclamo\n3️⃣ Hablar con una persona\n\nRespondé con el número de la opción.`;

    case 'menu':
      if (texto_lower === '1' || texto_lower.includes('reclamo') && !texto_lower.includes('estado')) {
        sesion.estado = 'esperando_reclamo';
        return '📝 Describí el problema con el mayor detalle posible. También podés enviar *fotos, videos o audios*.';
      } else if (texto_lower === '2' || texto_lower.includes('estado')) {
        sesion.estado = 'menu';
        // TODO: consultar estado en base de datos
        return '🔍 La consulta de estado de reclamo estará disponible próximamente. ¿Necesitás algo más?\n\n1️⃣ Hacer un reclamo\n3️⃣ Hablar con una persona';
      } else if (texto_lower === '3' || texto_lower.includes('persona') || texto_lower.includes('humano')) {
        sesion.estado = 'derivado';
        return '👤 En breve un operador se va a comunicar con vos. El horario de atención es de lunes a viernes de 9 a 18hs.';
      } else {
        return 'Por favor respondé con *1*, *2* o *3* según la opción que necesitás.';
      }

    case 'esperando_reclamo':
      sesion.datos.descripcion = texto;
      sesion.estado = 'reclamo_activo';
      return '📎 ¿Querés adjuntar fotos, videos o audios del problema? Si no, respondé *listo* para registrar el reclamo.';

    case 'reclamo_activo':
      if (texto_lower === 'listo' || texto_lower === 'no' || texto_lower === 'sin archivos') {
        const nro = Math.floor(Math.random() * 90000) + 10000;
        sesion.datos.numero_reclamo = nro;
        sesion.estado = 'menu';
        console.log(`RECLAMO #${nro} - ${sesion.datos.identificacion}: ${sesion.datos.descripcion}`);
        return `✅ Reclamo registrado con el número *#${nro}*.\n\nGuardá este número para consultar el estado.\n\n¿Necesitás algo más?\n\n1️⃣ Hacer otro reclamo\n2️⃣ Consultar estado\n3️⃣ Hablar con una persona`;
      } else {
        sesion.datos.descripcion += ' ' + texto;
        return '📎 ¿Algo más que agregar? Podés seguir enviando archivos o respondé *listo* para registrar el reclamo.';
      }

    case 'derivado':
      return '👤 Ya notificamos a un operador. Te contactarán a la brevedad. Si es urgente llamá al número de la administración.';

    default:
      sesion.estado = 'inicio';
      return await procesarMensaje(from, texto, tipo, message);
  }
}

async function enviarMensaje(to, texto) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: texto }
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
