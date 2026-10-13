import { dequantizeAngle, dequantizePosition, type BodyPointWire } from "../net/protocol";
import { nearestWrappedCoordinate } from "./geometry";
import type { Replica } from "./replica";
import type { InputState } from "./input";

interface RemotePose {
  x: number;
  y: number;
  angle: number;
}

interface RemoteTrack extends RemotePose {
  targetX: number;
  targetY: number;
  targetAngle: number;
  authorityX: number;
  authorityY: number;
  authorityAngle: number;
  startedAt: number;
  duration: number;
}

export class RemoteInterpolation {
  private readonly tracks = new Map<number, RemoteTrack>();

  reconcile(replica: Replica, now = performance.now()): void {
    const active = new Set<number>();
    const halfExtent = dequantizePosition(replica.arenaHalfExtent);
    const duration = 1_000 / Math.max(1, replica.publishRate);
    for (const snake of replica.snakes.values()) {
      if (snake.id === replica.playerId) continue;
      active.add(snake.id);
      const existing = this.tracks.get(snake.id);
      if (
        existing
        && existing.authorityX === snake.x
        && existing.authorityY === snake.y
        && existing.authorityAngle === snake.angle
      ) continue;
      const authorityX = dequantizePosition(snake.x);
      const authorityY = dequantizePosition(snake.y);
      const authorityAngle = dequantizeAngle(snake.angle);
      const current = existing ? this.interpolate(existing, now) : { x: authorityX, y: authorityY, angle: authorityAngle };
      this.tracks.set(snake.id, {
        ...current,
        targetX: nearestWrappedCoordinate(authorityX, current.x, halfExtent),
        targetY: nearestWrappedCoordinate(authorityY, current.y, halfExtent),
        targetAngle: current.angle + normalizeAngle(authorityAngle - current.angle),
        authorityX: snake.x,
        authorityY: snake.y,
        authorityAngle: snake.angle,
        startedAt: now,
        duration,
      });
    }
    for (const id of this.tracks.keys()) {
      if (!active.has(id)) this.tracks.delete(id);
    }
  }

  pose(id: number, now = performance.now()): RemotePose | undefined {
    const track = this.tracks.get(id);
    return track ? this.interpolate(track, now) : undefined;
  }

  private interpolate(track: RemoteTrack, now: number): RemotePose {
    const progress = Math.max(0, Math.min(1, (now - track.startedAt) / track.duration));
    return {
      x: track.x + (track.targetX - track.x) * progress,
      y: track.y + (track.targetY - track.y) * progress,
      angle: track.angle + (track.targetAngle - track.angle) * progress,
    };
  }
}

export interface BodyPose {
  x: number;
  y: number;
}

interface BodyTrack {
  points: BodyPose[];
  targets: BodyPose[];
  rendered: BodyPose[];
  unwrapped: BodyPose[];
  distances: number[];
  sampled: BodyPose[];
  authority: BodyPointWire[];
  startedAt: number;
  duration: number;
}

export class BodyInterpolation {
  private readonly tracks = new Map<number, BodyTrack>();

  reconcile(replica: Replica, now = performance.now()): void {
    const active = new Set<number>();
    const halfExtent = dequantizePosition(replica.arenaHalfExtent);
    const duration = 1_000 / Math.max(1, replica.publishRate);
    for (const snake of replica.snakes.values()) {
      active.add(snake.id);
      const existing = this.tracks.get(snake.id);
      if (existing && sameBody(existing.authority, snake.body)) continue;
      const points = existing
        ? this.interpolate(existing, now).map((point) => ({ ...point }))
        : snake.body.map((point) => ({ x: dequantizePosition(point.x), y: dequantizePosition(point.y) }));
      const targets = snake.body.map((point, index) => {
        const source = points[index] ?? points.at(-1);
        const x = dequantizePosition(point.x);
        const y = dequantizePosition(point.y);
        return source
          ? {
              x: nearestWrappedCoordinate(x, source.x, halfExtent),
              y: nearestWrappedCoordinate(y, source.y, halfExtent),
            }
          : { x, y };
      });
      this.tracks.set(snake.id, {
        points,
        targets,
        rendered: targets.map((point) => ({ ...point })),
        unwrapped: [],
        distances: [],
        sampled: targets.map((point) => ({ ...point })),
        authority: snake.body.map((point) => ({ ...point })),
        startedAt: now,
        duration,
      });
    }
    for (const id of this.tracks.keys()) {
      if (!active.has(id)) this.tracks.delete(id);
    }
  }

  points(id: number, now = performance.now()): BodyPose[] | undefined {
    const track = this.tracks.get(id);
    return track ? this.interpolate(track, now) : undefined;
  }

