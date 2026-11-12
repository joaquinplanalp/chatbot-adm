// Panel de atención: usuarios, derivaciones a operadores y respuestas desde la web.
// Necesita la variable DATABASE_URL (PostgreSQL). Sin ella el bot funciona igual, sin panel.

const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const axios = require('axios');
const express = require('express');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);

const USUARIOS_INICIALES = [
  { usuario: 'micaela', nombre: 'Micaela', rol: 'operador' },
  { usuario: 'belen', nombre: 'Belén', rol: 'operador' },
  { usuario: 'joaquin', nombre: 'Joaquín', rol: 'supervisor' },
  { usuario: 'bautista', nombre: 'Bautista', rol: 'supervisor' },
];

const SESION_HORAS = 12;
const CONECTADO_SEG = 45;        // sin señal del panel por más de esto = desconectado
const MENSAJE_CIERRE = '✅ Damos por finalizada la consulta. Si necesitás algo más, escribí *hola* y te atiende el asistente.';

let pool = null;
let deps = {};

const q = (sql, params) => pool.query(sql, params);
const activo = () => !!pool;

// ── Base de datos ─────────────────────────────────────────────────────────────

const ESQUEMA = `
create table if not exists usuarios (
  id serial primary key,
  usuario text not null unique,
  nombre text not null,
  rol text not null check (rol in ('operador','supervisor')),
  clave_hash text not null,
  debe_cambiar boolean not null default true,
  activo boolean not null default true,
  disponible boolean not null default true,
  ultimo_ping timestamptz,
  ultima_asignacion timestamptz,
  creado timestamptz not null default now()
);
create table if not exists sesiones (
  token_hash text primary key,
  user_id integer not null references usuarios(id) on delete cascade,
  expira timestamptz not null
);
create table if not exists conversaciones (
  id serial primary key,
  telefono text not null,
  nombre text not null default '',
  consorcio text not null default '',
  torre text not null default '',
  unidad text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente','en_atencion','resuelto')),
  asignado_a integer references usuarios(id),
  saludada boolean not null default false,
  sin_leer integer not null default 0,
  creado timestamptz not null default now(),
  asignado_en timestamptz,
  ultimo_entrante timestamptz not null default now(),
  cerrado_en timestamptz,
  cerrado_por text
);
create unique index if not exists conversaciones_abierta on conversaciones (telefono) where estado <> 'resuelto';
create table if not exists mensajes (
  id bigserial primary key,
  telefono text not null,
  conv_id integer references conversaciones(id),
  direccion text not null check (direccion in ('in','out','sys')),
  autor text not null default '',
  user_id integer references usuarios(id),
  tipo text not null default 'text',
  texto text not null default '',
  media_id text,
  creado timestamptz not null default now()
);
create index if not exists mensajes_telefono on mensajes (telefono, id);
`;

async function sembrarUsuarios() {
  const { rows } = await q('select count(*)::int as n from usuarios');
  if (rows[0].n > 0) return;
  const clave = process.env.PANEL_INITIAL_PASSWORD;
  if (!clave || clave.length < 8) {
    console.error('Panel: falta la variable PANEL_INITIAL_PASSWORD (mínimo 8 caracteres). No se crearon los usuarios iniciales.');
    return;
  }
  const hash = await hashClave(clave);
  for (const u of USUARIOS_INICIALES) {
    await q('insert into usuarios (usuario, nombre, rol, clave_hash) values ($1,$2,$3,$4) on conflict do nothing',
      [u.usuario, u.nombre, u.rol, hash]);
  }
  console.log('Panel: usuarios iniciales creados (' + USUARIOS_INICIALES.map(u => u.usuario).join(', ') + ')');
}

// ── Claves y sesiones ─────────────────────────────────────────────────────────

async function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(clave, sal, 64);
  return `scrypt$${sal.toString('hex')}$${h.toString('hex')}`;
}

