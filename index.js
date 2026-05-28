const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const CONSORCIOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'consorcios.json'), 'utf8'));

const FOOTER = '\n─────────────\n⬅️ Escribí *volver* para el paso anterior\n🔄 Escribí *0* para volver al inicio';

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizar(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[°º]/g, '')
    .trim();
}

// Normalización agresiva para comparar unidades (ignora espacios y símbolos)
function normalizarUnidad(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[°º\s\-]/g, '')
    .trim();
}

// Convierte aliases comunes al formato del sistema
function normalizarInputUnidad(texto) {
  let t = texto.trim().toLowerCase();
  t = t.replace(/\blocal\b/g, 'loc');
  t = t.replace(/\bcochera\b|\bgaraje\b|\bgarage\b|\bestacionamiento\b/g, 'coch');
  t = t.replace(/\bdepartamento\b|\bdepto\b|\bapto\b/g, '');
  return t.trim();
}

// Busca consorcios que coincidan — devuelve array (puede ser vacío, uno o varios)
function buscarConsorcios(texto) {
  // Solo números puros → selección por índice
  if (/^\d+$/.test(texto.trim())) {
    const num = parseInt(texto.trim());
    if (num >= 1 && num <= CONSORCIOS.length) return [CONSORCIOS[num - 1]];
    return [];
  }
  const t = normalizar(texto);
  return CONSORCIOS.filter(c =>
    normalizar(c.nombre).includes(t) ||
    t.includes(normalizar(c.nombre)) ||
    normalizar(c.direccion).includes(t) ||
    t.includes(normalizar(c.direccion))
  );
}

function validarUnidad(consorcio, unidad, torre = null) {
  const inputNorm = normalizarUnidad(normalizarInputUnidad(unidad));
  // También probar con prefijo "c" en lugar de "coch" (ej: C°1 en vez de COCH°1)
  const inputNormC = inputNorm.replace(/^coch/, 'c');
  const lista = torre
    ? (consorcio.torres[torre] || [])
    : (consorcio.unidades || []);
  return lista.some(x => {
    const xNorm = normalizarUnidad(x);
    return xNorm === inputNorm || xNorm === inputNormC;
  });
}

function listarConsorcios() {
  return CONSORCIOS.map((c, i) => `${i + 1}. ${c.nombre} (${c.direccion})`).join('\n');
}

function esVolver(t) {
  return ['volver', 'atras', 'atrás', 'back', 'anterior'].includes(t);
}

function esInicio(t) {
  return ['0', 'inicio', 'menu', 'menú', 'reiniciar', 'empezar'].includes(t);
}

function continueConConsorcio(sesion, consorcio) {
  sesion.datos.consorcio = consorcio;
  if (consorcio.tieneTorres) {
    sesion.estado = 'esperando_torre';
    const torres = Object.keys(consorcio.torres).filter(k => k !== 'cocheras');
    const tieneCocheras = 'cocheras' in consorcio.torres;
    const opciones = torres.map(t => `Torre ${t}`);
    if (tieneCocheras) opciones.push('Cocheras');
    return `Consorcio: *${consorcio.nombre}* ✅\n\n¿A qué torre o sector pertenecés?\n${opciones.join('\n')}` + FOOTER;
  }
  sesion.estado = 'esperando_unidad';
  return `Consorcio: *${consorcio.nombre}* ✅\n\n¿Cuál es tu unidad?\n_(ej: 3°A, local 1, cochera 5)_` + FOOTER;
}

// ── Webhook verification ──────────────────────────────────────────────────────

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

