# NovaLink Live server — production container image.
#
# The server is dependency-free Node 22+ (uses node:sqlite, node:http, and a
# hand-rolled RFC 6455 WebSocket), so this image has no `npm install` step at
# all. The base is `node:22-slim` for a small attack surface; non-root `node`
# user; persistent data mounted at /data.
#
# Build locally:   docker build -t novacode-link-server ./link-server
# Run locally:     docker run --rm -p 8790:8790 -v link-data:/data novacode-link-server
#
# Deployment (fly.io / render.com / Railway) is documented in DEPLOYMENT.md.

FROM node:22-slim

ENV NODE_ENV=production \
    LINK_HOST=0.0.0.0 \
    LINK_PORT=8790 \
    LINK_DATA_DIR=/data \
    LINK_TRUST_PROXY=1 \
    LINK_ALLOW_PLAINTEXT=0

WORKDIR /srv/app

# Copy the server source (CommonJS, no compile step). We do not run `npm ci`
# because the package declares no runtime dependencies; the file list here is
# what server.js actually requires.
COPY package.json server.js config.js db.js logger.js validate.js ./
COPY accounts.js attachments.js calls.js chat.js connections.js credentials.js ./
COPY events.js http.js hub.js presence.js rateLimit.js routes.js ./
# Some copies of the repo split WS handling into ws.js; include both if present
# by copying everything else. This keeps the image build tolerant of refactors.
COPY *.js ./
# The classroom admin dashboard is a single self-contained HTML file served at
# /admin (see server.js). It is not a .js file, so it must be copied explicitly
# or the route returns "Admin UI not found."
COPY admin-ui.html ./

# Writable mount point for the SQLite database + uploaded files.
RUN mkdir -p /data && chown -R node:node /data /srv/app
USER node

EXPOSE 8790

# Health check hits the /health endpoint link-server already exposes. curl is
# not installed on slim images, so we use `node -e` to keep the base image tiny.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.LINK_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