  trail(id: number, head: BodyPose, halfExtent: number, now = performance.now()): BodyPose[] | undefined {
    const track = this.tracks.get(id);
    if (!track) return undefined;
    const anchors = this.interpolate(track, now);
    const count = anchors.length;
    track.sampled.length = count;
    if (count === 0) return track.sampled;

    track.unwrapped.length = count + 1;
    const unwrappedHead = track.unwrapped[count] ?? { x: head.x, y: head.y };
    unwrappedHead.x = head.x;
    unwrappedHead.y = head.y;
    track.unwrapped[count] = unwrappedHead;
    for (let index = count - 1; index >= 0; index -= 1) {
      const anchor = anchors[index];
      const next = track.unwrapped[index + 1];
      if (!anchor || !next) continue;
      const point = track.unwrapped[index] ?? { x: anchor.x, y: anchor.y };
      point.x = nearestWrappedCoordinate(anchor.x, next.x, halfExtent);
      point.y = nearestWrappedCoordinate(anchor.y, next.y, halfExtent);
      track.unwrapped[index] = point;
    }

    track.distances.length = count + 1;
    track.distances[count] = 0;
    for (let index = count - 1; index >= 0; index -= 1) {
      const point = track.unwrapped[index];
      const next = track.unwrapped[index + 1];
      const nextDistance = track.distances[index + 1];
      if (!point || !next || nextDistance === undefined) continue;
      track.distances[index] = nextDistance + Math.hypot(point.x - next.x, point.y - next.y);
    }

    const totalDistance = track.distances[0] ?? 0;
    if (totalDistance === 0) {
      for (let index = 0; index < count; index += 1) {
        const sampled = track.sampled[index] ?? { x: head.x, y: head.y };
        sampled.x = head.x;
        sampled.y = head.y;
        track.sampled[index] = sampled;
      }
      return track.sampled;
    }

    const spacing = totalDistance / count;
    let segment = count - 1;
    for (let index = count - 1; index >= 0; index -= 1) {
      const targetDistance = (count - index) * spacing;
      while (segment > 0 && targetDistance > (track.distances[segment] ?? 0)) segment -= 1;
      const far = track.unwrapped[segment];
      const near = track.unwrapped[segment + 1];
      const farDistance = track.distances[segment];
      const nearDistance = track.distances[segment + 1];
      if (!far || !near || farDistance === undefined || nearDistance === undefined) continue;
      const segmentLength = farDistance - nearDistance;
      const progress = segmentLength > 0 ? (targetDistance - nearDistance) / segmentLength : 0;
      const sampled = track.sampled[index] ?? { x: near.x, y: near.y };
      sampled.x = near.x + (far.x - near.x) * progress;
      sampled.y = near.y + (far.y - near.y) * progress;
      track.sampled[index] = sampled;
    }
    return track.sampled;
  }

  private interpolate(track: BodyTrack, now: number): BodyPose[] {
    const progress = Math.max(0, Math.min(1, (now - track.startedAt) / track.duration));
    track.rendered.length = track.targets.length;
    for (let index = 0; index < track.targets.length; index += 1) {
      const target = track.targets[index];
      if (!target) continue;
      const source = track.points[index] ?? track.points.at(-1) ?? target;
      const rendered = track.rendered[index] ?? { x: target.x, y: target.y };
      rendered.x = source.x + (target.x - source.x) * progress;
      rendered.y = source.y + (target.y - source.y) * progress;
      track.rendered[index] = rendered;
    }
    return track.rendered;
  }
}

/** Same limit as the server `TURN_RATE`. The head turns at this rate on the client. */
const TURN_RATE = 3.4;

export class LocalPrediction {
  x = 0;
  y = 0;
  angle = 0;
  initialized = false;

  reconcile(replica: Replica): void {
    const snake = replica.snakes.get(replica.playerId);
    if (!snake) {
      this.initialized = false;
      return;
    }
    let authorityX = dequantizePosition(snake.x);
    let authorityY = dequantizePosition(snake.y);
    const authorityAngle = dequantizeAngle(snake.angle);
    if (!this.initialized) {
      this.x = authorityX;
      this.y = authorityY;
      this.angle = authorityAngle;
      this.initialized = true;
      return;
    }
    const halfExtent = dequantizePosition(replica.arenaHalfExtent);
    authorityX = nearestWrappedCoordinate(authorityX, this.x, halfExtent);
    authorityY = nearestWrappedCoordinate(authorityY, this.y, halfExtent);
    const errorX = authorityX - this.x;
    const errorY = authorityY - this.y;
    const forwardX = Math.cos(this.angle);
    const forwardY = Math.sin(this.angle);
    const parallel = errorX * forwardX + errorY * forwardY;
    // A snapshot is older than the pointer. Pulling backward along the heading
    // makes the snake look slow, so only sideways error and a server that is
    // actually ahead of us correct the position.
    this.x += (errorX - parallel * forwardX) * 0.35;
    this.y += (errorY - parallel * forwardY) * 0.35;
    if (parallel > 0) {
      this.x += forwardX * parallel * 0.35;
      this.y += forwardY * parallel * 0.35;
    }
    const angleError = normalizeAngle(authorityAngle - this.angle);
    if (Math.abs(angleError) > 1.2) {
      this.angle = normalizeAngle(this.angle + angleError * 0.5);
    }
  }

  update(replica: Replica, input: InputState, deltaSeconds: number): void {
    const snake = replica.snakes.get(replica.playerId);
    if (!snake || !this.initialized) return;
    const serverSpeed = dequantizePosition(snake.speed);
    const speed = input.boost && snake.worthNanos > 0 ? Math.max(serverSpeed, 220) : serverSpeed;
    const difference = normalizeAngle(input.aim - this.angle);
    const maxTurn = TURN_RATE * deltaSeconds;
    this.angle = normalizeAngle(this.angle + Math.max(-maxTurn, Math.min(maxTurn, difference)));
    this.x += Math.cos(this.angle) * speed * deltaSeconds;
    this.y += Math.sin(this.angle) * speed * deltaSeconds;
  }
}

function sameBody(left: BodyPointWire[], right: BodyPointWire[]): boolean {
  return left.length === right.length
    && left.every((point, index) => {
      const other = right[index];
      return other !== undefined && point.id === other.id && point.x === other.x && point.y === other.y;
    });
}

function normalizeAngle(value: number): number {
  const tau = Math.PI * 2;
  return ((value + Math.PI) % tau + tau) % tau - Math.PI;
}
