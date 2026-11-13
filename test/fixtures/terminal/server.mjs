// A long-running server: announces itself after a moment, then logs requests until interrupted.
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  console.log(`GET ${req.url}`);
  res.end('ok');
});
console.log('starting server...');
setTimeout(() => server.listen(0, '127.0.0.1', () => console.log(`Listening on http://127.0.0.1:${server.address().port}`)), 1500);
process.on('SIGINT', () => {
  console.log('shutting down');
  process.exit(130);
});
