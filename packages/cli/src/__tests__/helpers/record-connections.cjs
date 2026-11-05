// Loaded with node --require: records every outbound socket the process opens, one "host:port" per
// line, into the file named by GAUGELINE_RECORD_CONNECTIONS. Used by no-phone-home.test.ts (ADR-0003).
const fs = require("node:fs");
const net = require("node:net");

const file = process.env.GAUGELINE_RECORD_CONNECTIONS;
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = args[0];
  const opts = Array.isArray(first) ? first[0] : first;
  const target =
    opts !== null && typeof opts === "object"
      ? `${opts.host ?? "localhost"}:${opts.port ?? opts.path ?? ""}`
      : `${args[1] ?? "localhost"}:${opts}`;
  if (file) fs.appendFileSync(file, `${target}\n`);
  return original.apply(this, args);
};
