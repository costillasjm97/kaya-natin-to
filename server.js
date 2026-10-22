require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const { ROOMS, roomById, buildSchedule } = require("./scheduler");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("JWT_SECRET is not set. Using a temporary secret; everyone is signed out on restart.");
}

const ROLES = ["Student", "Professor", "Guard"];
// Staff roles need an invite code so nobody can register themselves as a guard.
const INVITE = { Professor: process.env.PROFESSOR_INVITE_CODE, Guard: process.env.GUARD_INVITE_CODE };
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "cvsu.edu.ph").toLowerCase();
const emailAllowed = (e, role) => role === "Guard" || e.split("@").pop() === DOMAIN;

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { error: "Too many attempts. Try again in a few minutes." }
});

/* ---------- Auth helpers ---------- */
const session = u => ({
  token: jwt.sign({ id: u.id, email: u.email, role: u.role }, SECRET, { expiresIn: "8h" }),
  user: { email: u.email, role: u.role }
});

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  try {
    req.user = jwt.verify(h.startsWith("Bearer ") ? h.slice(7) : "", SECRET);
    next();
  } catch {
    fail(res, 401, "Please sign in again.");
  }
}
const only = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : fail(res, 403, "Not allowed for your role.");

const pub = ({ requesterId, ...rest }) => rest; // never send internal ids to the client

/* ---------- Auth routes ---------- */
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { email = "", password = "", role = "", inviteCode = "" } = req.body || {};
  const e = String(email).trim().toLowerCase();

  if (!/^\S+@\S+\.\S+$/.test(e)) return fail(res, 400, "Enter a valid email address.");
  if (!emailAllowed(e, role)) return fail(res, 400, `Use your @${DOMAIN} email address.`);
  if (String(password).length < 8) return fail(res, 400, "Password must be at least 8 characters.");
  if (!ROLES.includes(role)) return fail(res, 400, "Choose a valid role.");
  if (role !== "Student" && (!INVITE[role] || inviteCode !== INVITE[role])) {
    return fail(res, 403, `A valid ${role} invite code is required.`);
  }
  if (db.data.users.some(u => u.email === e)) return fail(res, 409, "That email is already registered.");

  const user = {
    id: crypto.randomUUID(),
    email: e,
    role,
    passwordHash: await bcrypt.hash(String(password), 10),
    createdAt: new Date().toISOString()
  };
  db.data.users.push(user);
  db.save();
  res.status(201).json(session(user));
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { email = "", password = "", role = "" } = req.body || {};
  const user = db.data.users.find(u => u.email === String(email).trim().toLowerCase());
  const ok = user && user.role === role && (await bcrypt.compare(String(password), user.passwordHash));
  if (!ok) return fail(res, 401, "Wrong email, password or role.");
  res.json(session(user));
});

/* ---------- Rooms ---------- */
app.get("/api/rooms", auth, (req, res) => res.json(ROOMS));

/* ---------- Requests: Student / Professor ---------- */
app.post("/api/requests", auth, only("Student", "Professor"), (req, res) => {
  const { roomId, neededAt, reason = "" } = req.body || {};
  const text = String(reason).trim();

  if (!roomById(roomId) || roomId === "GP") return fail(res, 400, "Choose a classroom.");
  if (!text || text.length > 300) return fail(res, 400, "Add a reason (up to 300 characters).");

  const open = db.data.requests.filter(r => r.requesterId === req.user.id && r.status === "pending");
  if (open.length >= 5) return fail(res, 429, "You already have 5 pending requests.");

  const request = {
    id: crypto.randomUUID(),
    requesterId: req.user.id,
    requester: req.user.email,
    role: req.user.role,
    roomId,
    neededAt: String(neededAt || "").slice(0, 20) || "As soon as possible",
    reason: text,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  db.data.requests.push(request);
  db.save();
  res.status(201).json(pub(request));
});

app.get("/api/requests/mine", auth, only("Student", "Professor"), (req, res) => {
  res.json(
    db.data.requests
      .filter(r => r.requesterId === req.user.id)
      .reverse()
      .map(pub)
  );
});

/* ---------- Guard: schedule, history, decisions ---------- */
app.get("/api/schedule", auth, only("Guard"), (req, res) => {
  const start = roomById(req.query.start) || roomById("GP");
  const weight = req.query.weight === undefined ? 5 : Math.max(0, Number(req.query.weight) || 0);
  const pending = db.data.requests.filter(r => r.status === "pending");
  const route = buildSchedule(pending, start, weight).map(s => ({
    request: pub(s.req),
    leg: s.leg,
    eta: s.eta
  }));
  res.json({ route });
});

app.get("/api/requests/history", auth, only("Guard"), (req, res) => {
  res.json(
    db.data.requests
      .filter(r => r.status !== "pending")
      .reverse()
      .slice(0, 100)
      .map(pub)
  );
});

const NEXT = { pending: ["approved", "denied"], approved: ["completed"] };

app.patch("/api/requests/:id", auth, only("Guard"), (req, res) => {
  const request = db.data.requests.find(r => r.id === req.params.id);
  if (!request) return fail(res, 404, "Request not found.");

  const status = (req.body || {}).status;
  if (!(NEXT[request.status] || []).includes(status)) {
    return fail(res, 409, `A ${request.status} request cannot become ${status}.`);
  }
  request.status = status;
  request.handledBy = req.user.email;
  request.handledAt = new Date().toISOString();
  db.save();
  res.json(pub(request));
});

/* ---------- Fallbacks ---------- */
app.use("/api", (req, res) => fail(res, 404, "Unknown endpoint."));
app.use((err, req, res, next) => {
  console.error(err);
  fail(res, err.status || 500, err.status ? "Invalid request." : "Something went wrong.");
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));