const http = require('http');
const enviados = [];
let fallar = false;
http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (req.url === '/_enviados') { res.end(JSON.stringify(enviados.splice(0))); return; }
    if (req.url === '/_fallar') { fallar = b === '1'; res.end('ok'); return; }
    if (req.url.endsWith('/messages')) {
      if (fallar) { res.statusCode = 400; res.end(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } })); return; }
      const j = JSON.parse(b); enviados.push({ to: j.to, texto: j.text.body });
      res.end(JSON.stringify({ messages: [{ id: 'wamid.x' }] })); return;
    }
    if (req.url === '/MEDIA1') { res.end(JSON.stringify({ url: 'http://localhost:5600/bin', mime_type: 'image/png' })); return; }
    if (req.url === '/bin') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')); return; }
    res.statusCode = 404; res.end('{}');
  });
}).listen(5600);
