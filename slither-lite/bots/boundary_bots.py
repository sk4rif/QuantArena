"""Boundary bots for the QuantArena `/bot` endpoint.

Server messages match the browser. Bots send `join`, `input` (`x`, `y`, `boost`),
`reenter`, and `resync` — no replica digest. Deltas omit unchanged snakes, and
omit `economy` and `leaderboard` until those snapshots change. A sequence gap
asks for one `resync` per second and discards deltas until the next bootstrap.
The server keeps the last steering vector. Each decision sends the latest aim.
"""

import argparse
import asyncio
import json
import math
import time

import websockets

POSITION_SCALE = 100
ANGLE_SCALE = 10_000
PROTOCOL = 5
RESYNC_MIN_INTERVAL = 1.0
BOUNDARY = 200.0
TURN_RATE = 3.4
# Base speed is 150, so this is the tightest arc the snake can steer.
TURN_RADIUS = 150.0 / TURN_RATE
# Boost speed over the turn rate. The neck uses this wider circle.
BOOST_TURN_RADIUS = 440.0 / TURN_RATE
SIMULATION_DT = 1.0 / 15.0
# Two seconds of travel. One second let the bot drive straight until a body was too close to miss.
SIMULATION_STEPS = 30
DIRECTION_SAMPLES = 24
MAX_STATIC_OBSTACLES = 96
DECISION_PERIOD = 3


def neck_length(radius: float) -> float:
    """Straight lead that keeps the head outside a coil. Matches the server."""
    return 2.0 * math.sqrt(radius * (BOOST_TURN_RADIUS + radius))


def wrapped_delta(delta: float, half_extent: float) -> float:
    size = half_extent * 2
    return (delta + half_extent) % size - half_extent


def wrapped_angle(angle: float) -> float:
    return (angle + math.pi) % (2 * math.pi) - math.pi


def wrapped_coordinate(value: float, half_extent: float) -> float:
    return (value + half_extent) % (half_extent * 2) - half_extent


def wrapped_distance_squared(ax: float, ay: float, bx: float, by: float, half_extent: float) -> float:
    dx, dy = abs(ax - bx), abs(ay - by)
    size = half_extent * 2
    if dx > half_extent:
        dx = size - dx
    if dy > half_extent:
        dy = size - dy
    return dx * dx + dy * dy


def unit(x: float, y: float) -> tuple[float, float]:
    length = math.hypot(x, y)
    return (x / length, y / length) if length else (1.0, 0.0)


class Replica:
    """Browser-equivalent world view. Economy and leaderboard stay put when a delta omits them."""

    def __init__(self) -> None:
        self.me: int | None = None
        self.half_extent = 0.0
        self.sequence: int | None = None
        self.snakes: dict[int, dict] = {}
        self.food: dict[int, dict] = {}
        self.economy: dict | None = None
        self.leaderboard: list | None = None
        self.awaiting_bootstrap = False
        self.last_resync_at = float("-inf")

    def apply_bootstrap(self, msg: dict) -> None:
        self.me = msg["playerId"]
        self.half_extent = msg["arenaHalfExtent"] / POSITION_SCALE
        self.sequence = msg["sequence"]
        self.snakes = {snake["id"]: snake for snake in msg["snakes"]}
        self.food = {coin["id"]: coin for coin in msg["food"]}
        self.economy = msg["economy"]
        self.leaderboard = msg["leaderboard"]
        self.awaiting_bootstrap = False

    def resync_due(self, now: float) -> bool:
        return self.awaiting_bootstrap and now - self.last_resync_at >= RESYNC_MIN_INTERVAL

    def mark_resync_sent(self, now: float) -> None:
        self.awaiting_bootstrap = True
        self.last_resync_at = now

    def apply_delta(self, msg: dict) -> str:
        """Return `apply`, `gap`, or `discard`. A gap is not applied."""
        if self.awaiting_bootstrap or self.sequence is None:
            return "discard"
        if msg["sequence"] != self.sequence + 1:
            self.awaiting_bootstrap = True
            return "gap"
        self.sequence = msg["sequence"]
        apply_entity_delta(self.snakes, self.food, msg)
        if "economy" in msg:
            self.economy = msg["economy"]
        if "leaderboard" in msg:
            self.leaderboard = msg["leaderboard"]
        return "apply"


def apply_entity_delta(snakes: dict[int, dict], food: dict[int, dict], msg: dict) -> None:
    for snake_id in msg["snakesRemoved"]:
        snakes.pop(snake_id, None)
    for snake in msg["snakesAdded"]:
        snakes[snake["id"]] = snake
    for patch in msg["snakesUpdated"]:
        snake = snakes.get(patch["id"])
        if snake is None:
            continue
        for key in ("x", "y", "angle", "speed", "radius", "worthNanos", "lastInputSeq"):
            snake[key] = patch[key]
        if "replaceBody" in patch:
            snake["body"] = patch["replaceBody"]
        else:
            snake["body"] = snake.get("body", [])[patch["trimBody"] :] + patch["appendBody"]
    for food_id in msg["foodRemoved"]:
        food.pop(food_id, None)
    for coin in msg["foodAdded"]:
        food[coin["id"]] = coin


