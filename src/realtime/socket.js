const { Server } = require("socket.io");
const { logger } = require("../config/logger");

let io = null;

function initSocket(server, corsOrigins) {
  io = new Server(server, {
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const tenantId = socket.handshake.auth?.tenantId || socket.handshake.query?.tenantId || "default";
    const employeeId = socket.handshake.auth?.employeeId || socket.handshake.query?.employeeId;

    socket.join(`tenant:${tenantId}`);
    if (employeeId) socket.join(`tenant:${tenantId}:employee:${employeeId}`);

    socket.on("join:employee", (id) => {
      if (id) socket.join(`tenant:${tenantId}:employee:${id}`);
    });

    logger.info(`socket connected ${socket.id} tenant=${tenantId}`);
  });

  return io;
}

function emitTenant(tenantId, event, payload) {
  if (!io) return;
  io.to(`tenant:${tenantId || "default"}`).emit(event, payload);
}

function emitEmployee(tenantId, employeeId, event, payload) {
  if (!io || !employeeId) return;
  io.to(`tenant:${tenantId || "default"}:employee:${employeeId}`).emit(event, payload);
}

module.exports = { initSocket, emitTenant, emitEmployee };
