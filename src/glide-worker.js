/* Terrain-routed glide solver. Runs in a Worker: a wavefront over a 100 km radius is far too
 * much arithmetic to do on the thread that has to keep the field list scrolling.
 *
 * A classic worker on purpose, not a module one — this ships to phones and tablets in cockpits,
 * and classic workers are the version every one of them supports.
 *
 * WHAT IT ANSWERS
 * For each candidate field: the lowest glide ratio that actually gets you there, following a
 * path that stays clear of the ground, rather than the ratio along a straight line that may go
 * through a ridge (or, just as wrong, around a corner the straight line said was hopeless).
 *
 * HOW
 * At a fixed glide ratio G, altitude after s metres of flight is alt - s/G, so keeping the
 * required clearance over a cell is the condition s <= G * (alt - terrain - clearance). Smaller s
 * is better for everything downstream, so a plain Dijkstra minimising path length, refusing to
 * enter a cell that fails that test, finds every field reachable at G. Reachability only grows
 * with G, so the ladder climbs until each field is answered.
 *
 * The rung is not the answer, only the bracket. Once a field is reached, the path itself is
 * evaluated exactly: the required ratio is max(s(x) / (alt - terrain(x) - clearance)) over the
 * path, which is a real number rather than a rung. The cell where that maximum falls is the
 * point that actually constrains the glide — the col, or the shoulder you have to clear — and
 * that is what the app shows.
 *
 * Three candidate paths are evaluated and the best one wins: the straight line, the grid path,
 * and the grid path after string-pulling. All three are flyable, so taking the minimum is
 * honest, and including the straight line means flat country returns exactly the straight-line
 * answer instead of a number inflated by the grid's staircase.
 */

'use strict';

var NODATA = -32768;
// Rungs, not a continuous search: each one costs a full wavefront. Tight at the bottom where
// most fields resolve and most of the decisions are made, coarse above 30 where the answer is
// "you are not gliding there in anything" long before the exact figure matters.
var DEFAULT_LADDER = [8, 10, 12, 14, 17, 20, 24, 28, 33, 40, 50, 65];

// --- binary min-heap over cell indices, keyed by path length ----------------------------------

function Heap(capacity) {
  this.items = new Int32Array(capacity);
  this.keys = new Float64Array(capacity);
  this.size = 0;
}

Heap.prototype.push = function (item, key) {
  if (this.size === this.items.length) {
    var grownItems = new Int32Array(this.items.length * 2);
    var grownKeys = new Float64Array(this.keys.length * 2);
    grownItems.set(this.items);
    grownKeys.set(this.keys);
    this.items = grownItems;
    this.keys = grownKeys;
  }
  var i = this.size++;
  this.items[i] = item;
  this.keys[i] = key;
  while (i > 0) {
    var parent = (i - 1) >> 1;
    if (this.keys[parent] <= this.keys[i]) break;
    this.swap(parent, i);
    i = parent;
  }
};

Heap.prototype.pop = function () {
  var top = this.items[0];
  this.size -= 1;
  if (this.size > 0) {
    this.items[0] = this.items[this.size];
    this.keys[0] = this.keys[this.size];
    var i = 0;
    for (;;) {
      var left = 2 * i + 1;
      var right = left + 1;
      var smallest = i;
      if (left < this.size && this.keys[left] < this.keys[smallest]) smallest = left;
      if (right < this.size && this.keys[right] < this.keys[smallest]) smallest = right;
      if (smallest === i) break;
      this.swap(smallest, i);
      i = smallest;
    }
  }
  return top;
};

Heap.prototype.swap = function (a, b) {
  var item = this.items[a]; this.items[a] = this.items[b]; this.items[b] = item;
  var key = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = key;
};

// --- the solver -------------------------------------------------------------------------------

