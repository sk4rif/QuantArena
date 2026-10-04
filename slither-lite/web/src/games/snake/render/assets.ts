export interface GameAssets {
  body: HTMLImageElement;
  head: HTMLImageElement;
}

export async function loadAssets(): Promise<GameAssets> {
  const [body, head] = await Promise.all([loadImage("/assets/body_red.png"), loadImage("/assets/yellow_head.png")]);
  return { body, head };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error(`Unable to load ${source}`)), { once: true });
    image.src = source;
  });
}