def food_direction(
    head: dict, food: dict[int, dict], half_extent: float, locked_id: int | None
) -> tuple[tuple[float, float], int | None]:
    """Steer at one coin until it is eaten.

    Retargeting every decision flips the aim between neighboring coins and the
    turns cancel, so the snake travels in a straight line. A coin beside the
    head, inside the turning circle, is skipped so the snake does not orbit it.
    """
    hx, hy = head["x"] / POSITION_SCALE, head["y"] / POSITION_SCALE
    angle = head["angle"] / ANGLE_SCALE
    forward_x, forward_y = math.cos(angle), math.sin(angle)

    def offset(coin: dict) -> tuple[float, float, float]:
        dx = wrapped_delta(coin["x"] / POSITION_SCALE - hx, half_extent)
        dy = wrapped_delta(coin["y"] / POSITION_SCALE - hy, half_extent)
        return math.hypot(dx, dy), dx, dy

    if locked_id is not None and locked_id in food:
        distance, dx, dy = offset(food[locked_id])
        along = dx * forward_x + dy * forward_y
        if distance >= 8.0 and (along > 0 or distance > TURN_RADIUS * 3):
            return unit(dx, dy), locked_id

    ahead: list[tuple[float, float, float, int]] = []
    behind: list[tuple[float, float, float, int]] = []
    for coin_id, coin in food.items():
        distance, dx, dy = offset(coin)
        if distance < 8.0:
            continue
        along = dx * forward_x + dy * forward_y
        if along <= 0 and distance < TURN_RADIUS * 3:
            continue
        (ahead if along > 0 else behind).append((distance, dx, dy, coin_id))
    pool = ahead or behind
    if not pool:
        return (forward_x, forward_y), None
    _, dx, dy, coin_id = min(pool, key=lambda item: item[0])
    return unit(dx, dy), coin_id


def clamp_turn(head: dict, direction: tuple[float, float]) -> tuple[float, float]:
    """Ask for at most about 60° away from the current heading.

    The server already turns at 3.4 rad/s. A command on the opposite side of
    the circle makes that turn reverse on the next decision.
    """
    current = head["angle"] / ANGLE_SCALE
    desired = math.atan2(direction[1], direction[0])
    delta = max(-1.0, min(1.0, wrapped_angle(desired - current)))
    aim = current + delta
    return math.cos(aim), math.sin(aim)


def nearby_obstacles(
    snakes: dict[int, dict], me: int, hx: float, hy: float, half_extent: float
) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float, float, float]]]:
    own_radius = snakes[me]["radius"] / POSITION_SCALE
    horizon = SIMULATION_STEPS * SIMULATION_DT
    reach = horizon * 440.0
    static = []
    movers = []
    for snake_id, snake in snakes.items():
        if snake_id == me:
            continue
        safe_distance = BOUNDARY + own_radius + snake["radius"] / POSITION_SCALE
        limit_squared = (reach + safe_distance) ** 2
        ox, oy = snake["x"] / POSITION_SCALE, snake["y"] / POSITION_SCALE
        if wrapped_distance_squared(ox, oy, hx, hy, half_extent) <= limit_squared:
            angle = snake["angle"] / ANGLE_SCALE
            speed = snake["speed"] / POSITION_SCALE
            movers.append((ox, oy, math.cos(angle) * speed, math.sin(angle) * speed, safe_distance))
        for point in snake.get("body", []):
            px, py = point["x"] / POSITION_SCALE, point["y"] / POSITION_SCALE
            distance = wrapped_distance_squared(px, py, hx, hy, half_extent)
            if distance <= limit_squared:
                static.append((distance, px, py, safe_distance))
    static.sort(key=lambda obstacle: obstacle[0])
    return [(x, y, safe) for _, x, y, safe in static[:MAX_STATIC_OBSTACLES]], movers


def path_margin(
    head: dict,
    direction: tuple[float, float],
    static: list[tuple[float, float, float]],
    movers: list[tuple[float, float, float, float, float]],
    half_extent: float,
) -> float:
    x, y = head["x"] / POSITION_SCALE, head["y"] / POSITION_SCALE
    angle = head["angle"] / ANGLE_SCALE
    speed = max(head["speed"] / POSITION_SCALE, 150.0)
    neck = neck_length(head["radius"] / POSITION_SCALE)
    desired = math.atan2(direction[1], direction[0])
    margin = math.inf

    for step in range(1, SIMULATION_STEPS + 1):
        old_angle = angle
        turn = wrapped_angle(desired - angle)
        angle += max(-TURN_RATE * SIMULATION_DT, min(TURN_RATE * SIMULATION_DT, turn))
        base_x = x - math.cos(old_angle) * neck
        base_y = y - math.sin(old_angle) * neck
        base_x += math.cos(angle) * speed * SIMULATION_DT
        base_y += math.sin(angle) * speed * SIMULATION_DT
        x = wrapped_coordinate(base_x + math.cos(angle) * neck, half_extent)
        y = wrapped_coordinate(base_y + math.sin(angle) * neck, half_extent)
        elapsed = step * SIMULATION_DT

        for ox, oy, safe_distance in static:
            distance = math.sqrt(wrapped_distance_squared(ox, oy, x, y, half_extent))
            margin = min(margin, distance - safe_distance)
        for ox, oy, vx, vy, safe_distance in movers:
            px, py = ox + vx * elapsed, oy + vy * elapsed
            distance = math.sqrt(wrapped_distance_squared(px, py, x, y, half_extent))
            margin = min(margin, distance - safe_distance)
        if margin < -BOUNDARY / 2:
            break
    return margin