// ── Receive messages ──────────────────────────────────────────────────────────

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
    if (msgType === 'text') userText = message.text.body;
    else if (msgType === 'image') userText = '[imagen recibida]';
    else if (msgType === 'audio') userText = '[audio recibido]';
    else if (msgType === 'video') userText = '[video recibido]';
    else if (msgType === 'document') userText = '[documento recibido]';

    console.log(`Mensaje de ${from}: ${userText}`);

    const reply = await procesarMensaje(from, userText, msgType, message);
    if (reply) await enviarMensaje(from, reply);

    res.sendStatus(200);
  } catch (err) {
    console.error('Error completo:', err.response?.data || err.message);
    res.sendStatus(200);
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────

const sesiones = {};

function resetSesion(from) {
  sesiones[from] = { estado: 'inicio', datos: {}, historial: [] };
}

function guardarHistorial(sesion) {
  sesion.historial = sesion.historial || [];
  sesion.historial.push({
    estado: sesion.estado,
    datos: JSON.parse(JSON.stringify(sesion.datos))
  });
  if (sesion.historial.length > 10) sesion.historial.shift();
}

// ── Main message processor ────────────────────────────────────────────────────

async function procesarMensaje(from, texto, tipo, message) {
  if (!sesiones[from]) resetSesion(from);
  const sesion = sesiones[from];
  const t = normalizar(texto);

  // Volver al inicio — cualquier estado
  if (esInicio(t)) {
    resetSesion(from);
    return (
      `🔄 Volvemos al inicio.\n\n` +
      `¡Hola! 👋 Soy el asistente de *Manuel Jose Lorenzo & Asociados*.\n\n` +
      `¿A qué consorcio pertenecés? Podés escribir el nombre, dirección o número.\n\n` +
      listarConsorcios() + FOOTER
    );
  }

  // Volver un paso — cualquier estado
  if (esVolver(t) && sesion.estado !== 'inicio') {
    const anterior = sesion.historial?.pop();
    if (anterior) {
      sesion.estado = anterior.estado;
      sesion.datos = anterior.datos;
      // Re-mostrar la pregunta del estado anterior
      return await procesarMensaje(from, '__reprompt__', tipo, message);
    }
  }

  // Media durante reclamo
  if (['image', 'audio', 'video', 'document'].includes(tipo)) {
    if (sesion.estado === 'reclamo_activo') {
      sesion.datos.media = sesion.datos.media || [];
      sesion.datos.media.push({ tipo, id: message[tipo]?.id });
      return '✅ Archivo recibido. Respondé *listo* para confirmar o seguí enviando archivos.' + FOOTER;
    }
  }

  switch (sesion.estado) {

    case 'inicio': {
      sesion.estado = 'esperando_consorcio';
      // Si el primer mensaje ya parece una selección, procesarlo directamente
      const saludo = ['hola', 'buenas', 'buen dia', 'buenos dias', 'buenas tardes',
                      'buenas noches', 'hi', 'hey', '', 'ola'];
      if (saludo.includes(t) || texto === '__reprompt__') {
        return (
          `¡Hola! 👋 Soy el asistente de *Manuel Jose Lorenzo & Asociados*.\n\n` +
          `¿A qué consorcio pertenecés? Podés escribir el nombre, dirección o número.\n\n` +
          listarConsorcios() + FOOTER
        );
      }
      // Intentar procesar como selección de consorcio directamente
      return await procesarMensaje(from, texto, tipo, message);
    }

    case 'esperando_consorcio': {
      if (texto === '__reprompt__') {
        return (
          `¿A qué consorcio pertenecés? Podés escribir el nombre, dirección o número.\n\n` +
          listarConsorcios() + FOOTER
        );
      }
      const candidatos = buscarConsorcios(texto);
      if (candidatos.length === 0) {
        return (
          `No encontré ese consorcio. Por favor escribí el nombre, dirección o número:\n\n` +
          listarConsorcios() + FOOTER
        );
      }
      if (candidatos.length === 1) {
        guardarHistorial(sesion);
        return continueConConsorcio(sesion, candidatos[0]);
      }
      // Múltiples coincidencias → pedir aclaración
      guardarHistorial(sesion);
      sesion.datos.candidatos = candidatos;
      sesion.estado = 'esperando_aclaracion_consorcio';
      return (
        `Encontré más de un resultado:\n\n` +
        candidatos.map((c, i) => `${i + 1}. ${c.nombre} (${c.direccion})`).join('\n') +
        `\n\n¿Cuál es el tuyo?` + FOOTER
      );
    }

    case 'esperando_aclaracion_consorcio': {
      if (texto === '__reprompt__') {
        const cands = sesion.datos.candidatos || [];
        return (
          `¿Cuál de estos es tu consorcio?\n\n` +
          cands.map((c, i) => `${i + 1}. ${c.nombre} (${c.direccion})`).join('\n') + FOOTER
        );
      }
      const cands = sesion.datos.candidatos || [];
      // Intentar selección por número
      if (/^\d+$/.test(texto.trim())) {
        const num = parseInt(texto.trim());
        if (num >= 1 && num <= cands.length) {
          guardarHistorial(sesion);
          sesion.datos.candidatos = null;
          return continueConConsorcio(sesion, cands[num - 1]);
        }
      }
      // Intentar selección por texto dentro de los candidatos
      const match = cands.find(c =>
        normalizar(c.nombre).includes(t) || t.includes(normalizar(c.nombre))
      );
      if (match) {
        guardarHistorial(sesion);
        sesion.datos.candidatos = null;
        return continueConConsorcio(sesion, match);
      }
      return (
        `No reconocí esa opción. Respondé con el número:\n\n` +
        cands.map((c, i) => `${i + 1}. ${c.nombre} (${c.direccion})`).join('\n') + FOOTER
      );
    }

    case 'esperando_torre': {
      if (texto === '__reprompt__') {
        const consorcio = sesion.datos.consorcio;
        const torres = Object.keys(consorcio.torres).filter(k => k !== 'cocheras');
        const tieneCocheras = 'cocheras' in consorcio.torres;
        const opciones = torres.map(t => `Torre ${t}`);
        if (tieneCocheras) opciones.push('Cocheras');
        return `¿A qué torre o sector pertenecés?\n${opciones.join('\n')}` + FOOTER;
      }
      const consorcio = sesion.datos.consorcio;
      const torres = Object.keys(consorcio.torres).filter(k => k !== 'cocheras');
      const tieneCocheras = 'cocheras' in consorcio.torres;

      // Seleccionó cocheras
      if (t === 'cocheras' || t === 'cochera') {
        if (!tieneCocheras) {
          return `Este consorcio no tiene cocheras registradas.` + FOOTER;
        }
        guardarHistorial(sesion);
        sesion.datos.torre = 'cocheras';
        sesion.estado = 'esperando_unidad';
        return `Cocheras ✅\n\n¿Cuál es tu número de cochera?\n_(ej: C°1, cochera 5)_` + FOOTER;
      }

      const torreInput = texto.replace(/torre/i, '').trim();
      const torreValida = torres.find(tr => normalizar(tr) === normalizar(torreInput));
      if (!torreValida) {
        const opciones = torres.map(t => `Torre ${t}`);
        if (tieneCocheras) opciones.push('Cocheras');
        return `Opción no válida. Las opciones disponibles son:\n${opciones.join('\n')}` + FOOTER;
      }
      guardarHistorial(sesion);
      sesion.datos.torre = torreValida;
      sesion.estado = 'esperando_unidad';
      return `Torre *${torreValida}* ✅\n\n¿Cuál es tu unidad?\n_(ej: 3°A, PB°B, cochera 5)_` + FOOTER;
    }

    case 'esperando_unidad': {
      if (texto === '__reprompt__') {
        return `¿Cuál es tu unidad?\n_(ej: 3°A, local 1, cochera 5)_` + FOOTER;
      }
      const consorcio = sesion.datos.consorcio;
      const torre = sesion.datos.torre || null;
      const esValida = validarUnidad(consorcio, texto, torre);
      if (!esValida) {
        return (
          `No encontré la unidad *${texto}* en ${consorcio.nombre}${torre ? ` Torre ${torre}` : ''}.\n` +
          `Verificá y escribila de nuevo.\n_(ej: 3°A, local 1, cochera 5)_` + FOOTER
        );
      }
      guardarHistorial(sesion);
      sesion.datos.unidad = texto.trim();
      sesion.estado = 'esperando_nombre';
      return `Unidad *${texto.trim()}* ✅\n\n¿Cuál es tu nombre?` + FOOTER;
    }

    case 'esperando_nombre':
      if (texto === '__reprompt__') return `¿Cuál es tu nombre?` + FOOTER;
      guardarHistorial(sesion);
      sesion.datos.nombre = texto;
      sesion.estado = 'menu';
      return (
        `Gracias, *${texto}*. ¿En qué te puedo ayudar?\n\n` +
        `1️⃣ Hacer un reclamo\n2️⃣ Consultar estado de un reclamo\n3️⃣ Hablar con una persona` + FOOTER
      );

    case 'menu':
      if (texto === '__reprompt__') {
        return `¿En qué te puedo ayudar?\n\n1️⃣ Hacer un reclamo\n2️⃣ Consultar estado de un reclamo\n3️⃣ Hablar con una persona` + FOOTER;
      }
      if (t === '1' || (t.includes('reclamo') && !t.includes('estado'))) {
        guardarHistorial(sesion);
        sesion.estado = 'esperando_reclamo';
        return '📝 Describí el problema con el mayor detalle posible. También podés enviar *fotos, videos o audios*.' + FOOTER;
      } else if (t === '2' || t.includes('estado')) {
        return '🔍 La consulta de estado estará disponible próximamente.\n\n1️⃣ Hacer un reclamo\n3️⃣ Hablar con una persona' + FOOTER;
      } else if (t === '3' || t.includes('persona')) {
        guardarHistorial(sesion);
        sesion.estado = 'derivado';
        const { nombre, consorcio, unidad, torre } = sesion.datos;
        console.log(`DERIVAR A OPERADOR: ${nombre} | ${consorcio.nombre} | ${torre ? 'Torre ' + torre + ' ' : ''}${unidad}`);
        return '👤 En breve un operador se va a comunicar con vos. Horario: lunes a viernes 9 a 18hs.' + FOOTER;
      } else {
        return 'Por favor respondé con *1*, *2* o *3*.' + FOOTER;
      }

    case 'esperando_reclamo':
      if (texto === '__reprompt__') return '📝 Describí el problema con el mayor detalle posible.' + FOOTER;
      guardarHistorial(sesion);
      sesion.datos.descripcion = texto;
      sesion.estado = 'reclamo_activo';
      return '📎 ¿Querés adjuntar fotos, videos o audios? Si no, respondé *listo*.' + FOOTER;

    case 'reclamo_activo':
      if (texto === '__reprompt__') return '📎 ¿Querés adjuntar archivos? Respondé *listo* para registrar el reclamo.' + FOOTER;
      if (t === 'listo' || t === 'no') {
        const nro = Math.floor(Math.random() * 90000) + 10000;
        sesion.datos.numero_reclamo = nro;
        const { nombre, consorcio, unidad, torre, descripcion } = sesion.datos;
        const torreStr = torre ? `Torre ${torre} ` : '';
        console.log(`RECLAMO #${nro} | ${consorcio.nombre} | ${torreStr}${unidad} | ${nombre} | ${descripcion}`);
        sesion.estado = 'menu';
        return (
          `✅ Reclamo registrado con el número *#${nro}*.\n\n` +
          `¿Necesitás algo más?\n\n1️⃣ Otro reclamo\n2️⃣ Consultar estado\n3️⃣ Hablar con una persona` + FOOTER
        );
      } else {
        sesion.datos.descripcion += ' ' + texto;
        return '📎 ¿Algo más? Respondé *listo* para registrar.' + FOOTER;
      }

    case 'derivado':
      if (texto === '__reprompt__') return '👤 Ya notificamos a un operador. Te contactarán a la brevedad.' + FOOTER;
      return '👤 Ya notificamos a un operador. Te contactarán a la brevedad.' + FOOTER;

    default:
      resetSesion(from);
      return await procesarMensaje(from, texto, tipo, message);
  }
}

// ── Send message ──────────────────────────────────────────────────────────────

async function enviarMensaje(to, texto) {
  let toNormalizado = to;
  if (to.startsWith('549') && to.length === 13) {
    const area = to.slice(3, 6);
    const numero = to.slice(6);
    toNormalizado = '54' + area + '15' + numero;
  }
  const url = `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`;
  console.log(`Enviando a ${toNormalizado} via ${url}`);
  const response = await axios.post(
    url,
    { messaging_product: 'whatsapp', to: toNormalizado, type: 'text', text: { body: texto } },
    { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
  );
  console.log('Respuesta Meta:', JSON.stringify(response.data));
}

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
