'use strict';
// Used by the Docker HEALTHCHECK: the distroless runtime image has no shell or curl.
const http = require('node:http');

const req = http.get({ host: '127.0.0.1', port: process.env.PORT || 8080, path: '/healthz', timeout: 2000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
