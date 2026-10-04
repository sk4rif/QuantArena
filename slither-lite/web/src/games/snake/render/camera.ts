export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  follow(x: number, y: number, radius: number): void {
    this.x += (x - this.x) * 0.16;
    this.y += (y - this.y) * 0.16;
    const targetZoom = Math.max(0.7, Math.min(1.05, 1.05 - radius / 180));
    this.zoom += (targetZoom - this.zoom) * 0.05;
  }
}
