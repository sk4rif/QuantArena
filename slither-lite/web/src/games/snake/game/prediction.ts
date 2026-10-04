import { dequantizeAngle, dequantizePosition } from "../net/protocol";
import { nearestWrappedCoordinate } from "./geometry";
import type { Replica } from "./replica";
import type { InputState } from "./input";

export class LocalPrediction {
  x = 0;
  y = 0;
  initialized = false;

  reconcile(replica: Replica): void {
    const snake = replica.snakes.get(replica.playerId);
    if (!snake) {
      this.initialized = false;
      return;
    }
    let authorityX = dequantizePosition(snake.x);
    let authorityY = dequantizePosition(snake.y);
    if (!this.initialized) {
      this.x = authorityX;
      this.y = authorityY;
      this.initialized = true;
      return;
    }
    const halfExtent = dequantizePosition(replica.arenaHalfExtent);
    authorityX = nearestWrappedCoordinate(authorityX, this.x, halfExtent);
    authorityY = nearestWrappedCoordinate(authorityY, this.y, halfExtent);
    this.x += (authorityX - this.x) * 0.35;
    this.y += (authorityY - this.y) * 0.35;
  }

  update(replica: Replica, input: InputState, deltaSeconds: number): void {
    const snake = replica.snakes.get(replica.playerId);
    if (!snake || !this.initialized) return;
    const serverSpeed = dequantizePosition(snake.speed);
    const speed = input.boost && snake.worthNanos > 0 ? Math.max(serverSpeed, 220) : serverSpeed;
    const authorityAngle = dequantizeAngle(snake.angle);
    const angleDifference = normalizeAngle(input.aim - authorityAngle);
    const predictedAngle = authorityAngle + Math.max(-0.12, Math.min(0.12, angleDifference));
    this.x += Math.cos(predictedAngle) * speed * deltaSeconds;
    this.y += Math.sin(predictedAngle) * speed * deltaSeconds;
  }
}

function normalizeAngle(value: number): number {
  const tau = Math.PI * 2;
  return ((value + Math.PI) % tau + tau) % tau - Math.PI;
}
