require("dotenv").config();
const fs = require("fs");
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
const smallJson = express.json({ limit: "10kb" });
app.use((req, res, next) => (req.path.endsWith("/proof") ? next() : smallJson(req, res, next)));
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

const pub = ({ requesterId, proofFile, ...rest }) => ({ ...rest, hasProof: !!proofFile });

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

  if (!user) {
    return res.status(404).json({
      error: "No account found with that email. Click Create an account to sign up.",
      code: "no_account"
    });
  }
  const ok = user.role === role && (await bcrypt.compare(String(password), user.passwordHash));
  if (!ok) return fail(res, 401, "Wrong password or role.");
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

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

app.get("/api/requests/mine", auth, only("Student", "Professor"), (req, res) => {
  const wantHistory = req.query.scope === "history";
  const cutoff = startOfToday();
  res.json(
    db.data.requests
      .filter(r => r.requesterId === req.user.id && (new Date(r.createdAt) >= cutoff) !== wantHistory)
      .reverse()
      .slice(0, 100)
      .map(pub)
  );
});

// Pending requests from earlier days can no longer be acted on, so mark them expired
function expireOld() {
  const cutoff = startOfToday();
  let changed = false;
  for (const r of db.data.requests) {
    if (r.status === "pending" && new Date(r.createdAt) < cutoff) {
      r.status = "expired";
      r.expiredAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) db.save();
}
expireOld();                        // on startup
setInterval(expireOld, 60 * 1000);  // every minute, so midnight is caught

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
  expireOld();
  const cutoff = startOfToday();
  const earlier = req.query.scope === "earlier";
  res.json(
    db.data.requests
      .filter(r => r.status !== "pending" && (new Date(r.createdAt) < cutoff) === earlier)
      .reverse()
      .slice(0, 100)
      .map(pub)
  );
});

const NEXT = { pending: ["approved", "denied"] };

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

/* ---------- Proof photos ---------- */
const PROOF_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(PROOF_DIR, { recursive: true });

// Guard completes an approved request by uploading a photo
app.post("/api/requests/:id/proof", auth, only("Guard"), express.json({ limit: "2mb" }), (req, res) => {
  const request = db.data.requests.find(r => r.id === req.params.id);
  if (!request) return fail(res, 404, "Request not found.");
  if (request.status !== "approved") return fail(res, 409, "Only approved requests can be completed.");

  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec((req.body || {}).image || "");
  if (!m) return fail(res, 400, "Upload a JPEG photo.");
  const buf = Buffer.from(m[1], "base64");
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isJpeg || buf.length < 1000 || buf.length > 1.5 * 1024 * 1024) {
    return fail(res, 400, "That photo is not valid or is too large.");
  }

  const file = `${request.id}.jpg`;
  fs.writeFileSync(path.join(PROOF_DIR, file), buf);
  request.proofFile = file;
  request.status = "completed";
  request.completedBy = req.user.email;
  request.completedAt = new Date().toISOString();
  db.save();
  res.json(pub(request));
});

// Only guards and the person who made the request can view the photo
app.get("/api/requests/:id/proof", auth, (req, res) => {
  const r = db.data.requests.find(x => x.id === req.params.id);
  if (!r || !r.proofFile) return fail(res, 404, "No proof photo.");
  if (req.user.role !== "Guard" && r.requesterId !== req.user.id) return fail(res, 403, "Not allowed.");
  res.type("image/jpeg").sendFile(path.join(PROOF_DIR, r.proofFile));
});

/* ---------- Profile ---------- */
app.get("/api/me", auth, (req, res) => {
  const u = db.data.users.find(x => x.id === req.user.id);
  if (!u) return fail(res, 404, "Account not found.");
  const mine = u.role === "Guard"
    ? db.data.requests.filter(r => r.handledBy === u.email)
    : db.data.requests.filter(r => r.requesterId === u.id);
  const count = s => mine.filter(r => r.status === s).length;
  res.json({
    email: u.email, role: u.role, createdAt: u.createdAt, total: mine.length,
    approved: count("approved"), completed: count("completed"),
    denied: count("denied"), expired: count("expired")
  });
});

/* ---------- Fallbacks ---------- */
app.use("/api", (req, res) => fail(res, 404, "Unknown endpoint."));
app.use((err, req, res, next) => {
  console.error(err);
  fail(res, err.status || 500, err.status ? "Invalid request." : "Something went wrong.");
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));