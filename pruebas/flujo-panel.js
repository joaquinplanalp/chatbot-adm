const B = 'http://localhost:5700';
let n = 0, fallos = 0;
const ok = (c, d) => { if (c) console.log('  ok  ' + d); else { fallos++; console.log('  FALLA  ' + d); } };
const wa = async (from, texto, extra) => {
  const message = extra || { from, id: 'm' + (++n), type: 'text', text: { body: texto } };
  await fetch(B + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [message] } }] }] }) });
};
const enviados = async () => (await (await fetch('http://localhost:5600/_enviados')).json());
function cliente() {
  let cookie = '';
  return async (ruta, method = 'GET', body) => {
    const r = await fetch(B + '/panel/api' + ruta, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
}
async function ingresar(usuario, nueva) {
  const c = cliente();
  let r = await c('/login', 'POST', { usuario, clave: 'provisoria123' });
  if (r.s === 200 && r.j.debe_cambiar) { const e = await c('/estado'); ok(e.s === 403 && e.j.codigo === 'cambiar_clave', usuario + ': obligado a cambiar clave'); r = await c('/clave', 'POST', { actual: 'provisoria123', nueva }); }
  else if (r.s !== 200) r = await c('/login', 'POST', { usuario, clave: nueva });
  ok(r.s === 200, usuario + ' ingresa');
  return c;
}
const derivar = async (tel, nombre) => { for (const t of ['hola', '3', 'ervar', '3a', nombre]) await wa(tel, t); };

(async () => {
  console.log('Acceso');
  const anon = cliente();
  ok((await anon('/estado')).s === 401, 'sin sesión: 401');
  ok((await anon('/login', 'POST', { usuario: 'belen', clave: 'mala' })).s === 401, 'clave incorrecta: 401');
  const belen = await ingresar('belen', 'clave-belen-1');
  const mica = await ingresar('micaela', 'clave-mica-1');
  const joaco = await ingresar('joaquin', 'clave-joaco-1');
  ok((await belen('/usuarios')).s === 403, 'operador no ve usuarios');
  ok((await belen('/historial')).s === 403, 'operador no ve historial');

  console.log('Derivación con asignación automática');
  await mica('/disponible', 'POST', { disponible: false });
  await belen('/estado'); await mica('/estado'); await enviados();
  await derivar('5492235550001', 'Ana');
  let env = await enviados();
  ok(env.some(e => e.texto.includes('Gracias *Ana*')), 'bot confirma la derivación');
  ok(env.at(-1).texto === 'Hola, soy Belén. ¿Cómo puedo ayudarte hoy?', 'saludo con el nombre: ' + env.at(-1).texto);
  ok(env.at(-1).to === '54223155550001', 'número con formato de la lista de prueba');
  let e = await belen('/estado');
  ok(e.j.conversaciones.length === 1 && e.j.conversaciones[0].estado === 'en_atencion', 'Belén la tiene asignada');
  const c1 = e.j.conversaciones[0].id;
  ok((await mica('/estado')).j.conversaciones.length === 0, 'Micaela (no disponible) no ve chats ajenos');
  ok((await mica(`/conversaciones/${c1}/mensajes`)).s === 403, 'Micaela no puede leer el chat de Belén');
  ok((await mica(`/conversaciones/${c1}/responder`, 'POST', { texto: 'x' })).s === 403, 'Micaela no puede responder');

  console.log('Bot en pausa y respuesta del operador');
  await wa('5492235550001', 'tengo una duda con expensas');
  ok((await enviados()).length === 0, 'el bot no contesta mientras atiende una persona');
  ok((await belen('/estado')).j.conversaciones[0].sin_leer === 1, 'figura 1 sin leer');
  let r = await belen(`/conversaciones/${c1}/responder`, 'POST', { texto: 'Contame, Ana.' });
  env = await enviados();
  ok(r.s === 200 && env[0].texto === 'Contame, Ana.', 'la respuesta sale por WhatsApp');
  let m = (await belen(`/conversaciones/${c1}/mensajes`)).j.mensajes;
  ok(m.some(x => x.direccion === 'in' && x.texto === 'ervar'), 'el historial incluye lo hablado con el asistente');
  ok(m.some(x => x.autor === 'Belén' && x.texto === 'Contame, Ana.'), 'queda registrado quién respondió');
  await wa('5492235550001', '', { from: '5492235550001', id: 'img1', type: 'image', image: { id: 'MEDIA1', caption: 'mirá' } });
  m = (await belen(`/conversaciones/${c1}/mensajes`)).j.mensajes;
  const foto = m.find(x => x.tiene_media);
  const rf = await fetch(B + '/panel/api/media/' + foto.id);
  ok(foto.tipo === 'image' && rf.status === 401, 'foto registrada; sin sesión no se descarga');

  console.log('Supervisor');
  e = await joaco('/estado');
  ok(e.j.conversaciones.length === 1 && e.j.equipo.find(p => p.nombre === 'Belén').abiertos === 1, 've todos los chats y el resumen del equipo');
  ok((await joaco(`/conversaciones/${c1}/responder`, 'POST', { texto: 'x' })).s === 403, 'no responde sin asignárselo');
  const idMica = e.j.equipo.find(p => p.nombre === 'Micaela').id;
  await enviados();
  r = await joaco(`/conversaciones/${c1}/asignar`, 'POST', { user_id: idMica });
  env = await enviados();
  ok(r.s === 200 && env[0].texto === 'Hola, soy Micaela. Sigo yo con tu consulta.', 'reasigna: ' + env[0]?.texto);
  ok((await belen('/estado')).j.conversaciones.length === 0, 'Belén deja de verlo');

  console.log('Cola manual');
  await belen('/disponible', 'POST', { disponible: false });
  await derivar('5492235550002', 'Luis');
  env = await enviados();
  ok(!env.some(x => x.texto.startsWith('Hola, soy')), 'sin operadores disponibles queda en cola');
  await wa('5492235550002', 'hola?');
  await wa('5492235550002', 'hay alguien?');
  env = await enviados();
  ok(env.length === 0, 'no repite el aviso de espera enseguida (' + env.length + ')');
  e = await belen('/estado');
  const c2 = e.j.conversaciones.find(c => c.estado === 'pendiente').id;
  const [t1, t2] = await Promise.all([belen(`/conversaciones/${c2}/tomar`, 'POST'), mica(`/conversaciones/${c2}/tomar`, 'POST')]);
  ok([t1.s, t2.s].sort().join() === '200,409', 'dos lo toman a la vez: gana uno solo (' + t1.s + ',' + t2.s + ')');
  env = await enviados();
  ok(env.filter(x => x.texto.includes('¿Cómo puedo ayudarte hoy?')).length === 1, 'un solo saludo');

  console.log('Ventana de 24 h, resolución y vuelta al bot');
  await fetch('http://localhost:5600/_fallar', { method: 'POST', body: '1' });
  r = await mica(`/conversaciones/${c1}/responder`, 'POST', { texto: 'hola' });
  ok(r.s === 502 && r.j.error.includes('24 horas'), 'error claro de WhatsApp: ' + r.j.error);
  await fetch('http://localhost:5600/_fallar', { method: 'POST', body: '0' });
  ok((await belen(`/conversaciones/${c1}/resolver`, 'POST')).s === 403, 'Belén no resuelve un chat ajeno');
  r = await mica(`/conversaciones/${c1}/resolver`, 'POST');
  env = await enviados();
  ok(r.s === 200 && env[0].texto.includes('finalizada'), 'resuelve y avisa el cierre');
  await wa('5492235550001', 'hola');
  env = await enviados();
  ok(env[0].texto.includes('Soy el asistente'), 'el bot vuelve a responder');
  const h = await joaco('/historial');
  ok(h.j.conversaciones.length === 1 && h.j.conversaciones[0].cerrado_por === 'Micaela', 'queda en el historial');
  ok((await joaco(`/conversaciones/${c1}/mensajes`)).j.mensajes.length > 5, 'el supervisor puede releerla');
  // propietario escribe 0 durante la atención
  const quien = t1.s === 200 ? belen : mica;
  await wa('5492235550002', '0');
  env = await enviados();
  ok(env[0].texto.includes('Volvemos al inicio'), 'con 0 el propietario vuelve al asistente');
  ok((await quien('/estado')).j.conversaciones.length === 0, 'y el chat se cierra');

  console.log('Usuarios');
  ok((await joaco('/usuarios', 'POST', { nombre: 'Carla', usuario: 'carla', rol: 'operador', clave: 'corta' })).s === 400, 'rechaza clave corta');
  ok((await joaco('/usuarios', 'POST', { nombre: 'Carla', usuario: 'carla', rol: 'operador', clave: 'provisoria123' })).s === 200, 'crea usuario');
  const carla = await ingresar('carla', 'clave-carla-1');
  const us = (await joaco('/usuarios')).j.usuarios;
  const idJ = us.find(u => u.usuario === 'joaquin').id, idB = us.find(u => u.usuario === 'belen').id, idBau = us.find(u => u.usuario === 'bautista').id;
  ok((await joaco(`/usuarios/${idJ}`, 'PATCH', { activo: false })).s === 400, 'no puede darse de baja a sí mismo');
  ok((await joaco(`/usuarios/${idBau}`, 'PATCH', { activo: false })).s === 200, 'da de baja a otro supervisor');
  ok((await joaco(`/usuarios/${idJ}`, 'PATCH', { rol: 'operador' })).s === 400, 'no se quita su propio perfil');
  // baja con chats abiertos
  await belen('/disponible', 'POST', { disponible: true }); await belen('/estado');
  await derivar('5492235550003', 'Marta'); await enviados();
  ok((await belen('/estado')).j.conversaciones.length === 1, 'Belén recibe a Marta');
  await carla('/estado');
  r = await joaco(`/usuarios/${idB}`, 'PATCH', { activo: false });
  env = await enviados();
  ok(r.s === 200 && env.some(x => x.texto === 'Hola, soy Carla. Sigo yo con tu consulta.'), 'baja de Belén: su chat pasa a Carla');
  ok((await belen('/estado')).s === 401, 'Belén ya no puede entrar');
  ok((await cliente()('/login', 'POST', { usuario: 'belen', clave: 'clave-belen-1' })).s === 401, 'ni volver a ingresar');
  r = await joaco(`/usuarios/${idMica}/clave`, 'POST', { clave: 'provisoria123' });
  ok(r.s === 200 && (await mica('/estado')).s === 401, 'restablecer clave cierra la sesión de Micaela');

  console.log(fallos ? `\n${fallos} FALLAS` : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
