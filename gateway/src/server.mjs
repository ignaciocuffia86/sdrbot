// Servidor local para desarrollo y pruebas: el mismo enrutador que en Vercel.
import http from 'node:http';
import { handle } from './app.mjs';

export function startServer(port = Number(process.env.PORT ?? 8787), host = '127.0.0.1') {
  const server = http.createServer((req, res) => { handle(req, res); });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer();
  console.log(`mail gateway en http://127.0.0.1:${s.address().port}`);
}