function Solver(request) {
  var grid = request.grid;
  this.rows = grid.rows;
  this.cols = grid.cols;
  this.elevations = new Int16Array(grid.elevations);
  this.north = grid.north;
  this.west = grid.west;
  this.latStepDeg = grid.latStepDeg;
  this.lonStepDeg = grid.lonStepDeg;
  this.cellNorthM = grid.cellNorthM;
  this.cellEastM = grid.cellEastM;

  this.altitudeM = request.altitudeM;
  this.clearanceM = request.clearanceM;
  this.safetyMarginM = request.safetyMarginM;

  this.count = this.rows * this.cols;
  this.dist = new Float64Array(this.count);
  this.prev = new Int32Array(this.count);
  this.visited = new Uint8Array(this.count);

  // Where the glider is. Its own cell is exempt from the clearance test: the max-pooled cell it
  // stands in may well be higher than the glider, and refusing to start is never the right answer.
  this.origin = this.indexFor(request.latitude, request.longitude);

  // A field's own cell is exempt too. The pack's surveyed elevation is a better datum for a
  // landing field than a cell that max-pools the hillside behind it, and the constraint there is
  // arriving above the field with the safety margin, not clearing terrain you are landing on.
  this.targets = request.targets.map(function (target) {
    return {
      id: target.id,
      latitude: target.latitude,
      longitude: target.longitude,
      elevationM: target.elevationM,
      index: this.indexFor(target.latitude, target.longitude),
      floorM: target.elevationM + this.safetyMarginM,
    };
  }, this);
  this.targetFloor = new Float64Array(this.count).fill(NaN);
  for (var i = 0; i < this.targets.length; i += 1) {
    var target = this.targets[i];
    if (target.index < 0) continue;
    // Two fields in one cell: the lower floor wins, so neither is refused entry on the other's
    // account. Each is still scored against its own elevation afterwards.
    var existing = this.targetFloor[target.index];
    if (isNaN(existing) || target.floorM < existing) this.targetFloor[target.index] = target.floorM;
  }
}

Solver.prototype.indexFor = function (latitude, longitude) {
  var row = Math.floor((this.north - latitude) / this.latStepDeg);
  var col = Math.floor((longitude - this.west) / this.lonStepDeg);
  if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return -1;
  return row * this.cols + col;
};

Solver.prototype.latLonOf = function (index) {
  var row = (index / this.cols) | 0;
  var col = index - row * this.cols;
  return {
    latitude: this.north - (row + 0.5) * this.latStepDeg,
    longitude: this.west + (col + 0.5) * this.lonStepDeg,
  };
};

/** Height available over a cell before the clearance floor: negative means the ground is in the way. */
Solver.prototype.headroomAt = function (index) {
  var floor = this.targetFloor[index];
  if (!isNaN(floor)) return this.altitudeM - floor;
  var terrain = this.elevations[index];
  if (terrain === NODATA) return NaN;   // unknown ground: not passable, not a hard refusal either
  return this.altitudeM - terrain - this.clearanceM;
};

/**
 * One wavefront at glide ratio G. Fills dist/prev with the shortest flyable path length to every
 * cell reachable at that ratio; unreachable cells keep Infinity.
 */
Solver.prototype.flood = function (glideRatio) {
  this.dist.fill(Infinity);
  this.prev.fill(-1);
  this.visited.fill(0);
  if (this.origin < 0) return;

  var heap = new Heap(1024);
  this.dist[this.origin] = 0;
  heap.push(this.origin, 0);

  var cols = this.cols;
  var rows = this.rows;
  var dx = this.cellEastM;
  var dy = this.cellNorthM;
  var diagonal = Math.sqrt(dx * dx + dy * dy);
  // dRow, dCol, cost — the eight neighbours of a cell.
  var steps = [
    [-1, 0, dy], [1, 0, dy], [0, -1, dx], [0, 1, dx],
    [-1, -1, diagonal], [-1, 1, diagonal], [1, -1, diagonal], [1, 1, diagonal],
  ];

  while (heap.size > 0) {
    var current = heap.pop();
    if (this.visited[current]) continue;
    this.visited[current] = 1;
    var here = this.dist[current];
    var row = (current / cols) | 0;
    var col = current - row * cols;

    for (var s = 0; s < 8; s += 1) {
      var nextRow = row + steps[s][0];
      var nextCol = col + steps[s][1];
      if (nextRow < 0 || nextCol < 0 || nextRow >= rows || nextCol >= cols) continue;
      var next = nextRow * cols + nextCol;
      if (this.visited[next]) continue;

      var candidate = here + steps[s][2];
      if (candidate >= this.dist[next]) continue;
      // The whole terrain constraint, in one line: at glide ratio G you arrive over this cell
      // alt - candidate/G high, and that must clear its floor.
      var headroom = this.headroomAt(next);
      if (!(headroom > 0) || candidate > glideRatio * headroom) continue;

      this.dist[next] = candidate;
      this.prev[next] = current;
      heap.push(next, candidate);
    }
  }
};

