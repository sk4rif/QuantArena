import argparse
import asyncio
import json
import math

import websockets

POSITION_SCALE = 100
ANGLE_SCALE = 10_000
PROTOCOL = 5
BOUNDARY = 200.0
TURN_RATE = 3.4
SIMULATION_DT = 1.0 / 15.0
SIMULATION_STEPS = 15
DIRECTION_SAMPLES = 24
MAX_STATIC_OBSTACLES = 96
DECISION_PERIOD = 3


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


def apply_delta(snakes: dict[int, dict], food: dict[int, dict], msg: dict) -> None:
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


def nearest_food(food: dict[int, dict], hx: float, hy: float, half_extent: float) -> dict | None:
    nearest = None
    nearest_distance = math.inf
    for coin in food.values():
        distance = wrapped_distance_squared(
            coin["x"] / POSITION_SCALE, coin["y"] / POSITION_SCALE, hx, hy, half_extent
        )
        if distance < nearest_distance:
            nearest = coin
            nearest_distance = distance
    return nearest


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
    desired = math.atan2(direction[1], direction[0])
    margin = math.inf

    for step in range(1, SIMULATION_STEPS + 1):
        turn = wrapped_angle(desired - angle)
        angle += max(-TURN_RATE * SIMULATION_DT, min(TURN_RATE * SIMULATION_DT, turn))
        x = wrapped_coordinate(x + math.cos(angle) * speed * SIMULATION_DT, half_extent)
        y = wrapped_coordinate(y + math.sin(angle) * speed * SIMULATION_DT, half_extent)
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
    snakes: dict[int, dict], food: dict[int, dict], me: int, half_extent: float
) -> tuple[float, float] | None:
    head = snakes.get(me)
    if not head or not food:
        return None
    hx, hy = head["x"] / POSITION_SCALE, head["y"] / POSITION_SCALE
    target = nearest_food(food, hx, hy, half_extent)
    target_direction = unit(
        wrapped_delta(target["x"] / POSITION_SCALE - hx, half_extent),
        wrapped_delta(target["y"] / POSITION_SCALE - hy, half_extent),
    )
    static, movers = nearby_obstacles(snakes, me, hx, hy, half_extent)
    if not static and not movers:
        return target_direction
    if path_margin(head, target_direction, static, movers, half_extent) >= 0:
        return target_direction

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
        return max(
            safe,
            key=lambda candidate: (
                candidate[1][0] * target_direction[0]
                + candidate[1][1] * target_direction[1]
                + 0.1 * (candidate[1][0] * current_direction[0] + candidate[1][1] * current_direction[1])
            ),
        )[1]
    return max(candidates, key=lambda candidate: candidate[0])[1]


async def run_bot(url: str, name: str, skin: str, phase: int) -> None:
    while True:
        try:
            async with websockets.connect(url, ping_interval=10, ping_timeout=10) as ws:
                await ws.send(json.dumps({"type": "join", "protocol": PROTOCOL, "name": name, "skin": skin}))
                me = None
                half_extent = 0.0
                sequence = None
                snakes, food = {}, {}
                async for raw in ws:
                    msg = json.loads(raw)
                    kind = msg["type"]
                    if kind == "bootstrap":
                        me = msg["playerId"]
                        half_extent = msg["arenaHalfExtent"] / POSITION_SCALE
                        sequence = msg["sequence"]
                        snakes = {snake["id"]: snake for snake in msg["snakes"]}
                        food = {coin["id"]: coin for coin in msg["food"]}
                        print(f"{name} joined as {me}", flush=True)
                    elif kind == "delta":
                        if sequence is not None and msg["sequence"] != sequence + 1:
                            await ws.send(json.dumps({"type": "resync"}))
                            sequence = None
                            continue
                        sequence = msg["sequence"]
                        apply_delta(snakes, food, msg)
                        if me is None or sequence % DECISION_PERIOD != phase:
                            continue
                        direction = steering_direction(snakes, food, me, half_extent)
                        if direction is not None:
                            await ws.send(
                                json.dumps({"type": "input", "x": direction[0], "y": direction[1], "boost": False})
                            )
                    elif kind == "eliminated":
                        snakes.pop(me, None)
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
