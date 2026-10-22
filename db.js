// Minimal JSON-file storage. Swap this module for SQLite/MySQL/MongoDB later;
// server.js only touches db.data and db.save().
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data.json");
const data = { users: [], requests: [] };

if (fs.existsSync(FILE)) {
  Object.assign(data, JSON.parse(fs.readFileSync(FILE, "utf8")));
}

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE); // atomic replace, avoids half-written files
}

module.exports = { data, save };