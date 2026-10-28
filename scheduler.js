// Campus map in meters on a simple grid. Replace with your campus's real measurements.
const ROOMS = [
  { id: "GP", building: null, label: "Guard Post (Main Gate)", x: 0, y: 0 },

  // New Bldg
  { id: "NEW-201", building: "New Bldg", label: "Room 201", x: 60, y: 40 },
  { id: "NEW-202", building: "New Bldg", label: "Room 202", x: 65, y: 42 },
  { id: "NEW-203", building: "New Bldg", label: "Room 203", x: 62, y: 44 },
  { id: "NEW-204", building: "New Bldg", label: "Room 204", x: 62, y: 44 },
  { id: "NEW-205", building: "New Bldg", label: "Room 205", x: 62, y: 44 },
  { id: "NEW-301", building: "New Bldg", label: "Room 301", x: 62, y: 44 },
  { id: "NEW-302", building: "New Bldg", label: "Room 302", x: 62, y: 44 },
  { id: "NEW-303", building: "New Bldg", label: "Room 303", x: 62, y: 44 },
  { id: "NEW-304", building: "New Bldg", label: "Room 304", x: 62, y: 44 },
  { id: "NEW-305", building: "New Bldg", label: "Room 305", x: 62, y: 44 },
  { id: "NEW-401", building: "New Bldg", label: "Room 401", x: 62, y: 44 },
  { id: "NEW-402", building: "New Bldg", label: "Room 402", x: 62, y: 44 },
  { id: "NEW-403", building: "New Bldg", label: "Room 403", x: 62, y: 44 },
  { id: "NEW-404", building: "New Bldg", label: "Room 404", x: 62, y: 44 },
  { id: "NEW-405", building: "New Bldg", label: "Room 405", x: 62, y: 44 },
  { id: "NEW-501", building: "New Bldg", label: "Room 501", x: 62, y: 44 },
  { id: "NEW-502", building: "New Bldg", label: "Room 502", x: 62, y: 44 },
  { id: "NEW-503", building: "New Bldg", label: "Room 503", x: 62, y: 44 },
  { id: "NEW-504", building: "New Bldg", label: "Room 504", x: 62, y: 44 },
  { id: "NEW-505", building: "New Bldg", label: "Room 505", x: 62, y: 44 },

  // Old Bldg
  { id: "OLD-1", building: "Old Bldg", label: "CL 1", x: 180, y: 90 },
  { id: "OLD-2", building: "Old Bldg", label: "CL 2", x: 180, y: 90 },
  { id: "OLD-3", building: "Old Bldg", label: "CL 3", x: 180, y: 90 },
  { id: "OLD-4", building: "Old Bldg", label: "CL 4", x: 180, y: 90 },
  { id: "OLD-5", building: "Old Bldg", label: "CL 5", x: 180, y: 90 },
  { id: "OLD-6", building: "Old Bldg", label: "CL 6", x: 180, y: 90 },
  { id: "OLD-7", building: "Old Bldg", label: "CL 7", x: 180, y: 90 },
  { id: "OLD-8", building: "Old Bldg", label: "CL 8", x: 180, y: 90 },
  { id: "OLD-110", building: "Old Bldg", label: "Room 110", x: 180, y: 90 },
  { id: "OLD-111", building: "Old Bldg", label: "Room 111", x: 180, y: 90 },
  { id: "OLD-112", building: "Old Bldg", label: "Room 112", x: 185, y: 92 },
  { id: "OLD-113", building: "Old Bldg", label: "Room 113", x: 182, y: 94 },
  { id: "OLD-114", building: "Old Bldg", label: "Room 114", x: 180, y: 90 },
  { id: "OLD-115", building: "Old Bldg", label: "Room 115", x: 180, y: 90 },
  { id: "OLD-116", building: "Old Bldg", label: "Room 116", x: 180, y: 90 },
  { id: "OLD-117", building: "Old Bldg", label: "Room 117", x: 180, y: 90 },
  { id: "OLD-118", building: "Old Bldg", label: "Room 118", x: 180, y: 90 },
  { id: "OLD-119", building: "Old Bldg", label: "Room 119", x: 180, y: 90 },
  { id: "OLD-120", building: "Old Bldg", label: "Room 120", x: 180, y: 90 },
  { id: "OLD-121", building: "Old Bldg", label: "Room 121", x: 180, y: 90 },
  { id: "OLD-122", building: "Old Bldg", label: "Room 122", x: 180, y: 90 },
];
// Full display name, e.g. "New Bldg - Room 101" (used on the guard's page)
ROOMS.forEach(r => { r.name = r.building ? `${r.building} - ${r.label}` : r.label; });
const WALK_SPEED = 1.4; // meters per second

const roomById = id => ROOMS.find(r => r.id === id);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Greedy nearest-neighbour route with aging.
 * cost = distance(current stop -> room) - agingWeight * minutes waiting
 * The lowest cost goes next; the guard "moves" there and the step repeats.
 */
function buildSchedule(pending, startRoom, agingWeight, now = Date.now()) {
  const route = [];
  let current = startRoom;
  let elapsed = 0;
  let left = [...pending];

  while (left.length) {
    let best = null;
    for (const r of left) {
      const d = dist(current, roomById(r.roomId));
      const waitMin = (now - new Date(r.createdAt)) / 60000;
      const cost = d - agingWeight * waitMin;
      if (!best || cost < best.cost) best = { req: r, leg: d, cost };
    }
    elapsed += best.leg / WALK_SPEED;
    route.push({ req: best.req, leg: best.leg, eta: elapsed });
    current = roomById(best.req.roomId);
    left = left.filter(x => x.id !== best.req.id);
  }
  return route;
}

module.exports = { ROOMS, roomById, buildSchedule };