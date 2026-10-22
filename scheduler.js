// Campus map in meters on a simple grid. Replace with your campus's real measurements.
const ROOMS = [
  { id: "GP",   name: "Guard Post (Main Gate)", x: 0,   y: 0   },
  { id: "A101", name: "Building A - Room 101",  x: 60,  y: 40  },
  { id: "A204", name: "Building A - Room 204",  x: 65,  y: 45  },
  { id: "B110", name: "Building B - Room 110",  x: 180, y: 30  },
  { id: "B305", name: "Building B - Room 305",  x: 185, y: 35  },
  { id: "C201", name: "Building C - Room 201",  x: 120, y: 160 },
  { id: "LAB1", name: "Computer Lab 1",         x: 220, y: 140 },
  { id: "LIB",  name: "Library Study Room",     x: 90,  y: 100 }
];
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