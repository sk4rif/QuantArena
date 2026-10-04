"""Minimal QuantArena bot: chase the nearest ball, cash out at a profit target.

    pip install websockets
    python bots/example_bot.py [ws://127.0.0.1:3001/bot] [name]

Positions and radii on the wire are integers scaled by 100; worth is in nanos.
"""
import asyncio
import json
import math
import sys

POSITION_SCALE = 100
NANOS = 1_000_000_000
PROFIT_TARGET = 2.0  # cash out at 2x the entry ticket


def wrapped_delta(delta: float, half_extent: float) -> float:
    size = half_extent * 2
    return (delta + half_extent) % size - half_extent


async def run(url: str, name: str) -> None:
    import websockets

    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "join", "protocol": 4, "name": name}))
        me = None
        half_extent = 0.0
        ticket = 0
        cash_out_pending = False
        snakes, food = {}, {}

        async for raw in ws:
            msg = json.loads(raw)
            kind = msg["type"]

            if kind == "bootstrap":  # full state; sent on join and on every resync
                me = msg["playerId"]
                half_extent = msg["arenaHalfExtent"] / POSITION_SCALE
                ticket = msg["economyConfig"]["ticketNanos"]
                snakes = {s["id"]: s for s in msg["snakes"]}
                food = {f["id"]: f for f in msg["food"]}
            elif kind == "delta":
                for s in msg["snakesAdded"]:
                    snakes[s["id"]] = s
                for patch in msg["snakesUpdated"]:
                    snakes.setdefault(patch["id"], {}).update(
                        {k: patch[k] for k in ("x", "y", "worthNanos", "radius")}
                    )
                for sid in msg["snakesRemoved"]:
                    snakes.pop(sid, None)
                for f in msg["foodAdded"]:
                    food[f["id"]] = f
                for fid in msg["foodRemoved"]:
                    food.pop(fid, None)
            elif kind == "eliminated":
                cash_out_pending = False
                print(f"eliminated ({msg['reason']}); re-entering")
                await ws.send(json.dumps({"type": "reenter"}))
                continue
            elif kind == "cashOutPending":
                cash_out_pending = True
                print("cash-out pending until tick", msg["completesAtTick"])
                continue
            elif kind == "cashOutCanceled":
                cash_out_pending = False
                continue
            elif kind == "cashOutReceipt":
                cash_out_pending = False
                print("cashed out:", msg)
                await ws.send(json.dumps({"type": "reenter"}))
                continue
            elif kind == "error":
                print("server error:", msg["code"], msg["message"])
                continue
            else:
                continue

            if kind != "delta" or me not in snakes or "x" not in snakes[me]:
                continue
            head = snakes[me]
            hx, hy = head["x"] / POSITION_SCALE, head["y"] / POSITION_SCALE

            if head["worthNanos"] >= PROFIT_TARGET * ticket and not cash_out_pending:
                await ws.send(json.dumps({"type": "cashOut"}))
                continue

            if not food:
                continue
            nearest = min(
                food.values(),
                key=lambda f: math.hypot(
                    wrapped_delta(f["x"] / POSITION_SCALE - hx, half_extent),
                    wrapped_delta(f["y"] / POSITION_SCALE - hy, half_extent),
                ),
            )
            dx = wrapped_delta(nearest["x"] / POSITION_SCALE - hx, half_extent)
            dy = wrapped_delta(nearest["y"] / POSITION_SCALE - hy, half_extent)
            if dx == 0 and dy == 0:
                continue
            await ws.send(json.dumps({"type": "input", "x": dx, "y": dy, "boost": False}))


if __name__ == "__main__":
    asyncio.run(
        run(
            sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:3001/bot",
            sys.argv[2] if len(sys.argv) > 2 else "example-bot",
        )
    )