async function claveCorrecta(clave, guardado) {
  const [alg, salHex, hashHex] = String(guardado).split('$');
  if (alg !== 'scrypt' || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const h = await scrypt(clave, Buffer.from(salHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(h, esperado);
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function leerCookie(req, nombre) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

function ponerCookie(req, res, token, segundos) {
  const attrs = [`panel_s=${token}`, 'Path=/panel', 'HttpOnly', 'SameSite=Strict', `Max-Age=${segundos}`];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Freno a intentos de ingreso: 5 fallos por usuario+IP => 15 minutos de espera
const intentos = new Map();
function bloqueado(clave) {
  const r = intentos.get(clave);
  return !!(r && r.n >= 5 && Date.now() < r.hasta);
}
function anotarFallo(clave) {
  const r = intentos.get(clave);
  if (!r || Date.now() > r.hasta) intentos.set(clave, { n: 1, hasta: Date.now() + 15 * 60 * 1000 });
  else r.n++;
  if (intentos.size > 5000) intentos.clear();
}

// ── Mensajes ──────────────────────────────────────────────────────────────────

async function convAbierta(telefono) {
  const { rows } = await q(`select * from conversaciones where telefono=$1 and estado <> 'resuelto'`, [telefono]);
  return rows[0] || null;
}

// Mensaje que llega del propietario. Devuelve la conversación derivada si hay una abierta.
async function registrarEntrante(telefono, { tipo = 'text', texto = '', mediaId = null } = {}) {
  if (!activo()) return null;
  try {
    const conv = await convAbierta(telefono);
    await q(`insert into mensajes (telefono, conv_id, direccion, autor, tipo, texto, media_id) values ($1,$2,'in','Propietario',$3,$4,$5)`,
      [telefono, conv ? conv.id : null, tipo, String(texto).slice(0, 4000), mediaId]);
    if (conv) await q('update conversaciones set ultimo_entrante=now(), sin_leer=sin_leer+1 where id=$1', [conv.id]);
    return conv;
  } catch (err) {
    console.error('Panel: no se pudo registrar el mensaje entrante:', err.message);
    return null;
  }
}

async function registrarSaliente(telefono, texto, { autor = 'Asistente', userId = null } = {}) {
  if (!activo()) return;
  try {
    const conv = await convAbierta(telefono);
    await q(`insert into mensajes (telefono, conv_id, direccion, autor, user_id, texto) values ($1,$2,'out',$3,$4,$5)`,
      [telefono, conv ? conv.id : null, autor, userId, String(texto).slice(0, 4000)]);
  } catch (err) {
    console.error('Panel: no se pudo registrar el mensaje saliente:', err.message);
  }
}

async function nota(conv, texto) {
  await q(`insert into mensajes (telefono, conv_id, direccion, autor, texto) values ($1,$2,'sys','Sistema',$3)`,
    [conv.telefono, conv.id, texto]);
}

// ── Derivación y asignación ───────────────────────────────────────────────────

// Las asignaciones se hacen de a una para que dos pedidos simultáneos no se pisen
let cola = Promise.resolve();
function enSerie(fn) {
  const p = cola.then(fn, fn);
  cola = p.catch(() => {});
  return p;
}

async function derivar(telefono, datos) {
  if (!activo()) return;
  try {
    const { rows } = await q(
      `insert into conversaciones (telefono, nombre, consorcio, torre, unidad) values ($1,$2,$3,$4,$5)
       on conflict (telefono) where estado <> 'resuelto' do nothing returning *`,
      [telefono, datos.nombre || '', datos.consorcio || '', datos.torre || '', datos.unidad || '']);
    if (rows[0]) {
      const lugar = [datos.consorcio, datos.torre && datos.torre !== 'cocheras' ? `Torre ${datos.torre}` : datos.torre, datos.unidad].filter(Boolean).join(' · ');
      await nota(rows[0], `${datos.nombre || 'El propietario'} pidió hablar con una persona (${lugar})`);
    }
    await autoAsignar();
  } catch (err) {
    console.error('Panel: no se pudo derivar la conversación:', err.message);
  }
}

// Reparte los chats sin asignar entre los operadores conectados y disponibles:
// primero el que menos chats abiertos tiene; a igualdad, el que hace más que no recibe uno.
function autoAsignar() {
  return enSerie(async () => {
    const pendientes = await q(`select id from conversaciones where estado='pendiente' order by creado`);
    for (const c of pendientes.rows) {
      const op = await q(
        `select u.id from usuarios u
         where u.rol='operador' and u.activo and u.disponible
           and u.ultimo_ping > now() - make_interval(secs => $1)
         order by (select count(*) from conversaciones c where c.asignado_a=u.id and c.estado='en_atencion') asc,
                  u.ultima_asignacion asc nulls first, u.id
         limit 1`, [CONECTADO_SEG]);
      if (!op.rows[0]) break;
      await asignar(c.id, op.rows[0].id, null);
    }
  });
}

// Deja el chat a nombre de un usuario y lo saluda con su nombre. quien = usuario que lo hizo (null = automático)
async function asignar(convId, userId, quien) {
  const conv = (await q(`select * from conversaciones where id=$1 and estado <> 'resuelto'`, [convId])).rows[0];
  if (!conv) throw fallo(409, 'La conversación ya fue resuelta.');
  const u = (await q('select id, nombre from usuarios where id=$1 and activo', [userId])).rows[0];
  if (!u) throw fallo(400, 'Ese usuario no existe o está dado de baja.');
  if (conv.asignado_a === u.id) return;

  await q(`update conversaciones set asignado_a=$2, estado='en_atencion', asignado_en=now(), saludada=true where id=$1`, [conv.id, u.id]);
  await q('update usuarios set ultima_asignacion=now() where id=$1', [u.id]);
  await nota(conv, !quien ? `Asignado automáticamente a ${u.nombre}`
    : quien.id === u.id ? `${u.nombre} tomó el chat`
    : `${quien.nombre} asignó el chat a ${u.nombre}`);

  const saludo = conv.saludada
    ? `Hola, soy ${u.nombre}. Sigo yo con tu consulta.`
    : `Hola, soy ${u.nombre}. ¿Cómo puedo ayudarte hoy?`;
  try {
    await deps.enviarMensaje(conv.telefono, saludo, { autor: u.nombre, userId: u.id });
  } catch (err) {
    await nota(conv, `No se pudo enviar el saludo: ${errorMeta(err)}`);
  }
}

async function cerrar(conv, porQuien, avisar) {
  const r = await q(`update conversaciones set estado='resuelto', cerrado_en=now(), cerrado_por=$2 where id=$1 and estado <> 'resuelto' returning id`,
    [conv.id, porQuien]);
  if (!r.rows[0]) return false;
  if (avisar) {
    try { await deps.enviarMensaje(conv.telefono, MENSAJE_CIERRE); } catch (err) { /* fuera de la ventana de 24 h: se cierra igual */ }
  }
  await q(`insert into mensajes (telefono, conv_id, direccion, autor, texto) values ($1,$2,'sys','Sistema',$3)`,
    [conv.telefono, conv.id, avisar ? `${porQuien} resolvió la conversación` : 'El propietario volvió al asistente automático']);
  return true;
}

async function cerrarPorPropietario(convId) {
  if (!activo()) return;
  try {
    const conv = (await q('select * from conversaciones where id=$1', [convId])).rows[0];
    if (conv) await cerrar(conv, 'Propietario', false);
  } catch (err) {
    console.error('Panel: no se pudo cerrar la conversación:', err.message);
  }
}

// ── Utilidades HTTP ───────────────────────────────────────────────────────────

function fallo(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}

function errorMeta(err) {
  const m = err.response?.data?.error;
  if (m?.code === 131047) return 'pasaron más de 24 horas desde el último mensaje del propietario; WhatsApp no permite escribirle hasta que vuelva a escribir.';
  return m?.message || err.message;
}

const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const soloSupervisor = (req, res, next) =>
  req.user.rol === 'supervisor' ? next() : next(fallo(403, 'Solo para supervisores.'));

function idDe(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw fallo(400, 'Identificador inválido.');
  return n;
}

function validarUsuario({ usuario, nombre, rol, clave }, exigir) {
  const out = {};
  if (usuario !== undefined || exigir) {
    out.usuario = String(usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(out.usuario)) throw fallo(400, 'El usuario debe tener de 3 a 30 letras minúsculas, números, punto o guion.');
  }
  if (nombre !== undefined || exigir) {
    out.nombre = String(nombre || '').trim();
    if (out.nombre.length < 1 || out.nombre.length > 40) throw fallo(400, 'El nombre debe tener entre 1 y 40 caracteres.');
  }
  if (rol !== undefined || exigir) {
    if (!['operador', 'supervisor'].includes(rol)) throw fallo(400, 'El perfil debe ser operador o supervisor.');
    out.rol = rol;
  }
  if (clave !== undefined || exigir) {
    out.clave = String(clave || '');
    if (out.clave.length < 8 || out.clave.length > 200) throw fallo(400, 'La contraseña debe tener al menos 8 caracteres.');
  }
  return out;
}

async function quedaOtroSupervisor(exceptoId) {
  const { rows } = await q(`select count(*)::int as n from usuarios where rol='supervisor' and activo and id <> $1`, [exceptoId]);
  return rows[0].n > 0;
}

const CAMPOS_CONV = `c.id, c.telefono, c.nombre, c.consorcio, c.torre, c.unidad, c.estado, c.asignado_a, c.sin_leer,
  c.creado, c.asignado_en, c.ultimo_entrante, c.cerrado_en, c.cerrado_por, u.nombre as asignado_nombre`;

async function convPara(req, { resueltas = false } = {}) {
  const conv = (await q(`select ${CAMPOS_CONV} from conversaciones c left join usuarios u on u.id=c.asignado_a where c.id=$1`,
    [idDe(req.params.id)])).rows[0];
  if (!conv) throw fallo(404, 'No existe esa conversación.');
  if (conv.estado === 'resuelto' && !resueltas) throw fallo(409, 'La conversación ya fue resuelta.');
  const esSup = req.user.rol === 'supervisor';
  const puedeVer = esSup || conv.asignado_a === req.user.id || conv.estado === 'pendiente';
  if (!puedeVer) throw fallo(403, 'Esa conversación está a cargo de otra persona.');
  return conv;
}

// ── Rutas ─────────────────────────────────────────────────────────────────────

function rutas() {
  const r = express.Router();

  r.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  r.post('/login', h(async (req, res) => {
    const usuario = String(req.body?.usuario || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    const llave = `${usuario}|${req.ip}`;
    if (bloqueado(llave)) throw fallo(429, 'Demasiados intentos. Probá de nuevo en 15 minutos.');
    const u = (await q('select * from usuarios where usuario=$1 and activo', [usuario])).rows[0];
    if (!u || !(await claveCorrecta(clave, u.clave_hash))) {
      anotarFallo(llave);
      throw fallo(401, 'Usuario o contraseña incorrectos.');
    }
    intentos.delete(llave);
    const token = crypto.randomBytes(32).toString('hex');
    await q('delete from sesiones where expira < now()');
    await q(`insert into sesiones (token_hash, user_id, expira) values ($1,$2, now() + make_interval(hours => $3))`,
      [sha256(token), u.id, SESION_HORAS]);
    ponerCookie(req, res, token, SESION_HORAS * 3600);
    res.json({ ok: true, debe_cambiar: u.debe_cambiar });
  }));

  // Todo lo que sigue exige sesión iniciada
  r.use(h(async (req, res, next) => {
    const token = leerCookie(req, 'panel_s');
    if (!token) throw fallo(401, 'Iniciá sesión.');
    const u = (await q(
      `select u.* from sesiones s join usuarios u on u.id=s.user_id
       where s.token_hash=$1 and s.expira > now() and u.activo`, [sha256(token)])).rows[0];
    if (!u) throw fallo(401, 'Iniciá sesión.');
    req.user = u;
    req.tokenHash = sha256(token);
    const libres = ['/clave', '/logout'];
    if (u.debe_cambiar && !libres.includes(req.path)) {
      const e = fallo(403, 'Tenés que cambiar la contraseña antes de seguir.');
      e.codigo = 'cambiar_clave';
      throw e;
    }
    next();
  }));

  r.post('/logout', h(async (req, res) => {
    await q('delete from sesiones where token_hash=$1', [req.tokenHash]);
    await q('update usuarios set ultimo_ping=null where id=$1', [req.user.id]);
    ponerCookie(req, res, '', 0);
    res.json({ ok: true });
  }));

  r.post('/clave', h(async (req, res) => {
    const actual = String(req.body?.actual || '');
    const { clave } = validarUsuario({ clave: req.body?.nueva });
    if (!(await claveCorrecta(actual, req.user.clave_hash))) throw fallo(400, 'La contraseña actual no es correcta.');
    if (clave === actual) throw fallo(400, 'La contraseña nueva tiene que ser distinta de la actual.');
    await q('update usuarios set clave_hash=$2, debe_cambiar=false where id=$1', [req.user.id, await hashClave(clave)]);
    await q('delete from sesiones where user_id=$1 and token_hash <> $2', [req.user.id, req.tokenHash]);
    res.json({ ok: true });
  }));

  // Consulta periódica del panel: marca al usuario como conectado y devuelve sus chats
  r.get('/estado', h(async (req, res) => {
    await q('update usuarios set ultimo_ping=now() where id=$1', [req.user.id]);
    await autoAsignar();
    const esSup = req.user.rol === 'supervisor';
    const convs = (await q(
      `select ${CAMPOS_CONV},
         (select m.texto from mensajes m where m.conv_id=c.id and m.direccion <> 'sys' order by m.id desc limit 1) as ultimo_texto
       from conversaciones c left join usuarios u on u.id=c.asignado_a
       where c.estado <> 'resuelto' and ($1 or c.asignado_a=$2 or c.estado='pendiente')
       order by c.creado`, [esSup, req.user.id])).rows;
    const out = {
      yo: { id: req.user.id, nombre: req.user.nombre, usuario: req.user.usuario, rol: req.user.rol, disponible: req.user.disponible },
      conversaciones: convs,
    };
    if (esSup) {
      out.equipo = (await q(
        `select u.id, u.nombre, u.rol, u.disponible,
           coalesce(u.ultimo_ping > now() - make_interval(secs => $1), false) as conectado,
           (select count(*)::int from conversaciones c where c.asignado_a=u.id and c.estado='en_atencion') as abiertos
         from usuarios u where u.activo order by u.rol, u.nombre`, [CONECTADO_SEG])).rows;
    }
    res.json(out);
  }));

  r.post('/disponible', h(async (req, res) => {
    await q('update usuarios set disponible=$2 where id=$1', [req.user.id, req.body?.disponible === true]);
    res.json({ ok: true });
  }));

  r.get('/conversaciones/:id/mensajes', h(async (req, res) => {
    const conv = await convPara(req, { resueltas: true });
    if (conv.estado === 'resuelto' && req.user.rol !== 'supervisor' && conv.asignado_a !== req.user.id) {
      throw fallo(403, 'Solo para supervisores.');
    }
    const desde = Number(req.query.desde) || 0;
    // Incluye lo que el propietario habló con el asistente en las 6 horas previas a pedir un operador
    const { rows } = await q(
      `select id, direccion, autor, tipo, texto, (media_id is not null) as tiene_media, creado
       from mensajes
       where telefono=$1 and id > $2
         and creado >= $3::timestamptz - interval '6 hours'
         and ($4::timestamptz is null or creado <= $4::timestamptz + interval '1 minute')
       order by id limit 500`, [conv.telefono, desde, conv.creado, conv.cerrado_en]);
    if (conv.asignado_a === req.user.id && conv.sin_leer > 0) {
      await q('update conversaciones set sin_leer=0 where id=$1', [conv.id]);
    }
    res.json({ conversacion: conv, mensajes: rows });
  }));

  r.post('/conversaciones/:id/tomar', h(async (req, res) => {
    const conv = await convPara(req);
    await enSerie(async () => {
      const actual = (await q('select estado from conversaciones where id=$1', [conv.id])).rows[0];
      if (actual.estado !== 'pendiente') throw fallo(409, 'Otra persona ya tomó este chat.');
      await asignar(conv.id, req.user.id, req.user);
    });
    res.json({ ok: true });
  }));

  r.post('/conversaciones/:id/asignar', soloSupervisor, h(async (req, res) => {
    const conv = await convPara(req);
    const destino = idDe(req.body?.user_id);
    await enSerie(() => asignar(conv.id, destino, req.user));
    res.json({ ok: true });
  }));

  r.post('/conversaciones/:id/responder', h(async (req, res) => {
    const conv = await convPara(req);
    if (conv.asignado_a !== req.user.id) throw fallo(403, 'Para responder, el chat tiene que estar a tu nombre.');
    const texto = String(req.body?.texto || '').trim();
    if (!texto) throw fallo(400, 'El mensaje está vacío.');
    if (texto.length > 4000) throw fallo(400, 'El mensaje es demasiado largo (máximo 4000 caracteres).');
    try {
      await deps.enviarMensaje(conv.telefono, texto, { autor: req.user.nombre, userId: req.user.id });
    } catch (err) {
      throw fallo(502, 'WhatsApp no aceptó el mensaje: ' + errorMeta(err));
    }
    await q('update conversaciones set sin_leer=0 where id=$1', [conv.id]);
    res.json({ ok: true });
  }));

  r.post('/conversaciones/:id/resolver', h(async (req, res) => {
    const conv = await convPara(req);
    if (req.user.rol !== 'supervisor' && conv.asignado_a !== req.user.id) {
      throw fallo(403, 'Para resolverlo, el chat tiene que estar a tu nombre.');
    }
    if (!(await cerrar(conv, req.user.nombre, true))) throw fallo(409, 'La conversación ya fue resuelta.');
    deps.resetSesion(conv.telefono);
    res.json({ ok: true });
  }));

  // Fotos, audios, videos y documentos que mandó el propietario
  r.get('/media/:id', h(async (req, res) => {
    const m = (await q('select telefono, conv_id, media_id from mensajes where id=$1 and media_id is not null', [idDe(req.params.id)])).rows[0];
    if (!m) throw fallo(404, 'No existe ese archivo.');
    if (req.user.rol !== 'supervisor') {
      const c = (await q(
        `select 1 from conversaciones where telefono=$1 and (asignado_a=$2 or estado='pendiente') limit 1`,
        [m.telefono, req.user.id])).rows[0];
      if (!c) throw fallo(403, 'Ese archivo es de una conversación a cargo de otra persona.');
    }
    const auth = { Authorization: `Bearer ${deps.token()}` };
    let info, archivo;
    try {
      info = (await axios.get(`${deps.graph}/${encodeURIComponent(m.media_id)}`, { headers: auth })).data;
      archivo = await axios.get(info.url, { headers: auth, responseType: 'stream' });
    } catch (err) {
      throw fallo(502, 'No se pudo descargar el archivo de WhatsApp (los archivos vencen a los 30 días).');
    }
    const tipo = String(info.mime_type || 'application/octet-stream').split(';')[0];
    const visible = /^(image\/(jpeg|png|webp|gif)|audio\/|video\/)/.test(tipo);
    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', visible ? 'inline' : 'attachment');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    archivo.data.on('error', () => res.destroy());
    archivo.data.pipe(res);
  }));

  // ── Solo supervisores ──

  r.get('/historial', soloSupervisor, h(async (req, res) => {
    const { rows } = await q(
      `select ${CAMPOS_CONV} from conversaciones c left join usuarios u on u.id=c.asignado_a
       where c.estado='resuelto' order by c.cerrado_en desc limit 100`);
    res.json({ conversaciones: rows });
  }));

  r.get('/usuarios', soloSupervisor, h(async (req, res) => {
    const { rows } = await q('select id, usuario, nombre, rol, activo, debe_cambiar, creado from usuarios order by activo desc, rol, nombre');
    res.json({ usuarios: rows });
  }));

  r.post('/usuarios', soloSupervisor, h(async (req, res) => {
    const d = validarUsuario(req.body || {}, true);
    const existe = (await q('select 1 from usuarios where usuario=$1', [d.usuario])).rows[0];
    if (existe) throw fallo(409, 'Ya existe alguien con ese usuario.');
    await q('insert into usuarios (usuario, nombre, rol, clave_hash) values ($1,$2,$3,$4)',
      [d.usuario, d.nombre, d.rol, await hashClave(d.clave)]);
    res.json({ ok: true });
  }));

  r.patch('/usuarios/:id', soloSupervisor, h(async (req, res) => {
    const id = idDe(req.params.id);
    const u = (await q('select * from usuarios where id=$1', [id])).rows[0];
    if (!u) throw fallo(404, 'No existe ese usuario.');
    const d = validarUsuario({ nombre: req.body?.nombre, rol: req.body?.rol });
    const nuevoActivo = typeof req.body?.activo === 'boolean' ? req.body.activo : u.activo;
    const nuevoRol = d.rol || u.rol;
    const pierdeSupervisor = u.rol === 'supervisor' && u.activo && (nuevoRol !== 'supervisor' || !nuevoActivo);
    if (pierdeSupervisor && id === req.user.id) throw fallo(400, 'No podés darte de baja ni quitarte el perfil de supervisor a vos mismo.');
    if (pierdeSupervisor && !(await quedaOtroSupervisor(id))) throw fallo(400, 'Tiene que quedar al menos un supervisor activo.');

    await q('update usuarios set nombre=$2, rol=$3, activo=$4 where id=$1', [id, d.nombre || u.nombre, nuevoRol, nuevoActivo]);
    if (u.activo && !nuevoActivo) {
      // Baja: se cierra su sesión y sus chats vuelven a la cola
      await q('delete from sesiones where user_id=$1', [id]);
      const suyos = (await q(`update conversaciones set estado='pendiente', asignado_a=null where asignado_a=$1 and estado='en_atencion' returning id, telefono`, [id])).rows;
      for (const c of suyos) await nota(c, `${u.nombre} fue dado de baja; el chat volvió a la cola`);
      await autoAsignar();
    }
    res.json({ ok: true });
  }));

  r.post('/usuarios/:id/clave', soloSupervisor, h(async (req, res) => {
    const id = idDe(req.params.id);
    const { clave } = validarUsuario({ clave: req.body?.clave });
    const r2 = await q('update usuarios set clave_hash=$2, debe_cambiar=true where id=$1 returning id', [id, await hashClave(clave)]);
    if (!r2.rows[0]) throw fallo(404, 'No existe ese usuario.');
    await q('delete from sesiones where user_id=$1 and token_hash <> $2', [id, req.tokenHash]);
    res.json({ ok: true });
  }));

  r.use((req, res) => res.status(404).json({ error: 'No existe.' }));

  r.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status === 500) console.error('Panel:', err);
    if (res.headersSent) return res.destroy();
    res.status(status).json({ error: status === 500 ? 'Error interno del panel.' : err.message, codigo: err.codigo });
  });

  return r;
}

// ── Arranque ──────────────────────────────────────────────────────────────────

async function montar(app, dependencias) {
  deps = dependencias;
  const pagina = path.join(__dirname, 'panel.html');

  app.get('/panel', (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.sendFile(pagina);
  });

  if (!process.env.DATABASE_URL) {
    console.log('Panel desactivado: falta la variable DATABASE_URL.');
    app.use('/panel/api', (req, res) => res.status(503).json({ error: 'El panel todavía no está configurado (falta la base de datos).' }));
    return;
  }

  const nuevo = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  nuevo.on('error', err => console.error('Panel: error de la base de datos:', err.message));
  try {
    await nuevo.query(ESQUEMA);
    pool = nuevo;
    await sembrarUsuarios();
    console.log('Panel de atención listo en /panel');
  } catch (err) {
    pool = null;
    app.use('/panel/api', (req, res) => res.status(503).json({ error: 'El panel no pudo conectarse a la base de datos.' }));
    throw err;
  }
  app.use('/panel/api', rutas());
}

module.exports = { montar, registrarEntrante, registrarSaliente, derivar, cerrarPorPropietario };
