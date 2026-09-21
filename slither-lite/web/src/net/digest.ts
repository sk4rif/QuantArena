import type { EconomyStateWire, FoodWire, SnakeWire } from "./protocol";

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;
const encoder = new TextEncoder();

class Hasher {
  value = OFFSET;

  bytes(values: Uint8Array): void {
    for (const value of values) {
      this.value ^= BigInt(value);
      this.value = (this.value * PRIME) & MASK;
    }
  }

  u8(value: number): void {
    this.bytes(Uint8Array.of(value & 0xff));
  }

  u32(value: number): void {
    this.bytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
  }

  i32(value: number): void {
    this.u32(value | 0);
  }

  u64(value: number): void {
    let remaining = BigInt(value);
    const bytes = new Uint8Array(8);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.bytes(bytes);
  }

  string(value: string): void {
    const bytes = encoder.encode(value);
    this.u32(bytes.length);
    this.bytes(bytes);
  }
}

export function stateDigest(
  snakes: Iterable<SnakeWire>,
  food: Iterable<FoodWire>,
  economy: EconomyStateWire,
): string {
  const sortedSnakes = [...snakes].sort((left, right) => left.id - right.id);
  const sortedFood = [...food].sort((left, right) => left.id - right.id);
  const hash = new Hasher();
  hash.bytes(encoder.encode("SLITHER2"));
  hash.u64(economy.pendingFloorNanos);
  hash.u64(economy.ticketInflowNanos);
  hash.u64(economy.payoutsNanos);
  hash.u64(economy.platformFeesNanos);
  hash.u32(sortedSnakes.length);
  for (const snake of sortedSnakes) {
    hash.u8(1);
    hash.u32(snake.id);
    hash.string(snake.name);
    hash.string(snake.skin);
    hash.i32(snake.x);
    hash.i32(snake.y);
    hash.i32(snake.angle);
    hash.i32(snake.speed);
    hash.i32(snake.radius);
    hash.u64(snake.worthNanos);
    hash.u32(snake.lastInputSeq);
    hash.u32(snake.body.length);
    for (const point of snake.body) {
      hash.u64(point.id);
      hash.i32(point.x);
      hash.i32(point.y);
    }
  }
  hash.u32(sortedFood.length);
  for (const item of sortedFood) {
    hash.u8(2);
    hash.u32(item.id);
    hash.i32(item.x);
    hash.i32(item.y);
    hash.i32(item.radius);
    hash.u64(item.valueNanos);
    hash.u8(item.color);
  }
  return hash.value.toString(16).padStart(16, "0");
}
