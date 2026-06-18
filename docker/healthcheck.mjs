import net from 'node:net';

const host = process.env.AIRLOCK_HEALTH_HOST || '127.0.0.1';
const port = Number(process.env.AIRLOCK_HEALTH_PORT || process.env.PORT || 4111);
const timeoutMs = Number(process.env.AIRLOCK_HEALTH_TIMEOUT_MS || 3000);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.exit(1);
}

const socket = net.createConnection({ host, port });
socket.setTimeout(timeoutMs);

const fail = () => {
  socket.destroy();
  process.exit(1);
};

socket.once('connect', () => {
  socket.end();
  process.exit(0);
});
socket.once('timeout', fail);
socket.once('error', fail);