def steering_direction(
    snakes: dict[int, dict],
    food: dict[int, dict],
    me: int,
    half_extent: float,
    locked_food: dict[str, int | None],
) -> tuple[float, float] | None:
    head = snakes.get(me)
    if not head or not food:
        return None
    hx, hy = head["x"] / POSITION_SCALE, head["y"] / POSITION_SCALE
    target_direction, locked_food["id"] = food_direction(head, food, half_extent, locked_food.get("id"))
    static, movers = nearby_obstacles(snakes, me, hx, hy, half_extent)
    if not static and not movers:
        return clamp_turn(head, target_direction)
    if path_margin(head, target_direction, static, movers, half_extent) >= 0:
        return clamp_turn(head, target_direction)

    current_angle = head["angle"] / ANGLE_SCALE
    current_direction = (math.cos(current_angle), math.sin(current_angle))
    directions = [
        current_direction,
        *(
            (math.cos(2 * math.pi * index / DIRECTION_SAMPLES), math.sin(2 * math.pi * index / DIRECTION_SAMPLES))
            for index in range(DIRECTION_SAMPLES)
        ),
    ]
    candidates = [
        (path_margin(head, direction, static, movers, half_extent), direction)
        for direction in directions
    ]
    safe = [candidate for candidate in candidates if candidate[0] >= 0]
    if safe:
        chosen = max(
            safe,
            key=lambda candidate: (
                candidate[1][0] * target_direction[0]
                + candidate[1][1] * target_direction[1]
                + 0.1 * (candidate[1][0] * current_direction[0] + candidate[1][1] * current_direction[1])
            ),
        )[1]
    else:
        chosen = max(candidates, key=lambda candidate: candidate[0])[1]
    return clamp_turn(head, chosen)


async def send_resync(ws, replica: Replica) -> None:
    now = time.monotonic()
    if not replica.resync_due(now):
        return
    replica.mark_resync_sent(now)
    await ws.send(json.dumps({"type": "resync"}))


async def run_bot(url: str, name: str, skin: str, phase: int) -> None:
    while True:
        try:
            async with websockets.connect(url, ping_interval=10, ping_timeout=10) as ws:
                await ws.send(json.dumps({"type": "join", "protocol": PROTOCOL, "name": name, "skin": skin}))
                replica = Replica()
                locked_food: dict[str, int | None] = {"id": None}
                async for raw in ws:
                    msg = json.loads(raw)
                    kind = msg["type"]
                    if kind == "bootstrap":
                        replica.apply_bootstrap(msg)
                        locked_food["id"] = None
                        print(f"{name} joined as {replica.me} ({msg['reason']})", flush=True)
                    elif kind == "delta":
                        outcome = replica.apply_delta(msg)
                        if outcome != "apply":
                            if outcome == "gap":
                                replica.awaiting_bootstrap = True
                            await send_resync(ws, replica)
                            continue
                        if (
                            replica.me is None
                            or replica.sequence is None
                            or replica.sequence % DECISION_PERIOD != phase
                            or replica.me not in replica.snakes
                        ):
                            continue
                        direction = steering_direction(
                            replica.snakes, replica.food, replica.me, replica.half_extent, locked_food
                        )
                        if direction is None:
                            continue
                        await ws.send(
                            json.dumps({"type": "input", "x": direction[0], "y": direction[1], "boost": False})
                        )
                    elif kind == "eliminated":
                        if replica.me is not None:
                            replica.snakes.pop(replica.me, None)
                        print(f"{name} eliminated: {msg['reason']}", flush=True)
                        await ws.send(json.dumps({"type": "reenter"}))
                    elif kind == "error":
                        print(f"{name}: {msg['code']}: {msg['message']}", flush=True)
        except Exception as error:
            print(f"{name} reconnecting after {error}", flush=True)
            await asyncio.sleep(1)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", default="ws://127.0.0.1:3001/bot")
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--prefix", default="BoundaryBot")
    args = parser.parse_args()
    if not 1 <= args.count <= 99:
        parser.error("--count must be between 1 and 99")
    skins = ("red", "blue", "green", "purple", "orange", "yellow")
    await asyncio.gather(
        *(
            run_bot(args.url, f"{args.prefix}{index:02d}", skins[(index - 1) % len(skins)], index % DECISION_PERIOD)
            for index in range(1, args.count + 1)
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