/**
 * Walk one straight segment at cell resolution, carrying the distance already flown, and report
 * the worst distance-to-headroom ratio met along it. `skipLast` leaves the destination cell to
 * the caller, which scores it against the field rather than as terrain to clear.
 *
 * Returns null when the segment crosses ground that cannot be cleared at any ratio — either the
 * glider is already below it, or the cell has no terrain data and is therefore not a cell this
 * solver is willing to promise anything about.
 */
Solver.prototype.walkSegment = function (fromIndex, toIndex, travelledM, skipLast) {
  var cols = this.cols;
  var fromRow = (fromIndex / cols) | 0;
  var fromCol = fromIndex - fromRow * cols;
  var toRow = (toIndex / cols) | 0;
  var toCol = toIndex - toRow * cols;

  var stepCount = Math.max(Math.abs(toRow - fromRow), Math.abs(toCol - fromCol));
  var result = { travelledM: travelledM, worst: 0, worstIndex: -1 };
  if (stepCount === 0) return result;

  var deltaNorthM = (toRow - fromRow) * this.cellNorthM;
  var deltaEastM = (toCol - fromCol) * this.cellEastM;
  var perStepM = Math.sqrt(deltaNorthM * deltaNorthM + deltaEastM * deltaEastM) / stepCount;

  for (var step = 1; step <= stepCount; step += 1) {
    result.travelledM += perStepM;
    if (skipLast && step === stepCount) break;
    var row = Math.round(fromRow + (toRow - fromRow) * step / stepCount);
    var col = Math.round(fromCol + (toCol - fromCol) * step / stepCount);
    var index = row * cols + col;
    var headroom = this.headroomAt(index);
    if (!(headroom > 0)) return null;
    var ratio = result.travelledM / headroom;
    if (ratio > result.worst) { result.worst = ratio; result.worstIndex = index; }
  }
  return result;
};

/**
 * Score a whole polyline of cell indices as a real glide. The required ratio is the worst ratio
 * of distance-flown to headroom-available anywhere along it, including the arrival over the
 * field itself — that worst point is what the glide is genuinely limited by.
 */
Solver.prototype.evaluate = function (nodes, target) {
  var travelled = 0;
  var worst = 0;
  var worstIndex = -1;

  for (var n = 0; n + 1 < nodes.length; n += 1) {
    var leg = this.walkSegment(nodes[n], nodes[n + 1], travelled, n + 2 === nodes.length);
    if (!leg) return null;
    travelled = leg.travelledM;
    if (leg.worst > worst) { worst = leg.worst; worstIndex = leg.worstIndex; }
  }

  var arrivalHeadroom = this.altitudeM - target.elevationM - this.safetyMarginM;
  if (!(arrivalHeadroom > 0)) return null;
  var arrivalRatio = travelled / arrivalHeadroom;
  if (arrivalRatio > worst) { worst = arrivalRatio; worstIndex = -1; }

  return { ratio: worst, lengthM: travelled, criticalIndex: worstIndex };
};

/** Walk back up the predecessor tree from a reached cell. */
Solver.prototype.pathTo = function (index) {
  var path = [];
  for (var at = index; at !== -1; at = this.prev[at]) {
    path.push(at);
    if (at === this.origin) break;
  }
  return path.reverse();
};

/**
 * String-pulling: replace runs of the grid path with straight segments wherever the straight
 * segment scores no worse. An 8-neighbour path is a staircase and reads several per cent long;
 * this takes that back out, and leaves a route with a handful of legs that can be described.
 */
Solver.prototype.smooth = function (path, limitRatio) {
  if (path.length < 3) return path;
  var kept = [path[0]];
  var anchor = 0;
  var travelled = 0;

  while (anchor < path.length - 1) {
    // Reach as far along the path as a straight segment stays within the glide we already know
    // is achievable. Clearing the ground is not enough: a shortcut can skim a shoulder that is
    // technically below the glider and still demand an absurd ratio to get there, which is
    // exactly what a plain line-of-sight test happily returns.
    var best = anchor + 1;
    var bestLeg = this.walkSegment(path[anchor], path[best], travelled, best === path.length - 1);
    for (var candidate = anchor + 2; candidate < path.length; candidate += 1) {
      var leg = this.walkSegment(path[anchor], path[candidate], travelled, candidate === path.length - 1);
      if (!leg || leg.worst > limitRatio) break;
      best = candidate;
      bestLeg = leg;
    }
    kept.push(path[best]);
    travelled = bestLeg ? bestLeg.travelledM : travelled;
    anchor = best;
  }
  return kept;
};

/**
 * The best route to one field: the grid path, then string-pulled against its own achieved ratio,
 * repeated while it keeps improving. Each pass can only accept shortcuts that stay inside the
 * ratio the previous pass achieved, so the result is never worse than the path it started from.
 */
Solver.prototype.refine = function (path, target) {
  var best = this.evaluate(path, target);
  if (!best) return null;
  var bestPath = path;
  for (var pass = 0; pass < 2; pass += 1) {
    var pulled = this.smooth(bestPath, best.ratio);
    if (pulled.length >= bestPath.length) break;
    var scored = this.evaluate(pulled, target);
    if (!scored || scored.ratio >= best.ratio) break;
    best = scored;
    bestPath = pulled;
  }
  return { result: best, path: bestPath };
};

Solver.prototype.describe = function (result, target, path) {
  var out = {
    requiredGlideRatio: result.ratio,
    pathLengthM: result.lengthM,
    legs: path ? path.length - 1 : 1,
  };
  if (result.criticalIndex >= 0) {
    var where = this.latLonOf(result.criticalIndex);
    out.critical = {
      latitude: where.latitude,
      longitude: where.longitude,
      elevationM: this.elevations[result.criticalIndex],
    };
  }
  return out;
};

Solver.prototype.solve = function (ladder) {
  var results = {};
  var pending = this.targets.filter(function (target) { return target.index >= 0; });
  var straight = {};

  // The straight line first: it is the answer in flat country, it is the yardstick for whether a
  // route is a detour worth mentioning, and it costs one walk across the grid.
  for (var i = 0; i < pending.length; i += 1) {
    var target = pending[i];
    var direct = this.evaluate([this.origin, target.index], target);
    if (direct) straight[target.id] = direct;
  }

  var unresolved = pending.slice();
  for (var rung = 0; rung < ladder.length && unresolved.length; rung += 1) {
    this.flood(ladder[rung]);
    var stillPending = [];
    for (var j = 0; j < unresolved.length; j += 1) {
      var candidate = unresolved[j];
      if (!isFinite(this.dist[candidate.index])) { stillPending.push(candidate); continue; }
      var refined = this.refine(this.pathTo(candidate.index), candidate);
      if (refined) results[candidate.id] = this.describe(refined.result, candidate, refined.path);
    }
    unresolved = stillPending;
  }

  // Straight line wins wherever it is feasible and shorter to fly than the routed answer: it is
  // a real path too, and it is free of the grid's staircase.
  for (var k = 0; k < pending.length; k += 1) {
    var id = pending[k].id;
    var line = straight[id];
    if (!line) continue;
    var routed = results[id];
    if (!routed || line.ratio <= routed.requiredGlideRatio) {
      results[id] = this.describe(line, pending[k], null);
      results[id].direct = true;
    }
  }

  for (var m = 0; m < pending.length; m += 1) {
    var pid = pending[m].id;
    if (results[pid] && straight[pid]) {
      results[pid].directGlideRatio = straight[pid].ratio;
      results[pid].directLengthM = straight[pid].lengthM;
    }
  }
  return results;
};

self.onmessage = function (event) {
  var request = event.data;
  if (!request || request.type !== 'solve') return;
  try {
    var solver = new Solver(request);
    var results = solver.solve(request.ladder || DEFAULT_LADDER);
    self.postMessage({ type: 'solved', id: request.id, results: results });
  } catch (error) {
    self.postMessage({ type: 'error', id: request.id, message: String(error && error.message || error) });
  }
};
